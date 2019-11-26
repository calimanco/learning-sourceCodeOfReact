/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import {REACT_PROVIDER_TYPE, REACT_CONTEXT_TYPE} from 'shared/ReactSymbols';

import type {ReactContext} from 'shared/ReactTypes';

import warningWithoutStack from 'shared/warningWithoutStack';
import warning from 'shared/warning';

// 生成context对象的方法，第一个参数是context的默认值，第二个是判断是否需要更新的函数。
export function createContext<T>(
  defaultValue: T,
  calculateChangedBits: ?(a: T, b: T) => number,
): ReactContext<T> {
  // 先对传值进行验证。
  if (calculateChangedBits === undefined) {
    calculateChangedBits = null;
  } else {
    if (__DEV__) {
      warningWithoutStack(
        calculateChangedBits === null ||
          typeof calculateChangedBits === 'function',
        'createContext: Expected the optional second argument to be a ' +
          'function. Instead received: %s',
        calculateChangedBits,
      );
    }
  }

  // 这个就是context对象
  const context: ReactContext<T> = {
    // 跟react元素的$$typeof不一样
    $$typeof: REACT_CONTEXT_TYPE,
    _calculateChangedBits: calculateChangedBits,
    // As a workaround to support multiple concurrent renderers, we categorize
    // some renderers as primary and others as secondary. We only expect
    // there to be two concurrent renderers at most: React Native (primary) and
    // Fabric (secondary); React DOM (primary) and React ART (secondary).
    // Secondary renderers store their context values on separate fields.
    // 翻译：作为解决多个并发渲染器的解决方法，我们将一些渲染器归类为主要渲染器，将其他渲染器归类为次要渲染器。
    //      我们只希望最多有两个并发渲染器：React Native（主要）和Fabric（次要）；React DOM（主要）和React ART（次要）。
    //      辅助渲染器将其上下文值存储在单独的字段中。
    // 这里提供两个字段（具体使用跟平台有关）用来保存当前值，默认为传入函数的defaultValue。
    _currentValue: defaultValue,
    _currentValue2: defaultValue,
    // These are circular
    // 翻译：
    Provider: (null: any),
    Consumer: (null: any),
  };

  context.Provider = {
    $$typeof: REACT_PROVIDER_TYPE,
    _context: context,
  };

  let hasWarnedAboutUsingNestedContextConsumers = false;
  let hasWarnedAboutUsingConsumerProvider = false;

  if (__DEV__) {
    // A separate object, but proxies back to the original context object for
    // backwards compatibility. It has a different $$typeof, so we can properly
    // warn for the incorrect usage of Context as a Consumer.
    const Consumer = {
      $$typeof: REACT_CONTEXT_TYPE,
      _context: context,
      _calculateChangedBits: context._calculateChangedBits,
    };
    // $FlowFixMe: Flow complains about not setting a value, which is intentional here
    Object.defineProperties(Consumer, {
      Provider: {
        get() {
          if (!hasWarnedAboutUsingConsumerProvider) {
            hasWarnedAboutUsingConsumerProvider = true;
            warning(
              false,
              'Rendering <Context.Consumer.Provider> is not supported and will be removed in ' +
                'a future major release. Did you mean to render <Context.Provider> instead?',
            );
          }
          return context.Provider;
        },
        set(_Provider) {
          context.Provider = _Provider;
        },
      },
      _currentValue: {
        get() {
          return context._currentValue;
        },
        set(_currentValue) {
          context._currentValue = _currentValue;
        },
      },
      _currentValue2: {
        get() {
          return context._currentValue2;
        },
        set(_currentValue2) {
          context._currentValue2 = _currentValue2;
        },
      },
      Consumer: {
        get() {
          if (!hasWarnedAboutUsingNestedContextConsumers) {
            hasWarnedAboutUsingNestedContextConsumers = true;
            warning(
              false,
              'Rendering <Context.Consumer.Consumer> is not supported and will be removed in ' +
                'a future major release. Did you mean to render <Context.Consumer> instead?',
            );
          }
          return context.Consumer;
        },
      },
    });
    // $FlowFixMe: Flow complains about missing properties because it doesn't understand defineProperty
    context.Consumer = Consumer;
  } else {
    context.Consumer = context;
  }

  if (__DEV__) {
    context._currentRenderer = null;
    context._currentRenderer2 = null;
  }

  return context;
}
