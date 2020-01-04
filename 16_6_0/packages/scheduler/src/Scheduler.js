/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/* eslint-disable no-var */

// TODO: Use symbols?
var ImmediatePriority = 1;
var UserBlockingPriority = 2;
var NormalPriority = 3;
var IdlePriority = 4;

// Max 31 bit integer. The max integer size in V8 for 32-bit systems.
// 翻译：最多31位整数。对于32位系统，V8中的最大整数大小。
// Math.pow(2, 30) - 1
// 0b111111111111111111111111111111
var maxSigned31BitInt = 1073741823;

// Times out immediately
// 翻译：立即超时。
var IMMEDIATE_PRIORITY_TIMEOUT = -1;
// Eventually times out
// 最终：最终超时。
var USER_BLOCKING_PRIORITY = 250;
var NORMAL_PRIORITY_TIMEOUT = 5000;
// Never times out
// 翻译：永不超时。
var IDLE_PRIORITY = maxSigned31BitInt;

// Callbacks are stored as a circular, doubly linked list.
// 翻译：回调存储为循环的双向链接列表。
var firstCallbackNode = null;

var currentPriorityLevel = NormalPriority;
var currentEventStartTime = -1;
var currentExpirationTime = -1;

// This is set when a callback is being executed, to prevent re-entrancy.
// 翻译：在执行回调时设置此值，以防止重新进入。
var isExecutingCallback = false;

var isHostCallbackScheduled = false;

var hasNativePerformanceNow =
  typeof performance === 'object' && typeof performance.now === 'function';

var timeRemaining;
// 环境不同，timeRemaining的函数就不同。
if (hasNativePerformanceNow) {
  timeRemaining = function() {
    // 下面的判断由于currentExpirationTime写死是-1，所以不可能为true。
    if (
      firstCallbackNode !== null &&
      firstCallbackNode.expirationTime < currentExpirationTime
    ) {
      // A higher priority callback was scheduled. Yield so we can switch to
      // working on that.
      // 翻译：安排了较高优先级的回调。收益，因此我们可以切换到该目标。
      return 0;
    }
    // We assume that if we have a performance timer that the rAF callback
    // gets a performance timer value. Not sure if this is always true.
    // 翻译：我们假设如果有一个性能计时器，则rAF回调将获得一个性能计时器值。不知道这是否总是正确的。
    // getFrameDeadline是获取理论的帧截止时间。
    var remaining = getFrameDeadline() - performance.now();
    // 这一帧渲染时间还剩下多少，零就是没有。
    return remaining > 0 ? remaining : 0;
  };
} else {
  timeRemaining = function() {
    // Fallback to Date.now()
    // 翻译：降级使用Date.now()。
    if (
      firstCallbackNode !== null &&
      firstCallbackNode.expirationTime < currentExpirationTime
    ) {
      return 0;
    }
    var remaining = getFrameDeadline() - Date.now();
    return remaining > 0 ? remaining : 0;
  };
}

var deadlineObject = {
  // 0则过期，大于零就是剩余的毫秒数。
  timeRemaining,
  didTimeout: false,
};

/**
 * 启动循环前的预处理。
 */
function ensureHostCallbackIsScheduled() {
  if (isExecutingCallback) {
    // Don't schedule work yet; wait until the next time we yield.
    // 翻译：不要安排工作；等到下一次我们调用。
    // 有正在执行回调，调度是循环的，不需要再起启动。
    return;
  }
  // Schedule the host callback using the earliest expiration in the list.
  // 翻译：使用列表中的最早到期时间安排主回调。
  var expirationTime = firstCallbackNode.expirationTime;
  // 判断有没有正在进行的循环，如果有就先取消掉。
  if (!isHostCallbackScheduled) {
    isHostCallbackScheduled = true;
  } else {
    // Cancel the existing host callback.
    // 翻译：取消现有的循环。
    cancelHostCallback();
  }
  // 启动循环。
  requestHostCallback(flushWork, expirationTime);
}

/**
 * 将firstCallbackNode从队列里移除，并执行上面的回调。
 */
function flushFirstCallback() {
  var flushedNode = firstCallbackNode;

  // Remove the node from the list before calling the callback. That way the
  // list is in a consistent state even if the callback throws.
  // 翻译：在调用回调之前，从队列中删除该节点。这样使得即使回调函数被再次调用，队列也处于一致状态。
  // 这里的回调应该指的是循环要处理的hostCallback，也就是flushWork。
  var next = firstCallbackNode.next;
  if (firstCallbackNode === next) {
    // This is the last callback in the list.
    // 翻译：这是队列里最后一个回调函数。
    firstCallbackNode = null;
    next = null;
  } else {
    var lastCallbackNode = firstCallbackNode.previous;
    firstCallbackNode = lastCallbackNode.next = next;
    next.previous = lastCallbackNode;
  }

  // 清理之前的引用，避免内存溢出。
  flushedNode.next = flushedNode.previous = null;

  // Now it's safe to call the callback.
  // 翻译：现在可以安全的调用回调函数了。
  var callback = flushedNode.callback;
  var expirationTime = flushedNode.expirationTime;
  var priorityLevel = flushedNode.priorityLevel;
  var previousPriorityLevel = currentPriorityLevel;
  var previousExpirationTime = currentExpirationTime;
  currentPriorityLevel = priorityLevel;
  currentExpirationTime = expirationTime;
  var continuationCallback;
  try {
    // 这里的callback就是FiberScheduler那边传过来的回调(performAsyncWork)，
    // 会接受一个参数包含本次渲染的信息。
    continuationCallback = callback(deadlineObject);
  } finally {
    currentPriorityLevel = previousPriorityLevel;
    currentExpirationTime = previousExpirationTime;
  }

  // 由于performAsyncWork并没有返回指，所以现阶段下面的代码是无效的。
  // A callback may return a continuation. The continuation should be scheduled
  // with the same priority and expiration as the just-finished callback.
  // 翻译：回调可能会返回后续请求。应当以与刚刚完成的回调相同的优先级和到期时间来安排后续请求。
  if (typeof continuationCallback === 'function') {
    var continuationNode: CallbackNode = {
      callback: continuationCallback,
      priorityLevel,
      expirationTime,
      next: null,
      previous: null,
    };

    // Insert the new callback into the list, sorted by its expiration. This is
    // almost the same as the code in `scheduleCallback`, except the callback
    // is inserted into the list *before* callbacks of equal expiration instead
    // of after.
    if (firstCallbackNode === null) {
      // This is the first callback in the list.
      firstCallbackNode = continuationNode.next = continuationNode.previous = continuationNode;
    } else {
      var nextAfterContinuation = null;
      var node = firstCallbackNode;
      do {
        if (node.expirationTime >= expirationTime) {
          // This callback expires at or after the continuation. We will insert
          // the continuation *before* this callback.
          nextAfterContinuation = node;
          break;
        }
        node = node.next;
      } while (node !== firstCallbackNode);

      if (nextAfterContinuation === null) {
        // No equal or lower priority callback was found, which means the new
        // callback is the lowest priority callback in the list.
        nextAfterContinuation = firstCallbackNode;
      } else if (nextAfterContinuation === firstCallbackNode) {
        // The new callback is the highest priority callback in the list.
        firstCallbackNode = continuationNode;
        ensureHostCallbackIsScheduled();
      }

      var previous = nextAfterContinuation.previous;
      previous.next = nextAfterContinuation.previous = continuationNode;
      continuationNode.next = nextAfterContinuation;
      continuationNode.previous = previous;
    }
  }
}

/**
 * 这个函数现版本没有任何运行效果。
 */
function flushImmediateWork() {
  if (
    // Confirm we've exited the outer most event handler
    // 翻译：确认我们已经退出了最外面的事件处理程序
    currentEventStartTime === -1 &&
    firstCallbackNode !== null &&
    firstCallbackNode.priorityLevel === ImmediatePriority
  ) {
    isExecutingCallback = true;
    deadlineObject.didTimeout = true;
    try {
      do {
        flushFirstCallback();
      } while (
        // Keep flushing until there are no more immediate callbacks
        firstCallbackNode !== null &&
        firstCallbackNode.priorityLevel === ImmediatePriority
      );
    } finally {
      isExecutingCallback = false;
      if (firstCallbackNode !== null) {
        // There's still work remaining. Request another callback.
        ensureHostCallbackIsScheduled();
      } else {
        isHostCallbackScheduled = false;
      }
    }
  }
}

/**
 * "刷出"任务,一个按顺序循环取出队列内函数并运行的过程。
 * @param didTimeout 是否已经超时
 */
function flushWork(didTimeout) {
  isExecutingCallback = true;
  deadlineObject.didTimeout = didTimeout;
  try {
    if (didTimeout) {
      // 需要强制更新的情况。
      // Flush all the expired callbacks without yielding.
      // 翻译：执行所有过期的回调而不需要延迟。
      while (firstCallbackNode !== null) {
        // Read the current time. Flush all the callbacks that expire at or
        // earlier than that time. Then read the current time again and repeat.
        // This optimizes for as few performance.now calls as possible.
        // 翻译：读取当前时间。执行所有在该时间或更早之前到期的回调。然后再次读取当前时间并重复。
        //      为了优化性能，应尽可能少地调用performance.now。
        var currentTime = getCurrentTime();
        if (firstCallbackNode.expirationTime <= currentTime) {
          do {
            // 每一次调用flushFirstCallback都会把firstCallbackNode指向下一个。
            flushFirstCallback();
          } while (
            // 循环直到队列为空，或遇到还没有过期的任务。
            firstCallbackNode !== null &&
            firstCallbackNode.expirationTime <= currentTime
          );
          continue;
        }
        break;
      }
    } else {
      // Keep flushing callbacks until we run out of time in the frame.
      // 翻译：保持执行回调，直到帧中的时间用完为止。
      if (firstCallbackNode !== null) {
        do {
          flushFirstCallback();
        } while (
          // 循环直到队列为空，或帧时间用完。
          firstCallbackNode !== null &&
          getFrameDeadline() - getCurrentTime() > 0
        );
      }
    }
  } finally {
    // 标记正在运行状态为false。
    isExecutingCallback = false;
    if (firstCallbackNode !== null) {
      // There's still work remaining. Request another callback.
      // 翻译：仍有工作要做。请求另一个回调。
      ensureHostCallbackIsScheduled();
    } else {
      isHostCallbackScheduled = false;
    }
    // Before exiting, flush all the immediate work that was scheduled.
    // 翻译：退出之前，执行所有计划的立即工作。
    // 现阶段下面的函数无效。
    flushImmediateWork();
  }
}

function unstable_runWithPriority(priorityLevel, eventHandler) {
  switch (priorityLevel) {
    case ImmediatePriority:
    case UserBlockingPriority:
    case NormalPriority:
    case IdlePriority:
      break;
    default:
      priorityLevel = NormalPriority;
  }

  var previousPriorityLevel = currentPriorityLevel;
  var previousEventStartTime = currentEventStartTime;
  currentPriorityLevel = priorityLevel;
  currentEventStartTime = getCurrentTime();

  try {
    return eventHandler();
  } finally {
    currentPriorityLevel = previousPriorityLevel;
    currentEventStartTime = previousEventStartTime;

    // Before exiting, flush all the immediate work that was scheduled.
    flushImmediateWork();
  }
}

function unstable_wrapCallback(callback) {
  var parentPriorityLevel = currentPriorityLevel;
  return function() {
    // This is a fork of runWithPriority, inlined for performance.
    var previousPriorityLevel = currentPriorityLevel;
    var previousEventStartTime = currentEventStartTime;
    currentPriorityLevel = parentPriorityLevel;
    currentEventStartTime = getCurrentTime();

    try {
      return callback.apply(this, arguments);
    } finally {
      currentPriorityLevel = previousPriorityLevel;
      currentEventStartTime = previousEventStartTime;
      flushImmediateWork();
    }
  };
}

/**
 * 新建callbackNode节点插入队列，并返回节点对象。
 * @param callback 在ReactFiberScheduler里传performAsyncWork
 * @param deprecated_options 在ReactFiberScheduler里传过来的是回调过期时间与当前时间的差值
 *        结构为{timeout}（会废弃）
 * @return {{next: null, priorityLevel: number, previous: null, expirationTime: *, callback: *}}
 */
function unstable_scheduleCallback(callback, deprecated_options) {
  // getCurrentTime其实就是获取当前时间，不同平台会不一样，浏览器就是Date.now。
  // 暂无currentEventStartTime非-1的情况，所以这里getCurrentTime一定会被调用。
  var startTime =
    currentEventStartTime !== -1 ? currentEventStartTime : getCurrentTime();

  var expirationTime;
  // 当前版本由于不稳定，这个分支条件是一定成立的。
  if (
    typeof deprecated_options === 'object' &&
    deprecated_options !== null &&
    typeof deprecated_options.timeout === 'number'
  ) {
    // FIXME: Remove this branch once we lift expiration times out of React.
    // 翻译：一旦我们将到期时间从React中移除，请删除此分支。
    expirationTime = startTime + deprecated_options.timeout;
  } else {
    //  当前版本下面的代码无效。
    switch (currentPriorityLevel) {
      case ImmediatePriority:
        expirationTime = startTime + IMMEDIATE_PRIORITY_TIMEOUT;
        break;
      case UserBlockingPriority:
        expirationTime = startTime + USER_BLOCKING_PRIORITY;
        break;
      case IdlePriority:
        expirationTime = startTime + IDLE_PRIORITY;
        break;
      case NormalPriority:
      default:
        expirationTime = startTime + NORMAL_PRIORITY_TIMEOUT;
    }
  }

  // 下面的代码实际上是生成一个新节点，并插入链表适当位置的过程。
  var newNode = {
    callback,
    // 当前版本这个字段无效。
    priorityLevel: currentPriorityLevel,
    expirationTime,
    next: null,
    previous: null,
  };

  // Insert the new callback into the list, ordered first by expiration, then
  // by insertion. So the new callback is inserted any other callback with
  // equal expiration.
  // 翻译：将新的回调插入列表，首先按到期时间排序，然后按插入顺序排序。
  //      因此，新的回调将插入具有相等到期时间的其他回调之后。
  // firstCallbackNode是在当前文件里维护的链表头部。
  if (firstCallbackNode === null) {
    // This is the first callback in the list.
    // 翻译：这是列表中的第一个回调。
    firstCallbackNode = newNode.next = newNode.previous = newNode;
    ensureHostCallbackIsScheduled();
  } else {
    // 当前回调非第一个的情况，就要先遍历找到优先级比当前优先级低（expirationTime大）的节点。
    var next = null;
    var node = firstCallbackNode;
    // 由于链表是循环的，最后的一个next会指向firstCallbackNode，所以找不到的话node最终指向第一个并退出循环。
    do {
      if (node.expirationTime > expirationTime) {
        // The new callback expires before this one.
        // 翻译：新的回调在此之前到期。
        next = node;
        break;
      }
      // 如果不满足上面的条件就下一个。
      node = node.next;
    } while (node !== firstCallbackNode);

    if (next === null) {
      // No callback with a later expiration was found, which means the new
      // callback has the latest expiration in the list.
      // 翻译：未找到具有更高到期时间的回调，这意味着新的回调是列表里优先级最低的。
      // 判断优先级最低（到期时间大）。
      next = firstCallbackNode;
    } else if (next === firstCallbackNode) {
      // The new callback has the earliest expiration in the entire list.
      // 翻译：新的回调在整个列表中最早过期。
      // 判断优先级最高。
      firstCallbackNode = newNode;
      ensureHostCallbackIsScheduled();
    }

    // 下面就是插入的过程，next之前，previous之后的中间位置。
    var previous = next.previous;
    previous.next = next.previous = newNode;
    newNode.next = next;
    newNode.previous = previous;
  }

  return newNode;
}

function unstable_cancelCallback(callbackNode) {
  var next = callbackNode.next;
  if (next === null) {
    // Already cancelled.
    return;
  }

  if (next === callbackNode) {
    // This is the only scheduled callback. Clear the list.
    firstCallbackNode = null;
  } else {
    // Remove the callback from its position in the list.
    if (callbackNode === firstCallbackNode) {
      firstCallbackNode = next;
    }
    var previous = callbackNode.previous;
    previous.next = next;
    next.previous = previous;
  }

  callbackNode.next = callbackNode.previous = null;
}

function unstable_getCurrentPriorityLevel() {
  return currentPriorityLevel;
}

// The remaining code is essentially a polyfill for requestIdleCallback. It
// works by scheduling a requestAnimationFrame, storing the time for the start
// of the frame, then scheduling a postMessage which gets scheduled after paint.
// Within the postMessage handler do as much work as possible until time + frame
// rate. By separating the idle call into a separate event tick we ensure that
// layout, paint and other browser work is counted against the available time.
// The frame rate is dynamically adjusted.
// 翻译：其余代码本质上是requestIdleCallback的polyfill。
//      它的工作方式是安排一个requestAnimationFrame回调，存储帧开始的时间，
//      然后安排一个postMessage事件处理器，该消息在绘制后运行。
//      在postMessage处理程序中，直到当前帧结束为止，要尽可能多地工作。
//      通过将空闲回调函数分为一个单独的事件刻度，我们确保将布局，绘画和其他浏览器工作计入可用时间。
//      帧速率是动态调整的。

// We capture a local reference to any global, in case it gets polyfilled after
// this module is initially evaluated. We want to be using a
// consistent implementation.
// 翻译：我们会捕获对任何全局变量的本地引用，以防在最初评估此模块后将其填充。我们希望使用一致的实现。
var localDate = Date;

// This initialization code may run even on server environments if a component
// just imports ReactDOM (e.g. for findDOMNode). Some environments might not
// have setTimeout or clearTimeout. However, we always expect them to be defined
// on the client. https://github.com/facebook/react/pull/13088
// 翻译：如果组件仅导入ReactDOM（例如，对于findDOMNode），则此初始化代码甚至可以在服务器环境上运行。
//      某些环境可能没有setTimeout或clearTimeout。但是，我们始终希望在客户端上定义它们。
var localSetTimeout = typeof setTimeout === 'function' ? setTimeout : undefined;
var localClearTimeout =
  typeof clearTimeout === 'function' ? clearTimeout : undefined;

// We don't expect either of these to necessarily be defined, but we will error
// later if they are missing on the client.
// 翻译：我们不希望必须定义其中的任何一个，但是如果客户端上缺少它们，我们稍后将出错。
var localRequestAnimationFrame =
  typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame
    : undefined;
var localCancelAnimationFrame =
  typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : undefined;

var getCurrentTime;

// requestAnimationFrame does not run when the tab is in the background. If
// we're backgrounded we prefer for that work to happen so that the page
// continues to load in the background. So we also schedule a 'setTimeout' as
// a fallback.
// 翻译：当浏览器tab切换到后台时requestAnimationFrame不会运行。如果我们正在后台，
//      我们希望这项工作能够进行，以便页面继续在后台加载。因此我们也安排'setTimeout'作为后备方法。
// TODO: Need a better heuristic for backgrounded work.
var ANIMATION_FRAME_TIMEOUT = 100;
var rAFID;
var rAFTimeoutID;

/**
 * 带有超时处理的requestAnimationFrame封装。
 * @param callback 就是animationTick函数
 */
var requestAnimationFrameWithTimeout = function(callback) {
  // 下面两个函数是竞争关系，一个调用了requestAnimationFrame另一个调用setTimeout，
  // 当requestAnimationFrame在100毫秒内没有调用回调，就会取消，反之取消setTimeout。
  // schedule rAF and also a setTimeout
  // 翻译：安排rAF(时间片)和setTimeout。
  rAFID = localRequestAnimationFrame(function(timestamp) {
    // cancel the setTimeout
    // 翻译：取消setTimeout。
    localClearTimeout(rAFTimeoutID);
    callback(timestamp);
  });
  rAFTimeoutID = localSetTimeout(function() {
    // cancel the requestAnimationFrame
    // 取消rAF。
    localCancelAnimationFrame(rAFID);
    // requestAnimationFrame有返回当前时间戳，setTimeout没有，这里为了一致模拟了一个。
    callback(getCurrentTime());
  }, ANIMATION_FRAME_TIMEOUT);
};

if (hasNativePerformanceNow) {
  var Performance = performance;
  getCurrentTime = function() {
    return Performance.now();
  };
} else {
  getCurrentTime = function() {
    return localDate.now();
  };
}

var requestHostCallback;
var cancelHostCallback;
var getFrameDeadline;

if (typeof window !== 'undefined' && window._schedMock) {
  // Dynamic injection, only for testing purposes.
  // 翻译：动态注入，仅用于测试目的。
  var impl = window._schedMock;
  requestHostCallback = impl[0];
  cancelHostCallback = impl[1];
  getFrameDeadline = impl[2];
} else if (
  // If Scheduler runs in a non-DOM environment, it falls back to a naive
  // implementation using setTimeout.
  // 翻译：如果Scheduler在非DOM环境中运行，它将使用setTimeout退回到简单的实现。
  typeof window === 'undefined' ||
  // "addEventListener" might not be available on the window object
  // if this is a mocked "window" object. So we need to validate that too.
  // 翻译：如果这是一个模拟的“ window”对象，则在窗口对象上可能无法使用“ addEventListener”。
  //      因此，我们也需要对此进行验证。
  typeof window.addEventListener !== 'function'
) {
  // 下面是用setTimeout实现的Scheduler。
  var _callback = null;
  var _currentTime = -1;
  var _flushCallback = function(didTimeout, ms) {
    if (_callback !== null) {
      var cb = _callback;
      _callback = null;
      try {
        _currentTime = ms;
        cb(didTimeout);
      } finally {
        _currentTime = -1;
      }
    }
  };
  requestHostCallback = function(cb, ms) {
    if (_currentTime !== -1) {
      // Protect against re-entrancy.
      setTimeout(requestHostCallback, 0, cb, ms);
    } else {
      _callback = cb;
      setTimeout(_flushCallback, ms, true, ms);
      setTimeout(_flushCallback, maxSigned31BitInt, false, maxSigned31BitInt);
    }
  };
  cancelHostCallback = function() {
    _callback = null;
  };
  getFrameDeadline = function() {
    return Infinity;
  };
  getCurrentTime = function() {
    return _currentTime === -1 ? 0 : _currentTime;
  };
} else {
  // 这是浏览器环境下的Scheduler实现。
  if (typeof console !== 'undefined') {
    // 这里是如果缺少某些全局变量的警告。
    // TODO: Remove fb.me link
    if (typeof localRequestAnimationFrame !== 'function') {
      console.error(
        "This browser doesn't support requestAnimationFrame. " +
          'Make sure that you load a ' +
          'polyfill in older browsers. https://fb.me/react-polyfills',
      );
    }
    if (typeof localCancelAnimationFrame !== 'function') {
      console.error(
        "This browser doesn't support cancelAnimationFrame. " +
          'Make sure that you load a ' +
          'polyfill in older browsers. https://fb.me/react-polyfills',
      );
    }
  }

  var scheduledHostCallback = null;
  var isMessageEventScheduled = false;
  var timeoutTime = -1;

  var isAnimationFrameScheduled = false;

  var isFlushingHostCallback = false;

  var frameDeadline = 0;
  // We start out assuming that we run at 30fps but then the heuristic tracking
  // will adjust this value to a faster fps if we get more frequent animation
  // frames.
  // 翻译：我们开始假设我们以30fps运行，但是如果我们获得更频繁的动画帧，
  //      则启发式跟踪会将这个值调整为更快的fps。
  var previousFrameTime = 33;
  var activeFrameTime = 33;

  /**
   * 获取理论帧截至时间。
   * @return {number}
   */
  getFrameDeadline = function() {
    return frameDeadline;
  };

  // We use the postMessage trick to defer idle work until after the repaint.
  // 翻译：我们使用postMessage技巧将空闲工作推迟到重新绘制之后。
  // 随机一个key用来标识。
  var messageKey =
    '__reactIdleCallback$' +
    Math.random()
      .toString(36)
      .slice(2);
  /**
   * 浏览器渲染完，空闲时执行的函数。
   * 选择flushWork的工作模式。
   * @param event
   */
  var idleTick = function(event) {
    if (event.source !== window || event.data !== messageKey) {
      return;
    }

    isMessageEventScheduled = false;

    // 备份并重置这两个公共变量。
    var prevScheduledCallback = scheduledHostCallback;
    var prevTimeoutTime = timeoutTime;
    scheduledHostCallback = null;
    timeoutTime = -1;

    var currentTime = getCurrentTime();

    var didTimeout = false;
    if (frameDeadline - currentTime <= 0) {
      // There's no time left in this idle period. Check if the callback has
      // a timeout and whether it's been exceeded.
      // 翻译：在这个空闲时间没有剩余时间了。检查回调是否有超时时间以及是否超过超时时间。
      // 帧过期不代表任务也过期，所以还要分为任务过期和未过期两种处理。
      if (prevTimeoutTime !== -1 && prevTimeoutTime <= currentTime) {
        // Exceeded the timeout. Invoke the callback even though there's no
        // time left.
        // 翻译：任务超过超时时间。即使没有时间，也要调用回调。
        didTimeout = true;
      } else {
        // No timeout.
        // 翻译：没有超时。
        if (!isAnimationFrameScheduled) {
          // 不知这个判断有用的场景，设置下一个rAF回调已经在animationTick做过了。
          // Schedule another animation callback so we retry later.
          // 翻译：安排另一个动画回调，以便我们稍后重试。
          isAnimationFrameScheduled = true;
          requestAnimationFrameWithTimeout(animationTick);
        }
        // Exit without invoking the callback.
        // 翻译：退出而不调用回调。
        scheduledHostCallback = prevScheduledCallback;
        timeoutTime = prevTimeoutTime;
        return;
      }
    }

    // 判断有没有要执行的任务。
    if (prevScheduledCallback !== null) {
      isFlushingHostCallback = true;
      try {
        // didTimeout判断是否强制。
        prevScheduledCallback(didTimeout);
      } finally {
        // 执行完成。
        isFlushingHostCallback = false;
      }
    }
  };
  // Assumes that we have addEventListener in this environment. Might need
  // something better for old IE.
  // 翻译：假设在此环境中有addEventListener。对于旧的IE可能需要更好的东西。
  window.addEventListener('message', idleTick, false);

  /**
   * 提供给rAF的回调函数，运行完浏览器就进入渲染阶段。
   * 1. 准备下一个rAF（如果需要）;
   * 2. 启发式修正frameDeadline（理论截至时间）；
   * 3. 发起事件（window.postMessage），等待浏览器渲染完后空闲状态执行react操作。
   * @param rafTime 时间戳
   */
  var animationTick = function(rafTime) {
    // 这个参数在requestHostCallback里被设置，就是flushWork。
    if (scheduledHostCallback !== null) {
      // Eagerly schedule the next animation callback at the beginning of the
      // frame. If the scheduler queue is not empty at the end of the frame, it
      // will continue flushing inside that callback. If the queue *is* empty,
      // then it will exit immediately. Posting the callback at the start of the
      // frame ensures it's fired within the earliest possible frame. If we
      // waited until the end of the frame to post the callback, we risk the
      // browser skipping a frame and not firing the callback until the frame
      // after that.
      // 翻译：尽早将下一个动画回调安排在帧的开头。如果调度程序队列在帧末尾不为空，它将继续在该回调内flushing。
      //      如果队列是空的，则它将立即退出。在帧的开头发布回调，以确保在最早的帧内触发该回调。
      //      如果我们等到帧结束后才安排回调，就会冒着浏览器跳过一个帧并且直到之后的那一帧才触发回调的风险。
      // 在帧开头就把下一帧的回调设置好，这样是才不会跳过时间。
      requestAnimationFrameWithTimeout(animationTick);
    } else {
      // No pending work. Exit.
      // 翻译：没有待处理的工作。退出。
      isAnimationFrameScheduled = false;
      return;
    }

    // rafTime是当前时间戳；frameDeadline初始为0；
    // activeFrameTime初始为33（1秒刷新30次，一次就是1000/30=33.333）；
    // 当前时间减去理论的上一帧截至时间，得到的时间差就是理论和实际的误差，这样下一帧可能长也可能短些。
    var nextFrameTime = rafTime - frameDeadline + activeFrameTime;
    // 第一次运行这下面的判断不会是true的，只有第二次判断frameDeadline有值的时候。
    if (
      nextFrameTime < activeFrameTime &&
      previousFrameTime < activeFrameTime
    ) {
      // 这里需要启发式程序，如果两次计算的帧时间都小于预设的33毫秒，那将自动降低帧时间。
      if (nextFrameTime < 8) {
        // Defensive coding. We don't support higher frame rates than 120hz.
        // If the calculated frame time gets lower than 8, it is probably a bug.
        // 翻译：防御性编码。我们不支持高于120hz的帧频。如果计算的帧时间小于8，则可能是错误。
        // 也就是支持最低的帧时间为8毫秒，1秒刷新120次，一次就是1000/120=8.333。
        nextFrameTime = 8;
      }
      // If one frame goes long, then the next one can be short to catch up.
      // If two frames are short in a row, then that's an indication that we
      // actually have a higher frame rate than what we're currently optimizing.
      // We adjust our heuristic dynamically accordingly. For example, if we're
      // running on 120hz display or 90hz VR display.
      // Take the max of the two in case one of them was an anomaly due to
      // missed frame deadlines.
      // 翻译：如果一帧变长，那么下一帧可能会变短以赶上。如果连续两帧短于预期，
      //      则表明我们实际上具有比当前正在优化的帧速率更高的帧速率。
      //      我们会相应地动态调整启发式方法。例如，如果我们在120hz显示器或90hz VR显示器上运行。
      //      以两者中的最大值为例，以防其中一个由于错过了帧截止日期而出错。
      activeFrameTime =
        nextFrameTime < previousFrameTime ? previousFrameTime : nextFrameTime;
    } else {
      previousFrameTime = nextFrameTime;
    }
    // 计算出理论的帧截止时间。
    frameDeadline = rafTime + activeFrameTime;
    if (!isMessageEventScheduled) {
      // 当前没有安排任务才设置，这一帧渲染完之后的任务。
      isMessageEventScheduled = true;
      // 将任务延迟到浏览器渲染完成后执行，其实就是idleTick函数。
      window.postMessage(messageKey, '*');
    }
  };

  /**
   * 启动循环。（web平台）
   * @param callback 这个就是flushWork
   * @param absoluteTimeout firstCallbackNode的expirationTime
   */
  requestHostCallback = function(callback, absoluteTimeout) {
    scheduledHostCallback = callback;
    timeoutTime = absoluteTimeout;
    if (isFlushingHostCallback || absoluteTimeout < 0) {
      // Don't wait for the next frame. Continue working ASAP, in a new event.
      // 翻译：不要等待下一帧。在新事件中，请尽快继续工作。
      window.postMessage(messageKey, '*');
    } else if (!isAnimationFrameScheduled) {
      // If rAF didn't already schedule one, we need to schedule a frame.
      // 翻译：如果rAF尚未安排一个，我们需要安排一帧。
      // TODO: If this rAF doesn't materialize because the browser throttles, we
      // might want to still have setTimeout trigger rIC as a backup to ensure
      // that we keep performing work.
      isAnimationFrameScheduled = true;
      // 这里使用requestAnimationFrame这个API完成时间切片。
      requestAnimationFrameWithTimeout(animationTick);
    }
  };

  cancelHostCallback = function() {
    scheduledHostCallback = null;
    isMessageEventScheduled = false;
    timeoutTime = -1;
  };
}

export {
  ImmediatePriority as unstable_ImmediatePriority,
  UserBlockingPriority as unstable_UserBlockingPriority,
  NormalPriority as unstable_NormalPriority,
  IdlePriority as unstable_IdlePriority,
  unstable_runWithPriority,
  unstable_scheduleCallback,
  unstable_cancelCallback,
  unstable_wrapCallback,
  unstable_getCurrentPriorityLevel,
  getCurrentTime as unstable_now,
};
