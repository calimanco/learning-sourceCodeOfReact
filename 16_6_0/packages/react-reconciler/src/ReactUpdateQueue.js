/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

// UpdateQueue is a linked list of prioritized updates.
//
// Like fibers, update queues come in pairs: a current queue, which represents
// the visible state of the screen, and a work-in-progress queue, which is
// can be mutated and processed asynchronously before it is committed — a form
// of double buffering. If a work-in-progress render is discarded before
// finishing, we create a new work-in-progress by cloning the current queue.
//
// Both queues share a persistent, singly-linked list structure. To schedule an
// update, we append it to the end of both queues. Each queue maintains a
// pointer to first update in the persistent list that hasn't been processed.
// The work-in-progress pointer always has a position equal to or greater than
// the current queue, since we always work on that one. The current queue's
// pointer is only updated during the commit phase, when we swap in the
// work-in-progress.
//
// For example:
//
//   Current pointer:           A - B - C - D - E - F
//   Work-in-progress pointer:              D - E - F
//                                          ^
//                                          The work-in-progress queue has
//                                          processed more updates than current.
//
// The reason we append to both queues is because otherwise we might drop
// updates without ever processing them. For example, if we only add updates to
// the work-in-progress queue, some updates could be lost whenever a work-in
// -progress render restarts by cloning from current. Similarly, if we only add
// updates to the current queue, the updates will be lost whenever an already
// in-progress queue commits and swaps with the current queue. However, by
// adding to both queues, we guarantee that the update will be part of the next
// work-in-progress. (And because the work-in-progress queue becomes the
// current queue once it commits, there's no danger of applying the same
// update twice.)
//
// Prioritization
// --------------
//
// Updates are not sorted by priority, but by insertion; new updates are always
// appended to the end of the list.
//
// The priority is still important, though. When processing the update queue
// during the render phase, only the updates with sufficient priority are
// included in the result. If we skip an update because it has insufficient
// priority, it remains in the queue to be processed later, during a lower
// priority render. Crucially, all updates subsequent to a skipped update also
// remain in the queue *regardless of their priority*. That means high priority
// updates are sometimes processed twice, at two separate priorities. We also
// keep track of a base state, that represents the state before the first
// update in the queue is applied.
//
// For example:
//
//   Given a base state of '', and the following queue of updates
//
//     A1 - B2 - C1 - D2
//
//   where the number indicates the priority, and the update is applied to the
//   previous state by appending a letter, React will process these updates as
//   two separate renders, one per distinct priority level:
//
//   First render, at priority 1:
//     Base state: ''
//     Updates: [A1, C1]
//     Result state: 'AC'
//
//   Second render, at priority 2:
//     Base state: 'A'            <-  The base state does not include C1,
//                                    because B2 was skipped.
//     Updates: [B2, C1, D2]      <-  C1 was rebased on top of B2
//     Result state: 'ABCD'
//
// Because we process updates in insertion order, and rebase high priority
// updates when preceding updates are skipped, the final result is deterministic
// regardless of priority. Intermediate state may vary according to system
// resources, but the final state is always the same.

import type {Fiber} from './ReactFiber';
import type {ExpirationTime} from './ReactFiberExpirationTime';

import {NoWork} from './ReactFiberExpirationTime';
import {Callback, ShouldCapture, DidCapture} from 'shared/ReactSideEffectTags';
import {ClassComponent} from 'shared/ReactWorkTags';

import {
  debugRenderPhaseSideEffects,
  debugRenderPhaseSideEffectsForStrictMode,
} from 'shared/ReactFeatureFlags';

import {StrictMode} from './ReactTypeOfMode';

import invariant from 'shared/invariant';
import warningWithoutStack from 'shared/warningWithoutStack';

export type Update<State> = {
  // 更新的过期时间。
  expirationTime: ExpirationTime,

  // UpdateState = 0 更新state;
  // ReplaceState = 1 替代state;
  // ForceUpdate = 2 强制更新;
  // CaptureUpdate = 3 捕获的错误更新;
  // 指定更新的类型，值为以上几种，根据这个标记执行后续操作。
  tag: 0 | 1 | 2 | 3,
  // 更新内容，比如`setState`接收的第一个参数。
  payload: any,
  // 对应的回调，`setState`，`render`都有。
  callback: (() => mixed) | null,

  // 指向下一个更新。
  next: Update<State> | null,
  // 指向下一个`side effect`副作用。
  nextEffect: Update<State> | null,
};

export type UpdateQueue<State> = {
  // 每次操作完更新之后的`state`。
  baseState: State,

  // 记录单向链表的数据结构。
  // 队列中的第一个Update对象。
  firstUpdate: Update<State> | null,
  // 队列中的最后一个Update对象。
  lastUpdate: Update<State> | null,

  // 第一个错误捕获时的Update对象。
  firstCapturedUpdate: Update<State> | null,
  // 最后一个错误捕获时的Update对象。
  lastCapturedUpdate: Update<State> | null,

  // 第一个副作用。
  firstEffect: Update<State> | null,
  // 最后一个副作用。
  lastEffect: Update<State> | null,

  // 第一个和最后一个错误捕获产生的副作用。
  firstCapturedEffect: Update<State> | null,
  lastCapturedEffect: Update<State> | null,
};

// 给Update对象的tag属性的枚举。
export const UpdateState = 0;
export const ReplaceState = 1;
export const ForceUpdate = 2;
export const CaptureUpdate = 3;

// Global state that is reset at the beginning of calling `processUpdateQueue`.
// It should only be read right after calling `processUpdateQueue`, via
// `checkHasForceUpdateAfterProcessing`.
let hasForceUpdate = false;

let didWarnUpdateInsideUpdate;
let currentlyProcessingQueue;
export let resetCurrentlyProcessingQueue;
if (__DEV__) {
  didWarnUpdateInsideUpdate = false;
  currentlyProcessingQueue = null;
  resetCurrentlyProcessingQueue = () => {
    currentlyProcessingQueue = null;
  };
}

/**
 * 创建并返回UpdateQueue对象（队列）。（可以当成构造函数）
 * @param baseState 初始状态
 * @return {UpdateQueue<State>}
 */
export function createUpdateQueue<State>(baseState: State): UpdateQueue<State> {
  const queue: UpdateQueue<State> = {
    baseState,
    firstUpdate: null,
    lastUpdate: null,
    firstCapturedUpdate: null,
    lastCapturedUpdate: null,
    firstEffect: null,
    lastEffect: null,
    firstCapturedEffect: null,
    lastCapturedEffect: null,
  };
  return queue;
}

/**
 * 复制一个UpdateQueue对象（队列）。
 * 这里的复制只是复制了baseState，firstUpdate，lastUpdate，其他字段会置空。
 * @param currentQueue 需要复制的对象
 * @return {UpdateQueue<State>}
 */
function cloneUpdateQueue<State>(
  currentQueue: UpdateQueue<State>,
): UpdateQueue<State> {
  const queue: UpdateQueue<State> = {
    baseState: currentQueue.baseState,
    firstUpdate: currentQueue.firstUpdate,
    lastUpdate: currentQueue.lastUpdate,

    // TODO: With resuming, if we bail out and resuse the child tree, we should
    // keep these effects.
    firstCapturedUpdate: null,
    lastCapturedUpdate: null,

    firstEffect: null,
    lastEffect: null,

    firstCapturedEffect: null,
    lastCapturedEffect: null,
  };
  return queue;
}

/**
 * 创建并返回Update对象，可以理解成Update的构造函数。
 * @param expirationTime 过期时间
 * @return {{next: null, payload: null, expirationTime: ExpirationTime, callback: null, tag: number, nextEffect: null}}
 */
export function createUpdate(expirationTime: ExpirationTime): Update<*> {
  return {
    expirationTime: expirationTime,

    tag: UpdateState,
    payload: null,
    callback: null,

    next: null,
    nextEffect: null,
  };
}

/**
 * 将Update对象加入更新队列。
 * @param queue UpdateQueue对象
 * @param update Update对象
 */
function appendUpdateToQueue<State>(
  queue: UpdateQueue<State>,
  update: Update<State>,
) {
  // Append the update to the end of the list.
  // 翻译：把Update对象加到队列尾部。
  if (queue.lastUpdate === null) {
    // Queue is empty
    // 翻译：队列是空的。
    // 如果队列本来就没有尾部，就证明是第一个对象。
    queue.firstUpdate = queue.lastUpdate = update;
  } else {
    // 如果不是空队列，就把之前的尾部的next替换成当前的Update对象。
    // 并把尾部设置成当前的Update对象。
    queue.lastUpdate.next = update;
    queue.lastUpdate = update;
  }
}

/**
 * 初始化Fiber对象上的更新队列或将Update对象加入队列。
 * @param fiber Fiber对象
 * @param update Update对象
 */
export function enqueueUpdate<State>(fiber: Fiber, update: Update<State>) {
  // Update queues are created lazily.
  // 翻译：延迟创建更新队列。
  // alternate实际上就是workingProgress中的Fiber，为了要保证两个Fiber的更新队列相同，
  // 这里做了很多判断和处理。
  const alternate = fiber.alternate;
  let queue1;
  let queue2;
  if (alternate === null) {
    // There's only one fiber.
    // 翻译：这里只有一个Fiber对象。
    queue1 = fiber.updateQueue;
    queue2 = null;
    if (queue1 === null) {
      // 创建新的UpdateQueue对象。
      queue1 = fiber.updateQueue = createUpdateQueue(fiber.memoizedState);
    }
  } else {
    // There are two owners.
    // 翻译：这里有两个Fiber对象。
    queue1 = fiber.updateQueue;
    queue2 = alternate.updateQueue;
    if (queue1 === null) {
      if (queue2 === null) {
        // Neither fiber has an update queue. Create new ones.
        // 翻译：这两个Fiber对象都没有更新队列。 创建新的。
        queue1 = fiber.updateQueue = createUpdateQueue(fiber.memoizedState);
        queue2 = alternate.updateQueue = createUpdateQueue(
          alternate.memoizedState,
        );
      } else {
        // Only one fiber has an update queue. Clone to create a new one.
        // 翻译：只有一个Fiber对象有更新队列。克隆以创建一个新的。
        // 把alternate上的更新队列复制到Fiber对象上。
        queue1 = fiber.updateQueue = cloneUpdateQueue(queue2);
      }
    } else {
      if (queue2 === null) {
        // Only one fiber has an update queue. Clone to create a new one.
        // 翻译：只有一个Fiber对象有更新队列。克隆以创建一个新的。
        // 把Fiber对象上的更新队列复制到alternate上。
        queue2 = alternate.updateQueue = cloneUpdateQueue(queue1);
      } else {
        // Both owners have an update queue.
        // 两个都有更新队列。
      }
    }
  }
  if (queue2 === null || queue1 === queue2) {
    // There's only a single queue.
    // 翻译：这里只有一个Fiber对象。
    appendUpdateToQueue(queue1, update);
  } else {
    // There are two queues. We need to append the update to both queues,
    // while accounting for the persistent structure of the list — we don't
    // want the same update to be added multiple times.
    // 翻译：有两个队列。我们需要将更新添加到两个队列中，同时考虑列表的持久性结构，
    //      我们不希望多次添加相同的更新。
    if (queue1.lastUpdate === null || queue2.lastUpdate === null) {
      // One of the queues is not empty. We must add the update to both queues.
      // 翻译：队列之一不为空。我们必须将更新添加到两个队列中。
      appendUpdateToQueue(queue1, update);
      appendUpdateToQueue(queue2, update);
    } else {
      // Both queues are non-empty. The last update is the same in both lists,
      // because of structural sharing. So, only append to one of the lists.
      // 翻译：两个队列都是非空。两个列表中的最新更新相同，
      //      因为结构共享。因此，仅追加到列表之一。
      appendUpdateToQueue(queue1, update);
      // But we still need to update the `lastUpdate` pointer of queue2.
      // 翻译：但是我们仍然需要更新queue2的lastUpdate属性。
      queue2.lastUpdate = update;
    }
  }

  if (__DEV__) {
    if (
      fiber.tag === ClassComponent &&
      (currentlyProcessingQueue === queue1 ||
        (queue2 !== null && currentlyProcessingQueue === queue2)) &&
      !didWarnUpdateInsideUpdate
    ) {
      warningWithoutStack(
        false,
        'An update (setState, replaceState, or forceUpdate) was scheduled ' +
          'from inside an update function. Update functions should be pure, ' +
          'with zero side-effects. Consider using componentDidUpdate or a ' +
          'callback.',
      );
      didWarnUpdateInsideUpdate = true;
    }
  }
}

export function enqueueCapturedUpdate<State>(
  workInProgress: Fiber,
  update: Update<State>,
) {
  // Captured updates go into a separate list, and only on the work-in-
  // progress queue.
  let workInProgressQueue = workInProgress.updateQueue;
  if (workInProgressQueue === null) {
    workInProgressQueue = workInProgress.updateQueue = createUpdateQueue(
      workInProgress.memoizedState,
    );
  } else {
    // TODO: I put this here rather than createWorkInProgress so that we don't
    // clone the queue unnecessarily. There's probably a better way to
    // structure this.
    workInProgressQueue = ensureWorkInProgressQueueIsAClone(
      workInProgress,
      workInProgressQueue,
    );
  }

  // Append the update to the end of the list.
  if (workInProgressQueue.lastCapturedUpdate === null) {
    // This is the first render phase update
    workInProgressQueue.firstCapturedUpdate = workInProgressQueue.lastCapturedUpdate = update;
  } else {
    workInProgressQueue.lastCapturedUpdate.next = update;
    workInProgressQueue.lastCapturedUpdate = update;
  }
}

/**
 * 确保正在处理的队列是克隆副本
 * @param workInProgress
 * @param queue
 * @return {UpdateQueue<State>}
 */
function ensureWorkInProgressQueueIsAClone<State>(
  workInProgress: Fiber,
  queue: UpdateQueue<State>,
): UpdateQueue<State> {
  const current = workInProgress.alternate;
  if (current !== null) {
    // If the work-in-progress queue is equal to the current queue,
    // we need to clone it first.
    // 翻译：如果正在处理的队列等于当前队列，则需要首先克隆它。
    if (queue === current.updateQueue) {
      queue = workInProgress.updateQueue = cloneUpdateQueue(queue);
    }
  }
  return queue;
}

/**
 * 根据Update对象的tag值，操作state并返回结果。
 * @param workInProgress 当前处理的Fiber对象
 * @param queue 更新队列
 * @param update update对象
 * @param prevState 之前的state对象
 * @param nextProps 新的props对象
 * @param instance 类实例
 * @return {State|*}
 */
function getStateFromUpdate<State>(
  workInProgress: Fiber,
  queue: UpdateQueue<State>,
  update: Update<State>,
  prevState: State,
  nextProps: any,
  instance: any,
): any {
  // 根据需要进行更新操作进行。
  switch (update.tag) {
    case ReplaceState: {
      const payload = update.payload;
      if (typeof payload === 'function') {
        // Updater function
        // 翻译：更新函数。
        // 这就是使用者传递函数给setState的情况。
        if (__DEV__) {
          if (
            debugRenderPhaseSideEffects ||
            (debugRenderPhaseSideEffectsForStrictMode &&
              workInProgress.mode & StrictMode)
          ) {
            payload.call(instance, prevState, nextProps);
          }
        }
        return payload.call(instance, prevState, nextProps);
      }
      // State object
      return payload;
    }
    case CaptureUpdate: {
      // 移除ShouldCapture，加入DidCapture。
      workInProgress.effectTag =
        (workInProgress.effectTag & ~ShouldCapture) | DidCapture;
    }
    // Intentional fallthrough
    // 翻译：故意掉队。
    case UpdateState: {
      const payload = update.payload;
      let partialState;
      if (typeof payload === 'function') {
        // Updater function
        // 翻译：更新函数。
        if (__DEV__) {
          if (
            debugRenderPhaseSideEffects ||
            (debugRenderPhaseSideEffectsForStrictMode &&
              workInProgress.mode & StrictMode)
          ) {
            payload.call(instance, prevState, nextProps);
          }
        }
        partialState = payload.call(instance, prevState, nextProps);
      } else {
        // Partial state object
        // 翻译：部分state对象
        partialState = payload;
      }
      if (partialState === null || partialState === undefined) {
        // Null and undefined are treated as no-ops.
        // 翻译：Null和undefined视为无操作。
        return prevState;
      }
      // Merge the partial state and the previous state.
      // 翻译：合并部分状态和先前状态。
      return Object.assign({}, prevState, partialState);
    }
    case ForceUpdate: {
      hasForceUpdate = true;
      return prevState;
    }
  }
  return prevState;
}

/**
 * 进行Update队列流程
 * @param workInProgress 当前处理的Fiber对象
 * @param queue 更新队列
 * @param props 新的props对象
 * @param instance 类实例
 * @param renderExpirationTime 当前处理的Fiber所在的FiberRoot的nextExpirationTimeToWorkOn
 */
export function processUpdateQueue<State>(
  workInProgress: Fiber,
  queue: UpdateQueue<State>,
  props: any,
  instance: any,
  renderExpirationTime: ExpirationTime,
): void {
  hasForceUpdate = false;

  // 确保即将修改的queue只是克隆，不会修改current上的queue。
  queue = ensureWorkInProgressQueueIsAClone(workInProgress, queue);

  if (__DEV__) {
    currentlyProcessingQueue = queue;
  }

  // These values may change as we process the queue.
  // 翻译：当我们处理队列时，这些值可能会更改。
  // 每一次计算的结果都会保存到baseState。
  let newBaseState = queue.baseState;
  let newFirstUpdate = null;
  let newExpirationTime = NoWork;

  // Iterate through the list of updates to compute the result.
  // 翻译：遍历更新列表以计算结果。
  let update = queue.firstUpdate;
  let resultState = newBaseState;
  while (update !== null) {
    const updateExpirationTime = update.expirationTime;
    if (updateExpirationTime > renderExpirationTime) {
      // This update does not have sufficient priority. Skip it.
      // 翻译：此更新没有足够的优先级。 跳过它。
      if (newFirstUpdate === null) {
        // This is the first skipped update. It will be the first update in
        // the new list.
        // 翻译：这是第一个跳过的更新。这将是新列表中的第一个更新。
        newFirstUpdate = update;
        // Since this is the first update that was skipped, the current result
        // is the new base state.
        // 翻译：由于这是第一个被跳过的更新，因此当前结果是新的基本状态。
        newBaseState = resultState;
      }
      // Since this update will remain in the list, update the remaining
      // expiration time.
      // 翻译：由于此更新将保留在列表中，因此请更新剩余的到期时间。
      if (
        newExpirationTime === NoWork ||
        newExpirationTime > updateExpirationTime
      ) {
        newExpirationTime = updateExpirationTime;
      }
    } else {
      // This update does have sufficient priority. Process it and compute
      // a new result.
      // 翻译：此更新确实具有足够的优先级。处理它并计算新结果。
      resultState = getStateFromUpdate(
        workInProgress,
        queue,
        update,
        resultState,
        props,
        instance,
      );
      // 如果有回调，需要标记effectTag。
      const callback = update.callback;
      if (callback !== null) {
        workInProgress.effectTag |= Callback;
        // Set this to null, in case it was mutated during an aborted render.
        // 翻译：设置为null，以防在中止渲染期间被改变。
        update.nextEffect = null;
        if (queue.lastEffect === null) {
          queue.firstEffect = queue.lastEffect = update;
        } else {
          queue.lastEffect.nextEffect = update;
          queue.lastEffect = update;
        }
      }
    }
    // Continue to the next update.
    // 翻译：继续进行下一个更新。
    update = update.next;
  }

  // Separately, iterate though the list of captured updates.
  // 翻译：另外，遍历捕获的更新列表。
  let newFirstCapturedUpdate = null;
  update = queue.firstCapturedUpdate;
  while (update !== null) {
    const updateExpirationTime = update.expirationTime;
    if (updateExpirationTime > renderExpirationTime) {
      // This update does not have sufficient priority. Skip it.
      // 翻译：此更新没有足够的优先级。 跳过它。
      if (newFirstCapturedUpdate === null) {
        // This is the first skipped captured update. It will be the first
        // update in the new list.
        // 翻译：这是第一个跳过的更新。这将是新列表中的第一个更新。
        newFirstCapturedUpdate = update;
        // If this is the first update that was skipped, the current result is
        // the new base state.
        // 翻译：如果这是跳过的第一个更新，则当前结果是newBaseState。
        if (newFirstUpdate === null) {
          newBaseState = resultState;
        }
      }
      // Since this update will remain in the list, update the remaining
      // expiration time.
      // 翻译：由于此更新将保留在列表中，因此请更新剩余的到期时间。
      if (
        newExpirationTime === NoWork ||
        newExpirationTime > updateExpirationTime
      ) {
        newExpirationTime = updateExpirationTime;
      }
    } else {
      // This update does have sufficient priority. Process it and compute
      // a new result.
      // 翻译：此更新确实具有足够的优先级。处理它并计算新结果。
      resultState = getStateFromUpdate(
        workInProgress,
        queue,
        update,
        resultState,
        props,
        instance,
      );
      const callback = update.callback;
      if (callback !== null) {
        workInProgress.effectTag |= Callback;
        // Set this to null, in case it was mutated during an aborted render.
        // 翻译：设置为null，以防在中止渲染期间被改变。
        update.nextEffect = null;
        if (queue.lastCapturedEffect === null) {
          queue.firstCapturedEffect = queue.lastCapturedEffect = update;
        } else {
          queue.lastCapturedEffect.nextEffect = update;
          queue.lastCapturedEffect = update;
        }
      }
    }
    update = update.next;
  }

  if (newFirstUpdate === null) {
    queue.lastUpdate = null;
  }
  if (newFirstCapturedUpdate === null) {
    queue.lastCapturedUpdate = null;
  } else {
    workInProgress.effectTag |= Callback;
  }
  if (newFirstUpdate === null && newFirstCapturedUpdate === null) {
    // We processed every update, without skipping. That means the new base
    // state is the same as the result state.
    // 翻译：我们处理了所有更新，没有跳过。这意味着newBaseState与resultState相同。
    newBaseState = resultState;
  }

  queue.baseState = newBaseState;
  queue.firstUpdate = newFirstUpdate;
  queue.firstCapturedUpdate = newFirstCapturedUpdate;

  // Set the remaining expiration time to be whatever is remaining in the queue.
  // This should be fine because the only two other things that contribute to
  // expiration time are props and context. We're already in the middle of the
  // begin phase by the time we start processing the queue, so we've already
  // dealt with the props. Context in components that specify
  // shouldComponentUpdate is tricky; but we'll have to account for
  // that regardless.
  // 翻译：将剩余的到期时间设置为队列中剩余的时间。这应该没问题，因为促成到期时间的另外两件事是道具和上下文。
  //      到开始处理队列时，我们已经处于开始阶段的中间，因此我们已经处理了道具。
  //      指定shouldComponentUpdate的组件中的context很棘手。但无论如何，我们都必须考虑这一点。
  workInProgress.expirationTime = newExpirationTime;
  workInProgress.memoizedState = resultState;

  if (__DEV__) {
    currentlyProcessingQueue = null;
  }
}

function callCallback(callback, context) {
  invariant(
    typeof callback === 'function',
    'Invalid argument passed as callback. Expected a function. Instead ' +
      'received: %s',
    callback,
  );
  callback.call(context);
}

/**
 * 重置hasForceUpdate为false。
 */
export function resetHasForceUpdateBeforeProcessing() {
  hasForceUpdate = false;
}

/**
 * 读取hasForceUpdate的值。
 * @return {boolean}
 */
export function checkHasForceUpdateAfterProcessing(): boolean {
  return hasForceUpdate;
}

export function commitUpdateQueue<State>(
  finishedWork: Fiber,
  finishedQueue: UpdateQueue<State>,
  instance: any,
  renderExpirationTime: ExpirationTime,
): void {
  // If the finished render included captured updates, and there are still
  // lower priority updates left over, we need to keep the captured updates
  // in the queue so that they are rebased and not dropped once we process the
  // queue again at the lower priority.
  // 翻译：如果完成的渲染包含捕获的更新，并且还剩下优先级较低的更新，
  //      那么我们需要将捕获的更新保留在队列中，以便一旦我们以较低优先级再次处理队列时，
  //      捕获的更新将被重新设置并且不会被丢弃。
  if (finishedQueue.firstCapturedUpdate !== null) {
    // Join the captured update list to the end of the normal list.
    // 翻译：将捕获的更新列表加入到普通列表的末尾。
    if (finishedQueue.lastUpdate !== null) {
      finishedQueue.lastUpdate.next = finishedQueue.firstCapturedUpdate;
      finishedQueue.lastUpdate = finishedQueue.lastCapturedUpdate;
    }
    // Clear the list of captured updates.
    // 翻译：清理捕获的更新列表。
    finishedQueue.firstCapturedUpdate = finishedQueue.lastCapturedUpdate = null;
  }

  // Commit the effects
  // 翻译：提交Effect。
  commitUpdateEffects(finishedQueue.firstEffect, instance);
  finishedQueue.firstEffect = finishedQueue.lastEffect = null;

  commitUpdateEffects(finishedQueue.firstCapturedEffect, instance);
  finishedQueue.firstCapturedEffect = finishedQueue.lastCapturedEffect = null;
}

function commitUpdateEffects<State>(
  effect: Update<State> | null,
  instance: any,
): void {
  while (effect !== null) {
    const callback = effect.callback;
    if (callback !== null) {
      effect.callback = null;
      callCallback(callback, instance);
    }
    effect = effect.nextEffect;
  }
}
