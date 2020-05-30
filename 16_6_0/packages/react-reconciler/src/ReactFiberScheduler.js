/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {Fiber} from './ReactFiber';
import type {Batch, FiberRoot} from './ReactFiberRoot';
import type {ExpirationTime} from './ReactFiberExpirationTime';
import type {Interaction} from 'scheduler/src/Tracing';

import {__interactionsRef, __subscriberRef} from 'scheduler/tracing';
import {
  invokeGuardedCallback,
  hasCaughtError,
  clearCaughtError,
} from 'shared/ReactErrorUtils';
import ReactSharedInternals from 'shared/ReactSharedInternals';
import ReactStrictModeWarnings from './ReactStrictModeWarnings';
import {
  NoEffect,
  PerformedWork,
  Placement,
  Update,
  Snapshot,
  PlacementAndUpdate,
  Deletion,
  ContentReset,
  Callback,
  DidCapture,
  Ref,
  Incomplete,
  HostEffectMask,
} from 'shared/ReactSideEffectTags';
import {
  HostRoot,
  ClassComponent,
  HostComponent,
  ContextProvider,
  HostPortal,
} from 'shared/ReactWorkTags';
import {
  enableSchedulerTracing,
  enableProfilerTimer,
  enableUserTimingAPI,
  replayFailedUnitOfWorkWithInvokeGuardedCallback,
  warnAboutDeprecatedLifecycles,
} from 'shared/ReactFeatureFlags';
import getComponentName from 'shared/getComponentName';
import invariant from 'shared/invariant';
import warningWithoutStack from 'shared/warningWithoutStack';

import {
  scheduleTimeout,
  cancelTimeout,
  noTimeout,
} from './ReactFiberHostConfig';

import ReactFiberInstrumentation from './ReactFiberInstrumentation';
import * as ReactCurrentFiber from './ReactCurrentFiber';
// 这些导入来自forks/ReactFiberHostConfig.dom.js
import {
  now,
  scheduleDeferredCallback,
  cancelDeferredCallback,
  prepareForCommit,
  resetAfterCommit,
} from './ReactFiberHostConfig';
import {
  markPendingPriorityLevel,
  markCommittedPriorityLevels,
  markSuspendedPriorityLevel,
  markPingedPriorityLevel,
  hasLowerPriorityWork,
  isPriorityLevelSuspended,
  findEarliestOutstandingPriorityLevel,
  didExpireAtExpirationTime,
} from './ReactFiberPendingPriority';
import {
  recordEffect,
  recordScheduleUpdate,
  startRequestCallbackTimer,
  stopRequestCallbackTimer,
  startWorkTimer,
  stopWorkTimer,
  stopFailedWorkTimer,
  startWorkLoopTimer,
  stopWorkLoopTimer,
  startCommitTimer,
  stopCommitTimer,
  startCommitSnapshotEffectsTimer,
  stopCommitSnapshotEffectsTimer,
  startCommitHostEffectsTimer,
  stopCommitHostEffectsTimer,
  startCommitLifeCyclesTimer,
  stopCommitLifeCyclesTimer,
} from './ReactDebugFiberPerf';
import {createWorkInProgress, assignFiberPropertiesInDEV} from './ReactFiber';
import {onCommitRoot} from './ReactFiberDevToolsHook';
import {
  NoWork,
  Sync,
  Never,
  msToExpirationTime,
  expirationTimeToMs,
  computeAsyncExpiration,
  computeInteractiveExpiration,
} from './ReactFiberExpirationTime';
import {ConcurrentMode, ProfileMode, NoContext} from './ReactTypeOfMode';
import {
  enqueueUpdate,
  resetCurrentlyProcessingQueue,
  ForceUpdate,
  createUpdate,
} from './ReactUpdateQueue';
import {createCapturedValue} from './ReactCapturedValue';
import {
  isContextProvider as isLegacyContextProvider,
  popTopLevelContextObject as popTopLevelLegacyContextObject,
  popContext as popLegacyContext,
} from './ReactFiberContext';
import {popProvider, resetContextDependences} from './ReactFiberNewContext';
import {popHostContext, popHostContainer} from './ReactFiberHostContext';
import {
  recordCommitTime,
  startProfilerTimer,
  stopProfilerTimerIfRunningAndRecordDelta,
} from './ReactProfilerTimer';
import {
  checkThatStackIsEmpty,
  resetStackAfterFatalErrorInDev,
} from './ReactFiberStack';
import {beginWork} from './ReactFiberBeginWork';
import {completeWork} from './ReactFiberCompleteWork';
import {
  throwException,
  unwindWork,
  unwindInterruptedWork,
  createRootErrorUpdate,
  createClassErrorUpdate,
} from './ReactFiberUnwindWork';
import {
  commitBeforeMutationLifeCycles,
  commitResetTextContent,
  commitPlacement,
  commitDeletion,
  commitWork,
  commitLifeCycles,
  commitAttachRef,
  commitDetachRef,
} from './ReactFiberCommitWork';
import {Dispatcher} from './ReactFiberDispatcher';

export type Deadline = {
  timeRemaining(): number,
  didTimeout: boolean,
};

export type Thenable = {
  then(resolve: () => mixed, reject?: () => mixed): mixed,
};

const {ReactCurrentOwner} = ReactSharedInternals;

let didWarnAboutStateTransition;
let didWarnSetStateChildContext;
let warnAboutUpdateOnUnmounted;
let warnAboutInvalidUpdates;

if (enableSchedulerTracing) {
  // Provide explicit error message when production+profiling bundle of e.g. react-dom
  // is used with production (non-profiling) bundle of schedule/tracing
  invariant(
    __interactionsRef != null && __interactionsRef.current != null,
    'It is not supported to run the profiling version of a renderer (for example, `react-dom/profiling`) ' +
      'without also replacing the `schedule/tracing` module with `schedule/tracing-profiling`. ' +
      'Your bundler might have a setting for aliasing both modules. ' +
      'Learn more at http://fb.me/react-profiling',
  );
}

if (__DEV__) {
  didWarnAboutStateTransition = false;
  didWarnSetStateChildContext = false;
  const didWarnStateUpdateForUnmountedComponent = {};

  warnAboutUpdateOnUnmounted = function(fiber: Fiber) {
    // We show the whole stack but dedupe on the top component's name because
    // the problematic code almost always lies inside that component.
    const componentName = getComponentName(fiber.type) || 'ReactClass';
    if (didWarnStateUpdateForUnmountedComponent[componentName]) {
      return;
    }
    warningWithoutStack(
      false,
      "Can't call setState (or forceUpdate) on an unmounted component. This " +
        'is a no-op, but it indicates a memory leak in your application. To ' +
        'fix, cancel all subscriptions and asynchronous tasks in the ' +
        'componentWillUnmount method.%s',
      ReactCurrentFiber.getStackByFiberInDevAndProd(fiber),
    );
    didWarnStateUpdateForUnmountedComponent[componentName] = true;
  };

  warnAboutInvalidUpdates = function(instance: React$Component<any>) {
    switch (ReactCurrentFiber.phase) {
      case 'getChildContext':
        if (didWarnSetStateChildContext) {
          return;
        }
        warningWithoutStack(
          false,
          'setState(...): Cannot call setState() inside getChildContext()',
        );
        didWarnSetStateChildContext = true;
        break;
      case 'render':
        if (didWarnAboutStateTransition) {
          return;
        }
        warningWithoutStack(
          false,
          'Cannot update during an existing state transition (such as within ' +
            '`render`). Render methods should be a pure function of props and state.',
        );
        didWarnAboutStateTransition = true;
        break;
    }
  };
}

// Used to ensure computeUniqueAsyncExpiration is monotonically increasing.
let lastUniqueAsyncExpiration: number = 0;

// Represents the expiration time that incoming updates should use. (If this
// is NoWork, use the default strategy: async updates in async mode, sync
// updates in sync mode.)
// 翻译：表示传入更新应使用的到期时间。(如果这是NoWork，请使用默认策略：
//      在异步模式下进行异步更新，在同步模式下进行同步更新。)
let expirationContext: ExpirationTime = NoWork;

let isWorking: boolean = false;

// The next work in progress fiber that we're currently working on.
let nextUnitOfWork: Fiber | null = null;
let nextRoot: FiberRoot | null = null;
// The time at which we're currently rendering work.
let nextRenderExpirationTime: ExpirationTime = NoWork;
let nextLatestAbsoluteTimeoutMs: number = -1;
let nextRenderDidError: boolean = false;

// The next fiber with an effect that we're currently committing.
let nextEffect: Fiber | null = null;

let isCommitting: boolean = false;

let legacyErrorBoundariesThatAlreadyFailed: Set<mixed> | null = null;

// Used for performance tracking.
let interruptedBy: Fiber | null = null;

let stashedWorkInProgressProperties;
let replayUnitOfWork;
let isReplayingFailedUnitOfWork;
let originalReplayError;
let rethrowOriginalError;
if (__DEV__ && replayFailedUnitOfWorkWithInvokeGuardedCallback) {
  stashedWorkInProgressProperties = null;
  isReplayingFailedUnitOfWork = false;
  originalReplayError = null;
  replayUnitOfWork = (
    failedUnitOfWork: Fiber,
    thrownValue: mixed,
    isYieldy: boolean,
  ) => {
    if (
      thrownValue !== null &&
      typeof thrownValue === 'object' &&
      typeof thrownValue.then === 'function'
    ) {
      // Don't replay promises. Treat everything else like an error.
      // TODO: Need to figure out a different strategy if/when we add
      // support for catching other types.
      return;
    }

    // Restore the original state of the work-in-progress
    if (stashedWorkInProgressProperties === null) {
      // This should never happen. Don't throw because this code is DEV-only.
      warningWithoutStack(
        false,
        'Could not replay rendering after an error. This is likely a bug in React. ' +
          'Please file an issue.',
      );
      return;
    }
    assignFiberPropertiesInDEV(
      failedUnitOfWork,
      stashedWorkInProgressProperties,
    );

    switch (failedUnitOfWork.tag) {
      case HostRoot:
        popHostContainer(failedUnitOfWork);
        popTopLevelLegacyContextObject(failedUnitOfWork);
        break;
      case HostComponent:
        popHostContext(failedUnitOfWork);
        break;
      case ClassComponent: {
        const Component = failedUnitOfWork.type;
        if (isLegacyContextProvider(Component)) {
          popLegacyContext(failedUnitOfWork);
        }
        break;
      }
      case HostPortal:
        popHostContainer(failedUnitOfWork);
        break;
      case ContextProvider:
        popProvider(failedUnitOfWork);
        break;
    }
    // Replay the begin phase.
    isReplayingFailedUnitOfWork = true;
    originalReplayError = thrownValue;
    invokeGuardedCallback(null, workLoop, null, isYieldy);
    isReplayingFailedUnitOfWork = false;
    originalReplayError = null;
    if (hasCaughtError()) {
      const replayError = clearCaughtError();
      if (replayError != null && thrownValue != null) {
        try {
          // Reading the expando property is intentionally
          // inside `try` because it might be a getter or Proxy.
          if (replayError._suppressLogging) {
            // Also suppress logging for the original error.
            (thrownValue: any)._suppressLogging = true;
          }
        } catch (inner) {
          // Ignore.
        }
      }
    } else {
      // If the begin phase did not fail the second time, set this pointer
      // back to the original value.
      nextUnitOfWork = failedUnitOfWork;
    }
  };
  rethrowOriginalError = () => {
    throw originalReplayError;
  };
}

/**
 * 中断当前挂起的任务(重置堆栈)
 * nextUnitOfWork记录的是下一个要执行的节点。
 */
function resetStack() {
  if (nextUnitOfWork !== null) {
    // 这种情况就是有被挂起的任务，需要先找到其rootFiber节点，因为有更新一半的情况，
    // 有状态错乱的可能，所以先执行状态回滚。
    let interruptedWork = nextUnitOfWork.return;
    while (interruptedWork !== null) {
      // 向上遍历，退回更新前状态。
      unwindInterruptedWork(interruptedWork);
      interruptedWork = interruptedWork.return;
    }
  }

  if (__DEV__) {
    ReactStrictModeWarnings.discardPendingWarnings();
    checkThatStackIsEmpty();
  }

  // 重置Stack为初始值。
  nextRoot = null;
  nextRenderExpirationTime = NoWork;
  nextLatestAbsoluteTimeoutMs = -1;
  nextRenderDidError = false;
  nextUnitOfWork = null;
}

/**
 * 执行Effect提交，进行DOM操作。
 */
function commitAllHostEffects() {
  while (nextEffect !== null) {
    if (__DEV__) {
      ReactCurrentFiber.setCurrentFiber(nextEffect);
    }
    recordEffect();

    const effectTag = nextEffect.effectTag;

    // 重置文本节点。
    if (effectTag & ContentReset) {
      commitResetTextContent(nextEffect);
    }

    // 处理ref。
    if (effectTag & Ref) {
      const current = nextEffect.alternate;
      if (current !== null) {
        commitDetachRef(current);
      }
    }

    // The following switch statement is only concerned about placement,
    // updates, and deletions. To avoid needing to add a case for every
    // possible bitmap value, we remove the secondary effects from the
    // effect tag and switch on that value.
    // 翻译：以下switch语句仅关注放置，更新和删除。为了避免需要为每个可能的值添加处理，
    //      我们从效果标签中删除了次要EffectTag，然后打开该值。
    let primaryEffectTag = effectTag & (Placement | Update | Deletion);
    // 执行插入、更新、删除操作。
    switch (primaryEffectTag) {
      case Placement: {
        commitPlacement(nextEffect);
        // Clear the "placement" from effect tag so that we know that this is inserted, before
        // any life-cycles like componentDidMount gets called.
        // 翻译：从effect标签中清除“placement”，以便我们在调用如componentDidMount之类的任何生命周期之前已将其插入。
        // TODO: findDOMNode doesn't rely on this any more but isMounted
        // does and isMounted is deprecated anyway so we should be able
        // to kill this.
        nextEffect.effectTag &= ~Placement;
        break;
      }
      case PlacementAndUpdate: {
        // Placement
        // 翻译：插入。
        commitPlacement(nextEffect);
        // Clear the "placement" from effect tag so that we know that this is inserted, before
        // any life-cycles like componentDidMount gets called.
        // 翻译：从effect标签中清除“placement”，以便我们在调用如componentDidMount之类的任何生命周期之前已将其插入。
        nextEffect.effectTag &= ~Placement;

        // Update
        // 翻译：更新。
        const current = nextEffect.alternate;
        commitWork(current, nextEffect);
        break;
      }
      case Update: {
        const current = nextEffect.alternate;
        commitWork(current, nextEffect);
        break;
      }
      case Deletion: {
        commitDeletion(nextEffect);
        break;
      }
    }
    nextEffect = nextEffect.nextEffect;
  }

  if (__DEV__) {
    ReactCurrentFiber.resetCurrentFiber();
  }
}

/**
 * 这个函数覆盖了从ReactFiberCommitWork.js引入的同名方法。
 */
function commitBeforeMutationLifecycles() {
  // 沿着Effect链遍历。
  while (nextEffect !== null) {
    if (__DEV__) {
      ReactCurrentFiber.setCurrentFiber(nextEffect);
    }

    const effectTag = nextEffect.effectTag;
    if (effectTag & Snapshot) {
      // 提交数的计数器。
      recordEffect();
      // 这里是旧的状态，也就是更新前的节点。
      const current = nextEffect.alternate;
      // 在DOM变化之前调用生命周期。
      commitBeforeMutationLifeCycles(current, nextEffect);
    }

    // Don't cleanup effects yet;
    // This will be done by commitAllLifeCycles()
    // 翻译：不要清理效果；这将由commitAllLifeCycles()完成
    nextEffect = nextEffect.nextEffect;
  }

  if (__DEV__) {
    ReactCurrentFiber.resetCurrentFiber();
  }
}

/**
 * 执行DOM提交后的生命周期方法
 * @param finishedRoot 根Fiber节点
 * @param committedExpirationTime root上的pendingCommitExpirationTime
 */
function commitAllLifeCycles(
  finishedRoot: FiberRoot,
  committedExpirationTime: ExpirationTime,
) {
  if (__DEV__) {
    ReactStrictModeWarnings.flushPendingUnsafeLifecycleWarnings();
    ReactStrictModeWarnings.flushLegacyContextWarning();

    if (warnAboutDeprecatedLifecycles) {
      ReactStrictModeWarnings.flushPendingDeprecationWarnings();
    }
  }
  while (nextEffect !== null) {
    const effectTag = nextEffect.effectTag;

    if (effectTag & (Update | Callback)) {
      // 调试用计数器。
      recordEffect();
      const current = nextEffect.alternate;
      //
      commitLifeCycles(
        finishedRoot,
        current,
        nextEffect,
        committedExpirationTime,
      );
    }

    if (effectTag & Ref) {
      recordEffect();
      commitAttachRef(nextEffect);
    }

    const next = nextEffect.nextEffect;
    // Ensure that we clean these up so that we don't accidentally keep them.
    // I'm not actually sure this matters because we can't reset firstEffect
    // and lastEffect since they're on every node, not just the effectful
    // ones. So we have to clean everything as we reuse nodes anyway.
    nextEffect.nextEffect = null;
    // Ensure that we reset the effectTag here so that we can rely on effect
    // tags to reason about the current life-cycle.
    nextEffect = next;
  }
}

function isAlreadyFailedLegacyErrorBoundary(instance: mixed): boolean {
  return (
    legacyErrorBoundariesThatAlreadyFailed !== null &&
    legacyErrorBoundariesThatAlreadyFailed.has(instance)
  );
}

function markLegacyErrorBoundaryAsFailed(instance: mixed) {
  if (legacyErrorBoundariesThatAlreadyFailed === null) {
    legacyErrorBoundariesThatAlreadyFailed = new Set([instance]);
  } else {
    legacyErrorBoundariesThatAlreadyFailed.add(instance);
  }
}

/**
 * 提交更新。
 * @param root FiberRoot对象
 * @param finishedWork Fiber节点，一般是root.current.alternate
 */
function commitRoot(root: FiberRoot, finishedWork: Fiber): void {
  // 设置全局标记。
  isWorking = true;
  isCommitting = true;
  startCommitTimer();

  invariant(
    root.current !== finishedWork,
    'Cannot commit the same tree as before. This is probably a bug ' +
      'related to the return field. This error is likely caused by a bug ' +
      'in React. Please file an issue.',
  );
  // 取出pendingCommitExpirationTime。
  const committedExpirationTime = root.pendingCommitExpirationTime;
  invariant(
    committedExpirationTime !== NoWork,
    'Cannot commit an incomplete root. This error is likely caused by a ' +
      'bug in React. Please file an issue.',
  );
  // 移除root上的pendingCommitExpirationTime。
  root.pendingCommitExpirationTime = NoWork;

  // Update the pending priority levels to account for the work that we are
  // about to commit. This needs to happen before calling the lifecycles, since
  // they may schedule additional updates.
  // 翻译：更新挂起的优先级，以记录我们将要提交的工作。这需要在调用生命周期之前发生，因为他们可能会安排其他更新。
  const updateExpirationTimeBeforeCommit = finishedWork.expirationTime;
  const childExpirationTimeBeforeCommit = finishedWork.childExpirationTime;
  // 获得最小的那个过期时间（即最高优先级）。
  const earliestRemainingTimeBeforeCommit =
    updateExpirationTimeBeforeCommit === NoWork ||
    (childExpirationTimeBeforeCommit !== NoWork &&
      childExpirationTimeBeforeCommit < updateExpirationTimeBeforeCommit)
      ? childExpirationTimeBeforeCommit
      : updateExpirationTimeBeforeCommit;
  // 标记优先级，会重置或更新很多root上关于时间的标记。
  markCommittedPriorityLevels(root, earliestRemainingTimeBeforeCommit);

  let prevInteractions: Set<Interaction> = (null: any);
  if (enableSchedulerTracing) {
    // Restore any pending interactions at this point,
    // So that cascading work triggered during the render phase will be accounted for.
    // 翻译：此时，请还原所有未决的交互，以便考虑渲染阶段触发的级联工作。
    prevInteractions = __interactionsRef.current;
    __interactionsRef.current = root.memoizedInteractions;
  }

  // Reset this to null before calling lifecycles
  // 翻译：在调用生命周期之前将此值重置为null。
  ReactCurrentOwner.current = null;

  let firstEffect;
  // PerformedWork本身无意义，这里的判断只是说明该节点有Effect需要处理。
  if (finishedWork.effectTag > PerformedWork) {
    // A fiber's effect list consists only of its children, not itself. So if
    // the root has an effect, we need to add it to the end of the list. The
    // resulting list is the set that would belong to the root's parent, if
    // it had one; that is, all the effects in the tree including the root.
    // 翻译：一个Fiber对象的Effect链仅由其子节点组成，而不包含其本身。
    //      因此，如果一个root节点由Effect链，我们需要将它加入到列表末尾。
    //      结果列表是属于root节点的父级（如果有），也就是说，树中的所有Effect（包括根）。
    // 将当前节点上的Effect链增加到root的Effect链上。
    if (finishedWork.lastEffect !== null) {
      finishedWork.lastEffect.nextEffect = finishedWork;
      firstEffect = finishedWork.firstEffect;
    } else {
      firstEffect = finishedWork;
    }
  } else {
    // There is no effect on the root.
    // 翻译：在root上没有Effect需要处理。
    firstEffect = finishedWork.firstEffect;
  }

  prepareForCommit(root.containerInfo);

  // Invoke instances of getSnapshotBeforeUpdate before mutation.
  // 翻译：渲染输出前调用实例上的getSnapshotBeforeUpdate生命周期方法。
  nextEffect = firstEffect;
  startCommitSnapshotEffectsTimer();
  // 第一次遍历。
  // 这里的循环是为了让过程不会被错误中断。
  while (nextEffect !== null) {
    let didError = false;
    let error;
    if (__DEV__) {
      // 使用防护回调方法进行调用，收集错误。
      invokeGuardedCallback(null, commitBeforeMutationLifecycles, null);
      if (hasCaughtError()) {
        didError = true;
        error = clearCaughtError();
      }
    } else {
      try {
        // 调用生命周期方法。
        commitBeforeMutationLifecycles();
      } catch (e) {
        didError = true;
        error = e;
      }
    }
    if (didError) {
      invariant(
        nextEffect !== null,
        'Should have next effect. This error is likely caused by a bug ' +
          'in React. Please file an issue.',
      );
      captureCommitPhaseError(nextEffect, error);
      // Clean-up
      if (nextEffect !== null) {
        nextEffect = nextEffect.nextEffect;
      }
    }
  }
  stopCommitSnapshotEffectsTimer();

  if (enableProfilerTimer) {
    // Mark the current commit time to be shared by all Profilers in this batch.
    // This enables them to be grouped later.
    recordCommitTime();
  }

  // Commit all the side-effects within a tree. We'll do this in two passes.
  // The first pass performs all the host insertions, updates, deletions and
  // ref unmounts.
  // 翻译：提交所有该树上的副作用。我们将分两次处理。第一遍执行所有主机插入，更新，删除和引用卸载。
  nextEffect = firstEffect;
  startCommitHostEffectsTimer();
  // 第二次遍历。
  // 这里的循环是为了让过程不会被错误中断。
  while (nextEffect !== null) {
    let didError = false;
    let error;
    if (__DEV__) {
      // 使用防护回调方法进行调用，收集错误。
      invokeGuardedCallback(null, commitAllHostEffects, null);
      if (hasCaughtError()) {
        didError = true;
        error = clearCaughtError();
      }
    } else {
      try {
        // 操作DOM节点。
        commitAllHostEffects();
      } catch (e) {
        didError = true;
        error = e;
      }
    }
    if (didError) {
      invariant(
        nextEffect !== null,
        'Should have next effect. This error is likely caused by a bug ' +
          'in React. Please file an issue.',
      );
      captureCommitPhaseError(nextEffect, error);
      // Clean-up
      if (nextEffect !== null) {
        nextEffect = nextEffect.nextEffect;
      }
    }
  }
  stopCommitHostEffectsTimer();

  resetAfterCommit(root.containerInfo);

  // The work-in-progress tree is now the current tree. This must come after
  // the first pass of the commit phase, so that the previous tree is still
  // current during componentWillUnmount, but before the second pass, so that
  // the finished work is current during componentDidMount/Update.
  // 翻译：work-in-progress树现在已经变成current树。这必须在提交阶段的第一遍之后进行，
  //      以使上一棵树在componentWillUnmount期间仍是current树，但在第二遍之前，
  //      因此已完成的工作在componentDidMount / Update期间是current树。
  root.current = finishedWork;

  // In the second pass we'll perform all life-cycles and ref callbacks.
  // Life-cycles happen as a separate pass so that all placements, updates,
  // and deletions in the entire tree have already been invoked.
  // This pass also triggers any renderer-specific initial effects.
  // 翻译：在第二遍中，我们将执行所有生命周期和ref回调。
  //      生命周期作为分离的过程执行，因此整个树中的所有插入，更新和删除操作均已被调用。
  //      此遍还触发所有特定于渲染器的初始效果。
  nextEffect = firstEffect;
  startCommitLifeCyclesTimer();
  // 第三次遍历。
  while (nextEffect !== null) {
    let didError = false;
    let error;
    if (__DEV__) {
      // 使用防护回调方法进行调用，收集错误。
      invokeGuardedCallback(
        null,
        commitAllLifeCycles,
        null,
        root,
        committedExpirationTime,
      );
      if (hasCaughtError()) {
        didError = true;
        error = clearCaughtError();
      }
    } else {
      try {
        // 调用生命周期方法。
        commitAllLifeCycles(root, committedExpirationTime);
      } catch (e) {
        didError = true;
        error = e;
      }
    }
    if (didError) {
      invariant(
        nextEffect !== null,
        'Should have next effect. This error is likely caused by a bug ' +
          'in React. Please file an issue.',
      );
      captureCommitPhaseError(nextEffect, error);
      if (nextEffect !== null) {
        nextEffect = nextEffect.nextEffect;
      }
    }
  }

  // commit阶段完成。
  isCommitting = false;
  isWorking = false;
  stopCommitLifeCyclesTimer();
  stopCommitTimer();
  onCommitRoot(finishedWork.stateNode);
  if (__DEV__ && ReactFiberInstrumentation.debugTool) {
    ReactFiberInstrumentation.debugTool.onCommitWork(finishedWork);
  }

  const updateExpirationTimeAfterCommit = finishedWork.expirationTime;
  const childExpirationTimeAfterCommit = finishedWork.childExpirationTime;
  const earliestRemainingTimeAfterCommit =
    updateExpirationTimeAfterCommit === NoWork ||
    (childExpirationTimeAfterCommit !== NoWork &&
      childExpirationTimeAfterCommit < updateExpirationTimeAfterCommit)
      ? childExpirationTimeAfterCommit
      : updateExpirationTimeAfterCommit;
  if (earliestRemainingTimeAfterCommit === NoWork) {
    // If there's no remaining work, we can clear the set of already failed
    // error boundaries.
    // 翻译：如果没有剩余的工作，我们可以清除已经失败的错误边界集。
    legacyErrorBoundariesThatAlreadyFailed = null;
  }
  onCommit(root, earliestRemainingTimeAfterCommit);

  if (enableSchedulerTracing) {
    __interactionsRef.current = prevInteractions;

    let subscriber;

    try {
      subscriber = __subscriberRef.current;
      if (subscriber !== null && root.memoizedInteractions.size > 0) {
        const threadID = computeThreadID(
          committedExpirationTime,
          root.interactionThreadID,
        );
        subscriber.onWorkStopped(root.memoizedInteractions, threadID);
      }
    } catch (error) {
      // It's not safe for commitRoot() to throw.
      // Store the error for now and we'll re-throw in finishRendering().
      if (!hasUnhandledError) {
        hasUnhandledError = true;
        unhandledError = error;
      }
    } finally {
      // Clear completed interactions from the pending Map.
      // Unless the render was suspended or cascading work was scheduled,
      // In which case– leave pending interactions until the subsequent render.
      const pendingInteractionMap = root.pendingInteractionMap;
      pendingInteractionMap.forEach(
        (scheduledInteractions, scheduledExpirationTime) => {
          // Only decrement the pending interaction count if we're done.
          // If there's still work at the current priority,
          // That indicates that we are waiting for suspense data.
          if (
            earliestRemainingTimeAfterCommit === NoWork ||
            scheduledExpirationTime < earliestRemainingTimeAfterCommit
          ) {
            pendingInteractionMap.delete(scheduledExpirationTime);

            scheduledInteractions.forEach(interaction => {
              interaction.__count--;

              if (subscriber !== null && interaction.__count === 0) {
                try {
                  subscriber.onInteractionScheduledWorkCompleted(interaction);
                } catch (error) {
                  // It's not safe for commitRoot() to throw.
                  // Store the error for now and we'll re-throw in finishRendering().
                  if (!hasUnhandledError) {
                    hasUnhandledError = true;
                    unhandledError = error;
                  }
                }
              }
            });
          }
        },
      );
    }
  }
}

/**
 * 重置当前节点的childExpirationTime。
 * @param workInProgress 当前处理的Fiber对象的进行中副本
 * @param renderTime 当前处理的Fiber所在的FiberRoot的nextExpirationTimeToWorkOn
 */
function resetChildExpirationTime(
  workInProgress: Fiber,
  renderTime: ExpirationTime,
) {
  if (renderTime !== Never && workInProgress.childExpirationTime === Never) {
    // The children of this component are hidden. Don't bubble their
    // expiration times.
    // 翻译：该组件的子节点被隐藏。不要冒泡他们的到期时间。
    return;
  }

  let newChildExpirationTime = NoWork;

  // Bubble up the earliest expiration time.
  // 翻译：将最早的到期时间冒泡。
  if (enableProfilerTimer && workInProgress.mode & ProfileMode) {
    // We're in profiling mode.
    // Let's use this same traversal to update the render durations.
    // 翻译：我们处于分析模式。
    //      让我们使用相同的遍历来更新渲染持续时间。
    let actualDuration = workInProgress.actualDuration;
    let treeBaseDuration = workInProgress.selfBaseDuration;

    // When a fiber is cloned, its actualDuration is reset to 0.
    // This value will only be updated if work is done on the fiber (i.e. it doesn't bailout).
    // When work is done, it should bubble to the parent's actualDuration.
    // If the fiber has not been cloned though, (meaning no work was done),
    // Then this value will reflect the amount of time spent working on a previous render.
    // In that case it should not bubble.
    // We determine whether it was cloned by comparing the child pointer.
    const shouldBubbleActualDurations =
      workInProgress.alternate === null ||
      workInProgress.child !== workInProgress.alternate.child;

    let child = workInProgress.child;
    while (child !== null) {
      const childUpdateExpirationTime = child.expirationTime;
      const childChildExpirationTime = child.childExpirationTime;
      if (
        newChildExpirationTime === NoWork ||
        (childUpdateExpirationTime !== NoWork &&
          childUpdateExpirationTime < newChildExpirationTime)
      ) {
        newChildExpirationTime = childUpdateExpirationTime;
      }
      if (
        newChildExpirationTime === NoWork ||
        (childChildExpirationTime !== NoWork &&
          childChildExpirationTime < newChildExpirationTime)
      ) {
        newChildExpirationTime = childChildExpirationTime;
      }
      if (shouldBubbleActualDurations) {
        actualDuration += child.actualDuration;
      }
      treeBaseDuration += child.treeBaseDuration;
      child = child.sibling;
    }
    workInProgress.actualDuration = actualDuration;
    workInProgress.treeBaseDuration = treeBaseDuration;
  } else {
    // 取出第一个子节点。
    let child = workInProgress.child;
    while (child !== null) {
      // 当前子节点的过期时间。
      const childUpdateExpirationTime = child.expirationTime;
      // 当前子节点的子节点中最高优先级的过期时间。
      const childChildExpirationTime = child.childExpirationTime;
      // 下面是比较两个时间，早到优先级高的赋值给newChildExpirationTime。
      if (
        newChildExpirationTime === NoWork ||
        (childUpdateExpirationTime !== NoWork &&
          childUpdateExpirationTime < newChildExpirationTime)
      ) {
        newChildExpirationTime = childUpdateExpirationTime;
      }
      if (
        newChildExpirationTime === NoWork ||
        (childChildExpirationTime !== NoWork &&
          childChildExpirationTime < newChildExpirationTime)
      ) {
        newChildExpirationTime = childChildExpirationTime;
      }
      // 下一个子节点（也就是当前子节点的兄弟节点）。
      child = child.sibling;
    }
  }

  // 完成上面对当前节点所有第一层子节点的遍历，找到最高优先级，也就是最小的过期时间。
  workInProgress.childExpirationTime = newChildExpirationTime;
}

/**
 * 完成单元任务，也是一个向上回溯Fiber的过程。
 * @param workInProgress 当前处理的Fiber对象的进行中副本
 * @return {Fiber|null}
 */
function completeUnitOfWork(workInProgress: Fiber): Fiber | null {
  // Attempt to complete the current unit of work, then move to the
  // next sibling. If there are no more siblings, return to the
  // parent fiber.
  // 翻译：尝试完成当前的工作单元，然后移至下一个兄弟节点。如果没有更多的兄弟节点，返回到父级节点。
  while (true) {
    // The current, flushed, state of this fiber is the alternate.
    // Ideally nothing should rely on this, but relying on it here
    // means that we don't need an additional field on the work in
    // progress.
    // 翻译：该Fiber对象的当前执行状态是备用状态。理想情况下，没有人应该依赖此，
    //      但是这里依赖它意味着我们不需要在进行中的任务的其他领域。
    const current = workInProgress.alternate;
    if (__DEV__) {
      ReactCurrentFiber.setCurrentFiber(workInProgress);
    }

    // 父节点。
    const returnFiber = workInProgress.return;
    // 兄弟节点。
    const siblingFiber = workInProgress.sibling;

    // Incomplete是发生异常的标记，如果NoEffect即说明该节点正常。
    if ((workInProgress.effectTag & Incomplete) === NoEffect) {
      // 节点正常的流程。
      // This fiber completed.
      // 翻译：这个Fiber节点已经完成。
      if (enableProfilerTimer) {
        if (workInProgress.mode & ProfileMode) {
          startProfilerTimer(workInProgress);
        }

        nextUnitOfWork = completeWork(
          current,
          workInProgress,
          nextRenderExpirationTime,
        );

        if (workInProgress.mode & ProfileMode) {
          // Update render duration assuming we didn't error.
          // 翻译：假设我们没有错误，请更新渲染时间。
          stopProfilerTimerIfRunningAndRecordDelta(workInProgress, false);
        }
      } else {
        nextUnitOfWork = completeWork(
          current,
          workInProgress,
          nextRenderExpirationTime,
        );
      }
      stopWorkTimer(workInProgress);
      // 重置过期时间。
      resetChildExpirationTime(workInProgress, nextRenderExpirationTime);
      if (__DEV__) {
        ReactCurrentFiber.resetCurrentFiber();
      }

      // 处理Effect链，把当前节点的EffectTag以及Effect链（就是子节点的Effect）附加到父级。
      if (
        returnFiber !== null &&
        // Do not append effects to parents if a sibling failed to complete
        // 翻译：如果兄弟节点未能完成，不要给父节点附加effect标记。
        (returnFiber.effectTag & Incomplete) === NoEffect
      ) {
        // Append all the effects of the subtree and this fiber onto the effect
        // list of the parent. The completion order of the children affects the
        // side-effect order.
        // 翻译：将子树和此Fiber节点的所有effect附加到父级的effect列表上。
        //      子节点的完成顺序会影响副作用顺序。
        if (returnFiber.firstEffect === null) {
          // 父节点不存在头指针，即说明父节点还没有effect记录。
          returnFiber.firstEffect = workInProgress.firstEffect;
        }
        if (workInProgress.lastEffect !== null) {
          // 当前节点有尾指针，也说明当前节点有副作用。
          if (returnFiber.lastEffect !== null) {
            // 父节点有尾指针，即说明父节点已有effect记录，需要把当前节点的effect链连接到父节点链的末尾。
            returnFiber.lastEffect.nextEffect = workInProgress.firstEffect;
          }
          returnFiber.lastEffect = workInProgress.lastEffect;
        }

        // If this fiber had side-effects, we append it AFTER the children's
        // side-effects. We can perform certain side-effects earlier if
        // needed, by doing multiple passes over the effect list. We don't want
        // to schedule our own side-effect on our own list because if end up
        // reusing children we'll schedule this effect onto itself since we're
        // at the end.
        // 翻译：如果这个Fiber节点有副作用，我们将它添加到其子节点的副作用之后。
        //      如果需要，我们可以通过在effect列表上进行多次传递来更早地执行某些副作用。
        //      我们不想在自己的列表上安排自己的副作用，因为如果最终重用了子节点，
        //      我们将在自己的结尾安排这effect。
        const effectTag = workInProgress.effectTag;
        // Skip both NoWork and PerformedWork tags when creating the effect list.
        // PerformedWork effect is read by React DevTools but shouldn't be committed.
        // 翻译：创建效果列表时，请同时跳过NoWork和PerformedWork标签。
        //      React开发工具读取了PerformedWork标签，但不应提交。
        if (effectTag > PerformedWork) {
          if (returnFiber.lastEffect !== null) {
            // 如果父级有effect列表，则添加到最后。
            returnFiber.lastEffect.nextEffect = workInProgress;
          } else {
            // 如果父级没有effect列表，则就是首个。
            returnFiber.firstEffect = workInProgress;
          }
          returnFiber.lastEffect = workInProgress;
        }
      }

      if (__DEV__ && ReactFiberInstrumentation.debugTool) {
        ReactFiberInstrumentation.debugTool.onCompleteWork(workInProgress);
      }

      if (siblingFiber !== null) {
        // If there is more work to do in this returnFiber, do that next.
        // 翻译：如果在该returnFiber中还有更多工作要做，请继续执行下一步。
        return siblingFiber;
      } else if (returnFiber !== null) {
        // If there's no more work in this returnFiber. Complete the returnFiber.
        // 翻译：如果此returnFiber中没有其他工作。完成returnFiber。
        workInProgress = returnFiber;
        continue;
      } else {
        // We've reached the root.
        // 翻译：我们已经到了根节点。
        return null;
      }
    } else {
      // 节点异常的流程。
      if (workInProgress.mode & ProfileMode) {
        // Record the render duration for the fiber that errored.
        // 翻译：记录出现错误的Fiber节点的渲染时间。
        stopProfilerTimerIfRunningAndRecordDelta(workInProgress, false);
      }

      // This fiber did not complete because something threw. Pop values off
      // the stack without entering the complete phase. If this is a boundary,
      // capture values if possible.
      // 翻译：该Fiber节点未完成，因为有错误被抛出了。从堆栈中弹出值，而不进入完整阶段。
      //      如果这是一个边界，请尽可能捕获值。
      // 可能返回workInProgress或null。
      const next = unwindWork(workInProgress, nextRenderExpirationTime);
      // Because this fiber did not complete, don't reset its expiration time.
      // 翻译：因为该Fiber节点未完成，所以不要重置它的过期时间。
      if (workInProgress.effectTag & DidCapture) {
        // Restarting an error boundary
        // 翻译：重新启动错误边界处理。
        stopFailedWorkTimer(workInProgress);
      } else {
        stopWorkTimer(workInProgress);
      }

      if (__DEV__) {
        ReactCurrentFiber.resetCurrentFiber();
      }

      if (next !== null) {
        // 即next就是workInProgress的情况。
        stopWorkTimer(workInProgress);
        if (__DEV__ && ReactFiberInstrumentation.debugTool) {
          ReactFiberInstrumentation.debugTool.onCompleteWork(workInProgress);
        }

        if (enableProfilerTimer) {
          // Include the time spent working on failed children before continuing.
          if (next.mode & ProfileMode) {
            let actualDuration = next.actualDuration;
            let child = next.child;
            while (child !== null) {
              actualDuration += child.actualDuration;
              child = child.sibling;
            }
            next.actualDuration = actualDuration;
          }
        }

        // If completing this work spawned new work, do that next. We'll come
        // back here again.
        // Since we're restarting, remove anything that is not a host effect
        // from the effect tag.
        // 翻译：如果完成这项工作产生了新工作，请继续执行下一步。我们会再次回到这里。
        //      由于我们正在重新启动，因此请从effect标签中删除所有不是宿主effect的东西。
        // 下面操作会将effectTag的状态设置成effectTag和HostEffectMask共有部分。
        // 只会移除Incomplete和ShouldCapture，其他状态都会保留。
        next.effectTag &= HostEffectMask;
        return next;
      }

      if (returnFiber !== null) {
        // Mark the parent fiber as incomplete and clear its effect list.
        // 翻译：将父级Fiber对象标记为不完整，并清除其effect列表。
        returnFiber.firstEffect = returnFiber.lastEffect = null;
        returnFiber.effectTag |= Incomplete;
      }

      if (__DEV__ && ReactFiberInstrumentation.debugTool) {
        ReactFiberInstrumentation.debugTool.onCompleteWork(workInProgress);
      }

      if (siblingFiber !== null) {
        // If there is more work to do in this returnFiber, do that next.
        // 翻译：如果在该returnFiber中还有更多工作要做，请继续执行下一步。
        return siblingFiber;
      } else if (returnFiber !== null) {
        // If there's no more work in this returnFiber. Complete the returnFiber.
        // 翻译：如果此returnFiber中没有其他工作。完成returnFiber。
        workInProgress = returnFiber;
        continue;
      } else {
        return null;
      }
    }
  }

  // Without this explicit null return Flow complains of invalid return type
  // TODO Remove the above while(true) loop
  // eslint-disable-next-line no-unreachable
  return null;
}

/**
 * 执行Fiber单元工作
 * @param workInProgress 当前处理的Fiber对象的进行中副本
 * @return {*}
 */
function performUnitOfWork(workInProgress: Fiber): Fiber | null {
  // The current, flushed, state of this fiber is the alternate.
  // Ideally nothing should rely on this, but relying on it here
  // means that we don't need an additional field on the work in
  // progress.
  // 翻译：该Fiber对象的当前执行状态是备用状态。理想情况下，没有人应该依赖此，
  //      但是这里依赖它意味着我们不需要在进行中的任务的其他领域。
  // workInProgress的alternate指向的是当前的本体Fiber对象。
  const current = workInProgress.alternate;

  // See if beginning this work spawns more work.
  // 翻译：看看是否开始这项工作会产生更多的工作。
  startWorkTimer(workInProgress);
  if (__DEV__) {
    ReactCurrentFiber.setCurrentFiber(workInProgress);
  }

  if (__DEV__ && replayFailedUnitOfWorkWithInvokeGuardedCallback) {
    stashedWorkInProgressProperties = assignFiberPropertiesInDEV(
      stashedWorkInProgressProperties,
      workInProgress,
    );
  }

  let next;
  if (enableProfilerTimer) {
    if (workInProgress.mode & ProfileMode) {
      startProfilerTimer(workInProgress);
    }

    // 开始真正的渲染工作。
    next = beginWork(current, workInProgress, nextRenderExpirationTime);
    workInProgress.memoizedProps = workInProgress.pendingProps;

    if (workInProgress.mode & ProfileMode) {
      // Record the render duration assuming we didn't bailout (or error).
      // 翻译：假设我们没有纾困（或错误），请记录渲染时间。
      stopProfilerTimerIfRunningAndRecordDelta(workInProgress, true);
    }
  } else {
    // 开始真正的渲染工作，这里的current可能为空。
    // 执行的结果是当前节点的子节点。
    next = beginWork(current, workInProgress, nextRenderExpirationTime);
    workInProgress.memoizedProps = workInProgress.pendingProps;
  }

  if (__DEV__) {
    ReactCurrentFiber.resetCurrentFiber();
    if (isReplayingFailedUnitOfWork) {
      // Currently replaying a failed unit of work. This should be unreachable,
      // because the render phase is meant to be idempotent, and it should
      // have thrown again. Since it didn't, rethrow the original error, so
      // React's internal stack is not misaligned.
      rethrowOriginalError();
    }
  }
  if (__DEV__ && ReactFiberInstrumentation.debugTool) {
    ReactFiberInstrumentation.debugTool.onBeginWork(workInProgress);
  }

  if (next === null) {
    // If this doesn't spawn new work, complete the current work.
    // 翻译：如果这没有产生新的工作，请完成当前工作。
    // 这里会往上遍历。
    next = completeUnitOfWork(workInProgress);
  }

  ReactCurrentOwner.current = null;

  return next;
}

/**
 * 循环遍历Fiber树进行更新
 * @param isYieldy 是否可以被中断
 */
function workLoop(isYieldy) {
  if (!isYieldy) {
    // Flush work without yielding
    // 翻译：不中断地执行任务。
    while (nextUnitOfWork !== null) {
      nextUnitOfWork = performUnitOfWork(nextUnitOfWork);
    }
  } else {
    // Flush asynchronous work until the deadline runs out of time.
    // 翻译：执行异步工作，直到截止期限用完为止。。
    while (nextUnitOfWork !== null && !shouldYield()) {
      nextUnitOfWork = performUnitOfWork(nextUnitOfWork);
    }
  }
}

/**
 * 渲染函数。
 * @param root root节点
 * @param isYieldy 是否可中断
 * @param isExpired 是否过期（是否强制输出）
 */
function renderRoot(
  root: FiberRoot,
  isYieldy: boolean,
  isExpired: boolean,
): void {
  invariant(
    !isWorking,
    'renderRoot was called recursively. This error is likely caused ' +
      'by a bug in React. Please file an issue.',
  );
  isWorking = true;
  ReactCurrentOwner.currentDispatcher = Dispatcher;

  // 这个值来自performAsyncWork调用didExpireAtExpirationTime设置的，
  // 设置条件就是已经帧过期并且任务也过期，设置的是performAsyncWork调用时的时间。
  const expirationTime = root.nextExpirationTimeToWorkOn;

  // Check if we're starting from a fresh stack, or if we're resuming from
  // previously yielded work.
  // 翻译：检查我们是从新栈开始，还是从先前产生的工作中恢复。
  if (
    expirationTime !== nextRenderExpirationTime ||
    root !== nextRoot ||
    nextUnitOfWork === null
  ) {
    // Reset the stack and start working from the root.
    // 翻译：重置堆栈并从root节点开始任务。
    resetStack();
    nextRoot = root;
    // 赋值的是FiberRoot的nextExpirationTimeToWorkOn。
    nextRenderExpirationTime = expirationTime;
    // 复制出一份渲染中的Fiber节点副本，后续都是在workingProgress上操作。
    nextUnitOfWork = createWorkInProgress(
      // 传递的是FiberRoot的current指向的Fiber节点。
      nextRoot.current,
      null,
      nextRenderExpirationTime,
    );
    root.pendingCommitExpirationTime = NoWork;

    // 跟踪调试代码。
    if (enableSchedulerTracing) {
      // Determine which interactions this batch of work currently includes,
      // So that we can accurately attribute time spent working on it,
      // And so that cascading work triggered during the render phase will be associated with it.
      const interactions: Set<Interaction> = new Set();
      root.pendingInteractionMap.forEach(
        (scheduledInteractions, scheduledExpirationTime) => {
          if (scheduledExpirationTime <= expirationTime) {
            scheduledInteractions.forEach(interaction =>
              interactions.add(interaction),
            );
          }
        },
      );

      // Store the current set of interactions on the FiberRoot for a few reasons:
      // We can re-use it in hot functions like renderRoot() without having to recalculate it.
      // We will also use it in commitWork() to pass to any Profiler onRender() hooks.
      // This also provides DevTools with a way to access it when the onCommitRoot() hook is called.
      root.memoizedInteractions = interactions;

      if (interactions.size > 0) {
        const subscriber = __subscriberRef.current;
        if (subscriber !== null) {
          const threadID = computeThreadID(
            expirationTime,
            root.interactionThreadID,
          );
          try {
            subscriber.onWorkStarted(interactions, threadID);
          } catch (error) {
            // Work thrown by an interaction tracing subscriber should be rethrown,
            // But only once it's safe (to avoid leaveing the scheduler in an invalid state).
            // Store the error for now and we'll re-throw in finishRendering().
            if (!hasUnhandledError) {
              hasUnhandledError = true;
              unhandledError = error;
            }
          }
        }
      }
    }
  }

  let prevInteractions: Set<Interaction> = (null: any);
  // 跟踪调试代码。
  if (enableSchedulerTracing) {
    // We're about to start new traced work.
    // Restore pending interactions so cascading work triggered during the render phase will be accounted for.
    prevInteractions = __interactionsRef.current;
    __interactionsRef.current = root.memoizedInteractions;
  }

  // 致命错误标记。
  let didFatal = false;
  // 跟踪调试代码。
  startWorkLoopTimer(nextUnitOfWork);

  do {
    try {
      // 开始任务。
      workLoop(isYieldy);
    } catch (thrownValue) {
      if (nextUnitOfWork === null) {
        // 这个情况是不可能被修复的，会中断所有操作。
        // This is a fatal error.
        // 翻译：这是一个致命错误。
        didFatal = true;
        // 会将nextFlushedRoot.expirationTime置为NoWork。
        onUncaughtError(thrownValue);
      } else {
        if (__DEV__) {
          // Reset global debug state
          // We assume this is defined in DEV
          (resetCurrentlyProcessingQueue: any)();
        }

        const failedUnitOfWork: Fiber = nextUnitOfWork;
        if (__DEV__ && replayFailedUnitOfWorkWithInvokeGuardedCallback) {
          replayUnitOfWork(failedUnitOfWork, thrownValue, isYieldy);
        }

        // TODO: we already know this isn't true in some cases.
        // At least this shows a nicer error message until we figure out the cause.
        // https://github.com/facebook/react/issues/12449#issuecomment-386727431
        invariant(
          nextUnitOfWork !== null,
          'Failed to replay rendering after an error. This ' +
            'is likely caused by a bug in React. Please file an issue ' +
            'with a reproducing case to help us find it.',
        );

        // sourceFiber就是发生错误的节点。
        const sourceFiber: Fiber = nextUnitOfWork;
        let returnFiber = sourceFiber.return;
        if (returnFiber === null) {
          // 没有父节点即是根节点，这里处理根节点的错误，这里也算致命错误，会中断所有操作。
          // This is the root. The root could capture its own errors. However,
          // we don't know if it errors before or after we pushed the host
          // context. This information is needed to avoid a stack mismatch.
          // Because we're not sure, treat this as a fatal error. We could track
          // which phase it fails in, but doesn't seem worth it. At least
          // for now.
          // 翻译：这是一个根节点。根可以捕获自己的错误。但是，我们不知道在推送主上下文前后它是否出错。
          //      需要此信息以避免堆栈不匹配。因为我们不确定，所以将此视为致命错误。
          //      我们可以跟踪失败的阶段，但似乎不值得。至少目前是这样。
          didFatal = true;
          onUncaughtError(thrownValue);
        } else {
          // 非致命的常规错误处理。
          throwException(
            root,
            returnFiber,
            sourceFiber,
            thrownValue,
            nextRenderExpirationTime,
          );
          // 直接结束该节点，这里会调用到unwindWork的流程。
          // 会返回有处理能力的节点或null。
          nextUnitOfWork = completeUnitOfWork(sourceFiber);
          continue;
        }
      }
    }
    break;
  } while (true);

  if (enableSchedulerTracing) {
    // Traced work is done for now; restore the previous interactions.
    __interactionsRef.current = prevInteractions;
  }

  // We're done performing work. Time to clean up.
  // 翻译：我们完成了工作。是时候清理了。
  isWorking = false;
  ReactCurrentOwner.currentDispatcher = null;
  resetContextDependences();

  // Yield back to main thread.
  // 翻译：退回到主线程。
  if (didFatal) {
    const didCompleteRoot = false;
    stopWorkLoopTimer(interruptedBy, didCompleteRoot);
    interruptedBy = null;
    // There was a fatal error.
    // 翻译：发生致命错误。
    if (__DEV__) {
      resetStackAfterFatalErrorInDev();
    }
    // `nextRoot` points to the in-progress root. A non-null value indicates
    // that we're in the middle of an async render. Set it to null to indicate
    // there's no more work to be done in the current batch.
    // 翻译：`nextRoot`指向进行中的root节点。非null值表示我们处于异步渲染的中间。
    //      将其设置为null表示当前批处理中没有更多的工作要做。
    nextRoot = null;
    onFatal(root);
    return;
  }

  if (nextUnitOfWork !== null) {
    // 正常走完流程的情况下nextUnitOfWork应该是null，这是被中断的情况。
    // There's still remaining async work in this tree, but we ran out of time
    // in the current frame. Yield back to the renderer. Unless we're
    // interrupted by a higher priority update, we'll continue later from where
    // we left off.
    // 翻译：这棵树中仍然有异步工作，但是我们在当前帧中没有时间了。中断退回渲染器。
    //      除非我们被更高优先级的更新打断，否则我们将从该地方继续。
    const didCompleteRoot = false;
    stopWorkLoopTimer(interruptedBy, didCompleteRoot);
    interruptedBy = null;
    onYield(root);
    return;
  }

  // We completed the whole tree.
  // 翻译：我们完成了整个树。
  const didCompleteRoot = true;
  stopWorkLoopTimer(interruptedBy, didCompleteRoot);
  const rootWorkInProgress = root.current.alternate;
  invariant(
    rootWorkInProgress !== null,
    'Finished root should have a work-in-progress. This error is likely ' +
      'caused by a bug in React. Please file an issue.',
  );

  // `nextRoot` points to the in-progress root. A non-null value indicates
  // that we're in the middle of an async render. Set it to null to indicate
  // there's no more work to be done in the current batch.
  // 翻译：`nextRoot`指向进行中的根。非null值表示我们处于异步渲染的过程中。
  //      将其设置为null表示当前批处理中没有更多的工作要做。
  nextRoot = null;
  interruptedBy = null;

  if (nextRenderDidError) {
    // There was an error
    if (hasLowerPriorityWork(root, expirationTime)) {
      // There's lower priority work. If so, it may have the effect of fixing
      // the exception that was just thrown. Exit without committing. This is
      // similar to a suspend, but without a timeout because we're not waiting
      // for a promise to resolve. React will restart at the lower
      // priority level.
      markSuspendedPriorityLevel(root, expirationTime);
      const suspendedExpirationTime = expirationTime;
      const rootExpirationTime = root.expirationTime;
      onSuspend(
        root,
        rootWorkInProgress,
        suspendedExpirationTime,
        rootExpirationTime,
        -1, // Indicates no timeout
      );
      return;
    } else if (
      // There's no lower priority work, but we're rendering asynchronously.
      // Synchronsouly attempt to render the same level one more time. This is
      // similar to a suspend, but without a timeout because we're not waiting
      // for a promise to resolve.
      !root.didError &&
      !isExpired
    ) {
      root.didError = true;
      const suspendedExpirationTime = (root.nextExpirationTimeToWorkOn = expirationTime);
      const rootExpirationTime = (root.expirationTime = Sync);
      onSuspend(
        root,
        rootWorkInProgress,
        suspendedExpirationTime,
        rootExpirationTime,
        -1, // Indicates no timeout
      );
      return;
    }
  }

  if (!isExpired && nextLatestAbsoluteTimeoutMs !== -1) {
    // The tree was suspended.
    // 翻译：这个Fiber树被悬挂了。
    const suspendedExpirationTime = expirationTime;
    markSuspendedPriorityLevel(root, suspendedExpirationTime);

    // Find the earliest uncommitted expiration time in the tree, including
    // work that is suspended. The timeout threshold cannot be longer than
    // the overall expiration.
    const earliestExpirationTime = findEarliestOutstandingPriorityLevel(
      root,
      expirationTime,
    );
    const earliestExpirationTimeMs = expirationTimeToMs(earliestExpirationTime);
    if (earliestExpirationTimeMs < nextLatestAbsoluteTimeoutMs) {
      nextLatestAbsoluteTimeoutMs = earliestExpirationTimeMs;
    }

    // Subtract the current time from the absolute timeout to get the number
    // of milliseconds until the timeout. In other words, convert an absolute
    // timestamp to a relative time. This is the value that is passed
    // to `setTimeout`.
    const currentTimeMs = expirationTimeToMs(requestCurrentTime());
    let msUntilTimeout = nextLatestAbsoluteTimeoutMs - currentTimeMs;
    msUntilTimeout = msUntilTimeout < 0 ? 0 : msUntilTimeout;

    // TODO: Account for the Just Noticeable Difference

    const rootExpirationTime = root.expirationTime;
    onSuspend(
      root,
      rootWorkInProgress,
      suspendedExpirationTime,
      rootExpirationTime,
      msUntilTimeout,
    );
    return;
  }

  // Ready to commit.
  // 翻译：准备提交。
  onComplete(root, rootWorkInProgress, expirationTime);
}

function dispatch(
  sourceFiber: Fiber,
  value: mixed,
  expirationTime: ExpirationTime,
) {
  invariant(
    !isWorking || isCommitting,
    'dispatch: Cannot dispatch during the render phase.',
  );

  let fiber = sourceFiber.return;
  while (fiber !== null) {
    switch (fiber.tag) {
      case ClassComponent:
        const ctor = fiber.type;
        const instance = fiber.stateNode;
        if (
          typeof ctor.getDerivedStateFromError === 'function' ||
          (typeof instance.componentDidCatch === 'function' &&
            !isAlreadyFailedLegacyErrorBoundary(instance))
        ) {
          const errorInfo = createCapturedValue(value, sourceFiber);
          const update = createClassErrorUpdate(
            fiber,
            errorInfo,
            expirationTime,
          );
          enqueueUpdate(fiber, update);
          scheduleWork(fiber, expirationTime);
          return;
        }
        break;
      case HostRoot: {
        const errorInfo = createCapturedValue(value, sourceFiber);
        const update = createRootErrorUpdate(fiber, errorInfo, expirationTime);
        enqueueUpdate(fiber, update);
        scheduleWork(fiber, expirationTime);
        return;
      }
    }
    fiber = fiber.return;
  }

  if (sourceFiber.tag === HostRoot) {
    // Error was thrown at the root. There is no parent, so the root
    // itself should capture it.
    const rootFiber = sourceFiber;
    const errorInfo = createCapturedValue(value, rootFiber);
    const update = createRootErrorUpdate(rootFiber, errorInfo, expirationTime);
    enqueueUpdate(rootFiber, update);
    scheduleWork(rootFiber, expirationTime);
  }
}

function captureCommitPhaseError(fiber: Fiber, error: mixed) {
  return dispatch(fiber, error, Sync);
}

function computeThreadID(
  expirationTime: ExpirationTime,
  interactionThreadID: number,
): number {
  // Interaction threads are unique per root and expiration time.
  return expirationTime * 1000 + interactionThreadID;
}

// Creates a unique async expiration time.
function computeUniqueAsyncExpiration(): ExpirationTime {
  const currentTime = requestCurrentTime();
  let result = computeAsyncExpiration(currentTime);
  if (result <= lastUniqueAsyncExpiration) {
    // Since we assume the current time monotonically increases, we only hit
    // this branch when computeUniqueAsyncExpiration is fired multiple times
    // within a 200ms window (or whatever the async bucket size is).
    result = lastUniqueAsyncExpiration + 1;
  }
  lastUniqueAsyncExpiration = result;
  return lastUniqueAsyncExpiration;
}

/**
 * 计算Fiber对象的到期时间。
 * @param currentTime "到期时间"
 * @param fiber Fiber对象
 * @return {*}
 */
function computeExpirationForFiber(currentTime: ExpirationTime, fiber: Fiber) {
  let expirationTime;
  // expirationContext默认初始是NoWork，即使用默认策略，非NoWork即表明要强制使用某种模式。
  // 调用deferredUpdates时这个值会变成低优先级的"过期时间"；
  // 调用syncUpdates时这个值会变成Sync，使用ReactDom暴露的flushSync就是使用了这个函数。
  if (expirationContext !== NoWork) {
    // An explicit expiration context was set;
    // 翻译：设置了一个明确的过期context；
    expirationTime = expirationContext;
  } else if (isWorking) {
    // 这时有任务正在更新情况。
    if (isCommitting) {
      // Updates that occur during the commit phase should have sync priority
      // by default.
      // 翻译：在提交阶段发生的更新默认情况下应具有同步优先级。
      expirationTime = Sync;
    } else {
      // Updates during the render phase should expire at the same time as
      // the work that is being rendered.
      // 翻译：渲染阶段中的更新应与正在渲染的work同时到期。
      expirationTime = nextRenderExpirationTime;
    }
  } else {
    // 这里才是默认策略。
    // No explicit expiration context was set, and we're not currently
    // performing work. Calculate a new expiration time.
    // 翻译：没有设置任何明确的过期上下文，并且我们目前不在执行工作。计算新的到期时间。
    // 只有在ConcurrentMode组件内部才会是异步更新，否则就是同步的。
    if (fiber.mode & ConcurrentMode) {
      // 大部分情况这里都是true，比如标签上绑定的回调函数。
      if (isBatchingInteractiveUpdates) {
        // This is an interactive update
        // 翻译：这是一个交互式更新。
        expirationTime = computeInteractiveExpiration(currentTime);
      } else {
        // This is an async update
        // 翻译：这是一个异步更新。
        expirationTime = computeAsyncExpiration(currentTime);
      }
      // If we're in the middle of rendering a tree, do not update at the same
      // expiration time that is already rendering.
      // 翻译：如果我们正在渲染树，请不要在已经渲染的到期时间进行更新。
      if (nextRoot !== null && expirationTime === nextRenderExpirationTime) {
        expirationTime += 1;
      }
    } else {
      // This is a sync update
      // 翻译：这是一个同步更新。
      expirationTime = Sync;
    }
  }
  if (isBatchingInteractiveUpdates) {
    // This is an interactive update. Keep track of the lowest pending
    // interactive expiration time. This allows us to synchronously flush
    // all interactive updates when needed.
    if (expirationTime > lowestPriorityPendingInteractiveExpirationTime) {
      lowestPriorityPendingInteractiveExpirationTime = expirationTime;
    }
  }
  return expirationTime;
}

function renderDidSuspend(
  root: FiberRoot,
  absoluteTimeoutMs: number,
  suspendedTime: ExpirationTime,
) {
  // Schedule the timeout.
  if (
    absoluteTimeoutMs >= 0 &&
    nextLatestAbsoluteTimeoutMs < absoluteTimeoutMs
  ) {
    nextLatestAbsoluteTimeoutMs = absoluteTimeoutMs;
  }
}

function renderDidError() {
  nextRenderDidError = true;
}

function retrySuspendedRoot(
  root: FiberRoot,
  boundaryFiber: Fiber,
  sourceFiber: Fiber,
  suspendedTime: ExpirationTime,
) {
  let retryTime;

  if (isPriorityLevelSuspended(root, suspendedTime)) {
    // Ping at the original level
    retryTime = suspendedTime;

    markPingedPriorityLevel(root, retryTime);
  } else {
    // Suspense already timed out. Compute a new expiration time
    const currentTime = requestCurrentTime();
    retryTime = computeExpirationForFiber(currentTime, boundaryFiber);
    markPendingPriorityLevel(root, retryTime);
  }

  // TODO: If the suspense fiber has already rendered the primary children
  // without suspending (that is, all of the promises have already resolved),
  // we should not trigger another update here. One case this happens is when
  // we are in sync mode and a single promise is thrown both on initial render
  // and on update; we attach two .then(retrySuspendedRoot) callbacks and each
  // one performs Sync work, rerendering the Suspense.

  if ((boundaryFiber.mode & ConcurrentMode) !== NoContext) {
    if (root === nextRoot && nextRenderExpirationTime === suspendedTime) {
      // Received a ping at the same priority level at which we're currently
      // rendering. Restart from the root.
      nextRoot = null;
    }
  }

  scheduleWorkToRoot(boundaryFiber, retryTime);
  if ((boundaryFiber.mode & ConcurrentMode) === NoContext) {
    // Outside of concurrent mode, we must schedule an update on the source
    // fiber, too, since it already committed in an inconsistent state and
    // therefore does not have any pending work.
    scheduleWorkToRoot(sourceFiber, retryTime);
    const sourceTag = sourceFiber.tag;
    if (sourceTag === ClassComponent && sourceFiber.stateNode !== null) {
      // When we try rendering again, we should not reuse the current fiber,
      // since it's known to be in an inconsistent state. Use a force updte to
      // prevent a bail out.
      const update = createUpdate(retryTime);
      update.tag = ForceUpdate;
      enqueueUpdate(sourceFiber, update);
    }
  }

  const rootExpirationTime = root.expirationTime;
  if (rootExpirationTime !== NoWork) {
    requestWork(root, rootExpirationTime);
  }
}

/**
 * 寻找Fiber节点的FiberRoot。
 * @param fiber 产生更新的节点的Fiber对象
 * @param expirationTime 创建update时计算的"过期时间"
 * @return {null}
 */
function scheduleWorkToRoot(fiber: Fiber, expirationTime): FiberRoot | null {
  // 记录时间的独立模块。
  recordScheduleUpdate();

  if (__DEV__) {
    if (fiber.tag === ClassComponent) {
      const instance = fiber.stateNode;
      warnAboutInvalidUpdates(instance);
    }
  }

  // Update the source fiber's expiration time
  // 翻译：更新源（产生更新）Fiber对象的到期时间。
  if (
    fiber.expirationTime === NoWork ||
    fiber.expirationTime > expirationTime
  ) {
    // 当节点还没进行过更新或更新还没完成但之前的优先级比较低，更新完成expirationTime会去掉。
    fiber.expirationTime = expirationTime;
  }
  // alternate也做相同的更新时间操作。
  let alternate = fiber.alternate;
  if (
    alternate !== null &&
    (alternate.expirationTime === NoWork ||
      alternate.expirationTime > expirationTime)
  ) {
    alternate.expirationTime = expirationTime;
  }
  // Walk the parent path to the root and update the child expiration time.
  // 翻译：沿着父级节点直到找到root节点(rootFiber)，并更新子节点的过期时间。
  let node = fiber.return;
  // 记录FiberRoot。
  let root = null;
  if (node === null && fiber.tag === HostRoot) {
    // 如果return属性为空就证明这个节点是rootFiber节点，其stateNode也就是FiberRoot。
    root = fiber.stateNode;
  } else {
    // 如果当前的Fiber对象不是rootFiber，就通过return属性向上遍历。
    // Fiber对象上childExpirationTime的意义是子节点里优先级最高的节点的过期时间（最小），
    // 这里在向上遍历的过程中，会将沿途的父节点的childExpirationTime更新（如果需要）。
    while (node !== null) {
      alternate = node.alternate;
      if (
        node.childExpirationTime === NoWork ||
        node.childExpirationTime > expirationTime
      ) {
        node.childExpirationTime = expirationTime;
        if (
          alternate !== null &&
          (alternate.childExpirationTime === NoWork ||
            alternate.childExpirationTime > expirationTime)
        ) {
          alternate.childExpirationTime = expirationTime;
        }
      } else if (
        alternate !== null &&
        (alternate.childExpirationTime === NoWork ||
          alternate.childExpirationTime > expirationTime)
      ) {
        alternate.childExpirationTime = expirationTime;
      }
      if (node.return === null && node.tag === HostRoot) {
        // 找到rootFiber节点，取出FiberRoot。
        root = node.stateNode;
        break;
      }
      // 还不是rootFiber节点，继续找上一级。
      node = node.return;
    }
  }

  if (root === null) {
    // 如果一直没有找到rootFiber节点这证明生成的树是有错误的。
    if (__DEV__ && fiber.tag === ClassComponent) {
      warnAboutUpdateOnUnmounted(fiber);
    }
    return null;
  }

  // 任务跟踪的代码，与更新原理无关。
  if (enableSchedulerTracing) {
    const interactions = __interactionsRef.current;
    if (interactions.size > 0) {
      const pendingInteractionMap = root.pendingInteractionMap;
      const pendingInteractions = pendingInteractionMap.get(expirationTime);
      if (pendingInteractions != null) {
        interactions.forEach(interaction => {
          if (!pendingInteractions.has(interaction)) {
            // Update the pending async work count for previously unscheduled interaction.
            // 翻译：更新先前未调度交互的待处理异步工作数量。
            interaction.__count++;
          }

          pendingInteractions.add(interaction);
        });
      } else {
        pendingInteractionMap.set(expirationTime, new Set(interactions));

        // Update the pending async work count for the current interactions.
        // 翻译：更新当前交互的待处理异步工作数量。
        interactions.forEach(interaction => {
          interaction.__count++;
        });
      }

      const subscriber = __subscriberRef.current;
      if (subscriber !== null) {
        const threadID = computeThreadID(
          expirationTime,
          root.interactionThreadID,
        );
        subscriber.onWorkScheduled(interactions, threadID);
      }
    }
  }

  return root;
}

/**
 * Fiber对象进入scheduleFiber调度前预处理。
 * 1. 找到当前Fiber对象的FiberRoot，顺便更新沿途的expirationTime和childExpirationTime；
 * 2. 判断是否需要中断（resetStack）；
 * 3. 调和各种FiberRoot上的过期时间（markPendingPriorityLevel）；
 * 4. 请求调度（requestWork）；
 * 5. 防止死循环更新的情况。
 * @param fiber 产生更新的节点的Fiber对象
 * @param expirationTime 创建update时计算的"过期时间"
 */
function scheduleWork(fiber: Fiber, expirationTime: ExpirationTime) {
  // 寻找FiberRoot对象，加入更新队列的永远是FiberRoot对象，不是某个节点的Fiber对象。
  const root = scheduleWorkToRoot(fiber, expirationTime);
  if (root === null) {
    // 找不到FiberRoot节点，终止。
    return;
  }

  if (
    !isWorking &&
    nextRenderExpirationTime !== NoWork &&
    expirationTime < nextRenderExpirationTime
  ) {
    // 条件解读：没有任务在进行，有异步任务被挂起，当前任务的优先级，高于之前的（挂起）异步任务。
    // This is an interruption. (Used for performance tracking.)
    // 翻译：这是一个中断。（用于性能跟踪。）
    // interruptedBy仅用于调试记录。
    interruptedBy = fiber;
    // 中断。
    resetStack();
  }
  markPendingPriorityLevel(root, expirationTime);
  if (
    // If we're in the render phase, we don't need to schedule this root
    // for an update, because we'll do it before we exit...
    // 翻译：如果我们处于渲染阶段，则无需安排此根目录进行更新，因为我们会在退出之前进行此操作...
    !isWorking ||
    isCommitting ||
    // ...unless this is a different root than the one we're rendering.
    // 翻译：...除非这是与我们渲染的根不同的根。
    nextRoot !== root
  ) {
    // 因为markPendingPriorityLevel会改变expirationTime，这里不使用传入的值。
    const rootExpirationTime = root.expirationTime;
    // 请求调度。
    requestWork(root, rootExpirationTime);
  }
  // 下面的判断是解决出现死循环的情况，会抛出异常。
  if (nestedUpdateCount > NESTED_UPDATE_LIMIT) {
    // Reset this back to zero so subsequent updates don't throw.
    // 翻译：将此值重置为零，这样就不会引发后续更新。
    nestedUpdateCount = 0;
    invariant(
      false,
      'Maximum update depth exceeded. This can happen when a ' +
        'component repeatedly calls setState inside ' +
        'componentWillUpdate or componentDidUpdate. React limits ' +
        'the number of nested updates to prevent infinite loops.',
    );
  }
}

function deferredUpdates<A>(fn: () => A): A {
  const currentTime = requestCurrentTime();
  const previousExpirationContext = expirationContext;
  const previousIsBatchingInteractiveUpdates = isBatchingInteractiveUpdates;
  expirationContext = computeAsyncExpiration(currentTime);
  isBatchingInteractiveUpdates = false;
  try {
    return fn();
  } finally {
    expirationContext = previousExpirationContext;
    isBatchingInteractiveUpdates = previousIsBatchingInteractiveUpdates;
  }
}

function syncUpdates<A, B, C0, D, R>(
  fn: (A, B, C0, D) => R,
  a: A,
  b: B,
  c: C0,
  d: D,
): R {
  const previousExpirationContext = expirationContext;
  expirationContext = Sync;
  try {
    return fn(a, b, c, d);
  } finally {
    expirationContext = previousExpirationContext;
  }
}

// TODO: Everything below this is written as if it has been lifted to the
// renderers. I'll do this in a follow-up.

// Linked-list of roots
let firstScheduledRoot: FiberRoot | null = null;
let lastScheduledRoot: FiberRoot | null = null;

let callbackExpirationTime: ExpirationTime = NoWork;
let callbackID: *;
let isRendering: boolean = false;
let nextFlushedRoot: FiberRoot | null = null;
let nextFlushedExpirationTime: ExpirationTime = NoWork;
let lowestPriorityPendingInteractiveExpirationTime: ExpirationTime = NoWork;
let deadlineDidExpire: boolean = false;
let hasUnhandledError: boolean = false;
let unhandledError: mixed | null = null;
let deadline: Deadline | null = null;

let isBatchingUpdates: boolean = false;
let isUnbatchingUpdates: boolean = false;
let isBatchingInteractiveUpdates: boolean = false;

let completedBatches: Array<Batch> | null = null;

let originalStartTimeMs: number = now();
let currentRendererTime: ExpirationTime = msToExpirationTime(
  originalStartTimeMs,
);
let currentSchedulerTime: ExpirationTime = currentRendererTime;

// Use these to prevent an infinite loop of nested updates
// 翻译：使用这些来防止嵌套更新的无限循环。
const NESTED_UPDATE_LIMIT = 50;
let nestedUpdateCount: number = 0;
let lastCommittedRootDuringThisBatch: FiberRoot | null = null;

const timeHeuristicForUnitOfWork = 1;

/**
 * js加载完成到当前的时间。
 */
function recomputeCurrentRendererTime() {
  // now就是Date.now，originalStartTimeMs就是一开始加载的now，两者相减就是渲染过程的时间。
  const currentTimeMs = now() - originalStartTimeMs;
  // 转换成"过期时间"。
  currentRendererTime = msToExpirationTime(currentTimeMs);
}

/**
 * 异步调度的预处理方法
 * @param root FiberRoot对象
 * @param expirationTime "过期时间"
 */
function scheduleCallbackWithExpirationTime(
  root: FiberRoot,
  expirationTime: ExpirationTime,
) {
  // callbackExpirationTime这个全局变量，记录上一次调用这个方法的ExpirationTime
  if (callbackExpirationTime !== NoWork) {
    // 这个分支说明有正在进行的任务。
    // A callback is already scheduled. Check its expiration time (timeout).
    // 翻译：已经安排了回调。检查其到期时间（超时）。
    if (expirationTime > callbackExpirationTime) {
      // Existing callback has sufficient timeout. Exit.
      // 翻译：现有的回调任务优先级高。退出。
      // 当前的优先级比之前的低（过期时间大），当然不会执行。
      return;
    } else {
      if (callbackID !== null) {
        // Existing callback has insufficient timeout. Cancel and schedule a
        // new one.
        // 翻译：现有的回调任务优先级低。取消并安排一个新的。
        cancelDeferredCallback(callbackID);
      }
    }
    // The request callback timer is already running. Don't start a new one.
    // 翻译：请求回调计时器已在运行。不要开始新的。
  } else {
    // 性能相关
    startRequestCallbackTimer();
  }

  callbackExpirationTime = expirationTime;
  // 现在与代码加载时的时间差。
  const currentMs = now() - originalStartTimeMs;
  // "过期时间"转换成ms。
  const expirationTimeMs = expirationTimeToMs(expirationTime);
  // 现在运行时间减去回调的过期时间得到时间差。
  const timeout = expirationTimeMs - currentMs;
  // 生成一个回调id并记录，用来后面取消用。
  // scheduleDeferredCallback函数的本体在/packages/scheduler/src/Scheduler.js
  callbackID = scheduleDeferredCallback(performAsyncWork, {timeout});
}

// For every call to renderRoot, one of onFatal, onComplete, onSuspend, and
// onYield is called upon exiting. We use these in lieu of returning a tuple.
// I've also chosen not to inline them into renderRoot because these will
// eventually be lifted into the renderer.
// 翻译：对于每次对renderRoot的调用，退出时都会调用onFatal，onComplete，
//      onSuspend和onYield中的一种。我们用这些代替返回元组。
//      我还选择不将它们内联到renderRoot中，因为这些最终将被提升到渲染器中。
function onFatal(root) {
  root.finishedWork = null;
}

function onComplete(
  root: FiberRoot,
  finishedWork: Fiber,
  expirationTime: ExpirationTime,
) {
  root.pendingCommitExpirationTime = expirationTime;
  root.finishedWork = finishedWork;
}

function onSuspend(
  root: FiberRoot,
  finishedWork: Fiber,
  suspendedExpirationTime: ExpirationTime,
  rootExpirationTime: ExpirationTime,
  msUntilTimeout: number,
): void {
  root.expirationTime = rootExpirationTime;
  if (msUntilTimeout === 0 && !shouldYield()) {
    // Don't wait an additional tick. Commit the tree immediately.
    root.pendingCommitExpirationTime = suspendedExpirationTime;
    root.finishedWork = finishedWork;
  } else if (msUntilTimeout > 0) {
    // Wait `msUntilTimeout` milliseconds before committing.
    root.timeoutHandle = scheduleTimeout(
      onTimeout.bind(null, root, finishedWork, suspendedExpirationTime),
      msUntilTimeout,
    );
  }
}

function onYield(root) {
  root.finishedWork = null;
}

function onTimeout(root, finishedWork, suspendedExpirationTime) {
  // The root timed out. Commit it.
  root.pendingCommitExpirationTime = suspendedExpirationTime;
  root.finishedWork = finishedWork;
  // Read the current time before entering the commit phase. We can be
  // certain this won't cause tearing related to batching of event updates
  // because we're at the top of a timer event.
  recomputeCurrentRendererTime();
  currentSchedulerTime = currentRendererTime;
  flushRoot(root, suspendedExpirationTime);
}

function onCommit(root, expirationTime) {
  root.expirationTime = expirationTime;
  root.finishedWork = null;
}

/**
 * 获取一个过期时间。
 * 关键词：currentRendererTime（渲染时间），currentSchedulerTime（调度时间）
 * @return {ExpirationTime}
 */
function requestCurrentTime() {
  // requestCurrentTime is called by the scheduler to compute an expiration
  // time.
  // 翻译：调度程序调用requestCurrentTime函数以计算到期时间。
  //
  // Expiration times are computed by adding to the current time (the start
  // time). However, if two updates are scheduled within the same event, we
  // should treat their start times as simultaneous, even if the actual clock
  // time has advanced between the first and second call.
  // 翻译：到期时间是通过在当前时间（开始时间）上做加法计算得出的。
  //      但是，如果两个Update对象在同一个事件内处理，我们应该将他们的开始时间视为相同，
  //      即使实际时钟时间在第一次调用和第二次调用之间已经改变（前进）。

  // In other words, because expiration times determine how updates are batched,
  // we want all updates of like priority that occur within the same event to
  // receive the same expiration time. Otherwise we get tearing.
  // 翻译：换句话说，由于到期时间决定了更新的批处理方式，
  //      我们希望在同一事件中发生的所有优先级相同的更新都具有相同的到期时间。否则我们会失控。
  //
  // We keep track of two separate times: the current "renderer" time and the
  // current "scheduler" time. The renderer time can be updated whenever; it
  // only exists to minimize the calls performance.now.
  // 翻译：我们跟踪两个不同的时间：当前的“渲染器”时间和当前的“调度器”时间。渲染器时间可以随时更新。
  //      它只是为了最大程度地降低当前调用的性能损耗。
  //
  // But the scheduler time can only be updated if there's no pending work, or
  // if we know for certain that we're not in the middle of an event.
  // 翻译：但调度时间只能在没有待处理的工作时才更新，或者如果我们确定当前不在事件过程中。

  // 初始化阶段当然还未渲染自然为否。
  if (isRendering) {
    // We're already rendering. Return the most recently read time.
    // 翻译：我们已经在渲染。返回最近读取的时间。
    return currentSchedulerTime;
  }
  // Check if there's pending work.
  // 翻译：检查是否有待处理的工作。
  // 从调度队列中找到权限最高的worker。
  findHighestPriorityRoot();
  // 初始化阶段这个值还未改变，默认值就是NoWork，所以真。
  if (
    nextFlushedExpirationTime === NoWork ||
    nextFlushedExpirationTime === Never
  ) {
    // If there's no pending work, or if the pending work is offscreen, we can
    // read the current time without risk of tearing.
    // 翻译：如果没有待处理的工作，或者待处理的工作不在屏幕上，我们可以读取当前时间而不会有不一致的风险。
    // 重新计算当前渲染时间。
    recomputeCurrentRendererTime();
    // currentRendererTime是保留在这个文件的局部变量，上面的函数其实已经改变了它。
    currentSchedulerTime = currentRendererTime;
    return currentSchedulerTime;
  }
  // There's already pending work. We might be in the middle of a browser
  // event. If we were to read the current time, it could cause multiple updates
  // within the same event to receive different expiration times, leading to
  // tearing. Return the last read time. During the next idle callback, the
  // time will be updated.
  // 翻译：已经有待处理的工作。我们可能正处于浏览器事件中。如果要读取当前时间，
  //      则可能导致同一事件中的多个更新收到不同的到期时间，从而导致不一致。返回上次读取时间。
  //      在下一个空闲回调期间，时间将被更新。
  return currentSchedulerTime;
}

// requestWork is called by the scheduler whenever a root receives an update.
// It's up to the renderer to call renderRoot at some point in the future.
// 翻译：每当根收到更新时，调度程序就会调用requestWork。
//      将来某个时候由渲染器调用renderRoot。
/**
 * 请求开始调度。
 * 1. 加入到root调度队列；
 * 2. 判断是否批量更新；
 * 3. 根据expirationTime判断调度类型（同步/异步）。
 * @param root FiberRoot对象
 * @param expirationTime FiberRoot上的"过期时间"
 */
function requestWork(root: FiberRoot, expirationTime: ExpirationTime) {
  // 操作firstScheduledRoot和lastScheduledRoot这两个全局变量形成链表。
  addRootToSchedule(root, expirationTime);
  if (isRendering) {
    // Prevent reentrancy. Remaining work will be scheduled at the end of
    // the currently rendering batch.
    // 翻译：防止加入重复队列。其余工作将安排在当前渲染批处理的末尾。
    // 因为调度进行到中途，最新加入链表的FiberRoot对象自然会被执行到，所以不需要后续处理了。
    return;
  }

  // 批处理相关。
  if (isBatchingUpdates) {
    // Flush work at the end of the batch.
    // 翻译：在批处理结束时会从调度队列"刷出"任务。
    if (isUnbatchingUpdates) {
      // ...unless we're inside unbatchedUpdates, in which case we should
      // flush it now.
      // 翻译：除非我们在unbatchedUpdates状态，我们现在应该"刷出"它。
      nextFlushedRoot = root;
      nextFlushedExpirationTime = Sync;
      performWorkOnRoot(root, Sync, true);
    }
    return;
  }

  // TODO: Get rid of Sync and use current time?
  if (expirationTime === Sync) {
    // 如果是同步更新，就采用无法被打断的同步渲染。(旧版本的React就只有这种模式)
    performSyncWork();
  } else {
    // 如果是异步更新，就采用异步调度。
    scheduleCallbackWithExpirationTime(root, expirationTime);
  }
}

/**
 * 将FiberRoot对象加入调度列表，其实就是一个环形单向链表。
 * @param root FiberRoot对象
 * @param expirationTime FiberRoot上的"过期时间"
 */
function addRootToSchedule(root: FiberRoot, expirationTime: ExpirationTime) {
  // Add the root to the schedule.
  // Check if this root is already part of the schedule.
  // 翻译：将FiberRoot对象添加到调度。
  //      检查此FiberRoot对象是否已在调度队列中。
  if (root.nextScheduledRoot === null) {
    // This root is not already scheduled. Add it.
    // 翻译：当前的FiberRoot对象没有在调度队列中，添加它。
    root.expirationTime = expirationTime;
    if (lastScheduledRoot === null) {
      // 如果链表上只有一个的情况，直接将firstScheduledRoot和lastScheduledRoot置为相同，
      // nextScheduledRoot属性也是指向自身。
      firstScheduledRoot = lastScheduledRoot = root;
      root.nextScheduledRoot = root;
    } else {
      // 如果链表上有其他，就添加到后面。
      lastScheduledRoot.nextScheduledRoot = root;
      lastScheduledRoot = root;
      // 这里可见链表是环状的，尾部的nextScheduledRoot指向头部，但也许只是起到占位非null的作用。
      lastScheduledRoot.nextScheduledRoot = firstScheduledRoot;
    }
  } else {
    // This root is already scheduled, but its priority may have increased.
    // 翻译：该FiberRoot对象已在调度队列，但是其优先级可能已提高。
    // FiberRoot对象上的expirationTime永远都是最优先的节点的"过期时间"。
    const remainingExpirationTime = root.expirationTime;
    if (
      remainingExpirationTime === NoWork ||
      expirationTime < remainingExpirationTime
    ) {
      // Update the priority.
      // 翻译：更新优先级。
      root.expirationTime = expirationTime;
    }
  }
}

/**
 * 寻找最高优先级的root节点。
 * 这个函数会将找到的root节点记录在nextFlushedRoot，过期时间记录在nextFlushedExpirationTime。
 */
function findHighestPriorityRoot() {
  let highestPriorityWork = NoWork;
  let highestPriorityRoot = null;
  if (lastScheduledRoot !== null) {
    // 从第一个开始遍历，root节点是一个环状的单向链表。
    let previousScheduledRoot = lastScheduledRoot;
    let root = firstScheduledRoot;
    while (root !== null) {
      const remainingExpirationTime = root.expirationTime;
      if (remainingExpirationTime === NoWork) {
        // 如果当前的的root的"过期时间"是NoWork，即没有任务，就要将这个节点在链表里移除。
        // This root no longer has work. Remove it from the scheduler.
        // 翻译：该根节点不再起作用。从调度程序中删除它。

        // TODO: This check is redudant, but Flow is confused by the branch
        // below where we set lastScheduledRoot to null, even though we break
        // from the loop right after.
        invariant(
          previousScheduledRoot !== null && lastScheduledRoot !== null,
          'Should have a previous and last root. This error is likely ' +
            'caused by a bug in React. Please file an issue.',
        );
        if (root === root.nextScheduledRoot) {
          // This is the only root in the list.
          // 翻译：这是队列中的唯一根节点。
          // 清空不能忘了本身的nextScheduledRoot，循环引用自己也会造成内存泄露。
          root.nextScheduledRoot = null;
          firstScheduledRoot = lastScheduledRoot = null;
          break;
        } else if (root === firstScheduledRoot) {
          // This is the first root in the list.
          // 翻译：这是队列中的第一个根节点。
          const next = root.nextScheduledRoot;
          firstScheduledRoot = next;
          lastScheduledRoot.nextScheduledRoot = next;
          // 防止内存泄露。
          root.nextScheduledRoot = null;
        } else if (root === lastScheduledRoot) {
          // This is the last root in the list.
          // 翻译：这是队列中的最后一个根节点。
          lastScheduledRoot = previousScheduledRoot;
          lastScheduledRoot.nextScheduledRoot = firstScheduledRoot;
          // 防止内存泄露。
          root.nextScheduledRoot = null;
          break;
        } else {
          previousScheduledRoot.nextScheduledRoot = root.nextScheduledRoot;
          // 防止内存泄露。
          root.nextScheduledRoot = null;
        }
        // 进入下一个节点。
        root = previousScheduledRoot.nextScheduledRoot;
      } else {
        // 这是root节点上有任务的情况。
        if (
          highestPriorityWork === NoWork ||
          remainingExpirationTime < highestPriorityWork
        ) {
          // Update the priority, if it's higher
          // 翻译：更新优先级（如果更高）。
          highestPriorityWork = remainingExpirationTime;
          highestPriorityRoot = root;
        }
        if (root === lastScheduledRoot) {
          // 已经是最后一个，不需要遍历了。
          break;
        }
        if (highestPriorityWork === Sync) {
          // Sync is highest priority by definition so
          // we can stop searching.
          // 翻译：根据定义，同步是最高优先级，因此我们可以停止搜索。
          break;
        }
        // 下一个节点，继续遍历。
        previousScheduledRoot = root;
        root = root.nextScheduledRoot;
      }
    }
  }

  // 如果lastScheduledRoot为null，就证明没有root。
  // nextFlushedRoot就是默认值null，nextFlushedExpirationTime就是NoWork。
  nextFlushedRoot = highestPriorityRoot;
  nextFlushedExpirationTime = highestPriorityWork;
}

/**
 * 异步执行任务的预处理。
 * @param dl 由scheduler传递过来的deadlineObject，结构{timeRemaining, didTimeout}
 */
function performAsyncWork(dl) {
  if (dl.didTimeout) {
    // The callback timed out. That means at least one update has expired.
    // Iterate through the root schedule. If they contain expired work, set
    // the next render expiration time to the current time. This has the effect
    // of flushing all expired work in a single batch, instead of flushing each
    // level one at a time.
    // 翻译：回调超时。这意味着至少一个更新已过期。遍历根进行调度。
    //      如果它们包含到期的任务，请将下一个渲染到期时间设置为当前时间。
    //      这具有一次执行所有过期任务的效果，而不是一次只执行一个级别的任务。
    if (firstScheduledRoot !== null) {
      // 重新计算js加载完成到当前的时间。
      recomputeCurrentRendererTime();
      let root: FiberRoot = firstScheduledRoot;
      do {
        // 在root上增加一个过期的标记字段，即root.nextExpirationTimeToWorkOn。
        didExpireAtExpirationTime(root, currentRendererTime);
        // The root schedule is circular, so this is never null.
        // 翻译：根调度是循环的，因此永远不会为空。
        root = (root.nextScheduledRoot: any);
      } while (root !== firstScheduledRoot);
    }
  }
  performWork(NoWork, dl);
}

/**
 * 同步执行任务的预处理。
 */
function performSyncWork() {
  performWork(Sync, null);
}

/**
 * 执行工作
 * @param minExpirationTime 最小过期时间
 * @param dl DeferredCallbackScheduler传递过来的deadlineObject
 */
function performWork(minExpirationTime: ExpirationTime, dl: Deadline | null) {
  deadline = dl;

  // Keep working on roots until there's no more work, or until we reach
  // the deadline.
  // 翻译：继续在根节点上的工作，直到没有更多工作或直到截止日期为止。
  // 寻找最高优先级的root节点，结果会记录到nextFlushedRoot和nextFlushedExpirationTime。
  findHighestPriorityRoot();

  if (deadline !== null) {
    // 异步任务的情况。
    // 重新计算currentRendererTime。
    recomputeCurrentRendererTime();
    currentSchedulerTime = currentRendererTime;

    // 性能记录。
    if (enableUserTimingAPI) {
      const didExpire = nextFlushedExpirationTime < currentRendererTime;
      const timeout = expirationTimeToMs(nextFlushedExpirationTime);
      stopRequestCallbackTimer(didExpire, timeout);
    }

    while (
      nextFlushedRoot !== null &&
      nextFlushedExpirationTime !== NoWork &&
      (minExpirationTime === NoWork ||
        minExpirationTime >= nextFlushedExpirationTime) &&
      (!deadlineDidExpire || currentRendererTime >= nextFlushedExpirationTime)
    ) {
      // 循环条件就是有任务，已经到期的任务，时间片还有时间。
      performWorkOnRoot(
        nextFlushedRoot,
        nextFlushedExpirationTime,
        // 过期为true，没过期为false。
        currentRendererTime >= nextFlushedExpirationTime,
      );
      findHighestPriorityRoot();
      // 更新currentRendererTime。
      recomputeCurrentRendererTime();
      currentSchedulerTime = currentRendererTime;
    }
  } else {
    // 这里就是调用performSyncWork的时候deadline为null。
    while (
      nextFlushedRoot !== null &&
      nextFlushedExpirationTime !== NoWork &&
      (minExpirationTime === NoWork ||
        minExpirationTime >= nextFlushedExpirationTime)
    ) {
      // 循环条件就是有任务，并且是同步任务，遍历所有有任务的root节点，并执行更新。
      performWorkOnRoot(nextFlushedRoot, nextFlushedExpirationTime, true);
      findHighestPriorityRoot();
    }
  }

  // We're done flushing work. Either we ran out of time in this callback,
  // or there's no more work left with sufficient priority.
  // 翻译：我们已经完成"刷出"工作。要么我们在此回调中用完了时间，要么没有足够的优先级剩下更多的工作了。

  // If we're inside a callback, set this to false since we just completed it.
  // 翻译：如果我们在回调内部，则将其设置为false，因为我们刚刚完成了它。
  // 清理由调用scheduleCallbackWithExpirationTime时改变的两个值。
  if (deadline !== null) {
    callbackExpirationTime = NoWork;
    callbackID = null;
  }
  // If there's work left over, schedule a new callback.
  // 翻译：如果还有剩下的任务，安排一个新的回调。
  if (nextFlushedExpirationTime !== NoWork) {
    scheduleCallbackWithExpirationTime(
      ((nextFlushedRoot: any): FiberRoot),
      nextFlushedExpirationTime,
    );
  }

  // Clean-up.
  // 翻译：清理。
  deadline = null;
  deadlineDidExpire = false;

  finishRendering();
}

function flushRoot(root: FiberRoot, expirationTime: ExpirationTime) {
  invariant(
    !isRendering,
    'work.commit(): Cannot commit while already rendering. This likely ' +
      'means you attempted to commit from inside a lifecycle method.',
  );
  // Perform work on root as if the given expiration time is the current time.
  // This has the effect of synchronously flushing all work up to and
  // including the given time.
  nextFlushedRoot = root;
  nextFlushedExpirationTime = expirationTime;
  performWorkOnRoot(root, expirationTime, true);
  // Flush any sync work that was scheduled by lifecycles
  performSyncWork();
}

function finishRendering() {
  nestedUpdateCount = 0;
  lastCommittedRootDuringThisBatch = null;

  if (completedBatches !== null) {
    const batches = completedBatches;
    completedBatches = null;
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      try {
        batch._onComplete();
      } catch (error) {
        if (!hasUnhandledError) {
          hasUnhandledError = true;
          unhandledError = error;
        }
      }
    }
  }

  if (hasUnhandledError) {
    const error = unhandledError;
    unhandledError = null;
    hasUnhandledError = false;
    throw error;
  }
}

/**
 * 在root节点上执行渲染任务。
 * @param root 根节点
 * @param expirationTime 过期时间
 * @param isExpired 是否过期（是否强制输出）
 */
function performWorkOnRoot(
  root: FiberRoot,
  expirationTime: ExpirationTime,
  isExpired: boolean,
) {
  invariant(
    !isRendering,
    'performWorkOnRoot was called recursively. This error is likely caused ' +
      'by a bug in React. Please file an issue.',
  );

  // 开始渲染。
  isRendering = true;

  // Check if this is async work or sync/expired work.
  // 翻译：检查这是异步工作还是同步/过期工作。
  if (deadline === null || isExpired) {
    // 无中断流程。
    // Flush work without yielding.
    // 翻译：无中断执行任务。
    // TODO: Non-yieldy work does not necessarily imply expired work. A renderer
    // may want to perform some work without yielding, but also without
    // requiring the root to complete (by triggering placeholders).

    let finishedWork = root.finishedWork;
    if (finishedWork !== null) {
      // This root is already complete. We can commit it.
      // 翻译：该root节点已经完成。我们可以提交。
      completeRoot(root, finishedWork, expirationTime);
    } else {
      root.finishedWork = null;
      // If this root previously suspended, clear its existing timeout, since
      // we're about to try rendering again.
      // 翻译：如果该root节点先前已暂停，请清除其现有的超时，因为我们将尝试再次渲染。
      const timeoutHandle = root.timeoutHandle;
      if (timeoutHandle !== noTimeout) {
        root.timeoutHandle = noTimeout;
        // $FlowFixMe Complains noTimeout is not a TimeoutID, despite the check above
        cancelTimeout(timeoutHandle);
      }
      // 任务不可中断。
      const isYieldy = false;
      // 渲染。
      renderRoot(root, isYieldy, isExpired);
      // 再次判断是否完成。（保险）
      finishedWork = root.finishedWork;
      if (finishedWork !== null) {
        // We've completed the root. Commit it.
        // 翻译：我们已经完成该root节点。提交它。
        completeRoot(root, finishedWork, expirationTime);
      }
    }
  } else {
    // 可中断流程。
    // Flush async work.
    // 翻译：执行异步任务。
    let finishedWork = root.finishedWork;
    if (finishedWork !== null) {
      // This root is already complete. We can commit it.
      // 翻译：该root节点已经完成。我们可以提交。
      completeRoot(root, finishedWork, expirationTime);
    } else {
      root.finishedWork = null;
      // If this root previously suspended, clear its existing timeout, since
      // we're about to try rendering again.
      // 翻译：如果该root节点先前已暂停，请清除其现有的超时，因为我们将尝试再次渲染。
      const timeoutHandle = root.timeoutHandle;
      if (timeoutHandle !== noTimeout) {
        root.timeoutHandle = noTimeout;
        // $FlowFixMe Complains noTimeout is not a TimeoutID, despite the check above
        cancelTimeout(timeoutHandle);
      }
      // 任务可中断。
      const isYieldy = true;
      // 渲染。
      renderRoot(root, isYieldy, isExpired);
      // 再次判断是否完成。
      finishedWork = root.finishedWork;
      if (finishedWork !== null) {
        // We've completed the root. Check the deadline one more time
        // before committing.
        // 翻译：我们已经完成了root节点。提交前再检查一次截止日期。
        if (!shouldYield()) {
          // Still time left. Commit the root.
          // 翻译：还有时间，提交该root节点。
          completeRoot(root, finishedWork, expirationTime);
        } else {
          // There's no time left. Mark this root as complete. We'll come
          // back and commit it later.
          // 翻译：没有时间了。将此root节点标记为已完成。我们会回来，稍后再提交。
          root.finishedWork = finishedWork;
        }
      }
    }
  }

  // 渲染结束。
  isRendering = false;
}

/**
 * 完成FiberRoot
 * @param root FiberRoot节点
 * @param finishedWork Fiber节点，一般是root.current.alternate
 * @param expirationTime 过期时间
 */
function completeRoot(
  root: FiberRoot,
  finishedWork: Fiber,
  expirationTime: ExpirationTime,
): void {
  // Check if there's a batch that matches this expiration time.
  // 翻译：检查是否有与此到期时间匹配的批次。
  const firstBatch = root.firstBatch;
  if (firstBatch !== null && firstBatch._expirationTime <= expirationTime) {
    if (completedBatches === null) {
      completedBatches = [firstBatch];
    } else {
      completedBatches.push(firstBatch);
    }
    if (firstBatch._defer) {
      // This root is blocked from committing by a batch. Unschedule it until
      // we receive another update.
      // 翻译：批量阻止此root的提交。取消安排它，直到我们收到另一个更新。
      root.finishedWork = finishedWork;
      root.expirationTime = NoWork;
      return;
    }
  }

  // Commit the root.
  // 翻译：提交根节点。
  // 这里是重置了状态。
  root.finishedWork = null;

  // Check if this is a nested update (a sync update scheduled during the
  // commit phase).
  // 翻译：检查这是否是嵌套更新（在提交阶段安排的同步更新）。
  if (root === lastCommittedRootDuringThisBatch) {
    // If the next root is the same as the previous root, this is a nested
    // update. To prevent an infinite loop, increment the nested update count.
    // 翻译：如果下一个root与上一个root相同，则为嵌套更新。为防止无限循环，请增加嵌套更新计数。
    nestedUpdateCount++;
  } else {
    // Reset whenever we switch roots.
    // 翻译：每当我们切换root时，请重置。
    lastCommittedRootDuringThisBatch = root;
    nestedUpdateCount = 0;
  }
  commitRoot(root, finishedWork);
}

// When working on async work, the reconciler asks the renderer if it should
// yield execution. For DOM, we implement this with requestIdleCallback.
// 翻译：在进行异步工作时，协调器会询问渲染器是否应该推迟执行。
//      对于DOM，我们使用requestIdleCallback实现此功能。
/**
 * 判断时间片是否还有时间。
 * @return {boolean}
 */
function shouldYield() {
  if (deadlineDidExpire) {
    return true;
  }
  if (
    deadline === null ||
    deadline.timeRemaining() > timeHeuristicForUnitOfWork
  ) {
    // Disregard deadline.didTimeout. Only expired work should be flushed
    // during a timeout. This path is only hit for non-expired work.
    // 翻译：忽略deadline.didTimeout。在超时期间，仅清除过期的任务。仅对未到期的任务使用此路径。
    return false;
  }
  deadlineDidExpire = true;
  return true;
}

function onUncaughtError(error: mixed) {
  invariant(
    nextFlushedRoot !== null,
    'Should be working on a root. This error is likely caused by a bug in ' +
      'React. Please file an issue.',
  );
  // Unschedule this root so we don't work on it again until there's
  // another update.
  nextFlushedRoot.expirationTime = NoWork;
  if (!hasUnhandledError) {
    hasUnhandledError = true;
    unhandledError = error;
  }
}

// TODO: Batching should be implemented at the renderer level, not inside
// the reconciler.
/**
 * 批量更新。
 * @param fn 需要执行的函数
 * @param a fn的参数
 * @return {R}
 */
function batchedUpdates<A, R>(fn: (a: A) => R, a: A): R {
  const previousIsBatchingUpdates = isBatchingUpdates;
  isBatchingUpdates = true;
  try {
    return fn(a);
  } finally {
    isBatchingUpdates = previousIsBatchingUpdates;
    if (!isBatchingUpdates && !isRendering) {
      performSyncWork();
    }
  }
}

// TODO: Batching should be implemented at the renderer level, not inside
// the reconciler.
/**
 * 非批量更新。
 * @param fn 需要执行的函数
 * @param a fn的参数
 * @return {R}
 */
function unbatchedUpdates<A, R>(fn: (a: A) => R, a: A): R {
  if (isBatchingUpdates && !isUnbatchingUpdates) {
    isUnbatchingUpdates = true;
    try {
      return fn(a);
    } finally {
      isUnbatchingUpdates = false;
    }
  }
  return fn(a);
}

// TODO: Batching should be implemented at the renderer level, not within
// the reconciler.
function flushSync<A, R>(fn: (a: A) => R, a: A): R {
  invariant(
    !isRendering,
    'flushSync was called from inside a lifecycle method. It cannot be ' +
      'called when React is already rendering.',
  );
  const previousIsBatchingUpdates = isBatchingUpdates;
  isBatchingUpdates = true;
  try {
    return syncUpdates(fn, a);
  } finally {
    isBatchingUpdates = previousIsBatchingUpdates;
    performSyncWork();
  }
}

function interactiveUpdates<A, B, R>(fn: (A, B) => R, a: A, b: B): R {
  if (isBatchingInteractiveUpdates) {
    return fn(a, b);
  }
  // If there are any pending interactive updates, synchronously flush them.
  // This needs to happen before we read any handlers, because the effect of
  // the previous event may influence which handlers are called during
  // this event.
  if (
    !isBatchingUpdates &&
    !isRendering &&
    lowestPriorityPendingInteractiveExpirationTime !== NoWork
  ) {
    // Synchronously flush pending interactive updates.
    performWork(lowestPriorityPendingInteractiveExpirationTime, null);
    lowestPriorityPendingInteractiveExpirationTime = NoWork;
  }
  const previousIsBatchingInteractiveUpdates = isBatchingInteractiveUpdates;
  const previousIsBatchingUpdates = isBatchingUpdates;
  isBatchingInteractiveUpdates = true;
  isBatchingUpdates = true;
  try {
    return fn(a, b);
  } finally {
    isBatchingInteractiveUpdates = previousIsBatchingInteractiveUpdates;
    isBatchingUpdates = previousIsBatchingUpdates;
    if (!isBatchingUpdates && !isRendering) {
      performSyncWork();
    }
  }
}

function flushInteractiveUpdates() {
  if (
    !isRendering &&
    lowestPriorityPendingInteractiveExpirationTime !== NoWork
  ) {
    // Synchronously flush pending interactive updates.
    performWork(lowestPriorityPendingInteractiveExpirationTime, null);
    lowestPriorityPendingInteractiveExpirationTime = NoWork;
  }
}

function flushControlled(fn: () => mixed): void {
  const previousIsBatchingUpdates = isBatchingUpdates;
  isBatchingUpdates = true;
  try {
    syncUpdates(fn);
  } finally {
    isBatchingUpdates = previousIsBatchingUpdates;
    if (!isBatchingUpdates && !isRendering) {
      performSyncWork();
    }
  }
}

export {
  requestCurrentTime,
  computeExpirationForFiber,
  captureCommitPhaseError,
  onUncaughtError,
  renderDidSuspend,
  renderDidError,
  retrySuspendedRoot,
  markLegacyErrorBoundaryAsFailed,
  isAlreadyFailedLegacyErrorBoundary,
  scheduleWork,
  requestWork,
  flushRoot,
  batchedUpdates,
  unbatchedUpdates,
  flushSync,
  flushControlled,
  deferredUpdates,
  syncUpdates,
  interactiveUpdates,
  flushInteractiveUpdates,
  computeUniqueAsyncExpiration,
};
