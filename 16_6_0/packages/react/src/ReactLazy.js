/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {LazyComponent, Thenable} from 'shared/ReactLazyComponent';

import {REACT_LAZY_TYPE} from 'shared/ReactSymbols';

// lazy接口，只是个标记
export function lazy<T, R>(ctor: () => Thenable<T, R>): LazyComponent<T> {
  return {
    $$typeof: REACT_LAZY_TYPE,
    // 保存传入的生成promise的方法。
    _ctor: ctor,
    // React uses these fields to store the result.
    // 翻译：React使用这些字段来存储结果。
    // 记录Thenable对象（promise）的状态。
    _status: -1,
    // 记录Thenable对象（promise）最后完成时返回的结果，其实就是异步的组件。
    _result: null,
  };
}
