/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {Fiber} from './ReactFiber';
import type {FiberRoot} from './ReactFiberRoot';
import type {ExpirationTime} from './ReactFiberExpirationTime';
import type {CapturedValue} from './ReactCapturedValue';
import type {Update} from './ReactUpdateQueue';
import type {Thenable} from './ReactFiberScheduler';
import type {SuspenseState} from './ReactFiberSuspenseComponent';

import {unstable_wrap as Schedule_tracing_wrap} from 'scheduler/tracing';
import getComponentName from 'shared/getComponentName';
import warningWithoutStack from 'shared/warningWithoutStack';
import {
  ClassComponent,
  HostRoot,
  HostComponent,
  HostPortal,
  ContextProvider,
  SuspenseComponent,
  IncompleteClassComponent,
} from 'shared/ReactWorkTags';
import {
  DidCapture,
  Incomplete,
  NoEffect,
  ShouldCapture,
  Callback as CallbackEffect,
  LifecycleEffectMask,
} from 'shared/ReactSideEffectTags';
import {enableSchedulerTracing} from 'shared/ReactFeatureFlags';
import {ConcurrentMode} from './ReactTypeOfMode';
import {shouldCaptureSuspense} from './ReactFiberSuspenseComponent';

import {createCapturedValue} from './ReactCapturedValue';
import {
  enqueueCapturedUpdate,
  createUpdate,
  CaptureUpdate,
} from './ReactUpdateQueue';
import {logError} from './ReactFiberCommitWork';
import {popHostContainer, popHostContext} from './ReactFiberHostContext';
import {
  isContextProvider as isLegacyContextProvider,
  popContext as popLegacyContext,
  popTopLevelContextObject as popTopLevelLegacyContextObject,
} from './ReactFiberContext';
import {popProvider} from './ReactFiberNewContext';
import {
  renderDidSuspend,
  renderDidError,
  onUncaughtError,
  markLegacyErrorBoundaryAsFailed,
  isAlreadyFailedLegacyErrorBoundary,
  retrySuspendedRoot,
} from './ReactFiberScheduler';
import {NoWork, Sync} from './ReactFiberExpirationTime';

import invariant from 'shared/invariant';
import maxSigned31BitInt from './maxSigned31BitInt';
import {
  expirationTimeToMs,
  LOW_PRIORITY_EXPIRATION,
} from './ReactFiberExpirationTime';
import {findEarliestOutstandingPriorityLevel} from './ReactFiberPendingPriority';
import {reconcileChildren} from './ReactFiberBeginWork';

function createRootErrorUpdate(
  fiber: Fiber,
  errorInfo: CapturedValue<mixed>,
  expirationTime: ExpirationTime,
): Update<mixed> {
  const update = createUpdate(expirationTime);
  // Unmount the root by rendering null.
  update.tag = CaptureUpdate;
  // Caution: React DevTools currently depends on this property
  // being called "element".
  update.payload = {element: null};
  const error = errorInfo.value;
  update.callback = () => {
    onUncaughtError(error);
    logError(fiber, errorInfo);
  };
  return update;
}

function createClassErrorUpdate(
  fiber: Fiber,
  errorInfo: CapturedValue<mixed>,
  expirationTime: ExpirationTime,
): Update<mixed> {
  const update = createUpdate(expirationTime);
  update.tag = CaptureUpdate;
  const getDerivedStateFromError = fiber.type.getDerivedStateFromError;
  if (typeof getDerivedStateFromError === 'function') {
    const error = errorInfo.value;
    update.payload = () => {
      return getDerivedStateFromError(error);
    };
  }

  const inst = fiber.stateNode;
  if (inst !== null && typeof inst.componentDidCatch === 'function') {
    update.callback = function callback() {
      if (typeof getDerivedStateFromError !== 'function') {
        // To preserve the preexisting retry behavior of error boundaries,
        // we keep track of which ones already failed during this batch.
        // This gets reset before we yield back to the browser.
        // TODO: Warn in strict mode if getDerivedStateFromError is
        // not defined.
        markLegacyErrorBoundaryAsFailed(this);
      }
      const error = errorInfo.value;
      const stack = errorInfo.stack;
      logError(fiber, errorInfo);
      this.componentDidCatch(error, {
        componentStack: stack !== null ? stack : '',
      });
      if (__DEV__) {
        if (typeof getDerivedStateFromError !== 'function') {
          // If componentDidCatch is the only error boundary method defined,
          // then it needs to call setState to recover from errors.
          // If no state update is scheduled then the boundary will swallow the error.
          warningWithoutStack(
            fiber.expirationTime === Sync,
            '%s: Error boundaries should implement getDerivedStateFromError(). ' +
              'In that method, return a state update to display an error message or fallback UI.',
            getComponentName(fiber.type) || 'Unknown',
          );
        }
      }
    };
  }
  return update;
}

/**
 * 处理非致命错误的一般流程。
 * @param root root节点
 * @param returnFiber 发生错误的节点的父级
 * @param sourceFiber 发生错误的节点
 * @param value 捕获的错误信息
 * @param renderExpirationTime FiberRoot的nextExpirationTimeToWorkOn
 */
function throwException(
  root: FiberRoot,
  returnFiber: Fiber,
  sourceFiber: Fiber,
  value: mixed,
  renderExpirationTime: ExpirationTime,
) {
  // The source fiber did not complete.
  // 翻译：当前的Fiber未完成。
  sourceFiber.effectTag |= Incomplete;
  // Its effect list is no longer valid.
  // 翻译：其Effect列表不再有效。
  sourceFiber.firstEffect = sourceFiber.lastEffect = null;

  // Suspense相关代码。
  if (
    value !== null &&
    typeof value === 'object' &&
    typeof value.then === 'function'
  ) {
    // This is a thenable.
    const thenable: Thenable = (value: any);

    // Find the earliest timeout threshold of all the placeholders in the
    // ancestor path. We could avoid this traversal by storing the thresholds on
    // the stack, but we choose not to because we only hit this path if we're
    // IO-bound (i.e. if something suspends). Whereas the stack is used even in
    // the non-IO- bound case.
    let workInProgress = returnFiber;
    let earliestTimeoutMs = -1;
    let startTimeMs = -1;
    do {
      if (workInProgress.tag === SuspenseComponent) {
        const current = workInProgress.alternate;
        if (current !== null) {
          const currentState: SuspenseState | null = current.memoizedState;
          if (currentState !== null && currentState.didTimeout) {
            // Reached a boundary that already timed out. Do not search
            // any further.
            const timedOutAt = currentState.timedOutAt;
            startTimeMs = expirationTimeToMs(timedOutAt);
            // Do not search any further.
            break;
          }
        }
        let timeoutPropMs = workInProgress.pendingProps.maxDuration;
        if (typeof timeoutPropMs === 'number') {
          if (timeoutPropMs <= 0) {
            earliestTimeoutMs = 0;
          } else if (
            earliestTimeoutMs === -1 ||
            timeoutPropMs < earliestTimeoutMs
          ) {
            earliestTimeoutMs = timeoutPropMs;
          }
        }
      }
      workInProgress = workInProgress.return;
    } while (workInProgress !== null);

    // Schedule the nearest Suspense to re-render the timed out view.
    workInProgress = returnFiber;
    do {
      if (
        workInProgress.tag === SuspenseComponent &&
        shouldCaptureSuspense(workInProgress.alternate, workInProgress)
      ) {
        // Found the nearest boundary.

        // If the boundary is not in concurrent mode, we should not suspend, and
        // likewise, when the promise resolves, we should ping synchronously.
        const pingTime =
          (workInProgress.mode & ConcurrentMode) === NoEffect
            ? Sync
            : renderExpirationTime;

        // Attach a listener to the promise to "ping" the root and retry.
        let onResolveOrReject = retrySuspendedRoot.bind(
          null,
          root,
          workInProgress,
          sourceFiber,
          pingTime,
        );
        if (enableSchedulerTracing) {
          onResolveOrReject = Schedule_tracing_wrap(onResolveOrReject);
        }
        thenable.then(onResolveOrReject, onResolveOrReject);

        // If the boundary is outside of concurrent mode, we should *not*
        // suspend the commit. Pretend as if the suspended component rendered
        // null and keep rendering. In the commit phase, we'll schedule a
        // subsequent synchronous update to re-render the Suspense.
        //
        // Note: It doesn't matter whether the component that suspended was
        // inside a concurrent mode tree. If the Suspense is outside of it, we
        // should *not* suspend the commit.
        if ((workInProgress.mode & ConcurrentMode) === NoEffect) {
          workInProgress.effectTag |= CallbackEffect;

          // Unmount the source fiber's children
          const nextChildren = null;
          reconcileChildren(
            sourceFiber.alternate,
            sourceFiber,
            nextChildren,
            renderExpirationTime,
          );
          sourceFiber.effectTag &= ~Incomplete;

          if (sourceFiber.tag === ClassComponent) {
            // We're going to commit this fiber even though it didn't complete.
            // But we shouldn't call any lifecycle methods or callbacks. Remove
            // all lifecycle effect tags.
            sourceFiber.effectTag &= ~LifecycleEffectMask;
            const current = sourceFiber.alternate;
            if (current === null) {
              // This is a new mount. Change the tag so it's not mistaken for a
              // completed component. For example, we should not call
              // componentWillUnmount if it is deleted.
              sourceFiber.tag = IncompleteClassComponent;
            }
          }

          // Exit without suspending.
          return;
        }

        // Confirmed that the boundary is in a concurrent mode tree. Continue
        // with the normal suspend path.

        let absoluteTimeoutMs;
        if (earliestTimeoutMs === -1) {
          // If no explicit threshold is given, default to an abitrarily large
          // value. The actual size doesn't matter because the threshold for the
          // whole tree will be clamped to the expiration time.
          absoluteTimeoutMs = maxSigned31BitInt;
        } else {
          if (startTimeMs === -1) {
            // This suspend happened outside of any already timed-out
            // placeholders. We don't know exactly when the update was
            // scheduled, but we can infer an approximate start time from the
            // expiration time. First, find the earliest uncommitted expiration
            // time in the tree, including work that is suspended. Then subtract
            // the offset used to compute an async update's expiration time.
            // This will cause high priority (interactive) work to expire
            // earlier than necessary, but we can account for this by adjusting
            // for the Just Noticeable Difference.
            const earliestExpirationTime = findEarliestOutstandingPriorityLevel(
              root,
              renderExpirationTime,
            );
            const earliestExpirationTimeMs = expirationTimeToMs(
              earliestExpirationTime,
            );
            startTimeMs = earliestExpirationTimeMs - LOW_PRIORITY_EXPIRATION;
          }
          absoluteTimeoutMs = startTimeMs + earliestTimeoutMs;
        }

        // Mark the earliest timeout in the suspended fiber's ancestor path.
        // After completing the root, we'll take the largest of all the
        // suspended fiber's timeouts and use it to compute a timeout for the
        // whole tree.
        renderDidSuspend(root, absoluteTimeoutMs, renderExpirationTime);

        workInProgress.effectTag |= ShouldCapture;
        workInProgress.expirationTime = renderExpirationTime;
        return;
      }
      // This boundary already captured during this render. Continue to the next
      // boundary.
      workInProgress = workInProgress.return;
    } while (workInProgress !== null);
    // No boundary was found. Fallthrough to error mode.
    value = new Error(
      'An update was suspended, but no placeholder UI was provided.',
    );
  }

  // We didn't find a boundary that could handle this type of exception. Start
  // over and traverse parent path again, this time treating the exception
  // as an error.
  // 翻译：我们没有找到可以处理此类异常的边界。重新开始并再次遍历父路径，这次将异常视为错误。
  // 标记ReactFiberScheduler.js的nextRenderDidError为true。
  renderDidError();
  // 包装过的错误对象。结构是{value, source, stack}
  value = createCapturedValue(value, sourceFiber);
  let workInProgress = returnFiber;
  // 下面的循环会向上查找能够处理的这个错误的父节点（也就是有componentDidCatch方法），
  // 一直找找不到的话，最终会在根节点处理。
  do {
    switch (workInProgress.tag) {
      case HostRoot: {
        const errorInfo = value;
        workInProgress.effectTag |= ShouldCapture;
        workInProgress.expirationTime = renderExpirationTime;
        // 创建了一个tag为CaptureUpdate的Update对象。
        const update = createRootErrorUpdate(
          workInProgress,
          errorInfo,
          renderExpirationTime,
        );
        // 将Update对象加入队列。
        enqueueCapturedUpdate(workInProgress, update);
        return;
      }
      case ClassComponent:
        // Capture and retry
        // 翻译：捕获并重试。
        const errorInfo = value;
        // 类组件。
        const ctor = workInProgress.type;
        // DOM实例。
        const instance = workInProgress.stateNode;
        if (
          (workInProgress.effectTag & DidCapture) === NoEffect &&
          (typeof ctor.getDerivedStateFromError === 'function' ||
            (instance !== null &&
              typeof instance.componentDidCatch === 'function' &&
              !isAlreadyFailedLegacyErrorBoundary(instance)))
        ) {
          workInProgress.effectTag |= ShouldCapture;
          workInProgress.expirationTime = renderExpirationTime;
          // Schedule the error boundary to re-render using updated state
          // 翻译：安排错误边界以使用更新后的状态重新渲染。
          // 创建了一个tag为CaptureUpdate的Update对象，这里会安排componentDidCatch生命周期的回调。
          const update = createClassErrorUpdate(
            workInProgress,
            errorInfo,
            renderExpirationTime,
          );
          // 将Update对象加入队列。
          enqueueCapturedUpdate(workInProgress, update);
          return;
        }
        break;
      default:
        break;
    }
    workInProgress = workInProgress.return;
  } while (workInProgress !== null);
}

/**
 * 完成异常的节点的工作。
 * @param workInProgress 当前处理的Fiber节点的进行中副本
 * @param renderExpirationTime 当前处理的Fiber所在的FiberRoot的nextExpirationTimeToWorkOn
 * @return {Fiber|null}
 */
function unwindWork(
  workInProgress: Fiber,
  renderExpirationTime: ExpirationTime,
) {
  switch (workInProgress.tag) {
    case ClassComponent: {
      const Component = workInProgress.type;
      if (isLegacyContextProvider(Component)) {
        popLegacyContext(workInProgress);
      }
      const effectTag = workInProgress.effectTag;
      if (effectTag & ShouldCapture) {
        // 去掉ShouldCapture标记并添加DidCapture。
        workInProgress.effectTag = (effectTag & ~ShouldCapture) | DidCapture;
        // 有ShouldCapture标记才会返回本身。
        return workInProgress;
      }
      // 没有ShouldCapture标记会返回null。
      return null;
    }
    case HostRoot: {
      popHostContainer(workInProgress);
      popTopLevelLegacyContextObject(workInProgress);
      const effectTag = workInProgress.effectTag;
      invariant(
        (effectTag & DidCapture) === NoEffect,
        'The root failed to unmount after an error. This is likely a bug in ' +
          'React. Please file an issue.',
      );
      // 去掉ShouldCapture标记并添加DidCapture。
      workInProgress.effectTag = (effectTag & ~ShouldCapture) | DidCapture;
      // 只会返回本身。
      return workInProgress;
    }
    case HostComponent: {
      popHostContext(workInProgress);
      // 只会返回null。
      return null;
    }
    case SuspenseComponent: {
      const effectTag = workInProgress.effectTag;
      if (effectTag & ShouldCapture) {
        workInProgress.effectTag = (effectTag & ~ShouldCapture) | DidCapture;
        // Captured a suspense effect. Set the boundary's `alreadyCaptured`
        // state to true so we know to render the fallback.
        const current = workInProgress.alternate;
        const currentState: SuspenseState | null =
          current !== null ? current.memoizedState : null;
        let nextState: SuspenseState | null = workInProgress.memoizedState;
        if (nextState === null) {
          // No existing state. Create a new object.
          nextState = {
            alreadyCaptured: true,
            didTimeout: false,
            timedOutAt: NoWork,
          };
        } else if (currentState === nextState) {
          // There is an existing state but it's the same as the current tree's.
          // Clone the object.
          nextState = {
            alreadyCaptured: true,
            didTimeout: nextState.didTimeout,
            timedOutAt: nextState.timedOutAt,
          };
        } else {
          // Already have a clone, so it's safe to mutate.
          nextState.alreadyCaptured = true;
        }
        workInProgress.memoizedState = nextState;
        // Re-render the boundary.
        return workInProgress;
      }
      return null;
    }
    case HostPortal:
      popHostContainer(workInProgress);
      return null;
    case ContextProvider:
      popProvider(workInProgress);
      return null;
    default:
      return null;
  }
}

function unwindInterruptedWork(interruptedWork: Fiber) {
  switch (interruptedWork.tag) {
    case ClassComponent: {
      const childContextTypes = interruptedWork.type.childContextTypes;
      if (childContextTypes !== null && childContextTypes !== undefined) {
        popLegacyContext(interruptedWork);
      }
      break;
    }
    case HostRoot: {
      popHostContainer(interruptedWork);
      popTopLevelLegacyContextObject(interruptedWork);
      break;
    }
    case HostComponent: {
      popHostContext(interruptedWork);
      break;
    }
    case HostPortal:
      popHostContainer(interruptedWork);
      break;
    case ContextProvider:
      popProvider(interruptedWork);
      break;
    default:
      break;
  }
}

export {
  throwException,
  unwindWork,
  unwindInterruptedWork,
  createRootErrorUpdate,
  createClassErrorUpdate,
};
