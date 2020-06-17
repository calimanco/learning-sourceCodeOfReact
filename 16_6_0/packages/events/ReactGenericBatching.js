/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  needsStateRestore,
  restoreStateIfNeeded,
} from './ReactControlledComponent';

// Used as a way to call batchedUpdates when we don't have a reference to
// the renderer. Such as when we're dispatching events or if third party
// libraries need to call batchedUpdates. Eventually, this API will go away when
// everything is batched by default. We'll then have a similar API to opt-out of
// scheduled work and instead do synchronous work.
// 翻译：当我们没有对渲染器的参考时，用作调用batchedUpdates的方式。
//      例如，当我们调度事件或第三方库需要调用batchedUpdates时。
//      最终，当默认情况下所有批次都被批处理时，此API将消失。
//      然后，我们将有一个类似的API来选择退出调度工作，或进行同步工作。

// Defaults
let _batchedUpdatesImpl = function(fn, bookkeeping) {
  return fn(bookkeeping);
};
let _interactiveUpdatesImpl = function(fn, a, b) {
  return fn(a, b);
};
let _flushInteractiveUpdatesImpl = function() {};

let isBatching = false;
export function batchedUpdates(fn, bookkeeping) {
  if (isBatching) {
    // If we are currently inside another batch, we need to wait until it
    // fully completes before restoring state.
    // 翻译：如果我们当前在另一个批次中，则需要等到它完全完成后再恢复状态。
    return fn(bookkeeping);
  }
  isBatching = true;
  try {
    return _batchedUpdatesImpl(fn, bookkeeping);
  } finally {
    // Here we wait until all updates have propagated, which is important
    // when using controlled components within layers:
    // https://github.com/facebook/react/issues/1698
    // Then we restore state of any controlled component.
    // 翻译：在这里，我们等待所有更新均已完成，这对于在层中使用受控组件时非常重要：
    //      https://github.com/facebook/react/issues/1698
    //      然后，我们恢复任何受控组件的状态。
    isBatching = false;
    const controlledComponentsHavePendingUpdates = needsStateRestore();
    if (controlledComponentsHavePendingUpdates) {
      // If a controlled event was fired, we may need to restore the state of
      // the DOM node back to the controlled value. This is necessary when React
      // bails out of the update without touching the DOM.
      // 翻译：如果触发了受控事件，则可能需要将DOM节点的状态恢复回受控值。
      //      当React退出更新而不接触DOM时，这是必需的。
      _flushInteractiveUpdatesImpl();
      restoreStateIfNeeded();
    }
  }
}

export function interactiveUpdates(fn, a, b) {
  return _interactiveUpdatesImpl(fn, a, b);
}

export function flushInteractiveUpdates() {
  return _flushInteractiveUpdatesImpl();
}

export function setBatchingImplementation(
  batchedUpdatesImpl,
  interactiveUpdatesImpl,
  flushInteractiveUpdatesImpl,
) {
  _batchedUpdatesImpl = batchedUpdatesImpl;
  _interactiveUpdatesImpl = interactiveUpdatesImpl;
  _flushInteractiveUpdatesImpl = flushInteractiveUpdatesImpl;
}
