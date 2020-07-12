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
  // throw出来的是一个Promise对象。
  if (
    value !== null &&
    typeof value === 'object' &&
    typeof value.then === 'function'
  ) {
    // This is a thenable.
    // 翻译：这是一个Thenable对象（就是Promise对象）。
    const thenable: Thenable = (value: any);

    // Find the earliest timeout threshold of all the placeholders in the
    // ancestor path. We could avoid this traversal by storing the thresholds on
    // the stack, but we choose not to because we only hit this path if we're
    // IO-bound (i.e. if something suspends). Whereas the stack is used even in
    // the non-IO- bound case.
    // 翻译：查找父级路径中所有占位符(就是SuspenseComponent)的最早超时阈值。
    //      我们可以通过将阈值存储在堆栈中来避免这种遍历，但是我们选择不这样做，
    //      因为只有在受到IO束缚（即某些东西挂起）的情况下，我们才使用此路径。
    //      而即使在非IO束缚的情况下也使用堆栈。
    let workInProgress = returnFiber;
    let earliestTimeoutMs = -1;
    let startTimeMs = -1;
    // 向上循环找到所有SuspenseComponent组件，记录下最小的延迟时间。
    // 更新startTimeMs和earliestTimeoutMs。
    do {
      if (workInProgress.tag === SuspenseComponent) {
        // 已有的Fiber节点。
        const current = workInProgress.alternate;
        if (current !== null) {
          // 非首次渲染的情况。如果已经有state并且过期，则跳出循环。
          const currentState: SuspenseState | null = current.memoizedState;
          if (currentState !== null && currentState.didTimeout) {
            // Reached a boundary that already timed out. Do not search
            // any further.
            // 翻译：到达了已超时的节点。不要进一步搜索。
            const timedOutAt = currentState.timedOutAt;
            startTimeMs = expirationTimeToMs(timedOutAt);
            // Do not search any further.
            // 翻译：不要进一步搜索。
            break;
          }
        }
        // 设置超时时间的props。
        let timeoutPropMs = workInProgress.pendingProps.maxDuration;
        // 将earliestTimeoutMs置为最小值，也就是每一次循环都会获取到最小的那个值。
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
      // 下一个，向上遍历。
      workInProgress = workInProgress.return;
    } while (workInProgress !== null);

    // Schedule the nearest Suspense to re-render the timed out view.
    // 翻译：安排最近的Suspense以重新渲染超时的视图。
    // 重置了循环起点。
    workInProgress = returnFiber;
    do {
      if (
        workInProgress.tag === SuspenseComponent &&
        // 还未就绪，有fallback的情况会为true。
        shouldCaptureSuspense(workInProgress.alternate, workInProgress)
      ) {
        // Found the nearest boundary.
        // 翻译：找到最近的节点。

        // If the boundary is not in concurrent mode, we should not suspend, and
        // likewise, when the promise resolves, we should ping synchronously.
        // 翻译：如果节点不是在Concurrent模式下，则我们不应暂停，同样，当promise解决时，
        //      我们应该同步地ping。
        const pingTime =
          (workInProgress.mode & ConcurrentMode) === NoEffect
            ? Sync
            : renderExpirationTime;

        // Attach a listener to the promise to "ping" the root and retry.
        // 翻译：将监听器附加到对根“ping”的promise并重试。
        // 这个函数就是promise对象resolve之后的回调。
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
        // 给promise写入回调，resolve和reject的回调相同。
        thenable.then(onResolveOrReject, onResolveOrReject);

        // If the boundary is outside of concurrent mode, we should *not*
        // suspend the commit. Pretend as if the suspended component rendered
        // null and keep rendering. In the commit phase, we'll schedule a
        // subsequent synchronous update to re-render the Suspense.
        // 翻译：如果节点在concurrent模式之外，则不应挂起提交。
        //      假装挂起的组件渲染为null并继续渲染。
        //
        // Note: It doesn't matter whether the component that suspended was
        // inside a concurrent mode tree. If the Suspense is outside of it, we
        // should *not* suspend the commit.
        if ((workInProgress.mode & ConcurrentMode) === NoEffect) {
          // 非Concurrent模式的情况，即同步模式。
          // 一般情况都是走这里，因为Concurrent模式需要在创建根的时候就开启。
          // CallbackEffect只是Callback在这个文件里的别名。
          workInProgress.effectTag |= CallbackEffect;

          // Unmount the source fiber's children
          // 翻译：卸下源Fiber的子节点
          const nextChildren = null;
          // 将抛出promise的组件的子节点渲染为null。
          reconcileChildren(
            sourceFiber.alternate,
            sourceFiber,
            nextChildren,
            renderExpirationTime,
          );
          // 添加未完成标签。
          sourceFiber.effectTag &= ~Incomplete;
          // ClassComponent需要添加其他一些特殊标签。
          if (sourceFiber.tag === ClassComponent) {
            // We're going to commit this fiber even though it didn't complete.
            // But we shouldn't call any lifecycle methods or callbacks. Remove
            // all lifecycle effect tags.
            // 翻译：即使Fiber节点没有完成，我们也将提交它。
            //      但是我们不应该调用任何生命周期方法或回调。删除所有生命周期效果标签。
            // 把生命周期相关的Effect全部去掉。
            sourceFiber.effectTag &= ~LifecycleEffectMask;
            const current = sourceFiber.alternate;
            if (current === null) {
              // This is a new mount. Change the tag so it's not mistaken for a
              // completed component. For example, we should not call
              // componentWillUnmount if it is deleted.
              // 翻译：这是一个新的挂载。更改标签，以免将其误认为已完成的组件。
              //      例如，如果删除了componentWillUnmount，则不应调用它。
              sourceFiber.tag = IncompleteClassComponent;
            }
          }

          // Exit without suspending.
          // 翻译：退出而不挂起。
          return;
        }
        // 下面是Concurrent模式的情况，即异步模式。

        // Confirmed that the boundary is in a concurrent mode tree. Continue
        // with the normal suspend path.
        // 翻译：确认节点在Concurrent模式树中。继续使用正常的挂起路径。

        let absoluteTimeoutMs;
        if (earliestTimeoutMs === -1) {
          // If no explicit threshold is given, default to an abitrarily large
          // value. The actual size doesn't matter because the threshold for the
          // whole tree will be clamped to the expiration time.
          // 翻译：如果未给出明确的阈值，则默认为任意大的值。
          //      实际大小无关紧要，因为整棵树的阈值将被限制为到期时间。
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
            // 翻译：他的挂起发生在任何已经超时的占位符之外。
            //      我们不确定确切的更新时间，但是我们可以从到期时间推断出大概的开始时间。
            //      首先，在树中找到最早的未提交任务的到期时间，包括已挂起的任务。
            //      然后减去用于计算异步更新的到期时间的偏移量。
            //      这将导致高优先级（交互式）工作提前到期，但是我们可以通过调整“明显差异”来解决这一问题。
            // 找到pendingTime和suspendTime里最小的非NoWork的值。
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
        // 翻译：在挂起的Fiber节点父级路径中标记最早的超时时间。
        //      完成根操作后，我们将使用所有挂起的Fiber节点中最大的超时时间，
        //      并将其用于计算整棵树的超时时间。
        // 用于修改ReactFiberScheduler文件里的nextLatestAbsoluteTimeoutMs。
        // nextLatestAbsoluteTimeoutMs会保留较大的值。
        renderDidSuspend(root, absoluteTimeoutMs, renderExpirationTime);

        // 注意这里跟非Concurrent模式不同。
        workInProgress.effectTag |= ShouldCapture;
        // 这里更改了路径上节点的优先级。
        workInProgress.expirationTime = renderExpirationTime;
        return;
      }
      // This boundary already captured during this render. Continue to the next
      // boundary.
      // 翻译：在此渲染期间已经捕获了该节点。继续到下一个节点。
      workInProgress = workInProgress.return;
    } while (workInProgress !== null);
    // No boundary was found. Fallthrough to error mode.
    // 翻译：找不到进行中节点。进入错误模式。
    value = new Error(
      'An update was suspended, but no placeholder UI was provided.',
    );
  }

  // We didn't find a boundary that could handle this type of exception. Start
  // over and traverse parent path again, this time treating the exception
  // as an error.
  // 翻译：我们没有找到可以处理此类异常的节点。重新开始并再次遍历父路径，这次将异常视为错误。
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
        // 这个更改会反映在unwindWork里。
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
      // 非Concurrent模式其实不会做任何处理。
      const effectTag = workInProgress.effectTag;
      if (effectTag & ShouldCapture) {
        // Concurrent模式才会走这里。
        // 移除ShouldCapture，写入DidCapture。
        workInProgress.effectTag = (effectTag & ~ShouldCapture) | DidCapture;
        // Captured a suspense effect. Set the boundary's `alreadyCaptured`
        // state to true so we know to render the fallback.
        // 翻译：捕获Suspense组件的Effect。设置该节点的'alreadyCaptured'状态为true，
        //      这样我们就可以渲染fallback节点。
        const current = workInProgress.alternate;
        const currentState: SuspenseState | null =
          current !== null ? current.memoizedState : null;
        let nextState: SuspenseState | null = workInProgress.memoizedState;
        if (nextState === null) {
          // No existing state. Create a new object.
          // 翻译：没有现有状态。创建一个新对象。
          nextState = {
            alreadyCaptured: true,
            didTimeout: false,
            timedOutAt: NoWork,
          };
        } else if (currentState === nextState) {
          // There is an existing state but it's the same as the current tree's.
          // Clone the object.
          // 翻译：存在状态，但与当前树相同。克隆对象。
          nextState = {
            alreadyCaptured: true,
            didTimeout: nextState.didTimeout,
            timedOutAt: nextState.timedOutAt,
          };
        } else {
          // Already have a clone, so it's safe to mutate.
          // 翻译：已经有了克隆，因此可以安全地进行改变。
          nextState.alreadyCaptured = true;
        }
        workInProgress.memoizedState = nextState;
        // Re-render the boundary.
        // 重新渲染该节点。
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
