/**
 * Copyright (c) 2013-present, Facebook, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root direcreatey of this source tree.
 *
 * @flow
 */

import type {ReactContext} from 'shared/ReactTypes';
import type {Fiber} from './ReactFiber';
import type {ExpirationTime} from './ReactFiberExpirationTime';
import type {HookEffectTag} from './ReactHookEffectTags';

import {NoWork} from './ReactFiberExpirationTime';
import {enableHooks} from 'shared/ReactFeatureFlags';
import {readContext} from './ReactFiberNewContext';
import {
  Update as UpdateEffect,
  Passive as PassiveEffect,
} from 'shared/ReactSideEffectTags';
import {
  NoEffect as NoHookEffect,
  UnmountMutation,
  MountLayout,
  UnmountPassive,
  MountPassive,
} from './ReactHookEffectTags';
import {
  scheduleWork,
  computeExpirationForFiber,
  flushPassiveEffects,
  requestCurrentTime,
} from './ReactFiberScheduler';

import invariant from 'shared/invariant';
import areHookInputsEqual from 'shared/areHookInputsEqual';

type Update<A> = {
  expirationTime: ExpirationTime,
  action: A,
  next: Update<A> | null,
};

type UpdateQueue<A> = {
  last: Update<A> | null,
  dispatch: any,
};

export type Hook = {
  memoizedState: any,

  baseState: any,
  baseUpdate: Update<any> | null,
  queue: UpdateQueue<any> | null,

  next: Hook | null,
};

type Effect = {
  tag: HookEffectTag,
  create: () => mixed,
  destroy: (() => mixed) | null,
  inputs: Array<mixed>,
  next: Effect,
};

export type FunctionComponentUpdateQueue = {
  lastEffect: Effect | null,
};

type BasicStateAction<S> = (S => S) | S;

type Dispatch<A> = A => void;

// These are set right before calling the component.
let renderExpirationTime: ExpirationTime = NoWork;
// The work-in-progress fiber. I've named it differently to distinguish it from
// the work-in-progress hook.
let currentlyRenderingFiber: Fiber | null = null;

// Hooks are stored as a linked list on the fiber's memoizedState field. The
// current hook list is the list that belongs to the current fiber. The
// work-in-progress hook list is a new list that will be added to the
// work-in-progress fiber.
let firstCurrentHook: Hook | null = null;
let currentHook: Hook | null = null;
let firstWorkInProgressHook: Hook | null = null;
let workInProgressHook: Hook | null = null;

let remainingExpirationTime: ExpirationTime = NoWork;
let componentUpdateQueue: FunctionComponentUpdateQueue | null = null;

// Updates scheduled during render will trigger an immediate re-render at the
// end of the current pass. We can't store these updates on the normal queue,
// because if the work is aborted, they should be discarded. Because this is
// a relatively rare case, we also don't want to add an additional field to
// either the hook or queue object types. So we store them in a lazily create
// map of queue -> render-phase updates, which are discarded once the component
// completes without re-rendering.

// Whether the work-in-progress hook is a re-rendered hook
let isReRender: boolean = false;
// Whether an update was scheduled during the currently executing render pass.
let didScheduleRenderPhaseUpdate: boolean = false;
// Lazily created map of render-phase updates
let renderPhaseUpdates: Map<UpdateQueue<any>, Update<any>> | null = null;
// Counter to prevent infinite loops.
let numberOfReRenders: number = 0;
const RE_RENDER_LIMIT = 25;

function resolveCurrentlyRenderingFiber(): Fiber {
  invariant(
    currentlyRenderingFiber !== null,
    'Hooks can only be called inside the body of a function component.',
  );
  return currentlyRenderingFiber;
}

/**
 * 准备使用hooks。
 * @param current 当前的Fiber节点，可能为空
 * @param workInProgress 当前处理的Fiber节点的进行中副本
 * @param nextRenderExpirationTime 当前处理的Fiber所在的FiberRoot的nextExpirationTimeToWorkOn
 */
export function prepareToUseHooks(
  current: Fiber | null,
  workInProgress: Fiber,
  nextRenderExpirationTime: ExpirationTime,
): void {
  if (!enableHooks) {
    return;
  }
  renderExpirationTime = nextRenderExpirationTime;
  currentlyRenderingFiber = workInProgress;
  firstCurrentHook = current !== null ? current.memoizedState : null;

  // The following should have already been reset
  // currentHook = null;
  // workInProgressHook = null;

  // remainingExpirationTime = NoWork;
  // componentUpdateQueue = null;

  // isReRender = false;
  // didScheduleRenderPhaseUpdate = false;
  // renderPhaseUpdates = null;
  // numberOfReRenders = 0;
}

/**
 * 组件更新结束时重置公共变量。
 * @param Component 函数组件
 * @param props 新的props对象
 * @param children 运行函数组件得到子级元素
 * @param refOrContext context相关
 * @return {*}
 */
export function finishHooks(
  Component: any,
  props: any,
  children: any,
  refOrContext: any,
): any {
  if (!enableHooks) {
    return children;
  }

  // This must be called after every function component to prevent hooks from
  // being used in classes.
  // 翻译：必须在每个函数组件之后调用此函数，以防止在类中使用钩子。

  while (didScheduleRenderPhaseUpdate) {
    // 渲染过程中产生update，会在本次执行。
    // Updates were scheduled during the render phase. They are stored in
    // the `renderPhaseUpdates` map. Call the component again, reusing the
    // work-in-progress hooks and applying the additional updates on top. Keep
    // restarting until no more updates are scheduled.
    // 翻译：更新是在渲染阶段安排的。他们保存在'renderPhaseUpdates'的map中。
    //      再次调用组件，重用进行中的hooks，并在顶部应用其他更新。
    //      继续重新启动，直到不再安排任何更新。
    didScheduleRenderPhaseUpdate = false;
    numberOfReRenders += 1;

    // Start over from the beginning of the list
    // 翻译：从链表的开头重新开始。
    currentHook = null;
    workInProgressHook = null;
    componentUpdateQueue = null;

    // 重新运行了一边函数组件。
    children = Component(props, refOrContext);
  }
  renderPhaseUpdates = null;
  numberOfReRenders = 0;

  // 函数组件对应的Fiber对象。
  const renderedWork: Fiber = (currentlyRenderingFiber: any);

  renderedWork.memoizedState = firstWorkInProgressHook;
  renderedWork.expirationTime = remainingExpirationTime;
  renderedWork.updateQueue = (componentUpdateQueue: any);

  const didRenderTooFewHooks =
    currentHook !== null && currentHook.next !== null;

  renderExpirationTime = NoWork;
  currentlyRenderingFiber = null;

  firstCurrentHook = null;
  currentHook = null;
  firstWorkInProgressHook = null;
  workInProgressHook = null;

  remainingExpirationTime = NoWork;
  componentUpdateQueue = null;

  // Always set during createWorkInProgress
  // isReRender = false;

  // These were reset above
  // didScheduleRenderPhaseUpdate = false;
  // renderPhaseUpdates = null;
  // numberOfReRenders = 0;

  invariant(
    !didRenderTooFewHooks,
    'Rendered fewer hooks than expected. This may be caused by an accidental ' +
      'early return statement.',
  );

  return children;
}

export function resetHooks(): void {
  if (!enableHooks) {
    return;
  }

  // This is called instead of `finishHooks` if the component throws. It's also
  // called inside mountIndeterminateComponent if we determine the component
  // is a module-style component.
  renderExpirationTime = NoWork;
  currentlyRenderingFiber = null;

  firstCurrentHook = null;
  currentHook = null;
  firstWorkInProgressHook = null;
  workInProgressHook = null;

  remainingExpirationTime = NoWork;
  componentUpdateQueue = null;

  // Always set during createWorkInProgress
  // isReRender = false;

  didScheduleRenderPhaseUpdate = false;
  renderPhaseUpdates = null;
  numberOfReRenders = 0;
}

function createHook(): Hook {
  return {
    memoizedState: null,

    baseState: null,
    queue: null,
    baseUpdate: null,

    next: null,
  };
}

function cloneHook(hook: Hook): Hook {
  return {
    memoizedState: hook.memoizedState,

    baseState: hook.baseState,
    queue: hook.queue,
    baseUpdate: hook.baseUpdate,

    next: null,
  };
}

/**
 * 创建运行中的hook对象。
 * @return {Hook}
 */
function createWorkInProgressHook(): Hook {
  if (workInProgressHook === null) {
    // 当前没有hook的情况。
    // This is the first hook in the list
    // 翻译：这是列表中的第一个hook。
    if (firstWorkInProgressHook === null) {
      isReRender = false;
      // firstCurrentHook是prepareToUseHooks时写入的memoizedState。
      // 也就是现有的hook对象，在首次渲染时为空。
      currentHook = firstCurrentHook;
      if (currentHook === null) {
        // This is a newly mounted hook
        // 翻译：这是一个新挂载的hook。
        workInProgressHook = createHook();
      } else {
        // Clone the current hook.
        // 翻译：克隆已有的hook。
        workInProgressHook = cloneHook(currentHook);
      }
      firstWorkInProgressHook = workInProgressHook;
    } else {
      // There's already a work-in-progress. Reuse it.
      // 翻译：已经有一个运行中的hook，重用它。
      isReRender = true;
      currentHook = firstCurrentHook;
      workInProgressHook = firstWorkInProgressHook;
    }
  } else {
    // 当前有hook的情况。
    if (workInProgressHook.next === null) {
      isReRender = false;
      let hook;
      if (currentHook === null) {
        // This is a newly mounted hook
        // 翻译：这是一个新挂载的hook。
        hook = createHook();
      } else {
        currentHook = currentHook.next;
        if (currentHook === null) {
          // This is a newly mounted hook
          // 翻译：这是一个新挂载的hook。
          hook = createHook();
        } else {
          // Clone the current hook.
          // 翻译：克隆已有的hook。
          hook = cloneHook(currentHook);
        }
      }
      // Append to the end of the list
      // 翻译：追加到列表的末尾。
      workInProgressHook = workInProgressHook.next = hook;
    } else {
      // There's already a work-in-progress. Reuse it.
      // 翻译：已经有一个运行中的hook，重用它。
      isReRender = true;
      workInProgressHook = workInProgressHook.next;
      currentHook = currentHook !== null ? currentHook.next : null;
    }
  }
  return workInProgressHook;
}

function createFunctionComponentUpdateQueue(): FunctionComponentUpdateQueue {
  return {
    lastEffect: null,
  };
}

function basicStateReducer<S>(state: S, action: BasicStateAction<S>): S {
  return typeof action === 'function' ? action(state) : action;
}

export function useContext<T>(
  context: ReactContext<T>,
  observedBits: void | number | boolean,
): T {
  // Ensure we're in a function component (class components support only the
  // .unstable_read() form)
  resolveCurrentlyRenderingFiber();
  return readContext(context, observedBits);
}

export function useState<S>(
  initialState: (() => S) | S,
): [S, Dispatch<BasicStateAction<S>>] {
  return useReducer(
    basicStateReducer,
    // useReducer has a special case to support lazy useState initializers
    // 翻译：useReducer具有特殊情况以支持懒惰的useState初始化程序。
    (initialState: any),
  );
}

/**
 * hook的API之一，用于保存状态。
 * @param reducer (state, action) => newState的运行器
 * @param initialState 初始state
 * @param initialAction 初始action，惰性生成初始state
 * @return {[*, Dispatch<A>]|[*, Dispatch<A>]}
 */
export function useReducer<S, A>(
  reducer: (S, A) => S,
  initialState: S,
  initialAction: A | void | null,
): [S, Dispatch<A>] {
  // 获取到当前处理的Fiber对象，这个函数其实很多余只是把全局变量返回再赋值。
  currentlyRenderingFiber = resolveCurrentlyRenderingFiber();
  // 创建hook对象，它会检查当前Fiber上是否存在hook，有则复用，没有则创建。
  // 并且会设置isReRender的值，这是渲染中调用更新函数的结果。
  workInProgressHook = createWorkInProgressHook();
  // 一开始一定不存在。
  let queue: UpdateQueue<A> | null = (workInProgressHook.queue: any);
  if (queue !== null) {
    // Already have a queue, so this is an update.
    // 翻译：已经有了一个队列，所以这是一个更新。
    if (isReRender) {
      // 这是在渲染阶段中触发更新的特殊情况，这种情况下Update对象来自renderPhaseUpdates，
      // 并且会无视优先级，一次性更新。
      // This is a re-render. Apply the new render phase updates to the previous
      // work-in-progress hook.
      // 翻译：这是重新渲染。将新的渲染阶段更新应用于先前的运行中的hook。
      const dispatch: Dispatch<A> = (queue.dispatch: any);
      if (renderPhaseUpdates !== null) {
        // Render phase updates are stored in a map of queue -> linked list
        // 翻译：渲染阶段更新存储在队列映射->链表中。
        const firstRenderPhaseUpdate = renderPhaseUpdates.get(queue);
        if (firstRenderPhaseUpdate !== undefined) {
          renderPhaseUpdates.delete(queue);
          let newState = workInProgressHook.memoizedState;
          let update = firstRenderPhaseUpdate;
          do {
            // Process this render phase update. We don't have to check the
            // priority because it will always be the same as the current
            // render's.
            // 翻译：处理此渲染阶段更新。我们不必检查优先级，因为它始终与当前渲染的优先级相同。
            const action = update.action;
            newState = reducer(newState, action);
            update = update.next;
          } while (update !== null);

          workInProgressHook.memoizedState = newState;

          // Don't persist the state accumlated from the render phase updates to
          // the base state unless the queue is empty.
          // 翻译：除非队列为空，否则不要将从渲染阶段更新累积的状态持久化为基本状态。
          // TODO: Not sure if this is the desired semantics, but it's what we
          // do for gDSFP. I can't remember why.
          if (workInProgressHook.baseUpdate === queue.last) {
            workInProgressHook.baseState = newState;
          }

          return [newState, dispatch];
        }
      }
      return [workInProgressHook.memoizedState, dispatch];
    }

    // The last update in the entire queue
    // 翻译：整个队列中的最后更新。
    const last = queue.last;
    // The last update that is part of the base state.
    // 翻译：作为基本状态一部分的最后更新。
    // 上次运行中断的那个Update对象的前一个。
    const baseUpdate = workInProgressHook.baseUpdate;

    // Find the first unprocessed update.
    // 翻译：查找第一个未处理的更新。
    let first;
    if (baseUpdate !== null) {
      // 存在之前未完成的更新。
      if (last !== null) {
        // For the first update, the queue is a circular linked list where
        // `queue.last.next = queue.first`. Once the first update commits, and
        // the `baseUpdate` is no longer empty, we can unravel the list.
        // 翻译：对于第一次更新，队列是一个循环链接列表，其中“queue.last.next=queue.first”。
        //      一旦第一个更新提交，并且`baseUpdate`不再为空，我们就可以展开列表。
        last.next = null;
      }
      first = baseUpdate.next;
    } else {
      // 更新队列是环状的。
      first = last !== null ? last.next : null;
    }
    if (first !== null) {
      let newState = workInProgressHook.baseState;
      let newBaseState = null;
      let newBaseUpdate = null;
      let prevUpdate = baseUpdate;
      let update = first;
      let didSkip = false;
      // 循环Update队列，依据优先级判断是否要使用reducer运行它，遇到第一个不需要运行的对象则记录其前一个。
      do {
        const updateExpirationTime = update.expirationTime;
        if (updateExpirationTime < renderExpirationTime) {
          // Priority is insufficient. Skip this update. If this is the first
          // skipped update, the previous update/state is the new base
          // update/state.
          // 翻译：优先权不足。跳过此更新。
          //      如果这是第一个跳过的更新，则先前的update/state是新的基本update/state。
          if (!didSkip) {
            didSkip = true;
            newBaseUpdate = prevUpdate;
            newBaseState = newState;
          }
          // Update the remaining priority in the queue.
          // 翻译：更新队列中的剩余优先级。
          if (updateExpirationTime > remainingExpirationTime) {
            remainingExpirationTime = updateExpirationTime;
          }
        } else {
          // Process this update.
          // 翻译：处理此更新。
          const action = update.action;
          newState = reducer(newState, action);
        }
        prevUpdate = update;
        update = update.next;
      } while (update !== null && update !== first);

      if (!didSkip) {
        newBaseUpdate = prevUpdate;
        newBaseState = newState;
      }

      // 将结果写入hook对象。
      workInProgressHook.memoizedState = newState;
      workInProgressHook.baseUpdate = newBaseUpdate;
      workInProgressHook.baseState = newBaseState;
    }

    const dispatch: Dispatch<A> = (queue.dispatch: any);
    return [workInProgressHook.memoizedState, dispatch];
  }

  // There's no existing queue, so this is the initial render.
  // 翻译：没有现有的队列，因此这是初始渲染。
  if (reducer === basicStateReducer) {
    // Special case for `useState`.
    // 翻译：useState的特例。
    if (typeof initialState === 'function') {
      initialState = initialState();
    }
  } else if (initialAction !== undefined && initialAction !== null) {
    // 与redux相似的设计，reducer第一个参数是state对象，第二个参数是action对象。
    // 运行的结果是新的state。
    initialState = reducer(initialState, initialAction);
  }
  // 挂载新的state，由于是初始渲染baseState（前一次渲染结果）与memoizedState相同。
  workInProgressHook.memoizedState = workInProgressHook.baseState = initialState;
  // 生成queue链表的首个对象。
  queue = workInProgressHook.queue = {
    last: null,
    dispatch: null,
  };
  // 生成dispatch函数。
  const dispatch: Dispatch<A> = (queue.dispatch = (dispatchAction.bind(
    null,
    currentlyRenderingFiber,
    queue,
  ): any));
  // API返回的结果。
  return [workInProgressHook.memoizedState, dispatch];
}

/**
 * 推入更新。
 * @param tag
 * @param create
 * @param destroy
 * @param inputs
 * @return {Effect}
 */
function pushEffect(tag, create, destroy, inputs) {
  const effect: Effect = {
    tag,
    create,
    destroy,
    inputs,
    // Circular
    next: (null: any),
  };
  if (componentUpdateQueue === null) {
    componentUpdateQueue = createFunctionComponentUpdateQueue();
    componentUpdateQueue.lastEffect = effect.next = effect;
  } else {
    const lastEffect = componentUpdateQueue.lastEffect;
    if (lastEffect === null) {
      componentUpdateQueue.lastEffect = effect.next = effect;
    } else {
      const firstEffect = lastEffect.next;
      lastEffect.next = effect;
      effect.next = firstEffect;
      componentUpdateQueue.lastEffect = effect;
    }
  }
  return effect;
}

export function useRef<T>(initialValue: T): {current: T} {
  currentlyRenderingFiber = resolveCurrentlyRenderingFiber();
  workInProgressHook = createWorkInProgressHook();
  let ref;

  if (workInProgressHook.memoizedState === null) {
    ref = {current: initialValue};
    if (__DEV__) {
      Object.seal(ref);
    }
    workInProgressHook.memoizedState = ref;
  } else {
    ref = workInProgressHook.memoizedState;
  }
  return ref;
}

/**
 * hook的API之一，用于处理副作用。
 * DOM 变更之后同步调用。
 * @param create
 * @param inputs
 */
export function useLayoutEffect(
  create: () => mixed,
  inputs: Array<mixed> | void | null,
): void {
  useEffectImpl(UpdateEffect, UnmountMutation | MountLayout, create, inputs);
}

/**
 * hook的API之一，用于处理副作用。
 * 每轮渲染结束后执行。
 * @param create
 * @param inputs
 */
export function useEffect(
  create: () => mixed,
  inputs: Array<mixed> | void | null,
): void {
  useEffectImpl(
    UpdateEffect | PassiveEffect,
    UnmountPassive | MountPassive,
    create,
    inputs,
  );
}

/**
 * useEffect和useLayoutEffect都会调用的函数。
 * @param fiberEffectTag 有关Fiber的EffectTag
 * @param hookEffectTag 有关hook的EffectTag
 * @param create 用户输入的回调函数
 * @param inputs 用户输入的监听变量列表
 */
function useEffectImpl(fiberEffectTag, hookEffectTag, create, inputs): void {
  currentlyRenderingFiber = resolveCurrentlyRenderingFiber();
  workInProgressHook = createWorkInProgressHook();

  // 默认是[create]，而create是一个匿名函数，因此这是永远都会为true的。
  let nextInputs = inputs !== undefined && inputs !== null ? inputs : [create];
  let destroy = null;
  if (currentHook !== null) {
    // 二次渲染。
    const prevEffect = currentHook.memoizedState;
    destroy = prevEffect.destroy;
    if (areHookInputsEqual(nextInputs, prevEffect.inputs)) {
      // 对比结果，需要更新。
      pushEffect(NoHookEffect, create, destroy, nextInputs);
      return;
    }
  }

  // 首次渲染。
  // 增加需要检查的tag，这里涉及到回调触发时机，useEffect和useLayoutEffect不一样。
  currentlyRenderingFiber.effectTag |= fiberEffectTag;
  workInProgressHook.memoizedState = pushEffect(
    hookEffectTag,
    create,
    destroy,
    nextInputs,
  );
}

export function useImperativeMethods<T>(
  ref: {current: T | null} | ((inst: T | null) => mixed) | null | void,
  create: () => T,
  inputs: Array<mixed> | void | null,
): void {
  // TODO: If inputs are provided, should we skip comparing the ref itself?
  const nextInputs =
    inputs !== null && inputs !== undefined
      ? inputs.concat([ref])
      : [ref, create];

  // TODO: I've implemented this on top of useEffect because it's almost the
  // same thing, and it would require an equal amount of code. It doesn't seem
  // like a common enough use case to justify the additional size.
  useLayoutEffect(() => {
    if (typeof ref === 'function') {
      const refCallback = ref;
      const inst = create();
      refCallback(inst);
      return () => refCallback(null);
    } else if (ref !== null && ref !== undefined) {
      const refObject = ref;
      const inst = create();
      refObject.current = inst;
      return () => {
        refObject.current = null;
      };
    }
  }, nextInputs);
}

export function useCallback<T>(
  callback: T,
  inputs: Array<mixed> | void | null,
): T {
  currentlyRenderingFiber = resolveCurrentlyRenderingFiber();
  workInProgressHook = createWorkInProgressHook();

  const nextInputs =
    inputs !== undefined && inputs !== null ? inputs : [callback];

  const prevState = workInProgressHook.memoizedState;
  if (prevState !== null) {
    const prevInputs = prevState[1];
    if (areHookInputsEqual(nextInputs, prevInputs)) {
      return prevState[0];
    }
  }
  workInProgressHook.memoizedState = [callback, nextInputs];
  return callback;
}

export function useMemo<T>(
  nextCreate: () => T,
  inputs: Array<mixed> | void | null,
): T {
  currentlyRenderingFiber = resolveCurrentlyRenderingFiber();
  workInProgressHook = createWorkInProgressHook();

  const nextInputs =
    inputs !== undefined && inputs !== null ? inputs : [nextCreate];

  const prevState = workInProgressHook.memoizedState;
  if (prevState !== null) {
    const prevInputs = prevState[1];
    if (areHookInputsEqual(nextInputs, prevInputs)) {
      return prevState[0];
    }
  }

  const nextValue = nextCreate();
  workInProgressHook.memoizedState = [nextValue, nextInputs];
  return nextValue;
}

/**
 * useState和useReducer返回的更新函数（即返回数列里的第二位）的生成函数。
 * 用于生成update对象，并加入hook对象的更新队列，再将Fiber加入更新调度。
 * 这个函数通过bind语法生成更新函数，前两个参数生成时绑定，后续只会传入第三个参数。
 * @param fiber 绑定的Fiber节点
 * @param queue 绑定的hook对象更新队列
 * @param action 要更新的state对象
 */
function dispatchAction<A>(fiber: Fiber, queue: UpdateQueue<A>, action: A) {
  invariant(
    numberOfReRenders < RE_RENDER_LIMIT,
    'Too many re-renders. React limits the number of renders to prevent ' +
      'an infinite loop.',
  );

  const alternate = fiber.alternate;
  if (
    fiber === currentlyRenderingFiber ||
    (alternate !== null && alternate === currentlyRenderingFiber)
  ) {
    // This is a render phase update. Stash it in a lazily-created map of
    // queue -> linked list of updates. After this render pass, we'll restart
    // and apply the stashed updates on top of the work-in-progress hook.
    // 翻译：这是渲染阶段更新。将其存储在延迟创建的队列映射->链接的更新列表中。
    //      渲染通过之后，我们将重新启动并在顶部进行中的hook上应用隐藏的更新。
    didScheduleRenderPhaseUpdate = true;
    // 生成update对象。
    const update: Update<A> = {
      expirationTime: renderExpirationTime,
      action,
      next: null,
    };
    if (renderPhaseUpdates === null) {
      renderPhaseUpdates = new Map();
    }
    const firstRenderPhaseUpdate = renderPhaseUpdates.get(queue);
    if (firstRenderPhaseUpdate === undefined) {
      // 更新列队第一个。
      renderPhaseUpdates.set(queue, update);
    } else {
      // Append the update to the end of the list.
      // 翻译：将更新追加到列表的末尾。
      let lastRenderPhaseUpdate = firstRenderPhaseUpdate;
      while (lastRenderPhaseUpdate.next !== null) {
        lastRenderPhaseUpdate = lastRenderPhaseUpdate.next;
      }
      lastRenderPhaseUpdate.next = update;
    }
  } else {
    // 获取运行时间。
    const currentTime = requestCurrentTime();
    // 计算过期时间。
    const expirationTime = computeExpirationForFiber(currentTime, fiber);
    // 生成Update对象。
    const update: Update<A> = {
      expirationTime,
      action,
      next: null,
    };
    // 与useEffect有关。
    flushPassiveEffects();
    // Append the update to the end of the list.
    // 翻译：将更新追加到列表的末尾。
    const last = queue.last;
    if (last === null) {
      // This is the first update. Create a circular list.
      // 翻译：这是第一次更新。创建一个环状列表。
      update.next = update;
    } else {
      const first = last.next;
      if (first !== null) {
        // Still circular.
        // 翻译：仍然是环状的。
        update.next = first;
      }
      last.next = update;
    }
    queue.last = update;
    // 加入调度。
    scheduleWork(fiber, expirationTime);
  }
}
