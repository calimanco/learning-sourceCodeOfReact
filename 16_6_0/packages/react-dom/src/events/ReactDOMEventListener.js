/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {AnyNativeEvent} from 'events/PluginModuleType';
import type {Fiber} from 'react-reconciler/src/ReactFiber';
import type {DOMTopLevelEventType} from 'events/TopLevelEventTypes';

import {batchedUpdates, interactiveUpdates} from 'events/ReactGenericBatching';
import {runExtractedEventsInBatch} from 'events/EventPluginHub';
import {isFiberMounted} from 'react-reconciler/reflection';
import {HostRoot} from 'shared/ReactWorkTags';

import {addEventBubbleListener, addEventCaptureListener} from './EventListener';
import getEventTarget from './getEventTarget';
import {getClosestInstanceFromNode} from '../client/ReactDOMComponentTree';
import SimpleEventPlugin from './SimpleEventPlugin';
import {getRawEventName} from './DOMTopLevelEventTypes';

const {isInteractiveTopLevelEventType} = SimpleEventPlugin;

const CALLBACK_BOOKKEEPING_POOL_SIZE = 10;
const callbackBookkeepingPool = [];

/**
 * Find the deepest React component completely containing the root of the
 * passed-in instance (for use when entire React trees are nested within each
 * other). If React trees are not nested, returns null.
 * 翻译：查找完全包含传入实例根的最深的React组件（用于将整个React树相互嵌套时使用）。
 *      如果React树没有嵌套，则返回null。
 */
function findRootContainerNode(inst) {
  // TODO: It may be a good idea to cache this to prevent unnecessary DOM
  // traversal, but caching is difficult to do correctly without using a
  // mutation observer to listen for all DOM changes.
  while (inst.return) {
    inst = inst.return;
  }
  if (inst.tag !== HostRoot) {
    // This can happen if we're in a detached tree.
    // 翻译：如果我们在分离的树中，可能会发生这种情况。
    return null;
  }
  // RootFiber的stateNode是FiberRoot，FiberRoot的containerInfo是React树挂载的DOM节点。
  return inst.stateNode.containerInfo;
}

// Used to store ancestor hierarchy in top level callback
// 翻译：用于将祖先层次结构存储在顶级回调中。
function getTopLevelCallbackBookKeeping(
  topLevelType,
  nativeEvent,
  targetInst,
): {
  topLevelType: ?DOMTopLevelEventType,
  nativeEvent: ?AnyNativeEvent,
  targetInst: Fiber | null,
  ancestors: Array<Fiber>,
} {
  if (callbackBookkeepingPool.length) {
    const instance = callbackBookkeepingPool.pop();
    instance.topLevelType = topLevelType;
    instance.nativeEvent = nativeEvent;
    instance.targetInst = targetInst;
    return instance;
  }
  return {
    topLevelType,
    nativeEvent,
    targetInst,
    ancestors: [],
  };
}

function releaseTopLevelCallbackBookKeeping(instance) {
  instance.topLevelType = null;
  instance.nativeEvent = null;
  instance.targetInst = null;
  instance.ancestors.length = 0;
  if (callbackBookkeepingPool.length < CALLBACK_BOOKKEEPING_POOL_SIZE) {
    callbackBookkeepingPool.push(instance);
  }
}

/**
 * 处理React嵌套情况下的事件传递。
 * @param bookKeeping 保存事件信息的对象
 */
function handleTopLevel(bookKeeping) {
  // targetDOM节点的Fiber对象。
  let targetInst = bookKeeping.targetInst;

  // Loop through the hierarchy, in case there's any nested components.
  // It's important that we build the array of ancestors before calling any
  // event handlers, because event handlers can modify the DOM, leading to
  // inconsistencies with ReactMount's node cache. See #1105.
  // 翻译：遍历层次结构，以防存在任何嵌套的组件。
  //      在调用任何事件处理程序之前，先构建祖先数组非常重要，因为事件处理程序可以修改DOM，
  //      从而导致与ReactMount的节点缓存不一致。 请参阅＃1105。
  let ancestor = targetInst;
  do {
    if (!ancestor) {
      bookKeeping.ancestors.push(ancestor);
      break;
    }
    // 向上找RootFiber节点，找到则返回Container的DOM节点，否则返回null。
    const root = findRootContainerNode(ancestor);
    if (!root) {
      break;
    }
    bookKeeping.ancestors.push(ancestor);
    // 继续向上找Fiber节点，正常来说Container的DOM节点已经没有Fiber对象了。
    // 但不排除React实例嵌套React实例进行渲染的情况。
    ancestor = getClosestInstanceFromNode(root);
  } while (ancestor);

  // 遍历收集到的ancestors，包括触发节点的Fiber以及嵌套当前React实例的所有父级Fiber。
  // 一般情况下React都是单例模式，所以数组只有一个项。
  for (let i = 0; i < bookKeeping.ancestors.length; i++) {
    targetInst = bookKeeping.ancestors[i];
    runExtractedEventsInBatch(
      bookKeeping.topLevelType,
      targetInst,
      bookKeeping.nativeEvent,
      getEventTarget(bookKeeping.nativeEvent),
    );
  }
}

// TODO: can we stop exporting these?
export let _enabled = true;

export function setEnabled(enabled: ?boolean) {
  _enabled = !!enabled;
}

export function isEnabled() {
  return _enabled;
}

/**
 * Traps top-level events by using event bubbling.
 * 翻译：通过使用事件冒泡来捕获顶级事件。
 *
 * @param {number} topLevelType Number from `TopLevelEventTypes`.
 * @param {object} element Element on which to attach listener.
 * @return {?object} An object with a remove function which will forcefully
 *                  remove the listener.
 * @internal
 */
export function trapBubbledEvent(
  topLevelType: DOMTopLevelEventType,
  element: Document | Element,
) {
  if (!element) {
    return null;
  }
  // 这里是判断是不是交互式事件，两者的差别只是过期时间不同，交互式事件需要更即时的更新。
  const dispatch = isInteractiveTopLevelEventType(topLevelType)
    ? dispatchInteractiveEvent
    : dispatchEvent;

  addEventBubbleListener(
    element,
    getRawEventName(topLevelType),
    // Check if interactive and wrap in interactiveUpdates
    // 翻译：检查是否交互式并包装交互式更新。
    dispatch.bind(null, topLevelType),
  );
}

/**
 * Traps a top-level event by using event capturing.
 *
 * @param {number} topLevelType Number from `TopLevelEventTypes`.
 * @param {object} element Element on which to attach listener.
 * @return {?object} An object with a remove function which will forcefully
 *                  remove the listener.
 * @internal
 */
export function trapCapturedEvent(
  topLevelType: DOMTopLevelEventType,
  element: Document | Element,
) {
  if (!element) {
    return null;
  }
  const dispatch = isInteractiveTopLevelEventType(topLevelType)
    ? dispatchInteractiveEvent
    : dispatchEvent;

  addEventCaptureListener(
    element,
    getRawEventName(topLevelType),
    // Check if interactive and wrap in interactiveUpdates
    dispatch.bind(null, topLevelType),
  );
}

function dispatchInteractiveEvent(topLevelType, nativeEvent) {
  // 下面这个函数来自packages/react-reconciler/src/ReactFiberScheduler.js
  interactiveUpdates(dispatchEvent, topLevelType, nativeEvent);
}

/**
 * 派发事件。
 * @param topLevelType 顶级事件类型
 * @param nativeEvent 事件触发后浏览器传入的原生对象
 */
export function dispatchEvent(
  topLevelType: DOMTopLevelEventType,
  nativeEvent: AnyNativeEvent,
) {
  if (!_enabled) {
    return;
  }

  // 兼容各种环境获取target的方法（就是触发事件的DOM节点）。
  const nativeEventTarget = getEventTarget(nativeEvent);
  // 获取Fiber对象，如果当前的节点没有会向上找到一个有的。
  let targetInst = getClosestInstanceFromNode(nativeEventTarget);
  if (
    targetInst !== null &&
    typeof targetInst.tag === 'number' &&
    // 判断当前DOM是否已经挂载。
    !isFiberMounted(targetInst)
  ) {
    // 这个情况说明节点还未被挂载，即使已经有Fiber也要认为没有。
    // If we get an event (ex: img onload) before committing that
    // component's mount, ignore it for now (that is, treat it as if it was an
    // event on a non-React tree). We might also consider queueing events and
    // dispatching them after the mount.
    // 翻译：如果我们在提交组件挂载之前接到一个事件（比如：img的onload事件），
    //      请暂时将其忽略（即，将其视为非响应树上的事件）。
    //      我们也可以考虑对事件进行排队，然后在挂载后分派它们。
    targetInst = null;
  }

  // 创建一个bookKeeping对象保存现有的信息，这个对象会被保存到对象池重复使用。
  // 形如{topLevelType、nativeEvent、targetInst、ancestors}
  const bookKeeping = getTopLevelCallbackBookKeeping(
    topLevelType,
    nativeEvent,
    targetInst,
  );

  try {
    // Event queue being processed in the same cycle allows
    // `preventDefault`.
    // 翻译：在同一周期中处理的事件队列允许使用“ preventDefault”。
    // 这个函数也是
    batchedUpdates(handleTopLevel, bookKeeping);
  } finally {
    releaseTopLevelCallbackBookKeeping(bookKeeping);
  }
}
