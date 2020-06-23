/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 * @flow
 */

import {rethrowCaughtError} from 'shared/ReactErrorUtils';
import invariant from 'shared/invariant';

import {
  injectEventPluginOrder,
  injectEventPluginsByName,
  plugins,
} from './EventPluginRegistry';
import {
  executeDispatchesInOrder,
  getFiberCurrentPropsFromNode,
} from './EventPluginUtils';
import accumulateInto from './accumulateInto';
import forEachAccumulated from './forEachAccumulated';

import type {PluginModule} from './PluginModuleType';
import type {ReactSyntheticEvent} from './ReactSyntheticEventType';
import type {Fiber} from 'react-reconciler/src/ReactFiber';
import type {AnyNativeEvent} from './PluginModuleType';
import type {TopLevelType} from './TopLevelEventTypes';

/**
 * Internal queue of events that have accumulated their dispatches and are
 * waiting to have their dispatches executed.
 */
let eventQueue: ?(Array<ReactSyntheticEvent> | ReactSyntheticEvent) = null;

/**
 * Dispatches an event and releases it back into the pool, unless persistent.
 * 翻译：调度事件并将其释放回池中，除非是持久的。
 *
 * @param {?object} event Synthetic event to be dispatched.
 * @param {boolean} simulated If the event is simulated (changes exn behavior)
 * @private
 */
const executeDispatchesAndRelease = function(
  event: ReactSyntheticEvent,
  simulated: boolean,
) {
  if (event) {
    executeDispatchesInOrder(event, simulated);

    if (!event.isPersistent()) {
      event.constructor.release(event);
    }
  }
};
const executeDispatchesAndReleaseSimulated = function(e) {
  return executeDispatchesAndRelease(e, true);
};
const executeDispatchesAndReleaseTopLevel = function(e) {
  return executeDispatchesAndRelease(e, false);
};

function isInteractive(tag) {
  return (
    tag === 'button' ||
    tag === 'input' ||
    tag === 'select' ||
    tag === 'textarea'
  );
}

function shouldPreventMouseEvent(name, type, props) {
  switch (name) {
    case 'onClick':
    case 'onClickCapture':
    case 'onDoubleClick':
    case 'onDoubleClickCapture':
    case 'onMouseDown':
    case 'onMouseDownCapture':
    case 'onMouseMove':
    case 'onMouseMoveCapture':
    case 'onMouseUp':
    case 'onMouseUpCapture':
      return !!(props.disabled && isInteractive(type));
    default:
      return false;
  }
}

/**
 * This is a unified interface for event plugins to be installed and configured.
 *
 * Event plugins can implement the following properties:
 *
 *   `extractEvents` {function(string, DOMEventTarget, string, object): *}
 *     Required. When a top-level event is fired, this method is expected to
 *     extract synthetic events that will in turn be queued and dispatched.
 *
 *   `eventTypes` {object}
 *     Optional, plugins that fire events must publish a mapping of registration
 *     names that are used to register listeners. Values of this mapping must
 *     be objects that contain `registrationName` or `phasedRegistrationNames`.
 *
 *   `executeDispatch` {function(object, function, string)}
 *     Optional, allows plugins to override how an event gets dispatched. By
 *     default, the listener is simply invoked.
 *
 * Each plugin that is injected into `EventsPluginHub` is immediately operable.
 *
 * @public
 */

/**
 * Methods for injecting dependencies.
 * 翻译：注入依赖项的方法。
 */
export const injection = {
  /**
   * 设置插件的顺序。
   * @param {array} InjectedEventPluginOrder
   * @public
   */
  injectEventPluginOrder,

  /**
   * 设置插件的顺序。
   * @param {object} injectedNamesToPlugins Map from names to plugin modules.
   */
  injectEventPluginsByName,
};

/**
 * @param {object} inst The instance, which is the source of events.
 * @param {string} registrationName Name of listener (e.g. `onClick`).
 * @return {?function} The stored callback.
 */
export function getListener(inst: Fiber, registrationName: string) {
  let listener;

  // TODO: shouldPreventMouseEvent is DOM-specific and definitely should not
  // live here; needs to be moved to a better place soon
  const stateNode = inst.stateNode;
  if (!stateNode) {
    // Work in progress (ex: onload events in incremental mode).
    return null;
  }
  const props = getFiberCurrentPropsFromNode(stateNode);
  if (!props) {
    // Work in progress.
    return null;
  }
  listener = props[registrationName];
  if (shouldPreventMouseEvent(registrationName, inst.type, props)) {
    return null;
  }
  invariant(
    !listener || typeof listener === 'function',
    'Expected `%s` listener to be a function, instead got a value of `%s` type.',
    registrationName,
    typeof listener,
  );
  return listener;
}

/**
 * Allows registered plugins an opportunity to extract events from top-level
 * native browser events.
 * 翻译：使注册的插件有机会从顶级本机浏览器事件中提取事件。
 * @return {*} An accumulation of synthetic events.
 * @internal
 */
function extractEvents(
  topLevelType: TopLevelType,
  targetInst: null | Fiber,
  nativeEvent: AnyNativeEvent,
  nativeEventTarget: EventTarget,
): Array<ReactSyntheticEvent> | ReactSyntheticEvent | null {
  let events = null;
  for (let i = 0; i < plugins.length; i++) {
    // Not every plugin in the ordering may be loaded at runtime.
    // 翻译：并非队列中的每个插件都可以在运行时加载。
    const possiblePlugin: PluginModule<AnyNativeEvent> = plugins[i];
    if (possiblePlugin) {
      const extractedEvents = possiblePlugin.extractEvents(
        topLevelType,
        targetInst,
        nativeEvent,
        nativeEventTarget,
      );
      if (extractedEvents) {
        events = accumulateInto(events, extractedEvents);
      }
    }
  }
  return events;
}

/**
 * 批量运行事件。
 * @param events 事件数组或单个事件或null
 * @param simulated 布尔值，模拟器标识
 */
export function runEventsInBatch(
  events: Array<ReactSyntheticEvent> | ReactSyntheticEvent | null,
  simulated: boolean,
) {
  if (events !== null) {
    // 工具方法，将两个数据合并成一个数组。旧数据在前，新数据在后。
    // 其实根据下面代码eventQueue一直为null，所以这里就是直接返回events。
    eventQueue = accumulateInto(eventQueue, events);
  }

  // Set `eventQueue` to null before processing it so that we can tell if more
  // events get enqueued while processing.
  // 翻译：在处理之前将`eventQueue`设置为null，这样我们就可以知道在处理过程中是否有更多事件排队。
  const processingEventQueue = eventQueue;
  eventQueue = null;

  if (!processingEventQueue) {
    // 这是events为null的情况。
    return;
  }

  if (simulated) {
    forEachAccumulated(
      processingEventQueue,
      executeDispatchesAndReleaseSimulated,
    );
  } else {
    // 如果processingEventQueue是数组里的每一项调用executeDispatchesAndReleaseTopLevel。
    // 如果不是，则直接调用executeDispatchesAndReleaseTopLevel。
    forEachAccumulated(
      processingEventQueue,
      executeDispatchesAndReleaseTopLevel,
    );
  }
  invariant(
    !eventQueue,
    'processEventQueue(): Additional events were enqueued while processing ' +
      'an event queue. Support for this has not yet been implemented.',
  );
  // This would be a good time to rethrow if any of the event handlers threw.
  // 翻译：如果有任何事件处理程序抛出，这将是一个重新抛出的好时机。
  rethrowCaughtError();
}

/**
 * 将事件交给plugin处理，产生event数组。
 * @param topLevelType 顶级事件类型
 * @param targetInst ancestors里的Fiber节点（也就是要执行事件处理的节点）
 * @param nativeEvent 触发事件的DOM节点
 * @param nativeEventTarget 触发事件的Fiber节点
 */
export function runExtractedEventsInBatch(
  topLevelType: TopLevelType,
  targetInst: null | Fiber,
  nativeEvent: AnyNativeEvent,
  nativeEventTarget: EventTarget,
) {
  // 经过一系列plugin的处理，得到一个事件数组。
  const events = extractEvents(
    topLevelType,
    targetInst,
    nativeEvent,
    nativeEventTarget,
  );
  runEventsInBatch(events, false);
}
