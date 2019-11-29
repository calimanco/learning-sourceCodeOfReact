/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import invariant from 'shared/invariant';
import warning from 'shared/warning';
import {
  getIteratorFn,
  REACT_ELEMENT_TYPE,
  REACT_PORTAL_TYPE,
} from 'shared/ReactSymbols';

import {isValidElement, cloneAndReplaceKey} from './ReactElement';
import ReactDebugCurrentFrame from './ReactDebugCurrentFrame';

// 分隔符号。
const SEPARATOR = '.';
// 次级分隔符号。
const SUBSEPARATOR = ':';

/**
 * Escape and wrap key so it is safe to use as a reactid
 * 翻译：转义和换行键，因此可以安全地用作React的id。
 *
 * @param {string} key to be escaped.
 * @return {string} the escaped key.
 */
function escape(key) {
  const escapeRegex = /[=:]/g;
  const escaperLookup = {
    '=': '=0',
    ':': '=2',
  };
  const escapedString = ('' + key).replace(escapeRegex, function(match) {
    return escaperLookup[match];
  });

  return '$' + escapedString;
}

/**
 * TODO: Test that a single child and an array with one item have the same key
 * pattern.
 */

let didWarnAboutMaps = false;

const userProvidedKeyEscapeRegex = /\/+/g;
function escapeUserProvidedKey(text) {
  return ('' + text).replace(userProvidedKeyEscapeRegex, '$&/');
}

// 对象池最大限制。
const POOL_SIZE = 10;
// context对象池。
const traverseContextPool = [];
// 从对象池里获取对象的方法。
// 因为递归遍历会照成对象创建过度频繁的问题，这个设计是为了减少对象创建，提高性能。
function getPooledTraverseContext(
  mapResult,
  keyPrefix,
  mapFunction,
  mapContext,
) {
  if (traverseContextPool.length) {
    // 如果对象池里有东西，就pop一个出来，并设置传入的参数，返回。
    const traverseContext = traverseContextPool.pop();
    // 遍历的结果。
    traverseContext.result = mapResult;
    // key标记前缀。
    traverseContext.keyPrefix = keyPrefix;
    // 使用者传入的那个处理函数。
    traverseContext.func = mapFunction;
    // 上下文
    traverseContext.context = mapContext;
    // 计数器
    traverseContext.count = 0;
    return traverseContext;
  } else {
    // 如果对象池里没东西，新建一个对象返回。
    return {
      result: mapResult,
      keyPrefix: keyPrefix,
      func: mapFunction,
      context: mapContext,
      count: 0,
    };
  }
}

// 清空遍历的context对象，并push回traverseContextPool
function releaseTraverseContext(traverseContext) {
  traverseContext.result = null;
  traverseContext.keyPrefix = null;
  traverseContext.func = null;
  traverseContext.context = null;
  traverseContext.count = 0;
  if (traverseContextPool.length < POOL_SIZE) {
    traverseContextPool.push(traverseContext);
  }
}

/**
 * 遍历方法，主要用来递归和记数。
 * 核心在callback，从mapChildren过来的是mapSingleChildIntoContext；
 * 从forEachChildren过来的是forEachSingleChild。
 * @param {?*} children Children tree container.
 * 翻译：children树容器。
 * @param {!string} nameSoFar Name of the key path so far.
 * 翻译：到目前为止的密钥路径名称。
 * @param {!function} callback Callback to invoke with each child found.
 * 翻译：每个child都会调用的回调函数。
 * @param {?*} traverseContext Used to pass information throughout the traversal
 * process.
 * 翻译：用于在遍历过程中传递信息。
 * @return {!number} The number of children in this subtree.
 * 翻译：此子树中的children数。
 */
function traverseAllChildrenImpl(
  children,
  nameSoFar,
  callback,
  traverseContext,
) {
  const type = typeof children;

  if (type === 'undefined' || type === 'boolean') {
    // All of the above are perceived as null.
    // 翻译：以上所有内容均视为null。
    // 判断类型不对就把children置空。
    children = null;
  }

  // 是否触发回调函数。
  let invokeCallback = false;

  if (children === null) {
    // 如果为空就触发回调函数。
    invokeCallback = true;
  } else {
    // 特定类型才会触发回调函数。
    switch (type) {
      case 'string':
      case 'number':
        invokeCallback = true;
        break;
      case 'object':
        switch (children.$$typeof) {
          case REACT_ELEMENT_TYPE:
          case REACT_PORTAL_TYPE:
            invokeCallback = true;
        }
    }
  }

  // 如果前面是否回调的判断为真，就会调用回调，并返回1。
  // 这里也是递归调用的终点条件，遇到能被React正常渲染的类型就停止。
  if (invokeCallback) {
    callback(
      traverseContext,
      children,
      // If it's the only child, treat the name as if it was wrapped in an array
      // so that it's consistent if the number of children grows.
      // 如果它是唯一的child，将名称当作包裹在数组中一样对待，以便children数增加时保持一致。
      nameSoFar === '' ? SEPARATOR + getComponentKey(children, 0) : nameSoFar,
    );
    return 1;
  }

  let child;
  let nextName;
  let subtreeCount = 0; // Count of children found in the current subtree.
  // 翻译：当前子树中找到的children数。
  const nextNamePrefix =
    nameSoFar === '' ? SEPARATOR : nameSoFar + SUBSEPARATOR;

  if (Array.isArray(children)) {
    // 如果判断children是数组，则拼接新的nextName，并递归调用本身。
    // subtreeCount是个计数器，前面返回判断要回调就会返回1，这样就可以累加，
    for (let i = 0; i < children.length; i++) {
      child = children[i];
      nextName = nextNamePrefix + getComponentKey(child, i);
      subtreeCount += traverseAllChildrenImpl(
        child,
        nextName,
        callback,
        traverseContext,
      );
    }
  } else {
    // 下面这些都属于异常情况的处理。
    // 获取children里的遍历器。
    // 这里其实是处理传入的是Maps对象的情况，开发模式会警告，但还是会遍历执行。
    const iteratorFn = getIteratorFn(children);
    if (typeof iteratorFn === 'function') {
      if (__DEV__) {
        // Warn about using Maps as children
        // 翻译：警告将Maps对象作为children使用
        if (iteratorFn === children.entries) {
          warning(
            didWarnAboutMaps,
            'Using Maps as children is unsupported and will likely yield ' +
              'unexpected results. Convert it to a sequence/iterable of keyed ' +
              'ReactElements instead.',
          );
          didWarnAboutMaps = true;
        }
      }

      const iterator = iteratorFn.call(children);
      let step;
      let ii = 0;
      while (!(step = iterator.next()).done) {
        child = step.value;
        nextName = nextNamePrefix + getComponentKey(child, ii++);
        subtreeCount += traverseAllChildrenImpl(
          child,
          nextName,
          callback,
          traverseContext,
        );
      }
    } else if (type === 'object') {
      // 如果是个React可以渲染的child就会警告提示。
      let addendum = '';
      if (__DEV__) {
        addendum =
          ' If you meant to render a collection of children, use an array ' +
          'instead.' +
          ReactDebugCurrentFrame.getStackAddendum();
      }
      const childrenString = '' + children;
      invariant(
        false,
        'Objects are not valid as a React child (found: %s).%s',
        childrenString === '[object Object]'
          ? 'object with keys {' + Object.keys(children).join(', ') + '}'
          : childrenString,
        addendum,
      );
    }
  }

  return subtreeCount;
}

/**
 * Traverses children that are typically specified as `props.children`, but
 * might also be specified through attributes:
 * 翻译：遍历children（通常指`props.children`）,但也可以通过属性指定：
 *
 * - `traverseAllChildren(this.props.children, ...)`
 * - `traverseAllChildren(this.props.leftPanelChildren, ...)`
 *
 * The `traverseContext` is an optional argument that is passed through the
 * entire traversal. It can be used to store accumulations or anything else that
 * the callback might find relevant.
 * 翻译：'traverseContext'是一个可选参数，它在整个遍历中传递。
 *     它可以用来存储累积或其他可能与回调相关的内容。
 *
 * @param {?*} children Children tree object.
 * 翻译：children树对象。
 * @param {!function} callback To invoke upon traversing each child.
 * 翻译：在遍历每个children时调用。
 * 注意这个不是使用者传入的那个，这些回调都是内部定义的。
 * @param {?*} traverseContext Context for traversal.
 * 翻译：遍历的上下文。
 * @return {!number} The number of children in this subtree.
 * 翻译：此子树中的children数。
 */
function traverseAllChildren(children, callback, traverseContext) {
  if (children == null) {
    return 0;
  }

  // 直接调用了下一个方法
  return traverseAllChildrenImpl(children, '', callback, traverseContext);
}

/**
 * Generate a key string that identifies a component within a set.
 * 翻译：生成用于标识集合中组件的键字符串。
 *
 * @param {*} component A component that could contain a manual key.
 * 翻译：可能包含手动提供key的组件。
 * @param {number} index Index that is used if a manual key is not provided.
 * 翻译：如果没有手动提供key，则使用的索引。
 * @return {string}
 */
function getComponentKey(component, index) {
  // Do some typechecking here since we call this blindly. We want to ensure
  // that we don't block potential future ES APIs.
  // 翻译：因为我们盲目地调用它，所以在这里做一些类型检查。
  //      我们想要确保我们不会阻止潜在的未来ES API。
  if (
    typeof component === 'object' &&
    component !== null &&
    component.key != null
  ) {
    // Explicit key
    // 翻译：显式key。
    return escape(component.key);
  }
  // Implicit key determined by the index in the set
  // 翻译：隐式key由集合中的索引确定。
  // 会将index的数字转为36进制，暂不知道为啥。
  return index.toString(36);
}

function forEachSingleChild(bookKeeping, child, name) {
  const {func, context} = bookKeeping;
  func.call(context, child, bookKeeping.count++);
}

/**
 * Iterates through children that are typically specified as `props.children`.
 *
 * See https://reactjs.org/docs/react-api.html#reactchildrenforeach
 *
 * The provided forEachFunc(child, index) will be called for each
 * leaf child.
 *
 * @param {?*} children Children tree container.
 * @param {function(*, int)} forEachFunc
 * @param {*} forEachContext Context for forEachContext.
 */
function forEachChildren(children, forEachFunc, forEachContext) {
  if (children == null) {
    return children;
  }
  const traverseContext = getPooledTraverseContext(
    null,
    null,
    forEachFunc,
    forEachContext,
  );
  traverseAllChildren(children, forEachSingleChild, traverseContext);
  releaseTraverseContext(traverseContext);
}

// 这个是map的核心方法，当遍历到React可渲染对象才会传入
// bookKeeping：循环的context，来自对象池。
// child：React可渲染对象。
// childKey：对象的key。
function mapSingleChildIntoContext(bookKeeping, child, childKey) {
  const {result, keyPrefix, func, context} = bookKeeping;

  // func就是使用者定义的函数，用传入的上下文绑起，第一个参数是c，第二个是计数。
  let mappedChild = func.call(context, child, bookKeeping.count++);
  if (Array.isArray(mappedChild)) {
    // 如果判断结果是数组，则递归调用，这里其实是最外层的大递归，这里可以看出对象池会随嵌套层数增加而增加。。
    mapIntoWithKeyPrefixInternal(mappedChild, result, childKey, c => c);
  } else if (mappedChild != null) {
    // 判断非null，且是React元素，就更新key，返回一个新的React元素，保存进结果。
    if (isValidElement(mappedChild)) {
      mappedChild = cloneAndReplaceKey(
        mappedChild,
        // Keep both the (mapped) and old keys if they differ, just as
        // traverseAllChildren used to do for objects as children
        // 翻译：如果映射的key和旧的key不同，两者都保留，
        //      就像traverseAllChildren把对象当成children处理一样。
        keyPrefix +
          (mappedChild.key && (!child || child.key !== mappedChild.key)
            ? escapeUserProvidedKey(mappedChild.key) + '/'
            : '') +
          childKey,
      );
    }
    result.push(mappedChild);
  }
}

// children: children树；
// array：用来保存结果的数组；
// prefix：key前缀；
// func：映射用的函数，就是我们调用map传入的那个；
// context：上下文对象，一般是this对象。
function mapIntoWithKeyPrefixInternal(children, array, prefix, func, context) {
  // 设置key前缀。
  let escapedPrefix = '';
  if (prefix != null) {
    escapedPrefix = escapeUserProvidedKey(prefix) + '/';
  }
  // 从对象池里取出一个遍历context对象，注意这个context跟传入的context不一样。
  const traverseContext = getPooledTraverseContext(
    array,
    escapedPrefix,
    func,
    context,
  );
  // 遍历所有children，核心方法其实是mapSingleChildIntoContext。
  traverseAllChildren(children, mapSingleChildIntoContext, traverseContext);
  // 释放遍历context对象。
  releaseTraverseContext(traverseContext);
}

/**
 * Maps children that are typically specified as `props.children`.
 * 翻译：映射children（通常指`props.children`）
 *
 * See https://reactjs.org/docs/react-api.html#reactchildrenmap
 *
 * The provided mapFunction(child, key, index) will be called for each
 * leaf child.
 * 翻译：提供的mapFunction（child，key，index）将会给每个叶子子代调用。
 *
 * @param {?*} children Children tree container.
 * 翻译：children树容器。
 * 就是要遍历的children列表。
 * @param {function(*, int)} func The map function.
 * 翻译：映射用的函数。
 * @param {*} context Context for mapFunction.
 * 翻译：mapFunction的上下文，一般就是this对象。
 * @return {object} Object containing the ordered map of results.
 * 翻译：包含结果的有序映射。
 */
function mapChildren(children, func, context) {
  // 如果children为null或undefined，就会直接返回。
  if (children == null) {
    return children;
  }
  const result = [];
  // 入口方法
  mapIntoWithKeyPrefixInternal(children, result, null, func, context);
  return result;
}

/**
 * Count the number of children that are typically specified as
 * `props.children`.
 *
 * See https://reactjs.org/docs/react-api.html#reactchildrencount
 *
 * @param {?*} children Children tree container.
 * @return {number} The number of children.
 */
function countChildren(children) {
  return traverseAllChildren(children, () => null, null);
}

/**
 * Flatten a children object (typically specified as `props.children`) and
 * return an array with appropriately re-keyed children.
 *
 * See https://reactjs.org/docs/react-api.html#reactchildrentoarray
 */
function toArray(children) {
  const result = [];
  mapIntoWithKeyPrefixInternal(children, result, null, child => child);
  return result;
}

/**
 * Returns the first child in a collection of children and verifies that there
 * is only one child in the collection.
 *
 * See https://reactjs.org/docs/react-api.html#reactchildrenonly
 *
 * The current implementation of this function assumes that a single child gets
 * passed without a wrapper, but the purpose of this helper function is to
 * abstract away the particular structure of children.
 *
 * @param {?object} children Child collection structure.
 * @return {ReactElement} The first and only `ReactElement` contained in the
 * structure.
 */
function onlyChild(children) {
  invariant(
    isValidElement(children),
    'React.Children.only expected to receive a single React element child.',
  );
  return children;
}

export {
  forEachChildren as forEach,
  mapChildren as map,
  countChildren as count,
  onlyChild as only,
  toArray,
};
