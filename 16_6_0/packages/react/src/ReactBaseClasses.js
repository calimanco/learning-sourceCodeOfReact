/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import invariant from 'shared/invariant';
import lowPriorityWarning from 'shared/lowPriorityWarning';

import ReactNoopUpdateQueue from './ReactNoopUpdateQueue';

// 准备一个空对象给refs作为初始值
const emptyObject = {};
if (__DEV__) {
  Object.freeze(emptyObject);
}

/**
 * Base class helpers for the updating state of a component.
 * 翻译：组件更新状态的基类帮助程序。
 */
function Component(props, context, updater) {
  // 简单的将props和context挂载
  this.props = props;
  this.context = context;
  // If a component has string refs, we will assign a different object later.
  // 翻译：如果一个组件有字符串refs，我们将在后面指派一个不同的对象。
  this.refs = emptyObject;
  // We initialize the default updater but the real one gets injected by the
  // renderer.
  // 翻译：我们初始化了默认的更新程序，但是真正的更新程序来自渲染器。
  // 这里的渲染器会依照平台不同而不同，比如H5就是react-home，APP就是react-native，
  // 默认的更新程序其实只是个抽象接口。
  this.updater = updater || ReactNoopUpdateQueue;
}

// 原型上一个对象（功能未知）
Component.prototype.isReactComponent = {};

/**
 * Sets a subset of the state. Always use this to mutate
 * state. You should treat `this.state` as immutable.
 * 翻译：设置状态的子集。总是使用这个函数改变状态。你应该把this.state当成不可变的。
 *
 * There is no guarantee that `this.state` will be immediately updated, so
 * accessing `this.state` after calling this method may return the old value.
 * 翻译：没有保证this.state会立即更新，因此在这个方法之后访问this.state将可能返回旧值。
 *
 * There is no guarantee that calls to `setState` will run synchronously,
 * as they may eventually be batched together.  You can provide an optional
 * callback that will be executed when the call to setState is actually
 * completed.
 * 翻译：没有保证setState的调用将同步运行，因为它们最终可能会被混合在一起。
 *      你可以提供一个可选的回调函数, 该回调将在对setState的调用实际完成时执行.
 *
 * When a function is provided to setState, it will be called at some point in
 * the future (not synchronously). It will be called with the up to date
 * component arguments (state, props, context). These values can be different
 * from this.* because your function may be called after receiveProps but before
 * shouldComponentUpdate, and this new state, props, and context will not yet be
 * assigned to this.
 * 翻译：当一个函数提供给setState，它将会在未来某个时间点被调用。（非同步）
 *      将使用最新的组件参数调用它。这些值可能与this.*不同，因为你的函数可能在receiveProps
 *      之后但shouldComponentUpdate之前被调用，这些新的state、props、context将尚未指派给它。
 *
 * @param {object|function} partialState Next partial state or function to
 *        produce next partial state to be merged with current state.
 *        翻译：下一个部分状态或函数,用来产生要与当前状态合并的下一个部分状态。
 * @param {?function} callback Called after state is updated.
 *        翻译：当状态更新后的回调函数
 * @final
 * @protected
 */
Component.prototype.setState = function(partialState, callback) {
  // 检查partialState参数类型是否正确，不正确就提示
  invariant(
    typeof partialState === 'object' ||
      typeof partialState === 'function' ||
      partialState == null,
    'setState(...): takes an object of state variables to update or a ' +
      'function which returns an object of state variables.',
  );
  // enqueueSetState是渲染器上重要的渲染方法由外部平台渲染器传入
  this.updater.enqueueSetState(this, partialState, callback, 'setState');
};

/**
 * Forces an update. This should only be invoked when it is known with
 * certainty that we are **not** in a DOM transaction.
 * 翻译：强制更新。仅在确定我们不在DOM事务中时，才应调用此方法。
 *
 * You may want to call this when you know that some deeper aspect of the
 * component's state has changed but `setState` was not called.
 * 翻译：当你知道组件状态的某些更深的方面已更改，但未调用setState时，你可能想要调用这个函数。
 *
 * This will not invoke `shouldComponentUpdate`, but it will invoke
 * `componentWillUpdate` and `componentDidUpdate`.
 * 翻译：这将不会调用shouldComponentUpdate，但它将调用componentWillUpdate和componentDidUpdate。
 *
 * @param {?function} callback Called after update is complete.
 * @final
 * @protected
 */
Component.prototype.forceUpdate = function(callback) {
  // 就是调用一遍渲染器上的enqueueForceUpdate，但注意最后一个参数，有提示渲染器方法名，因此表现有点不同。
  // 比如：这将不会调用shouldComponentUpdate
  this.updater.enqueueForceUpdate(this, callback, 'forceUpdate');
};

/**
 * Deprecated APIs. These APIs used to exist on classic React classes but since
 * we would like to deprecate them, we're not going to move them over to this
 * modern base class. Instead, we define a getter that warns if it's accessed.
 * 翻译：弃用API。这些API曾经存在于经典的React类上，但从我们要弃用它们开始，我们将不会移动他们到到这个现代基类。
 *      取而代之，我们定义一个getter用来警告提示。
 */
if (__DEV__) {
  const deprecatedAPIs = {
    isMounted: [
      'isMounted',
      'Instead, make sure to clean up subscriptions and pending requests in ' +
        'componentWillUnmount to prevent memory leaks.',
    ],
    replaceState: [
      'replaceState',
      'Refactor your code to use setState instead (see ' +
        'https://github.com/facebook/react/issues/3236).',
    ],
  };
  const defineDeprecationWarning = function(methodName, info) {
    Object.defineProperty(Component.prototype, methodName, {
      get: function() {
        lowPriorityWarning(
          false,
          '%s(...) is deprecated in plain JavaScript React classes. %s',
          info[0],
          info[1],
        );
        return undefined;
      },
    });
  };
  for (const fnName in deprecatedAPIs) {
    if (deprecatedAPIs.hasOwnProperty(fnName)) {
      defineDeprecationWarning(fnName, deprecatedAPIs[fnName]);
    }
  }
}

function ComponentDummy() {}
ComponentDummy.prototype = Component.prototype;

/**
 * Convenience component with default shallow equality check for sCU.
 * 翻译：带有默认浅层相等性检查的便利组件。
 * 这里并没有实现比较的逻辑，只是保留这个构造函数。
 */
function PureComponent(props, context, updater) {
  this.props = props;
  this.context = context;
  // If a component has string refs, we will assign a different object later.
  this.refs = emptyObject;
  this.updater = updater || ReactNoopUpdateQueue;
}

// 这里的操作是为了将PureComponent的原型做得更Component一样。
const pureComponentPrototype = (PureComponent.prototype = new ComponentDummy());
pureComponentPrototype.constructor = PureComponent;
// Avoid an extra prototype jump for these methods.
// 翻译：对于这些方法，请避免额外的原型跳转。
Object.assign(pureComponentPrototype, Component.prototype);
// 唯一的不同，就是一个标识。
pureComponentPrototype.isPureReactComponent = true;

export {Component, PureComponent};
