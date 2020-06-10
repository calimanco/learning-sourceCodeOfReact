/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {ReactProviderType, ReactContext} from 'shared/ReactTypes';
import type {Fiber} from 'react-reconciler/src/ReactFiber';
import type {FiberRoot} from './ReactFiberRoot';
import type {ExpirationTime} from './ReactFiberExpirationTime';
import type {SuspenseState} from './ReactFiberSuspenseComponent';

import checkPropTypes from 'prop-types/checkPropTypes';

import {
  IndeterminateComponent,
  FunctionComponent,
  ClassComponent,
  HostRoot,
  HostComponent,
  HostText,
  HostPortal,
  ForwardRef,
  Fragment,
  Mode,
  ContextProvider,
  ContextConsumer,
  Profiler,
  SuspenseComponent,
  MemoComponent,
  SimpleMemoComponent,
  LazyComponent,
  IncompleteClassComponent,
} from 'shared/ReactWorkTags';
import {
  NoEffect,
  PerformedWork,
  Placement,
  ContentReset,
  DidCapture,
  Update,
  Ref,
} from 'shared/ReactSideEffectTags';
import ReactSharedInternals from 'shared/ReactSharedInternals';
import {
  debugRenderPhaseSideEffects,
  debugRenderPhaseSideEffectsForStrictMode,
  enableProfilerTimer,
} from 'shared/ReactFeatureFlags';
import invariant from 'shared/invariant';
import shallowEqual from 'shared/shallowEqual';
import getComponentName from 'shared/getComponentName';
import ReactStrictModeWarnings from './ReactStrictModeWarnings';
import warning from 'shared/warning';
import warningWithoutStack from 'shared/warningWithoutStack';
import * as ReactCurrentFiber from './ReactCurrentFiber';
import {startWorkTimer, cancelWorkTimer} from './ReactDebugFiberPerf';

import {
  mountChildFibers,
  reconcileChildFibers,
  cloneChildFibers,
} from './ReactChildFiber';
import {processUpdateQueue} from './ReactUpdateQueue';
import {NoWork, Never} from './ReactFiberExpirationTime';
import {ConcurrentMode, StrictMode} from './ReactTypeOfMode';
// 文件实际在 packages/react-dom/src/client/ReactDOMHostConfig.js
import {
  shouldSetTextContent,
  shouldDeprioritizeSubtree,
} from './ReactFiberHostConfig';
import {pushHostContext, pushHostContainer} from './ReactFiberHostContext';
import {
  pushProvider,
  propagateContextChange,
  readContext,
  prepareToReadContext,
  calculateChangedBits,
} from './ReactFiberNewContext';
import {stopProfilerTimerIfRunning} from './ReactProfilerTimer';
import {
  getMaskedContext,
  getUnmaskedContext,
  hasContextChanged as hasLegacyContextChanged,
  pushContextProvider as pushLegacyContextProvider,
  isContextProvider as isLegacyContextProvider,
  pushTopLevelContextObject,
  invalidateContextProvider,
} from './ReactFiberContext';
import {
  enterHydrationState,
  resetHydrationState,
  tryToClaimNextHydratableInstance,
} from './ReactFiberHydrationContext';
import {
  adoptClassInstance,
  applyDerivedStateFromProps,
  constructClassInstance,
  mountClassInstance,
  resumeMountClassInstance,
  updateClassInstance,
} from './ReactFiberClassComponent';
import {readLazyComponentType} from './ReactFiberLazyComponent';
import {
  resolveLazyComponentTag,
  createFiberFromTypeAndProps,
  createFiberFromFragment,
  createWorkInProgress,
  isSimpleFunctionComponent,
} from './ReactFiber';

const ReactCurrentOwner = ReactSharedInternals.ReactCurrentOwner;

let didWarnAboutBadClass;
let didWarnAboutContextTypeOnFunctionComponent;
let didWarnAboutGetDerivedStateOnFunctionComponent;
let didWarnAboutFunctionRefs;

if (__DEV__) {
  didWarnAboutBadClass = {};
  didWarnAboutContextTypeOnFunctionComponent = {};
  didWarnAboutGetDerivedStateOnFunctionComponent = {};
  didWarnAboutFunctionRefs = {};
}

/**
 * 调和子节点。
 * @param current 当前处理的Fiber对象，可能为空
 * @param workInProgress 当前处理的Fiber对象的进行中副本
 * @param nextChildren 新的React元素
 * @param renderExpirationTime 当前处理的Fiber所在的FiberRoot的nextExpirationTimeToWorkOn
 */
export function reconcileChildren(
  current: Fiber | null,
  workInProgress: Fiber,
  nextChildren: any,
  renderExpirationTime: ExpirationTime,
) {
  if (current === null) {
    // 第一次渲染。这时候当然子节点都是没有的。
    // If this is a fresh new component that hasn't been rendered yet, we
    // won't update its child set by applying minimal side-effects. Instead,
    // we will add them all to the child before it gets rendered. That means
    // we can optimize this reconciliation pass by not tracking side-effects.
    // 翻译：如果这是一个尚未渲染的全新组件，那么我们不会通过应用最小的副作用来更新其子集。
    //      相反，我们会在渲染当前节点之前将它们全部添加到子对象中。
    //      这意味着我们可以通过不跟踪副作用来优化此调和流程。
    workInProgress.child = mountChildFibers(
      workInProgress,
      null,
      nextChildren,
      renderExpirationTime,
    );
  } else {
    // 非第一次渲染，current.child是存在的。
    // If the current child is the same as the work in progress, it means that
    // we haven't yet started any work on these children. Therefore, we use
    // the clone algorithm to create a copy of all the current children.
    // 翻译：如果当前子节点与正在进行的工作相同，则意味着我们尚未对这些子节点进行任何工作。
    //      因此，我们使用克隆算法来创建所有当前子代的副本。

    // If we had any progressed work already, that is invalid at this point so
    // let's throw it out.
    // 翻译：如果我们已经有任何进行中的工作，那么在这一点上这是无效的，因此我们将其丢弃。
    workInProgress.child = reconcileChildFibers(
      workInProgress,
      current.child,
      nextChildren,
      renderExpirationTime,
    );
  }
}

/**
 * 强制更新子节点。
 * @param current 当前处理的Fiber对象，可能为空
 * @param workInProgress 当前处理的Fiber对象的进行中副本
 * @param nextChildren 新的React元素
 * @param renderExpirationTime 当前处理的Fiber所在的FiberRoot的nextExpirationTimeToWorkOn
 */
function forceUnmountCurrentAndReconcile(
  current: Fiber,
  workInProgress: Fiber,
  nextChildren: any,
  renderExpirationTime: ExpirationTime,
) {
  // This function is fork of reconcileChildren. It's used in cases where we
  // want to reconcile without matching against the existing set. This has the
  // effect of all current children being unmounted; even if the type and key
  // are the same, the old child is unmounted and a new child is created.
  // 翻译：此功能是reconcileChildren的分支。在我们希望不与现有集合匹配的情况下进行调和时使用。
  //      这会导致当前所有子级都被卸载；即使类型和键相同，也会卸载旧的子项并创建一个新的子项。
  //
  // To do this, we're going to go through the reconcile algorithm twice. In
  // the first pass, we schedule a deletion for all the current children by
  // passing null.
  // 翻译：为此，我们将两次进行协调算法。在第一次遍历中，我们通过传递null删除当前所有子节点。
  workInProgress.child = reconcileChildFibers(
    workInProgress,
    current.child,
    null,
    renderExpirationTime,
  );
  // In the second pass, we mount the new children. The trick here is that we
  // pass null in place of where we usually pass the current child set. This has
  // the effect of remounting all children regardless of whether their their
  // identity matches.
  // 翻译：在第二次遍历中，我们挂载了新的子节点。这里的窍门是我们传递null来代替通常传递当前子节点的位置。
  //      这具有重新挂载所有子节点的作用，无论其类型是否匹配。
  workInProgress.child = reconcileChildFibers(
    workInProgress,
    null,
    nextChildren,
    renderExpirationTime,
  );
}

/**
 * 更新ForwardRef节点
 * @param current 当前处理的Fiber对象，可能为空
 * @param workInProgress 当前处理的Fiber对象的进行中副本
 * @param type workInProgress的type，也是React.forwardRef的返回内容
 * @param nextProps 新的props对象
 * @param renderExpirationTime 当前处理的Fiber所在的FiberRoot的nextExpirationTimeToWorkOn
 * @return {Fiber}
 */
function updateForwardRef(
  current: Fiber | null,
  workInProgress: Fiber,
  type: any,
  nextProps: any,
  renderExpirationTime: ExpirationTime,
) {
  // 这个render就是React.forwardRef传递的回调函数。
  const render = type.render;
  // 取出当前fiber对象的引用。
  const ref = workInProgress.ref;
  if (hasLegacyContextChanged()) {
    // Normally we can bail out on props equality but if context has changed
    // we don't do the bailout and we have to reuse existing props instead.
    // 翻译：通常情况下，当新旧props相等时我们可以执行跳出操作，但是如果context发生变化，
    //      我们将不进行跳出，而必须重用现有的props。
  } else if (workInProgress.memoizedProps === nextProps) {
    // 新旧props没有改变，如果ref也没变则可以跳出。
    const currentRef = current !== null ? current.ref : null;
    if (ref === currentRef) {
      return bailoutOnAlreadyFinishedWork(
        current,
        workInProgress,
        renderExpirationTime,
      );
    }
  }

  let nextChildren;
  if (__DEV__) {
    ReactCurrentOwner.current = workInProgress;
    ReactCurrentFiber.setCurrentPhase('render');
    nextChildren = render(nextProps, ref);
    ReactCurrentFiber.setCurrentPhase(null);
  } else {
    // 这个就是回调函数接受的两个参数。React.forwardRef((props, ref) => ());
    // 由此可见ref是来自workInProgress.ref，可能会没有。
    nextChildren = render(nextProps, ref);
  }

  // 重新渲染，调和子节点。
  reconcileChildren(
    current,
    workInProgress,
    nextChildren,
    renderExpirationTime,
  );
  return workInProgress.child;
}

/**
 * 更新Memo组件，有记忆效果的函数组件。
 * @param current 当前处理的Fiber对象，可能为空
 * @param workInProgress 当前处理的Fiber对象的进行中副本
 * @param Component workInProgress的type，React.memo返回的内容
 * @param nextProps 新的props对象
 * @param updateExpirationTime workInProgress上的expirationTime
 * @param renderExpirationTime 当前处理的Fiber所在的FiberRoot的nextExpirationTimeToWorkOn
 * @return {Fiber}
 */
function updateMemoComponent(
  current: Fiber | null,
  workInProgress: Fiber,
  Component: any,
  nextProps: any,
  updateExpirationTime,
  renderExpirationTime: ExpirationTime,
): null | Fiber {
  if (current === null) {
    // type就是函数组件。
    let type = Component.type;
    // isSimpleFunctionComponent是用来判断函数组件是否有默认值的函数，没有默认值则为true。
    // compare就是使用memo的时候传入的第二个参数，一个对比新旧props的函数。
    if (isSimpleFunctionComponent(type) && Component.compare === null) {
      // If this is a plain function component without default props,
      // and with only the default shallow comparison, we upgrade it
      // to a SimpleMemoComponent to allow fast path updates.
      // 翻译：如果这是一个没有默认props的纯函数组件，并且仅具有默认的浅表比较，
      //      则我们将其升级为SimpleMemoComponent以允许快速更新路径。
      // 这里会改写tag，这会导致以后这个节点更新将直接进入updateSimpleMemoComponent。
      workInProgress.tag = SimpleMemoComponent;
      // type也被改写成函数组件。
      workInProgress.type = type;
      return updateSimpleMemoComponent(
        current,
        workInProgress,
        type,
        nextProps,
        updateExpirationTime,
        renderExpirationTime,
      );
    }
    // 直接生成子节点，因为它的子节点很明确是一个函数组件。
    let child = createFiberFromTypeAndProps(
      Component.type,
      null,
      nextProps,
      null,
      workInProgress.mode,
      renderExpirationTime,
    );
    child.ref = workInProgress.ref;
    child.return = workInProgress;
    workInProgress.child = child;
    return child;
  }
  // 二次渲染的情况。
  let currentChild = ((current.child: any): Fiber); // This is always exactly one child
  if (
    updateExpirationTime === NoWork ||
    updateExpirationTime > renderExpirationTime
  ) {
    // This will be the props with resolved defaultProps,
    // unlike current.memoizedProps which will be the unresolved ones.
    // 翻译：这将是带有解析过的默认值的props，跟未解析的current.memoizedProps不同。
    const prevProps = currentChild.memoizedProps;
    // Default to shallow comparison
    // 翻译：默认进行浅比较。
    let compare = Component.compare;
    compare = compare !== null ? compare : shallowEqual;
    if (compare(prevProps, nextProps) && current.ref === workInProgress.ref) {
      return bailoutOnAlreadyFinishedWork(
        current,
        workInProgress,
        renderExpirationTime,
      );
    }
  }
  let newChild = createWorkInProgress(
    currentChild,
    nextProps,
    renderExpirationTime,
  );
  newChild.ref = workInProgress.ref;
  newChild.return = workInProgress;
  workInProgress.child = newChild;
  return newChild;
}

/**
 * 更新纯的带记忆功能的函数组件。（没有默认值和自定义判断是否更新的函数）
 * @param current 当前处理的Fiber对象，可能为空
 * @param workInProgress 当前处理的Fiber对象的进行中副本
 * @param Component workInProgress的type，使用者写的函数组件
 * @param nextProps 新的props对象
 * @param updateExpirationTime workInProgress上的expirationTime
 * @param renderExpirationTime 当前处理的Fiber所在的FiberRoot的nextExpirationTimeToWorkOn
 * @return {Fiber|*}
 */
function updateSimpleMemoComponent(
  current: Fiber | null,
  workInProgress: Fiber,
  Component: any,
  nextProps: any,
  updateExpirationTime,
  renderExpirationTime: ExpirationTime,
): null | Fiber {
  if (
    // 二次渲染。
    current !== null &&
    // 没有更新任务或优先级较低。
    (updateExpirationTime === NoWork ||
      updateExpirationTime > renderExpirationTime)
  ) {
    const prevProps = current.memoizedProps;
    if (
      // 浅比较新旧props。
      shallowEqual(prevProps, nextProps) &&
      current.ref === workInProgress.ref
    ) {
      // 判断不需要更新，跳出。
      return bailoutOnAlreadyFinishedWork(
        current,
        workInProgress,
        renderExpirationTime,
      );
    }
  }
  // 需要更新，本质还是函数组件。
  return updateFunctionComponent(
    current,
    workInProgress,
    Component,
    nextProps,
    renderExpirationTime,
  );
}

function updateFragment(
  current: Fiber | null,
  workInProgress: Fiber,
  renderExpirationTime: ExpirationTime,
) {
  const nextChildren = workInProgress.pendingProps;
  reconcileChildren(
    current,
    workInProgress,
    nextChildren,
    renderExpirationTime,
  );
  return workInProgress.child;
}

/**
 * 更新React内置的特殊组件，比如ConcurrentMode和StrictMode。
 * @param current 当前处理的Fiber对象，可能为空
 * @param workInProgress 当前处理的Fiber对象的进行中副本
 * @param renderExpirationTime 当前处理的Fiber所在的FiberRoot的nextExpirationTimeToWorkOn
 * @return {Fiber}
 */
function updateMode(
  current: Fiber | null,
  workInProgress: Fiber,
  renderExpirationTime: ExpirationTime,
) {
  const nextChildren = workInProgress.pendingProps.children;
  reconcileChildren(
    current,
    workInProgress,
    nextChildren,
    renderExpirationTime,
  );
  return workInProgress.child;
}

function updateProfiler(
  current: Fiber | null,
  workInProgress: Fiber,
  renderExpirationTime: ExpirationTime,
) {
  if (enableProfilerTimer) {
    workInProgress.effectTag |= Update;
  }
  const nextProps = workInProgress.pendingProps;
  const nextChildren = nextProps.children;
  reconcileChildren(
    current,
    workInProgress,
    nextChildren,
    renderExpirationTime,
  );
  return workInProgress.child;
}

function markRef(current: Fiber | null, workInProgress: Fiber) {
  const ref = workInProgress.ref;
  if (
    (current === null && ref !== null) ||
    (current !== null && current.ref !== ref)
  ) {
    // Schedule a Ref effect
    workInProgress.effectTag |= Ref;
  }
}

/**
 * 更新函数组件。
 * @param current 当前处理的Fiber对象，可能为空
 * @param workInProgress 当前处理的Fiber对象的进行中副本
 * @param Component workInProgress的type，使用者写的函数组件
 * @param nextProps 新的props对象
 * @param renderExpirationTime 当前处理的Fiber所在的FiberRoot的nextExpirationTimeToWorkOn
 * @return {*} 当前Fiber对象的子级（也是Fiber）或是null
 */
function updateFunctionComponent(
  current,
  workInProgress,
  Component,
  nextProps: any,
  renderExpirationTime,
) {
  // context相关。
  const unmaskedContext = getUnmaskedContext(workInProgress, Component, true);
  const context = getMaskedContext(workInProgress, unmaskedContext);

  let nextChildren;
  prepareToReadContext(workInProgress, renderExpirationTime);
  if (__DEV__) {
    ReactCurrentOwner.current = workInProgress;
    ReactCurrentFiber.setCurrentPhase('render');
    nextChildren = Component(nextProps, context);
    ReactCurrentFiber.setCurrentPhase(null);
  } else {
    // Component其实就是使用者写的函数组件。props就是我们在函数里接收到的第一个参数。
    // 这里有一个文档里没有提及的点，函数第二个参数是context。
    nextChildren = Component(nextProps, context);
  }

  // React DevTools reads this flag.
  // 翻译：React DevTools读取此标志。
  // effectTag使用的是二进制定义的状态标记，或就是添加状态。
  workInProgress.effectTag |= PerformedWork;
  // 为React元素生成对应的Fiber对象，挂载child。
  reconcileChildren(
    current,
    workInProgress,
    nextChildren,
    renderExpirationTime,
  );
  // 返回当前处理的Fiber对象的子节点。
  return workInProgress.child;
}

/**
 * 更新类组件
 * @param current 当前处理的Fiber对象，可能为空
 * @param workInProgress 当前处理的Fiber对象的进行中副本
 * @param Component workInProgress的type，使用者写的类组件
 * @param nextProps 新的props对象
 * @param renderExpirationTime 当前处理的Fiber所在的FiberRoot的nextExpirationTimeToWorkOn
 * @return {Fiber|Fiber.child}
 */
function updateClassComponent(
  current: Fiber | null,
  workInProgress: Fiber,
  Component: any,
  nextProps,
  renderExpirationTime: ExpirationTime,
) {
  // Push context providers early to prevent context stack mismatches.
  // During mounting we don't know the child context yet as the instance doesn't exist.
  // We will invalidate the child context in finishClassComponent() right after rendering.
  // 翻译：尽早推送context providers，以防止context堆栈不匹配。
  //      在挂载期间，我们还不知道子节点的context，因为该实例不存在。
  //      渲染后，我们将在finishClassComponent()中使子节点的context无效。
  // context相关
  let hasContext;
  if (isLegacyContextProvider(Component)) {
    hasContext = true;
    pushLegacyContextProvider(workInProgress);
  } else {
    hasContext = false;
  }
  prepareToReadContext(workInProgress, renderExpirationTime);

  // instance即是new操作类返回的实例对象。
  const instance = workInProgress.stateNode;
  let shouldUpdate;
  if (instance === null) {
    if (current !== null) {
      // 第一次渲染，但却有current，这种特殊情况会出现在suspend组件时。
      // 之前一次渲染的时候它抛出promise，并没有生成实例，这里需要重置它一些状态，让它符合首次渲染的要求。
      // An class component without an instance only mounts if it suspended
      // inside a non- concurrent tree, in an inconsistent state. We want to
      // tree it like a new mount, even though an empty version of it already
      // committed. Disconnect the alternate pointers.
      // 翻译：没有实例的类组件只有在以非同步状态挂载在非并发树中时才挂载。
      //      尽管它已经提交了一个空版本，但我们仍希望像新的挂载一样将其树化。断开alternate指针。
      current.alternate = null;
      workInProgress.alternate = null;
      // Since this is conceptually a new fiber, schedule a Placement effect
      // 翻译：由于从概念上讲这是一个新Fiber对象，因此请安排"Placement"操作。
      workInProgress.effectTag |= Placement;
    }
    // In the initial pass we might need to construct the instance.
    // 翻译：在最初的过程中，我们可能需要构造实例。
    // 第一次渲染的情况。
    // 这个方法会生成实例，并建立实例与workInProgress直接的联系.
    // 经过这个步骤后workInProgress.stateNode会等于这个新实例，
    // workInProgress.memoizedState也会写入初始的state。
    constructClassInstance(
      workInProgress,
      Component,
      nextProps,
      renderExpirationTime,
    );
    mountClassInstance(
      workInProgress,
      Component,
      nextProps,
      renderExpirationTime,
    );
    shouldUpdate = true;
  } else if (current === null) {
    // In a resume, we'll already have an instance we can reuse.
    // 翻译：在恢复中，我们已经有一个可以重用的实例。
    // 处理被中断渲染的情况。
    shouldUpdate = resumeMountClassInstance(
      workInProgress,
      Component,
      nextProps,
      renderExpirationTime,
    );
  } else {
    // 第二次渲染的正常情况。
    shouldUpdate = updateClassInstance(
      current,
      workInProgress,
      Component,
      nextProps,
      renderExpirationTime,
    );
  }
  return finishClassComponent(
    current,
    workInProgress,
    Component,
    shouldUpdate,
    hasContext,
    renderExpirationTime,
  );
}

/**
 * 结束类组件更新。
 * @param current 当前处理的Fiber对象，可能为空
 * @param workInProgress 当前处理的Fiber对象的进行中副本
 * @param Component workInProgress的type，使用者写的类组件
 * @param shouldUpdate 是否需要更新的标记
 * @param hasContext 是否有context相关的标记
 * @param renderExpirationTime 当前处理的Fiber所在的FiberRoot的nextExpirationTimeToWorkOn
 * @return {Fiber}
 */
function finishClassComponent(
  current: Fiber | null,
  workInProgress: Fiber,
  Component: any,
  shouldUpdate: boolean,
  hasContext: boolean,
  renderExpirationTime: ExpirationTime,
) {
  // Refs should update even if shouldComponentUpdate returns false
  // 翻译：引用应该更新，即使shouldComponentUpdate返回false
  markRef(current, workInProgress);

  // 是否有抛出错误的标记。
  const didCaptureError = (workInProgress.effectTag & DidCapture) !== NoEffect;

  if (!shouldUpdate && !didCaptureError) {
    // 不需要更新并且没有错误抛出，则可以跳过这个节点的处理。
    // Context providers should defer to sCU for rendering
    // 翻译：context提供者应遵照sCU进行渲染
    if (hasContext) {
      invalidateContextProvider(workInProgress, Component, false);
    }

    // 收尾，返回当前的子级或null。
    return bailoutOnAlreadyFinishedWork(
      current,
      workInProgress,
      renderExpirationTime,
    );
  }

  // 取出实例。
  const instance = workInProgress.stateNode;

  // Rerender
  // 标记当前节点。
  ReactCurrentOwner.current = workInProgress;
  let nextChildren;
  if (
    didCaptureError &&
    typeof Component.getDerivedStateFromError !== 'function'
  ) {
    // If we captured an error, but getDerivedStateFrom catch is not defined,
    // unmount all the children. componentDidCatch will schedule an update to
    // re-render a fallback. This is temporary until we migrate everyone to
    // the new API.
    // 翻译：如果我们捕获了一个错误，但getDerivedStateFrom的捕获方法未定义，则卸载所有子项。
    //      componentDidCatch将安排更新以重新渲染后备。这是暂时的，直到我们将所有人都迁移到新的API为止。
    // TODO: Warn in a future release.
    nextChildren = null;

    if (enableProfilerTimer) {
      stopProfilerTimerIfRunning(workInProgress);
    }
  } else {
    if (__DEV__) {
      ReactCurrentFiber.setCurrentPhase('render');
      nextChildren = instance.render();
      if (
        debugRenderPhaseSideEffects ||
        (debugRenderPhaseSideEffectsForStrictMode &&
          workInProgress.mode & StrictMode)
      ) {
        instance.render();
      }
      ReactCurrentFiber.setCurrentPhase(null);
    } else {
      nextChildren = instance.render();
    }
  }

  // React DevTools reads this flag.
  // 翻译：React开发工具的标记。
  workInProgress.effectTag |= PerformedWork;
  if (current !== null && didCaptureError) {
    // 二次渲染，并有错误捕获。
    // If we're recovering from an error, reconcile without reusing any of
    // the existing children. Conceptually, the normal children and the children
    // that are shown on error are two different sets, so we shouldn't reuse
    // normal children even if their identities match.
    // 翻译：如果我们要从错误中恢复过来，请在不复用任何现有子级的情况下进行调和。
    //      从概念上讲，正常子节点和显示错误的子节点是两个不同的集合，
    //      因此，即使他们的类型匹配，我们也不应该重用正常子节点。
    forceUnmountCurrentAndReconcile(
      current,
      workInProgress,
      nextChildren,
      renderExpirationTime,
    );
  } else {
    reconcileChildren(
      current,
      workInProgress,
      nextChildren,
      renderExpirationTime,
    );
  }

  // Memoize state using the values we just used to render.
  // 翻译：使用我们刚刚用于渲染的值来写入记忆的state。
  // TODO: Restructure so we never read values from the instance.
  workInProgress.memoizedState = instance.state;

  // The context might have changed so we need to recalculate it.
  // 翻译：context可能已更改，因此我们需要重新计算。
  if (hasContext) {
    invalidateContextProvider(workInProgress, Component, true);
  }

  return workInProgress.child;
}

function pushHostRootContext(workInProgress) {
  const root = (workInProgress.stateNode: FiberRoot);
  if (root.pendingContext) {
    pushTopLevelContextObject(
      workInProgress,
      root.pendingContext,
      root.pendingContext !== root.context,
    );
  } else if (root.context) {
    // Should always be set
    pushTopLevelContextObject(workInProgress, root.context, false);
  }
  pushHostContainer(workInProgress, root.containerInfo);
}

/**
 * 更新根节点。
 * @param current 当前处理的Fiber对象，可能为空
 * @param workInProgress 当前处理的Fiber对象的进行中副本
 * @param renderExpirationTime 当前处理的Fiber所在的FiberRoot的nextExpirationTimeToWorkOn
 * @return {Fiber|*}
 */
function updateHostRoot(current, workInProgress, renderExpirationTime) {
  // context相关。
  pushHostRootContext(workInProgress);
  // 取出更新队列。
  const updateQueue = workInProgress.updateQueue;
  invariant(
    updateQueue !== null,
    'If the root does not have an updateQueue, we should have already ' +
      'bailed out. This error is likely caused by a bug in React. Please ' +
      'file an issue.',
  );
  // 新的props。
  const nextProps = workInProgress.pendingProps;
  // 旧的state。
  const prevState = workInProgress.memoizedState;
  // 对于hostRoot来说state.element就是存放ReactElement。
  const prevChildren = prevState !== null ? prevState.element : null;
  // update对象的payload属性里只有element一个属性，其实就是更新workInProgress.memoizedState。
  processUpdateQueue(
    workInProgress,
    updateQueue,
    nextProps,
    null,
    renderExpirationTime,
  );
  // 更新后的新state
  const nextState = workInProgress.memoizedState;
  // Caution: React DevTools currently depends on this property
  // being called "element".
  // 翻译：警告：React DevTools当前依赖于此属性，称为“element”。
  const nextChildren = nextState.element;
  if (nextChildren === prevChildren) {
    // If the state is the same as before, that's a bailout because we had
    // no work that expires at this time.
    // 翻译：如果状态与以前相同，则是可以跳过，因为我们目前尚无任何工作到期。
    // 复用服务端渲染的节点相关。
    resetHydrationState();
    // 结束。
    return bailoutOnAlreadyFinishedWork(
      current,
      workInProgress,
      renderExpirationTime,
    );
  }
  const root: FiberRoot = workInProgress.stateNode;
  if (
    (current === null || current.child === null) &&
    root.hydrate &&
    enterHydrationState(workInProgress)
  ) {
    // If we don't have any current children this might be the first pass.
    // We always try to hydrate. If this isn't a hydration pass there won't
    // be any children to hydrate which is effectively the same thing as
    // not hydrating.
    // 翻译：如果我们目前没有子节点，这可能是第一次遍历。我们总是尝试进行hydrate。
    //      如果这不是一次需要hydrate的遍历，那么就不会有任何子节点进行hydrate，
    //      这与不执行hydrate实际上是一回事。

    // This is a bit of a hack. We track the host root as a placement to
    // know that we're currently in a mounting state. That way isMounted
    // works as expected. We must reset this before committing.
    // 翻译：这是一个有点hack的方法。我们跟踪主root作为位置，以了解我们当前处于挂载状态。
    //      这样，isMounted可以按预期工作。我们必须在提交之前重置此设置。
    // TODO: Delete this when we delete isMounted and findDOMNode.
    workInProgress.effectTag |= Placement;

    // Ensure that children mount into this root without tracking
    // side-effects. This ensures that we don't store Placement effects on
    // nodes that will be hydrated.
    // 翻译：确保子节点挂载在该root中而不会跟踪副作用。这确保了我们不会在执行hydrate的节点上存储Placement效果。
    workInProgress.child = mountChildFibers(
      workInProgress,
      null,
      nextChildren,
      renderExpirationTime,
    );
  } else {
    // Otherwise reset hydration state in case we aborted and resumed another
    // root.
    // 翻译：否则，重置hydrate的状态，以防我们中止并恢复另一个root。
    reconcileChildren(
      current,
      workInProgress,
      nextChildren,
      renderExpirationTime,
    );
    resetHydrationState();
  }
  return workInProgress.child;
}

/**
 * 更新原生节。
 * @param current 当前处理的Fiber对象，可能为空
 * @param workInProgress 当前处理的Fiber对象的进行中副本
 * @param renderExpirationTime 当前处理的Fiber所在的FiberRoot的nextExpirationTimeToWorkOn
 * @return {null|*}
 */
function updateHostComponent(current, workInProgress, renderExpirationTime) {
  // context相关。
  pushHostContext(workInProgress);

  if (current === null) {
    // 第一次渲染时，对服务器渲染的节点进行hydrate（融合操作）。
    tryToClaimNextHydratableInstance(workInProgress);
  }

  const type = workInProgress.type;
  const nextProps = workInProgress.pendingProps;
  const prevProps = current !== null ? current.memoizedProps : null;

  let nextChildren = nextProps.children;
  // 判断节点内是否是文本内容。包括：textarea标签、option标签、noscript标签、标签里直接是文本。
  const isDirectTextChild = shouldSetTextContent(type, nextProps);

  if (isDirectTextChild) {
    // We special case a direct text child of a host node. This is a common
    // case. We won't handle it as a reified child. We will instead handle
    // this in the host environment that also have access to this prop. That
    // avoids allocating another HostText fiber and traversing it.
    // 翻译：我们特殊处理根节点的节点内是文本内容的情况。这个是一般的情况。我们不会将其作为子节点来处理。
    //      相反，我们将在也可以访问此prop的宿主节点环境中处理此问题。
    //      这样可以避免分配另一个HostText Fiber对象并遍历它。
    nextChildren = null;
  } else if (prevProps !== null && shouldSetTextContent(type, prevProps)) {
    // If we're switching from a direct text child to a normal child, or to
    // empty, we need to schedule the text content to be reset.
    // 翻译：如果我们要从节点内是文本内容切换到普通子项，或者要切换为空，则需要安排要重置的文本内容。
    workInProgress.effectTag |= ContentReset;
  }

  markRef(current, workInProgress);

  // Check the host config to see if the children are offscreen/hidden.
  // 翻译：检查该节点的设置，以查看子代是否处于屏幕外/隐藏状态。
  if (
    // FiberRoot的过期时间不是Never。
    renderExpirationTime !== Never &&
    // 在异步渲染模式下。
    workInProgress.mode & ConcurrentMode &&
    // props有hidden属性。
    shouldDeprioritizeSubtree(type, nextProps)
  ) {
    // Schedule this fiber to re-render at offscreen priority. Then bailout.
    // 安排此Fiber对象以离屏优先级重新渲染。然后跳过渲染。
    // 让这个节点的优先级降到最低。
    workInProgress.expirationTime = Never;
    return null;
  }

  reconcileChildren(
    current,
    workInProgress,
    nextChildren,
    renderExpirationTime,
  );
  return workInProgress.child;
}

/**
 * 更新文本节点。
 * @param current 当前处理的Fiber对象，可能为空
 * @param workInProgress 当前处理的Fiber对象的进行中副本
 * @return {null}
 */
function updateHostText(current, workInProgress) {
  if (current === null) {
    // 第一次渲染时，对服务器渲染的节点进行hydrate（融合操作）。
    tryToClaimNextHydratableInstance(workInProgress);
  }
  // Nothing to do here. This is terminal. We'll do the completion step
  // immediately after.
  // 翻译：没有其他操作。这是终点。之后，我们将立即执行完成步骤。
  return null;
}

/**
 * 处理组件默认的props值
 * @param Component 使用者写的代码，函数组件就是函数、类组件就是类对象
 * @param baseProps workInProgress上的pendingProps
 * @return {*}
 */
function resolveDefaultProps(Component, baseProps) {
  if (Component && Component.defaultProps) {
    // Resolve default props. Taken from ReactElement
    // 翻译：读取默认props。取自ReactElement
    const props = Object.assign({}, baseProps);
    const defaultProps = Component.defaultProps;
    for (let propName in defaultProps) {
      if (props[propName] === undefined) {
        props[propName] = defaultProps[propName];
      }
    }
    return props;
  }
  return baseProps;
}

function mountLazyComponent(
  _current,
  workInProgress,
  elementType,
  updateExpirationTime,
  renderExpirationTime,
) {
  if (_current !== null) {
    // An lazy component only mounts if it suspended inside a non-
    // concurrent tree, in an inconsistent state. We want to tree it like
    // a new mount, even though an empty version of it already committed.
    // Disconnect the alternate pointers.
    _current.alternate = null;
    workInProgress.alternate = null;
    // Since this is conceptually a new fiber, schedule a Placement effect
    workInProgress.effectTag |= Placement;
  }

  const props = workInProgress.pendingProps;
  // We can't start a User Timing measurement with correct label yet.
  // Cancel and resume right after we know the tag.
  cancelWorkTimer(workInProgress);
  let Component = readLazyComponentType(elementType);
  // Store the unwrapped component in the type.
  workInProgress.type = Component;
  const resolvedTag = (workInProgress.tag = resolveLazyComponentTag(Component));
  startWorkTimer(workInProgress);
  const resolvedProps = resolveDefaultProps(Component, props);
  let child;
  switch (resolvedTag) {
    case FunctionComponent: {
      child = updateFunctionComponent(
        null,
        workInProgress,
        Component,
        resolvedProps,
        renderExpirationTime,
      );
      break;
    }
    case ClassComponent: {
      child = updateClassComponent(
        null,
        workInProgress,
        Component,
        resolvedProps,
        renderExpirationTime,
      );
      break;
    }
    case ForwardRef: {
      child = updateForwardRef(
        null,
        workInProgress,
        Component,
        resolvedProps,
        renderExpirationTime,
      );
      break;
    }
    case MemoComponent: {
      child = updateMemoComponent(
        null,
        workInProgress,
        Component,
        resolveDefaultProps(Component.type, resolvedProps), // The inner type can have defaults too
        updateExpirationTime,
        renderExpirationTime,
      );
      break;
    }
    default: {
      // This message intentionally doesn't metion ForwardRef or MemoComponent
      // because the fact that it's a separate type of work is an
      // implementation detail.
      invariant(
        false,
        'Element type is invalid. Received a promise that resolves to: %s. ' +
          'Promise elements must resolve to a class or function.',
        Component,
      );
    }
  }
  return child;
}

function mountIncompleteClassComponent(
  _current,
  workInProgress,
  Component,
  nextProps,
  renderExpirationTime,
) {
  if (_current !== null) {
    // An incomplete component only mounts if it suspended inside a non-
    // concurrent tree, in an inconsistent state. We want to tree it like
    // a new mount, even though an empty version of it already committed.
    // Disconnect the alternate pointers.
    _current.alternate = null;
    workInProgress.alternate = null;
    // Since this is conceptually a new fiber, schedule a Placement effect
    workInProgress.effectTag |= Placement;
  }

  // Promote the fiber to a class and try rendering again.
  workInProgress.tag = ClassComponent;

  // The rest of this function is a fork of `updateClassComponent`

  // Push context providers early to prevent context stack mismatches.
  // During mounting we don't know the child context yet as the instance doesn't exist.
  // We will invalidate the child context in finishClassComponent() right after rendering.
  let hasContext;
  if (isLegacyContextProvider(Component)) {
    hasContext = true;
    pushLegacyContextProvider(workInProgress);
  } else {
    hasContext = false;
  }
  prepareToReadContext(workInProgress, renderExpirationTime);

  constructClassInstance(
    workInProgress,
    Component,
    nextProps,
    renderExpirationTime,
  );
  mountClassInstance(
    workInProgress,
    Component,
    nextProps,
    renderExpirationTime,
  );

  return finishClassComponent(
    null,
    workInProgress,
    Component,
    true,
    hasContext,
    renderExpirationTime,
  );
}

/**
 * 挂载不确定组件。
 * @param _current 当前处理的Fiber对象，可能为空
 * @param workInProgress 当前处理的Fiber对象的进行中副本
 * @param Component workInProgress的type，使用者写的类组件
 * @param renderExpirationTime 当前处理的Fiber所在的FiberRoot的nextExpirationTimeToWorkOn
 * @return {Fiber|*}
 */
function mountIndeterminateComponent(
  _current,
  workInProgress,
  Component,
  renderExpirationTime,
) {
  if (_current !== null) {
    // 一般这个函数只会在首次渲染时调用，出现这种特殊情况，可能是中断造成的。
    // An indeterminate component only mounts if it suspended inside a non-
    // concurrent tree, in an inconsistent state. We want to tree it like
    // a new mount, even though an empty version of it already committed.
    // Disconnect the alternate pointers.
    // 翻译：不确定的组件仅在其以不一致的状态被中断挂起在非并发树中时挂载。
    //      尽管它已经提交了一个空版本，但我们仍希望像新的挂载一样将其树化。断开alternate指针。
    _current.alternate = null;
    workInProgress.alternate = null;
    // Since this is conceptually a new fiber, schedule a Placement effect
    // 翻译：由于从概念上讲这是一种新Fiber对象，因此请安排"Placement"操作。
    workInProgress.effectTag |= Placement;
  }

  const props = workInProgress.pendingProps;
  const unmaskedContext = getUnmaskedContext(workInProgress, Component, false);
  const context = getMaskedContext(workInProgress, unmaskedContext);

  prepareToReadContext(workInProgress, renderExpirationTime);

  let value;

  if (__DEV__) {
    if (
      Component.prototype &&
      typeof Component.prototype.render === 'function'
    ) {
      const componentName = getComponentName(Component) || 'Unknown';

      if (!didWarnAboutBadClass[componentName]) {
        warningWithoutStack(
          false,
          "The <%s /> component appears to have a render method, but doesn't extend React.Component. " +
            'This is likely to cause errors. Change %s to extend React.Component instead.',
          componentName,
          componentName,
        );
        didWarnAboutBadClass[componentName] = true;
      }
    }

    if (workInProgress.mode & StrictMode) {
      ReactStrictModeWarnings.recordLegacyContextWarning(workInProgress, null);
    }

    ReactCurrentOwner.current = workInProgress;
    value = Component(props, context);
  } else {
    // 执行一次这个函数。
    value = Component(props, context);
  }
  // React DevTools reads this flag.
  // 翻译：React开发工具会读取这个标记。
  workInProgress.effectTag |= PerformedWork;

  if (
    typeof value === 'object' &&
    value !== null &&
    typeof value.render === 'function' &&
    value.$$typeof === undefined
  ) {
    // Proceed under the assumption that this is a class instance
    // 翻译：在假定这是一个类实例的情况下进行。
    workInProgress.tag = ClassComponent;

    // Push context providers early to prevent context stack mismatches.
    // During mounting we don't know the child context yet as the instance doesn't exist.
    // We will invalidate the child context in finishClassComponent() right after rendering.
    let hasContext = false;
    if (isLegacyContextProvider(Component)) {
      hasContext = true;
      pushLegacyContextProvider(workInProgress);
    } else {
      hasContext = false;
    }

    workInProgress.memoizedState =
      value.state !== null && value.state !== undefined ? value.state : null;

    const getDerivedStateFromProps = Component.getDerivedStateFromProps;
    if (typeof getDerivedStateFromProps === 'function') {
      applyDerivedStateFromProps(
        workInProgress,
        Component,
        getDerivedStateFromProps,
        props,
      );
    }

    adoptClassInstance(workInProgress, value);
    mountClassInstance(workInProgress, Component, props, renderExpirationTime);
    return finishClassComponent(
      null,
      workInProgress,
      Component,
      true,
      hasContext,
      renderExpirationTime,
    );
  } else {
    // Proceed under the assumption that this is a function component
    // 翻译：在假定这是功能组件的情况下进行。
    workInProgress.tag = FunctionComponent;
    if (__DEV__) {
      if (Component) {
        warningWithoutStack(
          !Component.childContextTypes,
          '%s(...): childContextTypes cannot be defined on a function component.',
          Component.displayName || Component.name || 'Component',
        );
      }
      if (workInProgress.ref !== null) {
        let info = '';
        const ownerName = ReactCurrentFiber.getCurrentFiberOwnerNameInDevOrNull();
        if (ownerName) {
          info += '\n\nCheck the render method of `' + ownerName + '`.';
        }

        let warningKey = ownerName || workInProgress._debugID || '';
        const debugSource = workInProgress._debugSource;
        if (debugSource) {
          warningKey = debugSource.fileName + ':' + debugSource.lineNumber;
        }
        if (!didWarnAboutFunctionRefs[warningKey]) {
          didWarnAboutFunctionRefs[warningKey] = true;
          warning(
            false,
            'Function components cannot be given refs. ' +
              'Attempts to access this ref will fail.%s',
            info,
          );
        }
      }

      if (typeof Component.getDerivedStateFromProps === 'function') {
        const componentName = getComponentName(Component) || 'Unknown';

        if (!didWarnAboutGetDerivedStateOnFunctionComponent[componentName]) {
          warningWithoutStack(
            false,
            '%s: Function components do not support getDerivedStateFromProps.',
            componentName,
          );
          didWarnAboutGetDerivedStateOnFunctionComponent[componentName] = true;
        }
      }

      if (
        typeof Component.contextType === 'object' &&
        Component.contextType !== null
      ) {
        const componentName = getComponentName(Component) || 'Unknown';

        if (!didWarnAboutContextTypeOnFunctionComponent[componentName]) {
          warningWithoutStack(
            false,
            '%s: Function components do not support contextType.',
            componentName,
          );
          didWarnAboutContextTypeOnFunctionComponent[componentName] = true;
        }
      }
    }
    reconcileChildren(null, workInProgress, value, renderExpirationTime);
    return workInProgress.child;
  }
}

function updateSuspenseComponent(
  current,
  workInProgress,
  renderExpirationTime,
) {
  const mode = workInProgress.mode;
  const nextProps = workInProgress.pendingProps;

  // We should attempt to render the primary children unless this boundary
  // already suspended during this render (`alreadyCaptured` is true).
  let nextState: SuspenseState | null = workInProgress.memoizedState;
  if (nextState === null) {
    // An empty suspense state means this boundary has not yet timed out.
  } else {
    if (!nextState.alreadyCaptured) {
      // Since we haven't already suspended during this commit, clear the
      // existing suspense state. We'll try rendering again.
      nextState = null;
    } else {
      // Something in this boundary's subtree already suspended. Switch to
      // rendering the fallback children. Set `alreadyCaptured` to true.
      if (current !== null && nextState === current.memoizedState) {
        // Create a new suspense state to avoid mutating the current tree's.
        nextState = {
          alreadyCaptured: true,
          didTimeout: true,
          timedOutAt: nextState.timedOutAt,
        };
      } else {
        // Already have a clone, so it's safe to mutate.
        nextState.alreadyCaptured = true;
        nextState.didTimeout = true;
      }
    }
  }
  const nextDidTimeout = nextState !== null && nextState.didTimeout;

  // This next part is a bit confusing. If the children timeout, we switch to
  // showing the fallback children in place of the "primary" children.
  // However, we don't want to delete the primary children because then their
  // state will be lost (both the React state and the host state, e.g.
  // uncontrolled form inputs). Instead we keep them mounted and hide them.
  // Both the fallback children AND the primary children are rendered at the
  // same time. Once the primary children are un-suspended, we can delete
  // the fallback children — don't need to preserve their state.
  //
  // The two sets of children are siblings in the host environment, but
  // semantically, for purposes of reconciliation, they are two separate sets.
  // So we store them using two fragment fibers.
  //
  // However, we want to avoid allocating extra fibers for every placeholder.
  // They're only necessary when the children time out, because that's the
  // only time when both sets are mounted.
  //
  // So, the extra fragment fibers are only used if the children time out.
  // Otherwise, we render the primary children directly. This requires some
  // custom reconciliation logic to preserve the state of the primary
  // children. It's essentially a very basic form of re-parenting.

  // `child` points to the child fiber. In the normal case, this is the first
  // fiber of the primary children set. In the timed-out case, it's a
  // a fragment fiber containing the primary children.
  let child;
  // `next` points to the next fiber React should render. In the normal case,
  // it's the same as `child`: the first fiber of the primary children set.
  // In the timed-out case, it's a fragment fiber containing the *fallback*
  // children -- we skip over the primary children entirely.
  let next;
  if (current === null) {
    // This is the initial mount. This branch is pretty simple because there's
    // no previous state that needs to be preserved.
    if (nextDidTimeout) {
      // Mount separate fragments for primary and fallback children.
      const nextFallbackChildren = nextProps.fallback;
      const primaryChildFragment = createFiberFromFragment(
        null,
        mode,
        NoWork,
        null,
      );
      const fallbackChildFragment = createFiberFromFragment(
        nextFallbackChildren,
        mode,
        renderExpirationTime,
        null,
      );
      primaryChildFragment.sibling = fallbackChildFragment;
      child = primaryChildFragment;
      // Skip the primary children, and continue working on the
      // fallback children.
      next = fallbackChildFragment;
      child.return = next.return = workInProgress;
    } else {
      // Mount the primary children without an intermediate fragment fiber.
      const nextPrimaryChildren = nextProps.children;
      child = next = mountChildFibers(
        workInProgress,
        null,
        nextPrimaryChildren,
        renderExpirationTime,
      );
    }
  } else {
    // This is an update. This branch is more complicated because we need to
    // ensure the state of the primary children is preserved.
    const prevState = current.memoizedState;
    const prevDidTimeout = prevState !== null && prevState.didTimeout;
    if (prevDidTimeout) {
      // The current tree already timed out. That means each child set is
      // wrapped in a fragment fiber.
      const currentPrimaryChildFragment: Fiber = (current.child: any);
      const currentFallbackChildFragment: Fiber = (currentPrimaryChildFragment.sibling: any);
      if (nextDidTimeout) {
        // Still timed out. Reuse the current primary children by cloning
        // its fragment. We're going to skip over these entirely.
        const nextFallbackChildren = nextProps.fallback;
        const primaryChildFragment = createWorkInProgress(
          currentPrimaryChildFragment,
          currentPrimaryChildFragment.pendingProps,
          NoWork,
        );
        primaryChildFragment.effectTag |= Placement;
        // Clone the fallback child fragment, too. These we'll continue
        // working on.
        const fallbackChildFragment = (primaryChildFragment.sibling = createWorkInProgress(
          currentFallbackChildFragment,
          nextFallbackChildren,
          currentFallbackChildFragment.expirationTime,
        ));
        fallbackChildFragment.effectTag |= Placement;
        child = primaryChildFragment;
        primaryChildFragment.childExpirationTime = NoWork;
        // Skip the primary children, and continue working on the
        // fallback children.
        next = fallbackChildFragment;
        child.return = next.return = workInProgress;
      } else {
        // No longer suspended. Switch back to showing the primary children,
        // and remove the intermediate fragment fiber.
        const nextPrimaryChildren = nextProps.children;
        const currentPrimaryChild = currentPrimaryChildFragment.child;
        const currentFallbackChild = currentFallbackChildFragment.child;
        const primaryChild = reconcileChildFibers(
          workInProgress,
          currentPrimaryChild,
          nextPrimaryChildren,
          renderExpirationTime,
        );
        // Delete the fallback children.
        reconcileChildFibers(
          workInProgress,
          currentFallbackChild,
          null,
          renderExpirationTime,
        );
        // Continue rendering the children, like we normally do.
        child = next = primaryChild;
      }
    } else {
      // The current tree has not already timed out. That means the primary
      // children are not wrapped in a fragment fiber.
      const currentPrimaryChild: Fiber = (current.child: any);
      if (nextDidTimeout) {
        // Timed out. Wrap the children in a fragment fiber to keep them
        // separate from the fallback children.
        const nextFallbackChildren = nextProps.fallback;
        const primaryChildFragment = createFiberFromFragment(
          // It shouldn't matter what the pending props are because we aren't
          // going to render this fragment.
          null,
          mode,
          NoWork,
          null,
        );
        primaryChildFragment.effectTag |= Placement;
        primaryChildFragment.child = currentPrimaryChild;
        currentPrimaryChild.return = primaryChildFragment;
        // Create a fragment from the fallback children, too.
        const fallbackChildFragment = (primaryChildFragment.sibling = createFiberFromFragment(
          nextFallbackChildren,
          mode,
          renderExpirationTime,
          null,
        ));
        fallbackChildFragment.effectTag |= Placement;
        child = primaryChildFragment;
        primaryChildFragment.childExpirationTime = NoWork;
        // Skip the primary children, and continue working on the
        // fallback children.
        next = fallbackChildFragment;
        child.return = next.return = workInProgress;
      } else {
        // Still haven't timed out.  Continue rendering the children, like we
        // normally do.
        const nextPrimaryChildren = nextProps.children;
        next = child = reconcileChildFibers(
          workInProgress,
          currentPrimaryChild,
          nextPrimaryChildren,
          renderExpirationTime,
        );
      }
    }
  }

  workInProgress.memoizedState = nextState;
  workInProgress.child = child;
  return next;
}

/**
 * 更新Portal组件。
 * @param current 当前处理的Fiber对象，可能为空
 * @param workInProgress 当前处理的Fiber对象的进行中副本
 * @param renderExpirationTime 当前处理的Fiber所在的FiberRoot的nextExpirationTimeToWorkOn
 * @return {Fiber}
 */
function updatePortalComponent(
  current: Fiber | null,
  workInProgress: Fiber,
  renderExpirationTime: ExpirationTime,
) {
  pushHostContainer(workInProgress, workInProgress.stateNode.containerInfo);
  const nextChildren = workInProgress.pendingProps;
  if (current === null) {
    // Portals are special because we don't append the children during mount
    // but at commit. Therefore we need to track insertions which the normal
    // flow doesn't do during mount. This doesn't happen at the root because
    // the root always starts with a "current" with a null child.
    // 翻译：Portals组件是特别的，因为我们不会在挂载期间添加子节点，而是在提交时才添加子节点。
    //      因此，我们需要跟踪在挂载过程中正常流程不进行的插入。
    //      在根节点上不会发生这种情况，因为根节点始终从带有空子节点的“current”节点开始。
    // TODO: Consider unifying this with how the root works.
    workInProgress.child = reconcileChildFibers(
      workInProgress,
      null,
      nextChildren,
      renderExpirationTime,
    );
  } else {
    reconcileChildren(
      current,
      workInProgress,
      nextChildren,
      renderExpirationTime,
    );
  }
  return workInProgress.child;
}

/**
 * 更新Context组件。
 * @param current 当前处理的Fiber对象，可能为空
 * @param workInProgress 当前处理的Fiber对象的进行中副本
 * @param renderExpirationTime 当前处理的Fiber所在的FiberRoot的nextExpirationTimeToWorkOn
 * @return {Fiber}
 */
function updateContextProvider(
  current: Fiber | null,
  workInProgress: Fiber,
  renderExpirationTime: ExpirationTime,
) {
  const providerType: ReactProviderType<any> = workInProgress.type;
  const context: ReactContext<any> = providerType._context;

  const newProps = workInProgress.pendingProps;
  const oldProps = workInProgress.memoizedProps;

  const newValue = newProps.value;

  if (__DEV__) {
    const providerPropTypes = workInProgress.type.propTypes;

    if (providerPropTypes) {
      checkPropTypes(
        providerPropTypes,
        newProps,
        'prop',
        'Context.Provider',
        ReactCurrentFiber.getCurrentFiberStackInDev,
      );
    }
  }

  pushProvider(workInProgress, newValue);

  if (oldProps !== null) {
    const oldValue = oldProps.value;
    const changedBits = calculateChangedBits(context, newValue, oldValue);
    if (changedBits === 0) {
      // No change. Bailout early if children are the same.
      // 翻译：没变。如果子节点相同，请尽早进行跳过。
      if (
        oldProps.children === newProps.children &&
        !hasLegacyContextChanged()
      ) {
        return bailoutOnAlreadyFinishedWork(
          current,
          workInProgress,
          renderExpirationTime,
        );
      }
    } else {
      // The context value changed. Search for matching consumers and schedule
      // them to update.
      // 翻译：context的值已更改。搜索匹配的使用者，并安排他们进行更新。
      propagateContextChange(
        workInProgress,
        context,
        changedBits,
        renderExpirationTime,
      );
    }
  }

  const newChildren = newProps.children;
  reconcileChildren(current, workInProgress, newChildren, renderExpirationTime);
  return workInProgress.child;
}

let hasWarnedAboutUsingContextAsConsumer = false;

function updateContextConsumer(
  current: Fiber | null,
  workInProgress: Fiber,
  renderExpirationTime: ExpirationTime,
) {
  let context: ReactContext<any> = workInProgress.type;
  // The logic below for Context differs depending on PROD or DEV mode. In
  // DEV mode, we create a separate object for Context.Consumer that acts
  // like a proxy to Context. This proxy object adds unnecessary code in PROD
  // so we use the old behaviour (Context.Consumer references Context) to
  // reduce size and overhead. The separate object references context via
  // a property called "_context", which also gives us the ability to check
  // in DEV mode if this property exists or not and warn if it does not.
  if (__DEV__) {
    if ((context: any)._context === undefined) {
      // This may be because it's a Context (rather than a Consumer).
      // Or it may be because it's older React where they're the same thing.
      // We only want to warn if we're sure it's a new React.
      if (context !== context.Consumer) {
        if (!hasWarnedAboutUsingContextAsConsumer) {
          hasWarnedAboutUsingContextAsConsumer = true;
          warning(
            false,
            'Rendering <Context> directly is not supported and will be removed in ' +
              'a future major release. Did you mean to render <Context.Consumer> instead?',
          );
        }
      }
    } else {
      context = (context: any)._context;
    }
  }
  const newProps = workInProgress.pendingProps;
  const render = newProps.children;

  if (__DEV__) {
    warningWithoutStack(
      typeof render === 'function',
      'A context consumer was rendered with multiple children, or a child ' +
        "that isn't a function. A context consumer expects a single child " +
        'that is a function. If you did pass a function, make sure there ' +
        'is no trailing or leading whitespace around it.',
    );
  }

  prepareToReadContext(workInProgress, renderExpirationTime);
  const newValue = readContext(context, newProps.unstable_observedBits);
  let newChildren;
  if (__DEV__) {
    ReactCurrentOwner.current = workInProgress;
    ReactCurrentFiber.setCurrentPhase('render');
    newChildren = render(newValue);
    ReactCurrentFiber.setCurrentPhase(null);
  } else {
    newChildren = render(newValue);
  }

  // React DevTools reads this flag.
  workInProgress.effectTag |= PerformedWork;
  reconcileChildren(current, workInProgress, newChildren, renderExpirationTime);
  return workInProgress.child;
}

/*
  function reuseChildrenEffects(returnFiber : Fiber, firstChild : Fiber) {
    let child = firstChild;
    do {
      // Ensure that the first and last effect of the parent corresponds
      // to the children's first and last effect.
      if (!returnFiber.firstEffect) {
        returnFiber.firstEffect = child.firstEffect;
      }
      if (child.lastEffect) {
        if (returnFiber.lastEffect) {
          returnFiber.lastEffect.nextEffect = child.firstEffect;
        }
        returnFiber.lastEffect = child.lastEffect;
      }
    } while (child = child.sibling);
  }
  */

/**
 * 对于已经完成更新的节点进行收尾操作，检查其子节点是否更新。
 * @param current 当前处理的Fiber对象，可能为空
 * @param workInProgress 当前处理的Fiber对象的进行中副本
 * @param renderExpirationTime 当前处理的Fiber所在的FiberRoot的nextExpirationTimeToWorkOn
 * @return {Fiber|null} 当前Fiber对象的子级（也是Fiber）或是null
 */
function bailoutOnAlreadyFinishedWork(
  current: Fiber | null,
  workInProgress: Fiber,
  renderExpirationTime: ExpirationTime,
): Fiber | null {
  cancelWorkTimer(workInProgress);

  if (current !== null) {
    // 非第一次渲染。
    // Reuse previous context list
    // 翻译：重用上一个context列表。
    workInProgress.firstContextDependency = current.firstContextDependency;
  }

  if (enableProfilerTimer) {
    // Don't update "base" render times for bailouts.
    // 翻译：不要更新断点的“基准”渲染时间。
    stopProfilerTimerIfRunning(workInProgress);
  }

  // Check if the children have any pending work.
  // 翻译：检查子节点是否有未完成的工作。
  const childExpirationTime = workInProgress.childExpirationTime;
  if (
    childExpirationTime === NoWork ||
    childExpirationTime > renderExpirationTime
  ) {
    // The children don't have any work either. We can skip them.
    // 翻译：子节点也没有任何工作。我们可以跳过它们。
    // TODO: Once we add back resuming, we should check if the children are
    // a work-in-progress set. If so, we need to transfer their effects.
    return null;
  } else {
    // This fiber doesn't have work, but its subtree does. Clone the child
    // fibers and continue.
    // 翻译：当前Fiber对象没有工作，但是它的子级有工作。克隆子级Fiber对象并继续。
    cloneChildFibers(current, workInProgress);
    return workInProgress.child;
  }
}

/**
 * 渲染入口方法，会在src/ReactFiberScheduler.js的performUnitOfWork调用。
 * @param current 当前处理的Fiber对象，可能为空
 * @param workInProgress 当前处理的Fiber对象的进行中副本
 * @param renderExpirationTime 当前处理的Fiber所在的FiberRoot的nextExpirationTimeToWorkOn
 * @return {Fiber|Fiber.child|Fiber|null|*} 当前Fiber对象的子级（也是Fiber）或是null
 */
function beginWork(
  current: Fiber | null,
  workInProgress: Fiber,
  renderExpirationTime: ExpirationTime,
): Fiber | null {
  // 这个是Fiber上的expirationTime，FiberRoot上的Fiber对象只有第一次渲染才有值。
  // 而renderExpirationTime是FiberRoot上的nextExpirationTimeToWorkOn。
  const updateExpirationTime = workInProgress.expirationTime;

  // 判断节点是不是第一次渲染，第一次渲染的时候有workInProgress，没有current。
  if (current !== null) {
    // 二次渲染。
    const oldProps = current.memoizedProps;
    const newProps = workInProgress.pendingProps;
    if (
      // props没有变化。
      oldProps === newProps &&
      // context没有变化
      !hasLegacyContextChanged() &&
      // 没有更新
      (updateExpirationTime === NoWork ||
        // 优先级不高（未过期）
        updateExpirationTime > renderExpirationTime)
    ) {
      // 判断不需要处理。
      // This fiber does not have any pending work. Bailout without entering
      // the begin phase. There's still some bookkeeping we that needs to be done
      // in this optimized path, mostly pushing stuff onto the stack.
      // 翻译：该Fiber对象没有任何待处理的工作。无需进入开始阶段即可进行输出。在这种优化路径下，
      //      我们仍然需要做一些记录工作，主要是将内容推入堆栈。
      // 下面会会根据组件的类型执行不同操作。
      switch (workInProgress.tag) {
        case HostRoot:
          pushHostRootContext(workInProgress);
          resetHydrationState();
          break;
        case HostComponent:
          pushHostContext(workInProgress);
          break;
        case ClassComponent: {
          const Component = workInProgress.type;
          if (isLegacyContextProvider(Component)) {
            pushLegacyContextProvider(workInProgress);
          }
          break;
        }
        case HostPortal:
          pushHostContainer(
            workInProgress,
            workInProgress.stateNode.containerInfo,
          );
          break;
        case ContextProvider: {
          const newValue = workInProgress.memoizedProps.value;
          pushProvider(workInProgress, newValue);
          break;
        }
        case Profiler:
          if (enableProfilerTimer) {
            workInProgress.effectTag |= Update;
          }
          break;
        case SuspenseComponent: {
          const state: SuspenseState | null = workInProgress.memoizedState;
          const didTimeout = state !== null && state.didTimeout;
          if (didTimeout) {
            // If this boundary is currently timed out, we need to decide
            // whether to retry the primary children, or to skip over it and
            // go straight to the fallback. Check the priority of the primary
            // child fragment.
            const primaryChildFragment: Fiber = (workInProgress.child: any);
            const primaryChildExpirationTime =
              primaryChildFragment.childExpirationTime;
            if (
              primaryChildExpirationTime !== NoWork &&
              primaryChildExpirationTime <= renderExpirationTime
            ) {
              // The primary children have pending work. Use the normal path
              // to attempt to render the primary children again.
              return updateSuspenseComponent(
                current,
                workInProgress,
                renderExpirationTime,
              );
            } else {
              // The primary children do not have pending work with sufficient
              // priority. Bailout.
              const child = bailoutOnAlreadyFinishedWork(
                current,
                workInProgress,
                renderExpirationTime,
              );
              if (child !== null) {
                // The fallback children have pending work. Skip over the
                // primary children and work on the fallback.
                return child.sibling;
              } else {
                return null;
              }
            }
          }
          break;
        }
      }
      // 跳出
      return bailoutOnAlreadyFinishedWork(
        current,
        workInProgress,
        renderExpirationTime,
      );
    }
  }

  // Before entering the begin phase, clear the expiration time.
  // 翻译：在进入开始阶段之前，清除到期时间。
  workInProgress.expirationTime = NoWork;

  // 第一次渲染，以及二次渲染需要更新的情况，下面会会根据组件的类型执行不同操作。
  switch (workInProgress.tag) {
    case IndeterminateComponent: {
      const elementType = workInProgress.elementType;
      return mountIndeterminateComponent(
        current,
        workInProgress,
        elementType,
        renderExpirationTime,
      );
    }
    case LazyComponent: {
      const elementType = workInProgress.elementType;
      return mountLazyComponent(
        current,
        workInProgress,
        elementType,
        updateExpirationTime,
        renderExpirationTime,
      );
    }
    case FunctionComponent: {
      // 这里的type就是使用者写的函数。
      const Component = workInProgress.type;
      // 新的props。
      const unresolvedProps = workInProgress.pendingProps;
      // 根据Component.defaultProps处理有默认值的props。
      const resolvedProps =
        workInProgress.elementType === Component
          ? unresolvedProps
          : resolveDefaultProps(Component, unresolvedProps);
      // 执行函数组件更新。
      return updateFunctionComponent(
        current,
        workInProgress,
        Component,
        resolvedProps,
        renderExpirationTime,
      );
    }
    case ClassComponent: {
      const Component = workInProgress.type;
      const unresolvedProps = workInProgress.pendingProps;
      const resolvedProps =
        workInProgress.elementType === Component
          ? unresolvedProps
          : resolveDefaultProps(Component, unresolvedProps);
      return updateClassComponent(
        current,
        workInProgress,
        Component,
        resolvedProps,
        renderExpirationTime,
      );
    }
    case HostRoot:
      return updateHostRoot(current, workInProgress, renderExpirationTime);
    case HostComponent:
      return updateHostComponent(current, workInProgress, renderExpirationTime);
    case HostText:
      return updateHostText(current, workInProgress);
    case SuspenseComponent:
      return updateSuspenseComponent(
        current,
        workInProgress,
        renderExpirationTime,
      );
    case HostPortal:
      return updatePortalComponent(
        current,
        workInProgress,
        renderExpirationTime,
      );
    case ForwardRef: {
      const type = workInProgress.type;
      const unresolvedProps = workInProgress.pendingProps;
      const resolvedProps =
        workInProgress.elementType === type
          ? unresolvedProps
          : resolveDefaultProps(type, unresolvedProps);
      return updateForwardRef(
        current,
        workInProgress,
        type,
        resolvedProps,
        renderExpirationTime,
      );
    }
    case Fragment:
      return updateFragment(current, workInProgress, renderExpirationTime);
    case Mode:
      return updateMode(current, workInProgress, renderExpirationTime);
    case Profiler:
      return updateProfiler(current, workInProgress, renderExpirationTime);
    case ContextProvider:
      return updateContextProvider(
        current,
        workInProgress,
        renderExpirationTime,
      );
    case ContextConsumer:
      return updateContextConsumer(
        current,
        workInProgress,
        renderExpirationTime,
      );
    case MemoComponent: {
      const type = workInProgress.type;
      const unresolvedProps = workInProgress.pendingProps;
      const resolvedProps = resolveDefaultProps(type.type, unresolvedProps);
      return updateMemoComponent(
        current,
        workInProgress,
        type,
        resolvedProps,
        updateExpirationTime,
        renderExpirationTime,
      );
    }
    case SimpleMemoComponent: {
      return updateSimpleMemoComponent(
        current,
        workInProgress,
        workInProgress.type,
        workInProgress.pendingProps,
        updateExpirationTime,
        renderExpirationTime,
      );
    }
    case IncompleteClassComponent: {
      const Component = workInProgress.type;
      const unresolvedProps = workInProgress.pendingProps;
      const resolvedProps =
        workInProgress.elementType === Component
          ? unresolvedProps
          : resolveDefaultProps(Component, unresolvedProps);
      return mountIncompleteClassComponent(
        current,
        workInProgress,
        Component,
        resolvedProps,
        renderExpirationTime,
      );
    }
    default:
      invariant(
        false,
        'Unknown unit of work tag. This error is likely caused by a bug in ' +
          'React. Please file an issue.',
      );
  }
}

export {beginWork};
