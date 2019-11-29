/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import ReactVersion from 'shared/ReactVersion';
import {
  REACT_CONCURRENT_MODE_TYPE,
  REACT_FRAGMENT_TYPE,
  REACT_PROFILER_TYPE,
  REACT_STRICT_MODE_TYPE,
  REACT_SUSPENSE_TYPE,
} from 'shared/ReactSymbols';

import {Component, PureComponent} from './ReactBaseClasses';
import {createRef} from './ReactCreateRef';
import {forEach, map, count, toArray, only} from './ReactChildren';
import {
  createElement,
  createFactory,
  cloneElement,
  isValidElement,
} from './ReactElement';
import {createContext} from './ReactContext';
import {lazy} from './ReactLazy';
import forwardRef from './forwardRef';
import memo from './memo';
import {
  createElementWithValidation,
  createFactoryWithValidation,
  cloneElementWithValidation,
} from './ReactElementValidator';
import ReactSharedInternals from './ReactSharedInternals';
import {enableStableConcurrentModeAPIs} from 'shared/ReactFeatureFlags';

// 总入口文件，这里挂载了很多方法和属性
const React = {
  Children: {
    map,
    forEach,
    count,
    toArray,
    only,
  },

  createRef,
  Component,
  PureComponent,

  createContext,
  forwardRef,
  lazy,
  memo,

  // React提供原生组件，默认只是个Symbol，在这没有具体实现
  Fragment: REACT_FRAGMENT_TYPE,
  StrictMode: REACT_STRICT_MODE_TYPE,
  Suspense: REACT_SUSPENSE_TYPE,

  // 创建React元素的方法，jsx的代码转换后就是变成这个API调用的函数。
  createElement: __DEV__ ? createElementWithValidation : createElement,
  // 复制React元素的方法。
  cloneElement: __DEV__ ? cloneElementWithValidation : cloneElement,
  // 创建生成React元素的工厂函数的方法，其实就是固定type，使用jsx编写的代码基本不会接触它。
  createFactory: __DEV__ ? createFactoryWithValidation : createFactory,
  // 验证对象是否为ReactElement的方法。
  isValidElement: isValidElement,

  // 记录React版本号
  version: ReactVersion,

  __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: ReactSharedInternals,
};

// ConcurrentMode这个API的开关，后续的版本其实都默认是true。
// 这里其实只是给这个API赋值了一个Symbol的标记，并没有实质性的实现。
if (enableStableConcurrentModeAPIs) {
  React.ConcurrentMode = REACT_CONCURRENT_MODE_TYPE;
  React.Profiler = REACT_PROFILER_TYPE;
} else {
  React.unstable_ConcurrentMode = REACT_CONCURRENT_MODE_TYPE;
  React.unstable_Profiler = REACT_PROFILER_TYPE;
}

export default React;
