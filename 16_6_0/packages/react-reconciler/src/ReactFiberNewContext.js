/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {ReactContext} from 'shared/ReactTypes';
import type {Fiber} from './ReactFiber';
import type {StackCursor} from './ReactFiberStack';
import type {ExpirationTime} from './ReactFiberExpirationTime';

export type ContextDependency<T> = {
  context: ReactContext<T>,
  observedBits: number,
  next: ContextDependency<mixed> | null,
};

import warningWithoutStack from 'shared/warningWithoutStack';
import {isPrimaryRenderer} from './ReactFiberHostConfig';
import {createCursor, push, pop} from './ReactFiberStack';
import MAX_SIGNED_31_BIT_INT from './maxSigned31BitInt';
import {NoWork} from './ReactFiberExpirationTime';
import {ContextProvider, ClassComponent} from 'shared/ReactWorkTags';

import invariant from 'shared/invariant';
import warning from 'shared/warning';
import {
  createUpdate,
  enqueueUpdate,
  ForceUpdate,
} from 'react-reconciler/src/ReactUpdateQueue';

const valueCursor: StackCursor<mixed> = createCursor(null);

let rendererSigil;
if (__DEV__) {
  // Use this to detect multiple renderers using the same context
  rendererSigil = {};
}

let currentlyRenderingFiber: Fiber | null = null;
let lastContextDependency: ContextDependency<mixed> | null = null;
let lastContextWithAllBitsObserved: ReactContext<any> | null = null;

export function resetContextDependences(): void {
  // This is called right before React yields execution, to ensure `readContext`
  // cannot be called outside the render phase.
  currentlyRenderingFiber = null;
  lastContextDependency = null;
  lastContextWithAllBitsObserved = null;
}

/**
 * 将Provider入栈。
 * @param providerFiber 将Provider入栈
 * @param nextValue
 */
export function pushProvider<T>(providerFiber: Fiber, nextValue: T): void {
  // 获取context对象，由createContext生成。
  const context: ReactContext<T> = providerFiber.type._context;

  // isPrimaryRenderer其实是定值true。
  if (isPrimaryRenderer) {
    push(valueCursor, context._currentValue, providerFiber);

    context._currentValue = nextValue;
    if (__DEV__) {
      warningWithoutStack(
        context._currentRenderer === undefined ||
          context._currentRenderer === null ||
          context._currentRenderer === rendererSigil,
        'Detected multiple renderers concurrently rendering the ' +
          'same context provider. This is currently unsupported.',
      );
      context._currentRenderer = rendererSigil;
    }
  } else {
    push(valueCursor, context._currentValue2, providerFiber);

    context._currentValue2 = nextValue;
    if (__DEV__) {
      warningWithoutStack(
        context._currentRenderer2 === undefined ||
          context._currentRenderer2 === null ||
          context._currentRenderer2 === rendererSigil,
        'Detected multiple renderers concurrently rendering the ' +
          'same context provider. This is currently unsupported.',
      );
      context._currentRenderer2 = rendererSigil;
    }
  }
}

export function popProvider(providerFiber: Fiber): void {
  const currentValue = valueCursor.current;

  pop(valueCursor, providerFiber);

  const context: ReactContext<any> = providerFiber.type._context;
  if (isPrimaryRenderer) {
    context._currentValue = currentValue;
  } else {
    context._currentValue2 = currentValue;
  }
}

/**
 * 对比新旧数据有没有变化。
 * @param context 要处理的context对象
 * @param newValue 新的值
 * @param oldValue 旧的值
 * @return {number}
 */
export function calculateChangedBits<T>(
  context: ReactContext<T>,
  newValue: T,
  oldValue: T,
) {
  // Use Object.is to compare the new context value to the old value. Inlined
  // Object.is polyfill.
  // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/is
  if (
    (oldValue === newValue &&
      (oldValue !== 0 || 1 / oldValue === 1 / (newValue: any))) ||
    (oldValue !== oldValue && newValue !== newValue) // eslint-disable-line no-self-compare
  ) {
    // No change
    return 0;
  } else {
    // 用户写的对比函数会保存在_calculateChangedBits。
    const changedBits =
      typeof context._calculateChangedBits === 'function'
        ? context._calculateChangedBits(oldValue, newValue)
        : MAX_SIGNED_31_BIT_INT;

    if (__DEV__) {
      warning(
        (changedBits & MAX_SIGNED_31_BIT_INT) === changedBits,
        'calculateChangedBits: Expected the return value to be a ' +
          '31-bit integer. Instead received: %s',
        changedBits,
      );
    }
    return changedBits | 0;
  }
}

/**
 * 安排context变化时的更新。
 * @param workInProgress 当前处理的Fiber对象的进行中副本
 * @param context 要处理的context对象
 * @param changedBits calculateChangedBits返回的数字
 * @param renderExpirationTime 当前处理的Fiber所在的FiberRoot的nextExpirationTimeToWorkOn
 */
export function propagateContextChange(
  workInProgress: Fiber,
  context: ReactContext<mixed>,
  changedBits: number,
  renderExpirationTime: ExpirationTime,
): void {
  let fiber = workInProgress.child;
  if (fiber !== null) {
    // Set the return pointer of the child to the work-in-progress fiber.
    // 翻译：设置子节点的return指针指向Fiber节点的进行中副本。
    fiber.return = workInProgress;
  }
  while (fiber !== null) {
    let nextFiber;

    // Visit this fiber.
    // 翻译：访问这个Fiber节点。
    let dependency = fiber.firstContextDependency;
    if (dependency !== null) {
      do {
        // Check if the context matches.
        // 翻译：检查context是否匹配。
        if (
          dependency.context === context &&
          (dependency.observedBits & changedBits) !== 0
        ) {
          // Match! Schedule an update on this fiber.
          // 翻译：匹配！在这个Fiber节点上安排一个更新

          if (fiber.tag === ClassComponent) {
            // Schedule a force update on the work-in-progress.
            // 翻译：在进行中副本上安排一个强制更新。
            const update = createUpdate(renderExpirationTime);
            update.tag = ForceUpdate;
            // TODO: Because we don't have a work-in-progress, this will add the
            // update to the current fiber, too, which means it will persist even if
            // this render is thrown away. Since it's a race condition, not sure it's
            // worth fixing.
            enqueueUpdate(fiber, update);
          }

          if (
            fiber.expirationTime === NoWork ||
            fiber.expirationTime > renderExpirationTime
          ) {
            fiber.expirationTime = renderExpirationTime;
          }
          let alternate = fiber.alternate;
          if (
            alternate !== null &&
            (alternate.expirationTime === NoWork ||
              alternate.expirationTime > renderExpirationTime)
          ) {
            alternate.expirationTime = renderExpirationTime;
          }
          // Update the child expiration time of all the ancestors, including
          // the alternates.
          // 翻译：更新所有父节点（包括alternate）的子节点到期时间。
          let node = fiber.return;
          while (node !== null) {
            alternate = node.alternate;
            if (
              node.childExpirationTime === NoWork ||
              node.childExpirationTime > renderExpirationTime
            ) {
              node.childExpirationTime = renderExpirationTime;
              if (
                alternate !== null &&
                (alternate.childExpirationTime === NoWork ||
                  alternate.childExpirationTime > renderExpirationTime)
              ) {
                alternate.childExpirationTime = renderExpirationTime;
              }
            } else if (
              alternate !== null &&
              (alternate.childExpirationTime === NoWork ||
                alternate.childExpirationTime > renderExpirationTime)
            ) {
              alternate.childExpirationTime = renderExpirationTime;
            } else {
              // Neither alternate was updated, which means the rest of the
              // ancestor path already has sufficient priority.
              // 翻译：这两个备用路径均未更新，这意味着其余的祖先路径已经具有足够的优先级。
              break;
            }
            node = node.return;
          }
        }
        nextFiber = fiber.child;
        dependency = dependency.next;
      } while (dependency !== null);
    } else if (fiber.tag === ContextProvider) {
      // Don't scan deeper if this is a matching provider
      // 翻译：如果这是一个匹配的provider，请不要更深入地扫描。
      nextFiber = fiber.type === workInProgress.type ? null : fiber.child;
    } else {
      // Traverse down.
      // 翻译：下移。
      nextFiber = fiber.child;
    }

    if (nextFiber !== null) {
      // Set the return pointer of the child to the work-in-progress fiber.
      // 翻译：设置子节点的return指针指向Fiber节点的进行中副本。
      nextFiber.return = fiber;
    } else {
      // No child. Traverse to next sibling.
      // 翻译：没有子节点。移向兄弟节点。
      nextFiber = fiber;
      while (nextFiber !== null) {
        if (nextFiber === workInProgress) {
          // We're back to the root of this subtree. Exit.
          // 翻译：我们正在返回这棵子树的根节点。离开。
          nextFiber = null;
          break;
        }
        let sibling = nextFiber.sibling;
        if (sibling !== null) {
          // Set the return pointer of the sibling to the work-in-progress fiber.
          // 翻译：设置兄弟节点的return指针指向Fiber节点的进行中副本。
          sibling.return = nextFiber.return;
          nextFiber = sibling;
          break;
        }
        // No more siblings. Traverse up.
        // 翻译：没有兄弟节点了。上移。
        nextFiber = nextFiber.return;
      }
    }
    fiber = nextFiber;
  }
}

export function prepareToReadContext(
  workInProgress: Fiber,
  renderExpirationTime: ExpirationTime,
): void {
  currentlyRenderingFiber = workInProgress;
  lastContextDependency = null;
  lastContextWithAllBitsObserved = null;

  // Reset the work-in-progress list
  workInProgress.firstContextDependency = null;
}

export function readContext<T>(
  context: ReactContext<T>,
  observedBits: void | number | boolean,
): T {
  if (lastContextWithAllBitsObserved === context) {
    // Nothing to do. We already observe everything in this context.
  } else if (observedBits === false || observedBits === 0) {
    // Do not observe any updates.
  } else {
    let resolvedObservedBits; // Avoid deopting on observable arguments or heterogeneous types.
    if (
      typeof observedBits !== 'number' ||
      observedBits === MAX_SIGNED_31_BIT_INT
    ) {
      // Observe all updates.
      lastContextWithAllBitsObserved = ((context: any): ReactContext<mixed>);
      resolvedObservedBits = MAX_SIGNED_31_BIT_INT;
    } else {
      resolvedObservedBits = observedBits;
    }

    let contextItem = {
      context: ((context: any): ReactContext<mixed>),
      observedBits: resolvedObservedBits,
      next: null,
    };

    if (lastContextDependency === null) {
      invariant(
        currentlyRenderingFiber !== null,
        'Context can only be read while React is ' +
          'rendering, e.g. inside the render method or getDerivedStateFromProps.',
      );
      // This is the first dependency in the list
      currentlyRenderingFiber.firstContextDependency = lastContextDependency = contextItem;
    } else {
      // Append a new context item.
      lastContextDependency = lastContextDependency.next = contextItem;
    }
  }
  return isPrimaryRenderer ? context._currentValue : context._currentValue2;
}
