/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {Fiber} from './ReactFiber';
import type {ExpirationTime} from './ReactFiberExpirationTime';

import React from 'react';
import {Update, Snapshot} from 'shared/ReactSideEffectTags';
import {
  debugRenderPhaseSideEffects,
  debugRenderPhaseSideEffectsForStrictMode,
  warnAboutDeprecatedLifecycles,
} from 'shared/ReactFeatureFlags';
import ReactStrictModeWarnings from './ReactStrictModeWarnings';
import {isMounted} from 'react-reconciler/reflection';
import * as ReactInstanceMap from 'shared/ReactInstanceMap';
import ReactSharedInternals from 'shared/ReactSharedInternals';
import shallowEqual from 'shared/shallowEqual';
import getComponentName from 'shared/getComponentName';
import invariant from 'shared/invariant';
import warningWithoutStack from 'shared/warningWithoutStack';
import {REACT_CONTEXT_TYPE} from 'shared/ReactSymbols';

import {startPhaseTimer, stopPhaseTimer} from './ReactDebugFiberPerf';
import {StrictMode} from './ReactTypeOfMode';

import {
  enqueueUpdate,
  processUpdateQueue,
  checkHasForceUpdateAfterProcessing,
  resetHasForceUpdateBeforeProcessing,
  createUpdate,
  ReplaceState,
  ForceUpdate,
} from './ReactUpdateQueue';
import {NoWork} from './ReactFiberExpirationTime';
import {
  cacheContext,
  getMaskedContext,
  getUnmaskedContext,
  hasContextChanged,
  emptyContextObject,
} from './ReactFiberContext';
import {
  requestCurrentTime,
  computeExpirationForFiber,
  scheduleWork,
} from './ReactFiberScheduler';

const ReactCurrentOwner = ReactSharedInternals.ReactCurrentOwner;

function readContext(contextType: any): any {
  const dispatcher = ReactCurrentOwner.currentDispatcher;
  return dispatcher.readContext(contextType);
}

const fakeInternalInstance = {};
const isArray = Array.isArray;

// React.Component uses a shared frozen object by default.
// We'll use it to determine whether we need to initialize legacy refs.
export const emptyRefsObject = new React.Component().refs;

let didWarnAboutStateAssignmentForComponent;
let didWarnAboutUninitializedState;
let didWarnAboutGetSnapshotBeforeUpdateWithoutDidUpdate;
let didWarnAboutLegacyLifecyclesAndDerivedState;
let didWarnAboutUndefinedDerivedState;
let warnOnUndefinedDerivedState;
let warnOnInvalidCallback;
let didWarnAboutDirectlyAssigningPropsToState;
let didWarnAboutContextTypeAndContextTypes;
let didWarnAboutInvalidateContextType;

if (__DEV__) {
  didWarnAboutStateAssignmentForComponent = new Set();
  didWarnAboutUninitializedState = new Set();
  didWarnAboutGetSnapshotBeforeUpdateWithoutDidUpdate = new Set();
  didWarnAboutLegacyLifecyclesAndDerivedState = new Set();
  didWarnAboutDirectlyAssigningPropsToState = new Set();
  didWarnAboutUndefinedDerivedState = new Set();
  didWarnAboutContextTypeAndContextTypes = new Set();
  didWarnAboutInvalidateContextType = new Set();

  const didWarnOnInvalidCallback = new Set();

  warnOnInvalidCallback = function(callback: mixed, callerName: string) {
    if (callback === null || typeof callback === 'function') {
      return;
    }
    const key = `${callerName}_${(callback: any)}`;
    if (!didWarnOnInvalidCallback.has(key)) {
      didWarnOnInvalidCallback.add(key);
      warningWithoutStack(
        false,
        '%s(...): Expected the last optional `callback` argument to be a ' +
          'function. Instead received: %s.',
        callerName,
        callback,
      );
    }
  };

  warnOnUndefinedDerivedState = function(type, partialState) {
    if (partialState === undefined) {
      const componentName = getComponentName(type) || 'Component';
      if (!didWarnAboutUndefinedDerivedState.has(componentName)) {
        didWarnAboutUndefinedDerivedState.add(componentName);
        warningWithoutStack(
          false,
          '%s.getDerivedStateFromProps(): A valid state object (or null) must be returned. ' +
            'You have returned undefined.',
          componentName,
        );
      }
    }
  };

  // This is so gross but it's at least non-critical and can be removed if
  // it causes problems. This is meant to give a nicer error message for
  // ReactDOM15.unstable_renderSubtreeIntoContainer(reactDOM16Component,
  // ...)) which otherwise throws a "_processChildContext is not a function"
  // exception.
  Object.defineProperty(fakeInternalInstance, '_processChildContext', {
    enumerable: false,
    value: function() {
      invariant(
        false,
        '_processChildContext is not available in React 16+. This likely ' +
          'means you have multiple copies of React and are attempting to nest ' +
          'a React 15 tree inside a React 16 tree using ' +
          "unstable_renderSubtreeIntoContainer, which isn't supported. Try " +
          'to make sure you have only one copy of React (and ideally, switch ' +
          'to ReactDOM.createPortal).',
      );
    },
  });
  Object.freeze(fakeInternalInstance);
}

/**
 * 处理getDerivedStateFromProps生命周期。
 * @param workInProgress 当前处理的Fiber对象的进行中副本
 * @param ctor workInProgress的type，使用者写的类组件
 * @param getDerivedStateFromProps 类上的生命周期方法
 * @param nextProps 新的props对象
 */
export function applyDerivedStateFromProps(
  workInProgress: Fiber,
  ctor: any,
  getDerivedStateFromProps: (props: any, state: any) => any,
  nextProps: any,
) {
  const prevState = workInProgress.memoizedState;

  if (__DEV__) {
    if (
      debugRenderPhaseSideEffects ||
      (debugRenderPhaseSideEffectsForStrictMode &&
        workInProgress.mode & StrictMode)
    ) {
      // Invoke the function an extra time to help detect side-effects.
      getDerivedStateFromProps(nextProps, prevState);
    }
  }

  const partialState = getDerivedStateFromProps(nextProps, prevState);

  if (__DEV__) {
    warnOnUndefinedDerivedState(ctor, partialState);
  }
  // Merge the partial state and the previous state.
  // 翻译：合并部分状态和先前状态。
  const memoizedState =
    partialState === null || partialState === undefined
      ? prevState
      : Object.assign({}, prevState, partialState);
  workInProgress.memoizedState = memoizedState;

  // Once the update queue is empty, persist the derived state onto the
  // base state.
  // 翻译：更新队列为空后，将派生状态保持在基本状态上。
  const updateQueue = workInProgress.updateQueue;
  if (updateQueue !== null && workInProgress.expirationTime === NoWork) {
    updateQueue.baseState = memoizedState;
  }
}

// 挂载到Fiber对象上的updater。
// 这里提供了SetState，ReplaceState，ForceUpdate产生Update对象并进入调度的方法。
const classComponentUpdater = {
  isMounted,
  /**
   * setState实际调用非方法。
   * @param inst
   * @param payload
   * @param callback
   */
  enqueueSetState(inst, payload, callback) {
    const fiber = ReactInstanceMap.get(inst);
    // 计算一个当前时间。
    const currentTime = requestCurrentTime();
    // 得到当前Fiber对象的"过期时间"。
    const expirationTime = computeExpirationForFiber(currentTime, fiber);

    // 生成Update对象。
    const update = createUpdate(expirationTime);
    // setState没有tag有payload。
    update.payload = payload;
    if (callback !== undefined && callback !== null) {
      if (__DEV__) {
        warnOnInvalidCallback(callback, 'setState');
      }
      update.callback = callback;
    }

    // 将Update对象加入队列。
    enqueueUpdate(fiber, update);
    // 进入调度fiberSchedule调度流程。
    scheduleWork(fiber, expirationTime);
  },
  enqueueReplaceState(inst, payload, callback) {
    const fiber = ReactInstanceMap.get(inst);
    const currentTime = requestCurrentTime();
    const expirationTime = computeExpirationForFiber(currentTime, fiber);

    const update = createUpdate(expirationTime);
    // replaceState既有tag又有payload。
    update.tag = ReplaceState;
    update.payload = payload;

    if (callback !== undefined && callback !== null) {
      if (__DEV__) {
        warnOnInvalidCallback(callback, 'replaceState');
      }
      update.callback = callback;
    }

    enqueueUpdate(fiber, update);
    scheduleWork(fiber, expirationTime);
  },
  enqueueForceUpdate(inst, callback) {
    const fiber = ReactInstanceMap.get(inst);
    const currentTime = requestCurrentTime();
    const expirationTime = computeExpirationForFiber(currentTime, fiber);

    const update = createUpdate(expirationTime);
    // forceUpdate有tag没有payload。
    update.tag = ForceUpdate;

    if (callback !== undefined && callback !== null) {
      if (__DEV__) {
        warnOnInvalidCallback(callback, 'forceUpdate');
      }
      update.callback = callback;
    }

    enqueueUpdate(fiber, update);
    scheduleWork(fiber, expirationTime);
  },
};

/**
 * 处理shouldComponentUpdate生命周期方法。
 * @param workInProgress 当前处理的Fiber对象的进行中副本
 * @param ctor workInProgress的type，使用者写的类组件
 * @param oldProps 旧的props对象
 * @param newProps 新的props对象
 * @param oldState 旧的state对象
 * @param newState 新的state对象
 * @param nextContext context相关
 * @return {boolean}
 */
function checkShouldComponentUpdate(
  workInProgress,
  ctor,
  oldProps,
  newProps,
  oldState,
  newState,
  nextContext,
) {
  // 取出类实例。
  const instance = workInProgress.stateNode;
  if (typeof instance.shouldComponentUpdate === 'function') {
    // 如果类实例上有shouldComponentUpdate生命周期方法旧执行。
    startPhaseTimer(workInProgress, 'shouldComponentUpdate');
    const shouldUpdate = instance.shouldComponentUpdate(
      newProps,
      newState,
      nextContext,
    );
    stopPhaseTimer();

    if (__DEV__) {
      warningWithoutStack(
        shouldUpdate !== undefined,
        '%s.shouldComponentUpdate(): Returned undefined instead of a ' +
          'boolean value. Make sure to return true or false.',
        getComponentName(ctor) || 'Component',
      );
    }

    return shouldUpdate;
  }

  // 如果实例上面没有shouldComponentUpdate方法，但是是PureReactComponent，
  // 则默认对props和state进行浅比较。
  if (ctor.prototype && ctor.prototype.isPureReactComponent) {
    return (
      !shallowEqual(oldProps, newProps) || !shallowEqual(oldState, newState)
    );
  }

  return true;
}

function checkClassInstance(workInProgress: Fiber, ctor: any, newProps: any) {
  const instance = workInProgress.stateNode;
  if (__DEV__) {
    const name = getComponentName(ctor) || 'Component';
    const renderPresent = instance.render;

    if (!renderPresent) {
      if (ctor.prototype && typeof ctor.prototype.render === 'function') {
        warningWithoutStack(
          false,
          '%s(...): No `render` method found on the returned component ' +
            'instance: did you accidentally return an object from the constructor?',
          name,
        );
      } else {
        warningWithoutStack(
          false,
          '%s(...): No `render` method found on the returned component ' +
            'instance: you may have forgotten to define `render`.',
          name,
        );
      }
    }

    const noGetInitialStateOnES6 =
      !instance.getInitialState ||
      instance.getInitialState.isReactClassApproved ||
      instance.state;
    warningWithoutStack(
      noGetInitialStateOnES6,
      'getInitialState was defined on %s, a plain JavaScript class. ' +
        'This is only supported for classes created using React.createClass. ' +
        'Did you mean to define a state property instead?',
      name,
    );
    const noGetDefaultPropsOnES6 =
      !instance.getDefaultProps ||
      instance.getDefaultProps.isReactClassApproved;
    warningWithoutStack(
      noGetDefaultPropsOnES6,
      'getDefaultProps was defined on %s, a plain JavaScript class. ' +
        'This is only supported for classes created using React.createClass. ' +
        'Use a static property to define defaultProps instead.',
      name,
    );
    const noInstancePropTypes = !instance.propTypes;
    warningWithoutStack(
      noInstancePropTypes,
      'propTypes was defined as an instance property on %s. Use a static ' +
        'property to define propTypes instead.',
      name,
    );
    const noInstanceContextType = !instance.contextType;
    warningWithoutStack(
      noInstanceContextType,
      'contextType was defined as an instance property on %s. Use a static ' +
        'property to define contextType instead.',
      name,
    );
    const noInstanceContextTypes = !instance.contextTypes;
    warningWithoutStack(
      noInstanceContextTypes,
      'contextTypes was defined as an instance property on %s. Use a static ' +
        'property to define contextTypes instead.',
      name,
    );

    if (
      ctor.contextType &&
      ctor.contextTypes &&
      !didWarnAboutContextTypeAndContextTypes.has(ctor)
    ) {
      didWarnAboutContextTypeAndContextTypes.add(ctor);
      warningWithoutStack(
        false,
        '%s declares both contextTypes and contextType static properties. ' +
          'The legacy contextTypes property will be ignored.',
        name,
      );
    }

    const noComponentShouldUpdate =
      typeof instance.componentShouldUpdate !== 'function';
    warningWithoutStack(
      noComponentShouldUpdate,
      '%s has a method called ' +
        'componentShouldUpdate(). Did you mean shouldComponentUpdate()? ' +
        'The name is phrased as a question because the function is ' +
        'expected to return a value.',
      name,
    );
    if (
      ctor.prototype &&
      ctor.prototype.isPureReactComponent &&
      typeof instance.shouldComponentUpdate !== 'undefined'
    ) {
      warningWithoutStack(
        false,
        '%s has a method called shouldComponentUpdate(). ' +
          'shouldComponentUpdate should not be used when extending React.PureComponent. ' +
          'Please extend React.Component if shouldComponentUpdate is used.',
        getComponentName(ctor) || 'A pure component',
      );
    }
    const noComponentDidUnmount =
      typeof instance.componentDidUnmount !== 'function';
    warningWithoutStack(
      noComponentDidUnmount,
      '%s has a method called ' +
        'componentDidUnmount(). But there is no such lifecycle method. ' +
        'Did you mean componentWillUnmount()?',
      name,
    );
    const noComponentDidReceiveProps =
      typeof instance.componentDidReceiveProps !== 'function';
    warningWithoutStack(
      noComponentDidReceiveProps,
      '%s has a method called ' +
        'componentDidReceiveProps(). But there is no such lifecycle method. ' +
        'If you meant to update the state in response to changing props, ' +
        'use componentWillReceiveProps(). If you meant to fetch data or ' +
        'run side-effects or mutations after React has updated the UI, use componentDidUpdate().',
      name,
    );
    const noComponentWillRecieveProps =
      typeof instance.componentWillRecieveProps !== 'function';
    warningWithoutStack(
      noComponentWillRecieveProps,
      '%s has a method called ' +
        'componentWillRecieveProps(). Did you mean componentWillReceiveProps()?',
      name,
    );
    const noUnsafeComponentWillRecieveProps =
      typeof instance.UNSAFE_componentWillRecieveProps !== 'function';
    warningWithoutStack(
      noUnsafeComponentWillRecieveProps,
      '%s has a method called ' +
        'UNSAFE_componentWillRecieveProps(). Did you mean UNSAFE_componentWillReceiveProps()?',
      name,
    );
    const hasMutatedProps = instance.props !== newProps;
    warningWithoutStack(
      instance.props === undefined || !hasMutatedProps,
      '%s(...): When calling super() in `%s`, make sure to pass ' +
        "up the same props that your component's constructor was passed.",
      name,
      name,
    );
    const noInstanceDefaultProps = !instance.defaultProps;
    warningWithoutStack(
      noInstanceDefaultProps,
      'Setting defaultProps as an instance property on %s is not supported and will be ignored.' +
        ' Instead, define defaultProps as a static property on %s.',
      name,
      name,
    );

    if (
      typeof instance.getSnapshotBeforeUpdate === 'function' &&
      typeof instance.componentDidUpdate !== 'function' &&
      !didWarnAboutGetSnapshotBeforeUpdateWithoutDidUpdate.has(ctor)
    ) {
      didWarnAboutGetSnapshotBeforeUpdateWithoutDidUpdate.add(ctor);
      warningWithoutStack(
        false,
        '%s: getSnapshotBeforeUpdate() should be used with componentDidUpdate(). ' +
          'This component defines getSnapshotBeforeUpdate() only.',
        getComponentName(ctor),
      );
    }

    const noInstanceGetDerivedStateFromProps =
      typeof instance.getDerivedStateFromProps !== 'function';
    warningWithoutStack(
      noInstanceGetDerivedStateFromProps,
      '%s: getDerivedStateFromProps() is defined as an instance method ' +
        'and will be ignored. Instead, declare it as a static method.',
      name,
    );
    const noInstanceGetDerivedStateFromCatch =
      typeof instance.getDerivedStateFromError !== 'function';
    warningWithoutStack(
      noInstanceGetDerivedStateFromCatch,
      '%s: getDerivedStateFromError() is defined as an instance method ' +
        'and will be ignored. Instead, declare it as a static method.',
      name,
    );
    const noStaticGetSnapshotBeforeUpdate =
      typeof ctor.getSnapshotBeforeUpdate !== 'function';
    warningWithoutStack(
      noStaticGetSnapshotBeforeUpdate,
      '%s: getSnapshotBeforeUpdate() is defined as a static method ' +
        'and will be ignored. Instead, declare it as an instance method.',
      name,
    );
    const state = instance.state;
    if (state && (typeof state !== 'object' || isArray(state))) {
      warningWithoutStack(
        false,
        '%s.state: must be set to an object or null',
        name,
      );
    }
    if (typeof instance.getChildContext === 'function') {
      warningWithoutStack(
        typeof ctor.childContextTypes === 'object',
        '%s.getChildContext(): childContextTypes must be defined in order to ' +
          'use getChildContext().',
        name,
      );
    }
  }
}

/**
 * 挂载updater，连接instance和workInProgress(就是workInProgress.stateNode)，加入ReactInstanceMap
 * @param workInProgress 处理中的Fiber对象
 * @param instance 用户写的类
 */
function adoptClassInstance(workInProgress: Fiber, instance: any): void {
  instance.updater = classComponentUpdater;
  workInProgress.stateNode = instance;
  // The instance needs access to the fiber so that it can schedule updates
  // 翻译：该实例需要访问Fiber对象，以便可以安排更新。
  // 这里的set其实是在instance上增加了_reactInternalFiber属性，指向workInProgress。
  ReactInstanceMap.set(instance, workInProgress);
  if (__DEV__) {
    instance._reactInternalInstance = fakeInternalInstance;
  }
}

/**
 * 构造类实例
 * @param workInProgress 当前处理的Fiber对象的进行中副本
 * @param ctor workInProgress的type，使用者写的类组件
 * @param props 新的props对象
 * @param renderExpirationTime 当前处理的Fiber所在的FiberRoot的nextExpirationTimeToWorkOn
 */
function constructClassInstance(
  workInProgress: Fiber,
  ctor: any,
  props: any,
  renderExpirationTime: ExpirationTime,
): any {
  // context相关
  let isLegacyContextConsumer = false;
  let unmaskedContext = emptyContextObject;
  let context = null;
  const contextType = ctor.contextType;
  if (typeof contextType === 'object' && contextType !== null) {
    if (__DEV__) {
      if (
        contextType.$$typeof !== REACT_CONTEXT_TYPE &&
        !didWarnAboutInvalidateContextType.has(ctor)
      ) {
        didWarnAboutInvalidateContextType.add(ctor);
        warningWithoutStack(
          false,
          '%s defines an invalid contextType. ' +
            'contextType should point to the Context object returned by React.createContext(). ' +
            'Did you accidentally pass the Context.Provider instead?',
          getComponentName(ctor) || 'Component',
        );
      }
    }

    context = readContext((contextType: any));
  } else {
    unmaskedContext = getUnmaskedContext(workInProgress, ctor, true);
    const contextTypes = ctor.contextTypes;
    isLegacyContextConsumer =
      contextTypes !== null && contextTypes !== undefined;
    context = isLegacyContextConsumer
      ? getMaskedContext(workInProgress, unmaskedContext)
      : emptyContextObject;
  }

  // Instantiate twice to help detect side-effects.
  // 翻译：实例化两次以帮助检测副作用。
  if (__DEV__) {
    if (
      debugRenderPhaseSideEffects ||
      (debugRenderPhaseSideEffectsForStrictMode &&
        workInProgress.mode & StrictMode)
    ) {
      new ctor(props, context); // eslint-disable-line no-new
    }
  }

  // 将使用者写的类实例化，ctor就是使用者的代码。
  const instance = new ctor(props, context);
  // 将instance的state赋值给workInProgress的memoizedState，这里也是state的初始值。
  const state = (workInProgress.memoizedState =
    instance.state !== null && instance.state !== undefined
      ? instance.state
      : null);
  // 挂载updater，连接instance和workInProgress(就是workInProgress.stateNode)，加入ReactInstanceMap
  adoptClassInstance(workInProgress, instance);

  if (__DEV__) {
    if (typeof ctor.getDerivedStateFromProps === 'function' && state === null) {
      const componentName = getComponentName(ctor) || 'Component';
      if (!didWarnAboutUninitializedState.has(componentName)) {
        didWarnAboutUninitializedState.add(componentName);
        warningWithoutStack(
          false,
          '`%s` uses `getDerivedStateFromProps` but its initial state is ' +
            '%s. This is not recommended. Instead, define the initial state by ' +
            'assigning an object to `this.state` in the constructor of `%s`. ' +
            'This ensures that `getDerivedStateFromProps` arguments have a consistent shape.',
          componentName,
          instance.state === null ? 'null' : 'undefined',
          componentName,
        );
      }
    }

    // If new component APIs are defined, "unsafe" lifecycles won't be called.
    // Warn about these lifecycles if they are present.
    // Don't warn about react-lifecycles-compat polyfilled methods though.
    if (
      typeof ctor.getDerivedStateFromProps === 'function' ||
      typeof instance.getSnapshotBeforeUpdate === 'function'
    ) {
      let foundWillMountName = null;
      let foundWillReceivePropsName = null;
      let foundWillUpdateName = null;
      if (
        typeof instance.componentWillMount === 'function' &&
        instance.componentWillMount.__suppressDeprecationWarning !== true
      ) {
        foundWillMountName = 'componentWillMount';
      } else if (typeof instance.UNSAFE_componentWillMount === 'function') {
        foundWillMountName = 'UNSAFE_componentWillMount';
      }
      if (
        typeof instance.componentWillReceiveProps === 'function' &&
        instance.componentWillReceiveProps.__suppressDeprecationWarning !== true
      ) {
        foundWillReceivePropsName = 'componentWillReceiveProps';
      } else if (
        typeof instance.UNSAFE_componentWillReceiveProps === 'function'
      ) {
        foundWillReceivePropsName = 'UNSAFE_componentWillReceiveProps';
      }
      if (
        typeof instance.componentWillUpdate === 'function' &&
        instance.componentWillUpdate.__suppressDeprecationWarning !== true
      ) {
        foundWillUpdateName = 'componentWillUpdate';
      } else if (typeof instance.UNSAFE_componentWillUpdate === 'function') {
        foundWillUpdateName = 'UNSAFE_componentWillUpdate';
      }
      if (
        foundWillMountName !== null ||
        foundWillReceivePropsName !== null ||
        foundWillUpdateName !== null
      ) {
        const componentName = getComponentName(ctor) || 'Component';
        const newApiName =
          typeof ctor.getDerivedStateFromProps === 'function'
            ? 'getDerivedStateFromProps()'
            : 'getSnapshotBeforeUpdate()';
        if (!didWarnAboutLegacyLifecyclesAndDerivedState.has(componentName)) {
          didWarnAboutLegacyLifecyclesAndDerivedState.add(componentName);
          warningWithoutStack(
            false,
            'Unsafe legacy lifecycles will not be called for components using new component APIs.\n\n' +
              '%s uses %s but also contains the following legacy lifecycles:%s%s%s\n\n' +
              'The above lifecycles should be removed. Learn more about this warning here:\n' +
              'https://fb.me/react-async-component-lifecycle-hooks',
            componentName,
            newApiName,
            foundWillMountName !== null ? `\n  ${foundWillMountName}` : '',
            foundWillReceivePropsName !== null
              ? `\n  ${foundWillReceivePropsName}`
              : '',
            foundWillUpdateName !== null ? `\n  ${foundWillUpdateName}` : '',
          );
        }
      }
    }
  }

  // Cache unmasked context so we can avoid recreating masked context unless necessary.
  // ReactFiberContext usually updates this cache but can't for newly-created instances.
  // 翻译：缓存未屏蔽的context，因此除非必要，否则我们可以避免重新创建屏蔽的context。
  //      ReactFiberContext通常会更新此缓存，但不能用于新创建的实例。
  if (isLegacyContextConsumer) {
    cacheContext(workInProgress, unmaskedContext, context);
  }

  return instance;
}

function callComponentWillMount(workInProgress, instance) {
  startPhaseTimer(workInProgress, 'componentWillMount');
  const oldState = instance.state;

  if (typeof instance.componentWillMount === 'function') {
    instance.componentWillMount();
  }
  if (typeof instance.UNSAFE_componentWillMount === 'function') {
    instance.UNSAFE_componentWillMount();
  }

  stopPhaseTimer();

  if (oldState !== instance.state) {
    if (__DEV__) {
      warningWithoutStack(
        false,
        '%s.componentWillMount(): Assigning directly to this.state is ' +
          "deprecated (except inside a component's " +
          'constructor). Use setState instead.',
        getComponentName(workInProgress.type) || 'Component',
      );
    }
    classComponentUpdater.enqueueReplaceState(instance, instance.state, null);
  }
}

function callComponentWillReceiveProps(
  workInProgress,
  instance,
  newProps,
  nextContext,
) {
  const oldState = instance.state;
  startPhaseTimer(workInProgress, 'componentWillReceiveProps');
  if (typeof instance.componentWillReceiveProps === 'function') {
    instance.componentWillReceiveProps(newProps, nextContext);
  }
  if (typeof instance.UNSAFE_componentWillReceiveProps === 'function') {
    instance.UNSAFE_componentWillReceiveProps(newProps, nextContext);
  }
  stopPhaseTimer();

  if (instance.state !== oldState) {
    if (__DEV__) {
      const componentName =
        getComponentName(workInProgress.type) || 'Component';
      if (!didWarnAboutStateAssignmentForComponent.has(componentName)) {
        didWarnAboutStateAssignmentForComponent.add(componentName);
        warningWithoutStack(
          false,
          '%s.componentWillReceiveProps(): Assigning directly to ' +
            "this.state is deprecated (except inside a component's " +
            'constructor). Use setState instead.',
          componentName,
        );
      }
    }
    classComponentUpdater.enqueueReplaceState(instance, instance.state, null);
  }
}

// Invokes the mount life-cycles on a previously never rendered instance.
// 翻译：在以前从未渲染过的实例上调用mount生命周期。
/**
 * 挂载类实例。
 * @param workInProgress 当前处理的Fiber对象的进行中副本
 * @param ctor workInProgress的type，使用者写的类组件
 * @param newProps 新的props对象
 * @param renderExpirationTime 当前处理的Fiber所在的FiberRoot的nextExpirationTimeToWorkOn
 */
function mountClassInstance(
  workInProgress: Fiber,
  ctor: any,
  newProps: any,
  renderExpirationTime: ExpirationTime,
): void {
  if (__DEV__) {
    checkClassInstance(workInProgress, ctor, newProps);
  }

  const instance = workInProgress.stateNode;
  // 写入props，state和refs，这也是我们使用的this.props，this.state，this.refs。
  instance.props = newProps;
  instance.state = workInProgress.memoizedState;
  instance.refs = emptyRefsObject;

  // 处理context。
  const contextType = ctor.contextType;
  if (typeof contextType === 'object' && contextType !== null) {
    instance.context = readContext(contextType);
  } else {
    const unmaskedContext = getUnmaskedContext(workInProgress, ctor, true);
    instance.context = getMaskedContext(workInProgress, unmaskedContext);
  }

  if (__DEV__) {
    if (instance.state === newProps) {
      const componentName = getComponentName(ctor) || 'Component';
      if (!didWarnAboutDirectlyAssigningPropsToState.has(componentName)) {
        didWarnAboutDirectlyAssigningPropsToState.add(componentName);
        warningWithoutStack(
          false,
          '%s: It is not recommended to assign props directly to state ' +
            "because updates to props won't be reflected in state. " +
            'In most cases, it is better to use props directly.',
          componentName,
        );
      }
    }

    if (workInProgress.mode & StrictMode) {
      ReactStrictModeWarnings.recordUnsafeLifecycleWarnings(
        workInProgress,
        instance,
      );

      ReactStrictModeWarnings.recordLegacyContextWarning(
        workInProgress,
        instance,
      );
    }

    if (warnAboutDeprecatedLifecycles) {
      ReactStrictModeWarnings.recordDeprecationWarnings(
        workInProgress,
        instance,
      );
    }
  }

  // 处理update。
  let updateQueue = workInProgress.updateQueue;
  if (updateQueue !== null) {
    // 这里会改变workInProgress和updateQueue。
    processUpdateQueue(
      workInProgress,
      updateQueue,
      newProps,
      instance,
      renderExpirationTime,
    );
    instance.state = workInProgress.memoizedState;
  }

  // 这里getDerivedStateFromProps是一个生命周期方法，React16新增。
  const getDerivedStateFromProps = ctor.getDerivedStateFromProps;
  if (typeof getDerivedStateFromProps === 'function') {
    // 如果有这个生命周期方法的定义，就执行它。
    applyDerivedStateFromProps(
      workInProgress,
      ctor,
      getDerivedStateFromProps,
      newProps,
    );
    // 重新把结果写入。
    instance.state = workInProgress.memoizedState;
  }

  // In order to support react-lifecycles-compat polyfilled components,
  // Unsafe lifecycles should not be invoked for components using the new APIs.
  // 翻译：为了支持与react生命周期兼容的polyfilled组件，不安全的生命周期不应该使用新的API进行调用。
  if (
    typeof ctor.getDerivedStateFromProps !== 'function' &&
    typeof instance.getSnapshotBeforeUpdate !== 'function' &&
    (typeof instance.UNSAFE_componentWillMount === 'function' ||
      typeof instance.componentWillMount === 'function')
  ) {
    // 执行componentWillMount生命周期方法
    callComponentWillMount(workInProgress, instance);
    // If we had additional state updates during this life-cycle, let's
    // process them now.
    // 翻译：如果在此生命周期中还有其他状态更新，请立即进行处理。
    updateQueue = workInProgress.updateQueue;
    if (updateQueue !== null) {
      processUpdateQueue(
        workInProgress,
        updateQueue,
        newProps,
        instance,
        renderExpirationTime,
      );
      instance.state = workInProgress.memoizedState;
    }
  }

  if (typeof instance.componentDidMount === 'function') {
    workInProgress.effectTag |= Update;
  }
}

/**
 * 恢复被中断的组件。有instance，无current。
 * @param workInProgress 当前处理的Fiber对象的进行中副本
 * @param ctor workInProgress的type，使用者写的类组件
 * @param newProps 新的props对象
 * @param renderExpirationTime 当前处理的Fiber所在的FiberRoot的nextExpirationTimeToWorkOn
 * @return {boolean|*}
 */
function resumeMountClassInstance(
  workInProgress: Fiber,
  ctor: any,
  newProps: any,
  renderExpirationTime: ExpirationTime,
): boolean {
  // 组件类实例。
  const instance = workInProgress.stateNode;

  // 写入props。
  const oldProps = workInProgress.memoizedProps;
  instance.props = oldProps;

  // 处理context相关。
  const oldContext = instance.context;
  const contextType = ctor.contextType;
  let nextContext;
  if (typeof contextType === 'object' && contextType !== null) {
    nextContext = readContext(contextType);
  } else {
    const nextLegacyUnmaskedContext = getUnmaskedContext(
      workInProgress,
      ctor,
      true,
    );
    nextContext = getMaskedContext(workInProgress, nextLegacyUnmaskedContext);
  }

  // getDerivedStateFromProps生命周期是类函数，需要从类里取得。
  const getDerivedStateFromProps = ctor.getDerivedStateFromProps;
  // 判断是否使用了新的生命周期方法。
  const hasNewLifecycles =
    typeof getDerivedStateFromProps === 'function' ||
    typeof instance.getSnapshotBeforeUpdate === 'function';

  // Note: During these life-cycles, instance.props/instance.state are what
  // ever the previously attempted to render - not the "current". However,
  // during componentDidUpdate we pass the "current" props.
  // 翻译：注意：在这个生命周期期间，instance.props和instance.state是以前试图渲染的内容，而不是"current"。
  //      但是，在componentDidUpdate中我们传递了"current"的props。

  // In order to support react-lifecycles-compat polyfilled components,
  // Unsafe lifecycles should not be invoked for components using the new APIs.
  // 翻译：为了支持与react生命周期兼容的polyfilled组件，不安全的生命周期不应该使用新的API进行调用。
  if (
    !hasNewLifecycles &&
    (typeof instance.UNSAFE_componentWillReceiveProps === 'function' ||
      typeof instance.componentWillReceiveProps === 'function')
  ) {
    // 没用使用新的生命周期方法才会运行这里。
    if (oldProps !== newProps || oldContext !== nextContext) {
      // 一个废弃的生命周期方法。
      callComponentWillReceiveProps(
        workInProgress,
        instance,
        newProps,
        nextContext,
      );
    }
  }

  // 重置hasForceUpdate为false，为了下面执行update做准备。
  resetHasForceUpdateBeforeProcessing();

  // 处理update。
  const oldState = workInProgress.memoizedState;
  let newState = (instance.state = oldState);
  let updateQueue = workInProgress.updateQueue;
  if (updateQueue !== null) {
    // 这里会改变workInProgress和updateQueue，以及hasForceUpdate。
    processUpdateQueue(
      workInProgress,
      updateQueue,
      newProps,
      instance,
      renderExpirationTime,
    );
    newState = workInProgress.memoizedState;
  }
  if (
    // 新旧props相同
    oldProps === newProps &&
    // 新旧state相同
    oldState === newState &&
    // 没有context更改
    !hasContextChanged() &&
    // 没有forceUpdate为true
    !checkHasForceUpdateAfterProcessing()
  ) {
    // 这种情况就是不需要更新。
    // If an update was already in progress, we should schedule an Update
    // effect even though we're bailing out, so that cWU/cDU are called.
    // 翻译：如果更新已经在进行中，即使我们正在等待更新，也应该安排更新效果，以便调用cWU / cDU。
    // 这里是没有current的情况，所以也是第一次更新，需要触发componentDidMount生命周期方法。
    if (typeof instance.componentDidMount === 'function') {
      workInProgress.effectTag |= Update;
    }
    return false;
  }

  // 处理getDerivedStateFromProps生命周期。
  if (typeof getDerivedStateFromProps === 'function') {
    applyDerivedStateFromProps(
      workInProgress,
      ctor,
      getDerivedStateFromProps,
      newProps,
    );
    newState = workInProgress.memoizedState;
  }

  // forceUpdate为true，或者shouldComponentUpdate返回true，就标记为需要更新。
  const shouldUpdate =
    checkHasForceUpdateAfterProcessing() ||
    checkShouldComponentUpdate(
      workInProgress,
      ctor,
      oldProps,
      newProps,
      oldState,
      newState,
      nextContext,
    );

  if (shouldUpdate) {
    // In order to support react-lifecycles-compat polyfilled components,
    // Unsafe lifecycles should not be invoked for components using the new APIs.
    // 翻译：为了支持与react生命周期兼容的polyfilled组件，不安全的生命周期不应该使用新的API进行调用。
    if (
      !hasNewLifecycles &&
      (typeof instance.UNSAFE_componentWillMount === 'function' ||
        typeof instance.componentWillMount === 'function')
    ) {
      startPhaseTimer(workInProgress, 'componentWillMount');
      if (typeof instance.componentWillMount === 'function') {
        instance.componentWillMount();
      }
      if (typeof instance.UNSAFE_componentWillMount === 'function') {
        instance.UNSAFE_componentWillMount();
      }
      stopPhaseTimer();
    }
    if (typeof instance.componentDidMount === 'function') {
      workInProgress.effectTag |= Update;
    }
  } else {
    // If an update was already in progress, we should schedule an Update
    // effect even though we're bailing out, so that cWU/cDU are called.
    // 翻译：如果更新已经在进行中，即使我们正在等待更新，也应该安排更新效果，以便调用cWU / cDU。
    if (typeof instance.componentDidMount === 'function') {
      workInProgress.effectTag |= Update;
    }

    // If shouldComponentUpdate returned false, we should still update the
    // memoized state to indicate that this work can be reused.
    // 翻译：如果shouldComponentUpdate返回false，则我们仍应更新已记忆的状态以指示可以重复使用此工作。

    workInProgress.memoizedProps = newProps;
    workInProgress.memoizedState = newState;
  }

  // Update the existing instance's state, props, and context pointers even
  // if shouldComponentUpdate returns false.
  // 翻译：即使shouldComponentUpdate返回false，也要更新现有实例的状态，属性和上下文指针。
  instance.props = newProps;
  instance.state = newState;
  instance.context = nextContext;

  return shouldUpdate;
}

// Invokes the update life-cycles and returns false if it shouldn't rerender.
// 翻译：调用更新生命周期，如果不应该重新渲染，则返回false。
/**
 * 二次更新的组件。有instance，有current。
 * @param current 当前处理的Fiber对象（旧）
 * @param workInProgress 当前处理的Fiber对象的进行中副本
 * @param ctor workInProgress的type，使用者写的类组件
 * @param newProps 新的props对象
 * @param renderExpirationTime 当前处理的Fiber所在的FiberRoot的nextExpirationTimeToWorkOn
 * @return {boolean}
 */
function updateClassInstance(
  current: Fiber,
  workInProgress: Fiber,
  ctor: any,
  newProps: any,
  renderExpirationTime: ExpirationTime,
): boolean {
  // 组件类实例。
  const instance = workInProgress.stateNode;

  // 写入props。
  const oldProps = workInProgress.memoizedProps;
  instance.props = oldProps;

  // 处理context相关。
  const oldContext = instance.context;
  const contextType = ctor.contextType;
  let nextContext;
  if (typeof contextType === 'object' && contextType !== null) {
    nextContext = readContext(contextType);
  } else {
    const nextUnmaskedContext = getUnmaskedContext(workInProgress, ctor, true);
    nextContext = getMaskedContext(workInProgress, nextUnmaskedContext);
  }

  // getDerivedStateFromProps生命周期是类函数，需要从类里取得。
  const getDerivedStateFromProps = ctor.getDerivedStateFromProps;
  // 判断是否使用了新的生命周期方法。
  const hasNewLifecycles =
    typeof getDerivedStateFromProps === 'function' ||
    typeof instance.getSnapshotBeforeUpdate === 'function';

  // Note: During these life-cycles, instance.props/instance.state are what
  // ever the previously attempted to render - not the "current". However,
  // during componentDidUpdate we pass the "current" props.
  // 翻译：注意：在这个生命周期期间，instance.props和instance.state是以前试图渲染的内容，而不是"current"。
  //      但是，在componentDidUpdate中我们传递了"current"的props。

  // In order to support react-lifecycles-compat polyfilled components,
  // Unsafe lifecycles should not be invoked for components using the new APIs.
  // 翻译：为了支持与react生命周期兼容的polyfilled组件，不安全的生命周期不应该使用新的API进行调用。
  if (
    !hasNewLifecycles &&
    (typeof instance.UNSAFE_componentWillReceiveProps === 'function' ||
      typeof instance.componentWillReceiveProps === 'function')
  ) {
    // 没用使用新的生命周期方法才会运行这里。
    if (oldProps !== newProps || oldContext !== nextContext) {
      // 一个废弃的生命周期方法。
      callComponentWillReceiveProps(
        workInProgress,
        instance,
        newProps,
        nextContext,
      );
    }
  }

  // 重置hasForceUpdate为false，为了下面执行update做准备。
  resetHasForceUpdateBeforeProcessing();

  // 处理update。
  const oldState = workInProgress.memoizedState;
  let newState = (instance.state = oldState);
  let updateQueue = workInProgress.updateQueue;
  if (updateQueue !== null) {
    // 这里会改变workInProgress和updateQueue，以及hasForceUpdate。
    processUpdateQueue(
      workInProgress,
      updateQueue,
      newProps,
      instance,
      renderExpirationTime,
    );
    newState = workInProgress.memoizedState;
  }

  if (
    // 新旧props相同
    oldProps === newProps &&
    // 新旧state相同
    oldState === newState &&
    // 没有context更改
    !hasContextChanged() &&
    // 没有forceUpdate为true
    !checkHasForceUpdateAfterProcessing()
  ) {
    // 这种情况就是不需要更新。
    // If an update was already in progress, we should schedule an Update
    // effect even though we're bailing out, so that cWU/cDU are called.
    // 翻译：如果更新已经在进行中，即使我们正在等待更新，也应该安排更新效果，以便调用cWU / cDU。
    // 这里会标记componentDidUpdate生命周期。
    if (typeof instance.componentDidUpdate === 'function') {
      if (
        oldProps !== current.memoizedProps ||
        oldState !== current.memoizedState
      ) {
        workInProgress.effectTag |= Update;
      }
    }
    // 这里会标记getSnapshotBeforeUpdate生命周期。
    if (typeof instance.getSnapshotBeforeUpdate === 'function') {
      if (
        oldProps !== current.memoizedProps ||
        oldState !== current.memoizedState
      ) {
        workInProgress.effectTag |= Snapshot;
      }
    }
    return false;
  }

  // 处理getDerivedStateFromProps生命周期。
  if (typeof getDerivedStateFromProps === 'function') {
    applyDerivedStateFromProps(
      workInProgress,
      ctor,
      getDerivedStateFromProps,
      newProps,
    );
    newState = workInProgress.memoizedState;
  }

  // forceUpdate为true，或者shouldComponentUpdate为true，就标记为需要更新。
  const shouldUpdate =
    checkHasForceUpdateAfterProcessing() ||
    checkShouldComponentUpdate(
      workInProgress,
      ctor,
      oldProps,
      newProps,
      oldState,
      newState,
      nextContext,
    );

  if (shouldUpdate) {
    // In order to support react-lifecycles-compat polyfilled components,
    // Unsafe lifecycles should not be invoked for components using the new APIs.
    // 翻译：为了支持与react生命周期兼容的polyfilled组件，不安全的生命周期不应该使用新的API进行调用。
    if (
      !hasNewLifecycles &&
      (typeof instance.UNSAFE_componentWillUpdate === 'function' ||
        typeof instance.componentWillUpdate === 'function')
    ) {
      startPhaseTimer(workInProgress, 'componentWillUpdate');
      if (typeof instance.componentWillUpdate === 'function') {
        instance.componentWillUpdate(newProps, newState, nextContext);
      }
      if (typeof instance.UNSAFE_componentWillUpdate === 'function') {
        instance.UNSAFE_componentWillUpdate(newProps, newState, nextContext);
      }
      stopPhaseTimer();
    }
    if (typeof instance.componentDidUpdate === 'function') {
      workInProgress.effectTag |= Update;
    }
    if (typeof instance.getSnapshotBeforeUpdate === 'function') {
      workInProgress.effectTag |= Snapshot;
    }
  } else {
    // If an update was already in progress, we should schedule an Update
    // effect even though we're bailing out, so that cWU/cDU are called.
    // 翻译：如果更新已经在进行中，即使我们正在等待更新，也应该安排更新效果，以便调用cWU / cDU。
    if (typeof instance.componentDidUpdate === 'function') {
      if (
        oldProps !== current.memoizedProps ||
        oldState !== current.memoizedState
      ) {
        workInProgress.effectTag |= Update;
      }
    }
    if (typeof instance.getSnapshotBeforeUpdate === 'function') {
      if (
        oldProps !== current.memoizedProps ||
        oldState !== current.memoizedState
      ) {
        workInProgress.effectTag |= Snapshot;
      }
    }

    // If shouldComponentUpdate returned false, we should still update the
    // memoized props/state to indicate that this work can be reused.
    // 翻译：如果shouldComponentUpdate返回false，则我们仍应更新已记忆的状态以指示可以重复使用此工作。
    workInProgress.memoizedProps = newProps;
    workInProgress.memoizedState = newState;
  }

  // Update the existing instance's state, props, and context pointers even
  // if shouldComponentUpdate returns false.
  // 翻译：即使shouldComponentUpdate返回false，也要更新现有实例的状态，属性和上下文指针。
  instance.props = newProps;
  instance.state = newState;
  instance.context = nextContext;

  return shouldUpdate;
}

export {
  adoptClassInstance,
  constructClassInstance,
  mountClassInstance,
  resumeMountClassInstance,
  updateClassInstance,
};
