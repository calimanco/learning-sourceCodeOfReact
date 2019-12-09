/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import MAX_SIGNED_31_BIT_INT from './maxSigned31BitInt';

export type ExpirationTime = number;

export const NoWork = 0;
export const Sync = 1;
export const Never = MAX_SIGNED_31_BIT_INT;

const UNIT_SIZE = 10;
const MAGIC_NUMBER_OFFSET = 2;

// 1 unit of expiration time represents 10ms.
// 翻译：1单位的到期时间代表10毫秒。
/**
 * 将毫秒转换成"过期时间"（一种特殊定义的时间，非标准毫秒）。
 * @param ms 毫秒
 * @return {number}
 */
export function msToExpirationTime(ms: number): ExpirationTime {
  // Always add an offset so that we don't clash with the magic number for NoWork.
  // 翻译：始终添加偏移量，以免与NoWork的魔幻数字发生冲突。
  // 求有效时间，取整，加偏移量。
  return ((ms / UNIT_SIZE) | 0) + MAGIC_NUMBER_OFFSET;
}

export function expirationTimeToMs(expirationTime: ExpirationTime): number {
  return (expirationTime - MAGIC_NUMBER_OFFSET) * UNIT_SIZE;
}

/**
 * 将数字转为以精度值为倍数的值。
 * 比如：num为9，precision为3，输出为12，输入num为10和11，结果也不变。
 * @param num 输入值
 * @param precision 精度
 * @return {number}
 */
function ceiling(num: number, precision: number): number {
  return (((num / precision) | 0) + 1) * precision;
}

/**
 * 将"过期时间"按照转换成对应优先级的精度的倍数。
 * 就是把一段时间内的时间强制统一，以减少渲染频率。
 * @param currentTime 当前的到期时间
 * @param expirationInMs 权限对应基础过期时间
 * @param bucketSizeMs 多长时间内归为一段，精度
 * @return {number}
 */
function computeExpirationBucket(
  currentTime,
  expirationInMs,
  bucketSizeMs,
): ExpirationTime {
  return (
    MAGIC_NUMBER_OFFSET +
    ceiling(
      // 这里减去偏移量才是真正的currentTime，毫秒的时间要转换成"过期时间"才能参与计算。
      // 权限高加的就少，最终结果就小；权限低加的就多，最终结果就大。
      currentTime - MAGIC_NUMBER_OFFSET + expirationInMs / UNIT_SIZE,
      bucketSizeMs / UNIT_SIZE,
    )
  );
}

// 低权限常量。
export const LOW_PRIORITY_EXPIRATION = 5000;
export const LOW_PRIORITY_BATCH_SIZE = 250;

/**
 * 将"过期时间"按照转换成"异步更新"级别的精度的倍数（低权限）。
 * @param currentTime 需要转换的当前的"过期时间"
 * @return {ExpirationTime}
 */
export function computeAsyncExpiration(
  currentTime: ExpirationTime,
): ExpirationTime {
  return computeExpirationBucket(
    currentTime,
    LOW_PRIORITY_EXPIRATION,
    LOW_PRIORITY_BATCH_SIZE,
  );
}

// We intentionally set a higher expiration time for interactive updates in
// dev than in production.
// 翻译：我们故意为dev中的"交互更新"设置了比生产环境更长的到期时间。
//
// If the main thread is being blocked so long that you hit the expiration,
// it's a problem that could be solved with better scheduling.
// 翻译：如果主线程被阻塞的时间太长，以至于您遇到过期，则可以通过更好的调度来解决此问题。
//
// People will be more likely to notice this and fix it with the long
// expiration time in development.
// 翻译：人们将更有可能注意到这一点，并在开发中使用较长的到期时间来解决它。
//
// In production we opt for better UX at the risk of masking scheduling
// problems, by expiring fast.
// 翻译：在生产中，我们选择了更好的用户体验，因为它会很快过期，因此会掩盖调度问题。
// 这里在开发模式故意延长了过期时间，是用来放大调度过程中调度的不合理，便于优化。
// 高权限常量。
export const HIGH_PRIORITY_EXPIRATION = __DEV__ ? 500 : 150;
export const HIGH_PRIORITY_BATCH_SIZE = 100;

/**
 * 将"过期时间"按照转换成"交互更新"级别的精度的倍数（高权限）。
 * @param currentTime 需要转换的当前的"过期时间"
 * @return {ExpirationTime}
 */
export function computeInteractiveExpiration(currentTime: ExpirationTime) {
  return computeExpirationBucket(
    currentTime,
    HIGH_PRIORITY_EXPIRATION,
    HIGH_PRIORITY_BATCH_SIZE,
  );
}
