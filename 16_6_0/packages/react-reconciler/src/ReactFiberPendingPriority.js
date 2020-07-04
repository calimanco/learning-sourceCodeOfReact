/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {FiberRoot} from './ReactFiberRoot';
import type {ExpirationTime} from './ReactFiberExpirationTime';

import {NoWork} from './ReactFiberExpirationTime';

// TODO: Offscreen updates should never suspend. However, a promise that
// suspended inside an offscreen subtree should be able to ping at the priority
// of the outer render.

/**
 * 标记待处理优先级。
 * @param root FiberRoot对象
 * @param expirationTime 过期时间
 */
export function markPendingPriorityLevel(
  root: FiberRoot,
  expirationTime: ExpirationTime,
): void {
  // If there's a gap between completing a failed root and retrying it,
  // additional updates may be scheduled. Clear `didError`, in case the update
  // is sufficient to fix the error.
  // 翻译：如果完成失败的根目录与重试根目录之间存在间隔，则可以安排其他更新。
  //      如果更新足以解决错误，请清除`didError`。
  root.didError = false;

  // Update the latest and earliest pending times
  // 翻译：更新最新和最早的待处理时间。
  const earliestPendingTime = root.earliestPendingTime;
  if (earliestPendingTime === NoWork) {
    // No other pending updates.
    // 翻译：没有其他待处理的更新。
    root.earliestPendingTime = root.latestPendingTime = expirationTime;
  } else {
    if (earliestPendingTime > expirationTime) {
      // This is the earliest pending update.
      // 翻译：这是最早的待处理更新。
      root.earliestPendingTime = expirationTime;
    } else {
      const latestPendingTime = root.latestPendingTime;
      if (latestPendingTime < expirationTime) {
        // This is the latest pending update
        // 翻译：这是最新的待处理更新。
        root.latestPendingTime = expirationTime;
      }
    }
  }
  findNextExpirationTimeToWorkOn(expirationTime, root);
}

export function markCommittedPriorityLevels(
  root: FiberRoot,
  earliestRemainingTime: ExpirationTime,
): void {
  root.didError = false;

  if (earliestRemainingTime === NoWork) {
    // Fast path. There's no remaining work. Clear everything.
    root.earliestPendingTime = NoWork;
    root.latestPendingTime = NoWork;
    root.earliestSuspendedTime = NoWork;
    root.latestSuspendedTime = NoWork;
    root.latestPingedTime = NoWork;
    findNextExpirationTimeToWorkOn(NoWork, root);
    return;
  }

  // Let's see if the previous latest known pending level was just flushed.
  const latestPendingTime = root.latestPendingTime;
  if (latestPendingTime !== NoWork) {
    if (latestPendingTime < earliestRemainingTime) {
      // We've flushed all the known pending levels.
      root.earliestPendingTime = root.latestPendingTime = NoWork;
    } else {
      const earliestPendingTime = root.earliestPendingTime;
      if (earliestPendingTime < earliestRemainingTime) {
        // We've flushed the earliest known pending level. Set this to the
        // latest pending time.
        root.earliestPendingTime = root.latestPendingTime;
      }
    }
  }

  // Now let's handle the earliest remaining level in the whole tree. We need to
  // decide whether to treat it as a pending level or as suspended. Check
  // it falls within the range of known suspended levels.

  const earliestSuspendedTime = root.earliestSuspendedTime;
  if (earliestSuspendedTime === NoWork) {
    // There's no suspended work. Treat the earliest remaining level as a
    // pending level.
    markPendingPriorityLevel(root, earliestRemainingTime);
    findNextExpirationTimeToWorkOn(NoWork, root);
    return;
  }

  const latestSuspendedTime = root.latestSuspendedTime;
  if (earliestRemainingTime > latestSuspendedTime) {
    // The earliest remaining level is later than all the suspended work. That
    // means we've flushed all the suspended work.
    root.earliestSuspendedTime = NoWork;
    root.latestSuspendedTime = NoWork;
    root.latestPingedTime = NoWork;

    // There's no suspended work. Treat the earliest remaining level as a
    // pending level.
    markPendingPriorityLevel(root, earliestRemainingTime);
    findNextExpirationTimeToWorkOn(NoWork, root);
    return;
  }

  if (earliestRemainingTime < earliestSuspendedTime) {
    // The earliest remaining time is earlier than all the suspended work.
    // Treat it as a pending update.
    markPendingPriorityLevel(root, earliestRemainingTime);
    findNextExpirationTimeToWorkOn(NoWork, root);
    return;
  }

  // The earliest remaining time falls within the range of known suspended
  // levels. We should treat this as suspended work.
  findNextExpirationTimeToWorkOn(NoWork, root);
}

export function hasLowerPriorityWork(
  root: FiberRoot,
  erroredExpirationTime: ExpirationTime,
): boolean {
  const latestPendingTime = root.latestPendingTime;
  const latestSuspendedTime = root.latestSuspendedTime;
  const latestPingedTime = root.latestPingedTime;
  return (
    (latestPendingTime !== NoWork &&
      latestPendingTime > erroredExpirationTime) ||
    (latestSuspendedTime !== NoWork &&
      latestSuspendedTime > erroredExpirationTime) ||
    (latestPingedTime !== NoWork && latestPingedTime > erroredExpirationTime)
  );
}

export function isPriorityLevelSuspended(
  root: FiberRoot,
  expirationTime: ExpirationTime,
): boolean {
  const earliestSuspendedTime = root.earliestSuspendedTime;
  const latestSuspendedTime = root.latestSuspendedTime;
  return (
    earliestSuspendedTime !== NoWork &&
    expirationTime >= earliestSuspendedTime &&
    expirationTime <= latestSuspendedTime
  );
}

/**
 * 标记挂起优先级。
 * @param root FiberRoot对象
 * @param suspendedTime 挂起的时间
 */
export function markSuspendedPriorityLevel(
  root: FiberRoot,
  suspendedTime: ExpirationTime,
): void {
  root.didError = false;
  clearPing(root, suspendedTime);

  // First, check the known pending levels and update them if needed.
  // 翻译：首先，检查已知的待处理级别并根据需要进行更新。
  const earliestPendingTime = root.earliestPendingTime;
  const latestPendingTime = root.latestPendingTime;
  if (earliestPendingTime === suspendedTime) {
    // 待处理的优先级被挂起就要执行清理。
    if (latestPendingTime === suspendedTime) {
      // Both known pending levels were suspended. Clear them.
      // 翻译：两个已知的待处理优先级都被挂起。清理他们。
      root.earliestPendingTime = root.latestPendingTime = NoWork;
    } else {
      // The earliest pending level was suspended. Clear by setting it to the
      // latest pending level.
      // 翻译：最早的待处理级别已挂起。通过将其设置为latestPendingTime来清除。
      root.earliestPendingTime = latestPendingTime;
    }
  } else if (latestPendingTime === suspendedTime) {
    // The latest pending level was suspended. Clear by setting it to the
    // latest pending level.
    // 翻译：最新的待处理级别已挂起。通过将其设置为earliestPendingTime来清除。
    root.latestPendingTime = earliestPendingTime;
  }

  // Finally, update the known suspended levels.
  // 翻译：最后，更新已知的挂起级别。
  const earliestSuspendedTime = root.earliestSuspendedTime;
  const latestSuspendedTime = root.latestSuspendedTime;
  if (earliestSuspendedTime === NoWork) {
    // No other suspended levels.
    // 翻译：没有其他挂起级别。
    root.earliestSuspendedTime = root.latestSuspendedTime = suspendedTime;
  } else {
    if (earliestSuspendedTime > suspendedTime) {
      // This is the earliest suspended level.
      // 翻译：这是最早的挂起级别。
      root.earliestSuspendedTime = suspendedTime;
    } else if (latestSuspendedTime < suspendedTime) {
      // This is the latest suspended level
      // 翻译：这是最新的挂起级别。
      root.latestSuspendedTime = suspendedTime;
    }
  }

  findNextExpirationTimeToWorkOn(suspendedTime, root);
}

/**
 * 标记重试优先级。
 * @param root FiberRoot对象
 * @param pingedTime 重试的时间
 */
export function markPingedPriorityLevel(
  root: FiberRoot,
  pingedTime: ExpirationTime,
): void {
  root.didError = false;

  // TODO: When we add back resuming, we need to ensure the progressed work
  // is thrown out and not reused during the restarted render. One way to
  // invalidate the progressed work is to restart at expirationTime + 1.
  const latestPingedTime = root.latestPingedTime;
  if (latestPingedTime === NoWork || latestPingedTime < pingedTime) {
    root.latestPingedTime = pingedTime;
  }
  findNextExpirationTimeToWorkOn(pingedTime, root);
}

function clearPing(root, completedTime) {
  // TODO: Track whether the root was pinged during the render phase. If so,
  // we need to make sure we don't lose track of it.
  const latestPingedTime = root.latestPingedTime;
  if (latestPingedTime !== NoWork && latestPingedTime <= completedTime) {
    root.latestPingedTime = NoWork;
  }
}

export function findEarliestOutstandingPriorityLevel(
  root: FiberRoot,
  renderExpirationTime: ExpirationTime,
): ExpirationTime {
  let earliestExpirationTime = renderExpirationTime;

  const earliestPendingTime = root.earliestPendingTime;
  const earliestSuspendedTime = root.earliestSuspendedTime;
  if (
    earliestExpirationTime === NoWork ||
    (earliestPendingTime !== NoWork &&
      earliestPendingTime < earliestExpirationTime)
  ) {
    earliestExpirationTime = earliestPendingTime;
  }
  if (
    earliestExpirationTime === NoWork ||
    (earliestSuspendedTime !== NoWork &&
      earliestSuspendedTime < earliestExpirationTime)
  ) {
    earliestExpirationTime = earliestSuspendedTime;
  }
  return earliestExpirationTime;
}

/**
 * 如果过期，将FiberRoot对象上的nextExpirationTimeToWorkOn设置为当前时间。
 * @param root FiberRoot对象
 * @param currentTime 当前时间
 */
export function didExpireAtExpirationTime(
  root: FiberRoot,
  currentTime: ExpirationTime,
): void {
  const expirationTime = root.expirationTime;
  if (expirationTime !== NoWork && currentTime >= expirationTime) {
    // The root has expired. Flush all work up to the current time.
    // 这个根节点已经过期。执行所有工作到当前时间。
    root.nextExpirationTimeToWorkOn = currentTime;
  }
}

/**
 * 设置树的nextExpirationTimeToWorkOn和expirationTime。
 * @param completedExpirationTime 完成的过期时间，最后改变的时间
 * @param root FiberRoot对象
 */
function findNextExpirationTimeToWorkOn(completedExpirationTime, root) {
  const earliestSuspendedTime = root.earliestSuspendedTime;
  const latestSuspendedTime = root.latestSuspendedTime;
  const earliestPendingTime = root.earliestPendingTime;
  const latestPingedTime = root.latestPingedTime;

  // Work on the earliest pending time. Failing that, work on the latest
  // pinged time.
  // 翻译：在最早的pendingTime上工作。如果失败，请在最新的pingedTime上工作。
  // 一般正常流程是前者，后者是特殊的重试流程。
  let nextExpirationTimeToWorkOn =
    earliestPendingTime !== NoWork ? earliestPendingTime : latestPingedTime;

  // If there is no pending or pinged work, check if there's suspended work
  // that's lower priority than what we just completed.
  // 翻译：如果没有待处理或重试的任务，请检查是否有比我们刚刚完成的任务优先级低的挂起任务。
  if (
    nextExpirationTimeToWorkOn === NoWork &&
    (completedExpirationTime === NoWork ||
      latestSuspendedTime > completedExpirationTime)
  ) {
    // The lowest priority suspended work is the work most likely to be
    // committed next. Let's start rendering it again, so that if it times out,
    // it's ready to commit.
    // 最低优先级的挂起任务是最有可能在接下来提交的。让我们再次开始渲染它，以便如果超时，就可以提交了。
    nextExpirationTimeToWorkOn = latestSuspendedTime;
  }

  let expirationTime = nextExpirationTimeToWorkOn;
  if (
    expirationTime !== NoWork &&
    earliestSuspendedTime !== NoWork &&
    earliestSuspendedTime < expirationTime
  ) {
    // 挂起任务比当前将要执行的任务优先级更高，则先执行挂起的任务。
    // Expire using the earliest known expiration time.
    // 翻译：使用已知的最早到期时间来到期。
    expirationTime = earliestSuspendedTime;
  }

  root.nextExpirationTimeToWorkOn = nextExpirationTimeToWorkOn;
  root.expirationTime = expirationTime;
}
