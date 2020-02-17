/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {ReactElement} from 'shared/ReactElementType';
import type {ReactPortal} from 'shared/ReactTypes';
import type {Fiber} from 'react-reconciler/src/ReactFiber';
import type {ExpirationTime} from 'react-reconciler/src/ReactFiberExpirationTime';

import getComponentName from 'shared/getComponentName';
import {Placement, Deletion} from 'shared/ReactSideEffectTags';
import {
  getIteratorFn,
  REACT_ELEMENT_TYPE,
  REACT_FRAGMENT_TYPE,
  REACT_PORTAL_TYPE,
} from 'shared/ReactSymbols';
import {
  FunctionComponent,
  ClassComponent,
  HostText,
  HostPortal,
  Fragment,
} from 'shared/ReactWorkTags';
import invariant from 'shared/invariant';
import warning from 'shared/warning';
import warningWithoutStack from 'shared/warningWithoutStack';

import {
  createWorkInProgress,
  createFiberFromElement,
  createFiberFromFragment,
  createFiberFromText,
  createFiberFromPortal,
} from './ReactFiber';
import {emptyRefsObject} from './ReactFiberClassComponent';
import {
  getCurrentFiberStackInDev,
  getStackByFiberInDevAndProd,
} from './ReactCurrentFiber';
import {StrictMode} from './ReactTypeOfMode';

let didWarnAboutMaps;
let didWarnAboutGenerators;
let didWarnAboutStringRefInStrictMode;
let ownerHasKeyUseWarning;
let ownerHasFunctionTypeWarning;
let warnForMissingKey = (child: mixed) => {};

if (__DEV__) {
  didWarnAboutMaps = false;
  didWarnAboutGenerators = false;
  didWarnAboutStringRefInStrictMode = {};

  /**
   * Warn if there's no key explicitly set on dynamic arrays of children or
   * object keys are not valid. This allows us to keep track of children between
   * updates.
   */
  ownerHasKeyUseWarning = {};
  ownerHasFunctionTypeWarning = {};

  warnForMissingKey = (child: mixed) => {
    if (child === null || typeof child !== 'object') {
      return;
    }
    if (!child._store || child._store.validated || child.key != null) {
      return;
    }
    invariant(
      typeof child._store === 'object',
      'React Component in warnForMissingKey should have a _store. ' +
        'This error is likely caused by a bug in React. Please file an issue.',
    );
    child._store.validated = true;

    const currentComponentErrorInfo =
      'Each child in an array or iterator should have a unique ' +
      '"key" prop. See https://fb.me/react-warning-keys for ' +
      'more information.' +
      getCurrentFiberStackInDev();
    if (ownerHasKeyUseWarning[currentComponentErrorInfo]) {
      return;
    }
    ownerHasKeyUseWarning[currentComponentErrorInfo] = true;

    warning(
      false,
      'Each child in an array or iterator should have a unique ' +
        '"key" prop. See https://fb.me/react-warning-keys for ' +
        'more information.',
    );
  };
}

const isArray = Array.isArray;

function coerceRef(
  returnFiber: Fiber,
  current: Fiber | null,
  element: ReactElement,
) {
  let mixedRef = element.ref;
  if (
    mixedRef !== null &&
    typeof mixedRef !== 'function' &&
    typeof mixedRef !== 'object'
  ) {
    if (__DEV__) {
      if (returnFiber.mode & StrictMode) {
        const componentName = getComponentName(returnFiber.type) || 'Component';
        if (!didWarnAboutStringRefInStrictMode[componentName]) {
          warningWithoutStack(
            false,
            'A string ref, "%s", has been found within a strict mode tree. ' +
              'String refs are a source of potential bugs and should be avoided. ' +
              'We recommend using createRef() instead.' +
              '\n%s' +
              '\n\nLearn more about using refs safely here:' +
              '\nhttps://fb.me/react-strict-mode-string-ref',
            mixedRef,
            getStackByFiberInDevAndProd(returnFiber),
          );
          didWarnAboutStringRefInStrictMode[componentName] = true;
        }
      }
    }

    if (element._owner) {
      const owner: ?Fiber = (element._owner: any);
      let inst;
      if (owner) {
        const ownerFiber = ((owner: any): Fiber);
        invariant(
          ownerFiber.tag === ClassComponent,
          'Function components cannot have refs.',
        );
        inst = ownerFiber.stateNode;
      }
      invariant(
        inst,
        'Missing owner for string ref %s. This error is likely caused by a ' +
          'bug in React. Please file an issue.',
        mixedRef,
      );
      const stringRef = '' + mixedRef;
      // Check if previous string ref matches new string ref
      if (
        current !== null &&
        current.ref !== null &&
        typeof current.ref === 'function' &&
        current.ref._stringRef === stringRef
      ) {
        return current.ref;
      }
      const ref = function(value) {
        let refs = inst.refs;
        if (refs === emptyRefsObject) {
          // This is a lazy pooled frozen object, so we need to initialize.
          refs = inst.refs = {};
        }
        if (value === null) {
          delete refs[stringRef];
        } else {
          refs[stringRef] = value;
        }
      };
      ref._stringRef = stringRef;
      return ref;
    } else {
      invariant(
        typeof mixedRef === 'string',
        'Expected ref to be a function, a string, an object returned by React.createRef(), or null.',
      );
      invariant(
        element._owner,
        'Element ref was specified as a string (%s) but no owner was set. This could happen for one of' +
          ' the following reasons:\n' +
          '1. You may be adding a ref to a function component\n' +
          "2. You may be adding a ref to a component that was not created inside a component's render method\n" +
          '3. You have multiple copies of React loaded\n' +
          'See https://fb.me/react-refs-must-have-owner for more information.',
        mixedRef,
      );
    }
  }
  return mixedRef;
}

function throwOnInvalidObjectType(returnFiber: Fiber, newChild: Object) {
  if (returnFiber.type !== 'textarea') {
    let addendum = '';
    if (__DEV__) {
      addendum =
        ' If you meant to render a collection of children, use an array ' +
        'instead.' +
        getCurrentFiberStackInDev();
    }
    invariant(
      false,
      'Objects are not valid as a React child (found: %s).%s',
      Object.prototype.toString.call(newChild) === '[object Object]'
        ? 'object with keys {' + Object.keys(newChild).join(', ') + '}'
        : newChild,
      addendum,
    );
  }
}

function warnOnFunctionType() {
  const currentComponentErrorInfo =
    'Functions are not valid as a React child. This may happen if ' +
    'you return a Component instead of <Component /> from render. ' +
    'Or maybe you meant to call this function rather than return it.' +
    getCurrentFiberStackInDev();

  if (ownerHasFunctionTypeWarning[currentComponentErrorInfo]) {
    return;
  }
  ownerHasFunctionTypeWarning[currentComponentErrorInfo] = true;

  warning(
    false,
    'Functions are not valid as a React child. This may happen if ' +
      'you return a Component instead of <Component /> from render. ' +
      'Or maybe you meant to call this function rather than return it.',
  );
}

// This wrapper function exists because I expect to clone the code in each path
// to be able to optimize each path individually by branching early. This needs
// a compiler or we can do it manually. Helpers that don't need this branching
// live outside of this function.
// 翻译：存在该包装函数是因为我希望克隆每个路径中的代码，以便能够通过尽早分支化来分别优化每个路径。
//      这需要编译器，或者我们可以手动完成。不需要此分支的辅助函数位于此函数之外。
/**
 * 子节点调和器的包装函数。
 * @param shouldTrackSideEffects 是否应该跟踪副作用
 * @return {reconcileChildFibers}
 * @constructor
 */
function ChildReconciler(shouldTrackSideEffects) {
  /**
   * 删除子节点。其实是将要删除的Fiber节点加入父级的副作用列表。
   * @param returnFiber 父级Fiber节点
   * @param childToDelete 要删除的Fiber节点
   */
  function deleteChild(returnFiber: Fiber, childToDelete: Fiber): void {
    if (!shouldTrackSideEffects) {
      // Noop.
      return;
    }
    // Deletions are added in reversed order so we add it to the front.
    // At this point, the return fiber's effect list is empty except for
    // deletions, so we can just append the deletion to the list. The remaining
    // effects aren't added until the complete phase. Once we implement
    // resuming, this may not be true.
    // 翻译：要删除的对象以相反的顺序添加，因此我们将其添加到最前面。
    //      此时，返回Fiber对象的副作用列表是空的（除了删除），因此我们可以将要删除的对象添加到列表中。
    //      其余的副作用要等到整个阶段结束才能添加。一旦执行恢复操作，就可能不正确。
    const last = returnFiber.lastEffect;
    if (last !== null) {
      last.nextEffect = childToDelete;
      returnFiber.lastEffect = childToDelete;
    } else {
      returnFiber.firstEffect = returnFiber.lastEffect = childToDelete;
    }
    childToDelete.nextEffect = null;
    childToDelete.effectTag = Deletion;
  }

  /**
   * 批量删除子节点，会将子节点及其兄弟节点删掉。
   * @param returnFiber 父级Fiber节点
   * @param currentFirstChild 要删除的首个Fiber节点
   * @return {null}
   */
  function deleteRemainingChildren(
    returnFiber: Fiber,
    currentFirstChild: Fiber | null,
  ): null {
    if (!shouldTrackSideEffects) {
      // Noop.
      return null;
    }

    // TODO: For the shouldClone case, this could be micro-optimized a bit by
    // assuming that after the first child we've already added everything.
    let childToDelete = currentFirstChild;
    while (childToDelete !== null) {
      deleteChild(returnFiber, childToDelete);
      childToDelete = childToDelete.sibling;
    }
    return null;
  }

  /**
   * 使用将剩下的现有子节点（旧节点）生成Map对象。
   * @param returnFiber 父级Fiber节点
   * @param currentFirstChild 要处理的首个Fiber节点
   * @return {Map<string|number, Fiber>}
   */
  function mapRemainingChildren(
    returnFiber: Fiber,
    currentFirstChild: Fiber,
  ): Map<string | number, Fiber> {
    // Add the remaining children to a temporary map so that we can find them by
    // keys quickly. Implicit (null) keys get added to this set with their index
    // instead.
    // 翻译：将剩余的子节点添加到临时Map对象中，以便我们可以通过按键快速找到他们。
    const existingChildren: Map<string | number, Fiber> = new Map();

    let existingChild = currentFirstChild;
    while (existingChild !== null) {
      if (existingChild.key !== null) {
        existingChildren.set(existingChild.key, existingChild);
      } else {
        existingChildren.set(existingChild.index, existingChild);
      }
      existingChild = existingChild.sibling;
    }
    return existingChildren;
  }

  /**
   * 复用节点。
   * @param fiber 要被复用的Fiber对象
   * @param pendingProps 新的props
   * @param expirationTime fiber所在的FiberRoot的nextExpirationTimeToWorkOn
   * @return {Fiber}
   */
  function useFiber(
    fiber: Fiber,
    pendingProps: mixed,
    expirationTime: ExpirationTime,
  ): Fiber {
    // We currently set sibling to null and index to 0 here because it is easy
    // to forget to do before returning it. E.g. for the single child case.
    // 翻译：我们目前将sibling设置为null，并将索引设置为0，因为在返回它之前很容易忘记做。
    const clone = createWorkInProgress(fiber, pendingProps, expirationTime);
    clone.index = 0;
    clone.sibling = null;
    return clone;
  }

  /**
   * 确定新Fiber对象的写入方式。
   * @param newFiber 新Fiber对象
   * @param lastPlacedIndex 上一个下标
   * @param newIndex 这个新节点的下标
   * @return {number}
   */
  function placeChild(
    newFiber: Fiber,
    lastPlacedIndex: number,
    newIndex: number,
  ): number {
    // 设置好新位置。
    newFiber.index = newIndex;
    if (!shouldTrackSideEffects) {
      // Noop.
      return lastPlacedIndex;
    }
    // newFiber是旧节点复用来的才有alternate。
    const current = newFiber.alternate;
    if (current !== null) {
      const oldIndex = current.index;
      if (oldIndex < lastPlacedIndex) {
        // This is a move.
        // 翻译：这个对象需要移动。
        newFiber.effectTag = Placement;
        return lastPlacedIndex;
      } else {
        // This item can stay in place.
        // 翻译：这个对象可以留在原地。
        return oldIndex;
      }
    } else {
      // This is an insertion.
      // 翻译：这是一个插入。
      newFiber.effectTag = Placement;
      return lastPlacedIndex;
    }
  }

  function placeSingleChild(newFiber: Fiber): Fiber {
    // This is simpler for the single child case. We only need to do a
    // placement for inserting new children.
    if (shouldTrackSideEffects && newFiber.alternate === null) {
      newFiber.effectTag = Placement;
    }
    return newFiber;
  }

  /**
   * 更新文本节点。类似reconcileSingleTextNode，但少了清理的功能。
   * @param returnFiber 当前处理中的节点的父节点
   * @param current 当前位置的旧Fiber对象
   * @param textContent 文本节点
   * @param expirationTime returnFiber所在的FiberRoot的nextExpirationTimeToWorkOn
   * @return {Fiber}
   */
  function updateTextNode(
    returnFiber: Fiber,
    current: Fiber | null,
    textContent: string,
    expirationTime: ExpirationTime,
  ) {
    if (current === null || current.tag !== HostText) {
      // Insert
      // 翻译：插入
      const created = createFiberFromText(
        textContent,
        returnFiber.mode,
        expirationTime,
      );
      created.return = returnFiber;
      return created;
    } else {
      // Update
      // 翻译：更新
      const existing = useFiber(current, textContent, expirationTime);
      existing.return = returnFiber;
      return existing;
    }
  }

  /**
   * 更新React元素节点。
   * @param returnFiber 当前处理中的节点的父节点
   * @param current 当前位置的旧Fiber对象
   * @param element 新的React元素
   * @param expirationTime returnFiber所在的FiberRoot的nextExpirationTimeToWorkOn
   * @return {Fiber}
   */
  function updateElement(
    returnFiber: Fiber,
    current: Fiber | null,
    element: ReactElement,
    expirationTime: ExpirationTime,
  ): Fiber {
    if (current !== null && current.elementType === element.type) {
      // Move based on index
      // 翻译：根据索引移动。
      const existing = useFiber(current, element.props, expirationTime);
      existing.ref = coerceRef(returnFiber, current, element);
      existing.return = returnFiber;
      if (__DEV__) {
        existing._debugSource = element._source;
        existing._debugOwner = element._owner;
      }
      return existing;
    } else {
      // Insert
      // 翻译：插入。
      const created = createFiberFromElement(
        element,
        returnFiber.mode,
        expirationTime,
      );
      created.ref = coerceRef(returnFiber, current, element);
      created.return = returnFiber;
      return created;
    }
  }

  function updatePortal(
    returnFiber: Fiber,
    current: Fiber | null,
    portal: ReactPortal,
    expirationTime: ExpirationTime,
  ): Fiber {
    if (
      current === null ||
      current.tag !== HostPortal ||
      current.stateNode.containerInfo !== portal.containerInfo ||
      current.stateNode.implementation !== portal.implementation
    ) {
      // Insert
      const created = createFiberFromPortal(
        portal,
        returnFiber.mode,
        expirationTime,
      );
      created.return = returnFiber;
      return created;
    } else {
      // Update
      const existing = useFiber(current, portal.children || [], expirationTime);
      existing.return = returnFiber;
      return existing;
    }
  }

  /**
   * 更新Fragment节点。
   * @param returnFiber 当前处理中的节点的父节点
   * @param current 当前位置的旧Fiber对象
   * @param fragment 新的数组或Iterator对象
   * @param expirationTime returnFiber所在的FiberRoot的nextExpirationTimeToWorkOn
   * @param key current上的显式的key
   * @return {Fiber}
   */
  function updateFragment(
    returnFiber: Fiber,
    current: Fiber | null,
    fragment: Iterable<*>,
    expirationTime: ExpirationTime,
    key: null | string,
  ): Fiber {
    if (current === null || current.tag !== Fragment) {
      // Insert
      // 翻译：插入。
      const created = createFiberFromFragment(
        fragment,
        returnFiber.mode,
        expirationTime,
        key,
      );
      created.return = returnFiber;
      return created;
    } else {
      // Update
      // 翻译：更新。
      const existing = useFiber(current, fragment, expirationTime);
      existing.return = returnFiber;
      return existing;
    }
  }

  /**
   * 便捷方式生成子节点。基本跟updateSlot函数相同，就是少了关于key的判断。
   * @param returnFiber 当前处理中的节点的父节点
   * @param newChild 当前位置的新React元素
   * @param expirationTime returnFiber所在的FiberRoot的nextExpirationTimeToWorkOn
   * @return {Fiber|null}
   */
  function createChild (
    returnFiber: Fiber,
    newChild: any,
    expirationTime: ExpirationTime,
  ): Fiber | null {
    if (typeof newChild === 'string' || typeof newChild === 'number') {
      // Text nodes don't have keys. If the previous node is implicitly keyed
      // we can continue to replace it without aborting even if it is not a text
      // node.
      // 翻译：文本节点没有key。如果前一个节点是隐式key，即使它不是文本节点，
      //      我们也可以继续替换它而不会中止。
      const created = createFiberFromText(
        '' + newChild,
        returnFiber.mode,
        expirationTime,
      )
      created.return = returnFiber
      return created
    }

    if (typeof newChild === 'object' && newChild !== null) {
      switch (newChild.$$typeof) {
        case REACT_ELEMENT_TYPE: {
          const created = createFiberFromElement(
            newChild,
            returnFiber.mode,
            expirationTime,
          )
          created.ref = coerceRef(returnFiber, null, newChild)
          created.return = returnFiber
          return created
        }
        case REACT_PORTAL_TYPE: {
          const created = createFiberFromPortal(
            newChild,
            returnFiber.mode,
            expirationTime,
          )
          created.return = returnFiber
          return created
        }
      }

      if (isArray(newChild) || getIteratorFn(newChild)) {
        const created = createFiberFromFragment(
          newChild,
          returnFiber.mode,
          expirationTime,
          null,
        )
        created.return = returnFiber
        return created
      }

      throwOnInvalidObjectType(returnFiber, newChild)
    }

    if (__DEV__) {
      if (typeof newChild === 'function') {
        warnOnFunctionType()
      }
    }

    return null
  }

  /**
   * 更新数组某个位置的Fiber。
   * @param returnFiber 当前处理中的节点的父节点
   * @param oldFiber 当前位置的旧Fiber对象
   * @param newChild 当前位置的新React元素
   * @param expirationTime returnFiber所在的FiberRoot的nextExpirationTimeToWorkOn
   * @return {Fiber|null}
   */
  function updateSlot(
    returnFiber: Fiber,
    oldFiber: Fiber | null,
    newChild: any,
    expirationTime: ExpirationTime,
  ): Fiber | null {
    // Update the fiber if the keys match, otherwise return null.
    // 翻译：如果key匹配，则更新Fiber对象，否则返回null。

    // 显示的key。
    const key = oldFiber !== null ? oldFiber.key : null;

    if (typeof newChild === 'string' || typeof newChild === 'number') {
      // Text nodes don't have keys. If the previous node is implicitly keyed
      // we can continue to replace it without aborting even if it is not a text
      // node.
      // 翻译：文本节点没有key。如果前一个节点是隐式key，即使它不是文本节点，
      //      我们也可以继续替换它而不会中止。
      if (key !== null) {
        return null;
      }
      return updateTextNode(
        returnFiber,
        oldFiber,
        '' + newChild,
        expirationTime,
      );
    }

    if (typeof newChild === 'object' && newChild !== null) {
      switch (newChild.$$typeof) {
        case REACT_ELEMENT_TYPE: {
          if (newChild.key === key) {
            if (newChild.type === REACT_FRAGMENT_TYPE) {
              return updateFragment(
                returnFiber,
                oldFiber,
                newChild.props.children,
                expirationTime,
                key,
              );
            }
            return updateElement(
              returnFiber,
              oldFiber,
              newChild,
              expirationTime,
            );
          } else {
            return null;
          }
        }
        case REACT_PORTAL_TYPE: {
          if (newChild.key === key) {
            return updatePortal(
              returnFiber,
              oldFiber,
              newChild,
              expirationTime,
            );
          } else {
            return null;
          }
        }
      }

      if (isArray(newChild) || getIteratorFn(newChild)) {
        if (key !== null) {
          return null;
        }

        return updateFragment(
          returnFiber,
          oldFiber,
          newChild,
          expirationTime,
          null,
        );
      }

      throwOnInvalidObjectType(returnFiber, newChild);
    }

    if (__DEV__) {
      if (typeof newChild === 'function') {
        warnOnFunctionType();
      }
    }

    return null;
  }

  /**
   * 使用Map更新新节点。
   * @param existingChildren 剩余旧Fiber对象组成的Map
   * @param returnFiber 当前处理中的节点的父节点
   * @param newIdx 新的下标
   * @param newChild 当前位置的新React元素
   * @param expirationTime returnFiber所在的FiberRoot的nextExpirationTimeToWorkOn
   * @return {Fiber|null}
   */
  function updateFromMap(
    existingChildren: Map<string | number, Fiber>,
    returnFiber: Fiber,
    newIdx: number,
    newChild: any,
    expirationTime: ExpirationTime,
  ): Fiber | null {
    if (typeof newChild === 'string' || typeof newChild === 'number') {
      // Text nodes don't have keys, so we neither have to check the old nor
      // new node for the key. If both are text nodes, they match.
      // 翻译：文本节点没有key，因此我们不必检查新旧节点的key。如果两者都是文本节点，则它们匹配。
      const matchedFiber = existingChildren.get(newIdx) || null;
      return updateTextNode(
        returnFiber,
        matchedFiber,
        '' + newChild,
        expirationTime,
      );
    }

    if (typeof newChild === 'object' && newChild !== null) {
      switch (newChild.$$typeof) {
        case REACT_ELEMENT_TYPE: {
          const matchedFiber =
            existingChildren.get(
              newChild.key === null ? newIdx : newChild.key,
            ) || null;
          if (newChild.type === REACT_FRAGMENT_TYPE) {
            return updateFragment(
              returnFiber,
              matchedFiber,
              newChild.props.children,
              expirationTime,
              newChild.key,
            );
          }
          return updateElement(
            returnFiber,
            matchedFiber,
            newChild,
            expirationTime,
          );
        }
        case REACT_PORTAL_TYPE: {
          const matchedFiber =
            existingChildren.get(
              newChild.key === null ? newIdx : newChild.key,
            ) || null;
          return updatePortal(
            returnFiber,
            matchedFiber,
            newChild,
            expirationTime,
          );
        }
      }

      if (isArray(newChild) || getIteratorFn(newChild)) {
        const matchedFiber = existingChildren.get(newIdx) || null;
        return updateFragment(
          returnFiber,
          matchedFiber,
          newChild,
          expirationTime,
          null,
        );
      }

      throwOnInvalidObjectType(returnFiber, newChild);
    }

    if (__DEV__) {
      if (typeof newChild === 'function') {
        warnOnFunctionType();
      }
    }

    return null;
  }

  /**
   * Warns if there is a duplicate or missing key
   * 翻译：如果密钥重复或丢失，则发出警告。
   */
  function warnOnInvalidKey(
    child: mixed,
    knownKeys: Set<string> | null,
  ): Set<string> | null {
    if (__DEV__) {
      if (typeof child !== 'object' || child === null) {
        return knownKeys;
      }
      switch (child.$$typeof) {
        case REACT_ELEMENT_TYPE:
        case REACT_PORTAL_TYPE:
          warnForMissingKey(child);
          const key = child.key;
          if (typeof key !== 'string') {
            break;
          }
          if (knownKeys === null) {
            knownKeys = new Set();
            knownKeys.add(key);
            break;
          }
          if (!knownKeys.has(key)) {
            knownKeys.add(key);
            break;
          }
          warning(
            false,
            'Encountered two children with the same key, `%s`. ' +
              'Keys should be unique so that components maintain their identity ' +
              'across updates. Non-unique keys may cause children to be ' +
              'duplicated and/or omitted — the behavior is unsupported and ' +
              'could change in a future version.',
            key,
          );
          break;
        default:
          break;
      }
    }
    return knownKeys;
  }

  /**
   * 调和子节点列表
   * @param returnFiber 当前处理中的节点的父节点
   * @param currentFirstChild returnFiber的第一个child
   * @param newChildren 新生成的React元素列表
   * @param expirationTime returnFiber所在的FiberRoot的nextExpirationTimeToWorkOn
   * @return {Fiber}
   */
  function reconcileChildrenArray(
    returnFiber: Fiber,
    currentFirstChild: Fiber | null,
    newChildren: Array<*>,
    expirationTime: ExpirationTime,
  ): Fiber | null {
    // This algorithm can't optimize by searching from boths ends since we
    // don't have backpointers on fibers. I'm trying to see how far we can get
    // with that model. If it ends up not being worth the tradeoffs, we can
    // add it later.
    // 翻译：由于我们在Fiber对象上没有反向指针，因此无法通过从两端进行搜索来优化此算法。
    //      我正在尝试考察该模型可以达到的效果。如果最终不值得权衡，我们可以稍后添加。

    // Even with a two ended optimization, we'd want to optimize for the case
    // where there are few changes and brute force the comparison instead of
    // going for the Map. It'd like to explore hitting that path first in
    // forward-only mode and only go for the Map once we notice that we need
    // lots of look ahead. This doesn't handle reversal as well as two ended
    // search but that's unusual. Besides, for the two ended optimization to
    // work on Iterables, we'd need to copy the whole set.
    // 翻译：即使进行了两端优化，我们也希望针对变化不多的情况进行优化，并强行进行比较，而不是使用Map。
    //      它旨在探索仅前进模式中的那条路，并且只有在我们注意到我们需要大量的前瞻性之后才选择Map。
    //      这不能处理逆转以及两端搜索，但这是不寻常的。
    //      此外，为了使两端优化都能在Iterables上运行，我们需要复制整个集合。

    // In this first iteration, we'll just live with hitting the bad case
    // (adding everything to a Map) in for every insert/move.
    // 翻译：在第一个迭代中，我们将为每个插入/移动命中最坏的情况（将所有内容添加到Map）。

    // If you change this code, also update reconcileChildrenIterator() which
    // uses the same algorithm.
    // 翻译：如果更改此代码，则还更新使用相同算法的reconcileChildrenIterator()。

    if (__DEV__) {
      // First, validate keys.
      let knownKeys = null;
      for (let i = 0; i < newChildren.length; i++) {
        const child = newChildren[i];
        knownKeys = warnOnInvalidKey(child, knownKeys);
      }
    }

    let resultingFirstChild: Fiber | null = null;
    let previousNewFiber: Fiber | null = null;

    let oldFiber = currentFirstChild;
    let lastPlacedIndex = 0;
    let newIdx = 0;
    let nextOldFiber = null;
    // 将新的React元素列表进行遍历。newIdx为新的下标。
    for (; oldFiber !== null && newIdx < newChildren.length; newIdx++) {
      if (oldFiber.index > newIdx) {
        // 新位置与老位置不匹配，则不再复用老节点。
        nextOldFiber = oldFiber;
        oldFiber = null;
      } else {
        // 新位置匹配。
        nextOldFiber = oldFiber.sibling;
      }
      // 更新该位置的新节点。
      const newFiber = updateSlot(
        returnFiber,
        oldFiber,
        newChildren[newIdx],
        expirationTime,
      );
      if (newFiber === null) {
        // 这里就是无法复用的情况。
        // TODO: This breaks on empty slots like null children. That's
        // unfortunate because it triggers the slow path all the time. We need
        // a better way to communicate whether this was a miss or null,
        // boolean, undefined, etc.
        if (oldFiber === null) {
          // 如果oldFiber不存在就指向下一个节点。
          oldFiber = nextOldFiber;
        }
        break;
      }
      if (shouldTrackSideEffects) {
        // 需要跟跟副作用，也就是非首次渲染。
        if (oldFiber && newFiber.alternate === null) {
          // We matched the slot, but we didn't reuse the existing fiber, so we
          // need to delete the existing child.
          // 翻译：我们匹配了插槽，但是没有重用现有的Fiber对象，因此我们需要删除现有的子代。
          deleteChild(returnFiber, oldFiber);
        }
      }
      lastPlacedIndex = placeChild(newFiber, lastPlacedIndex, newIdx);
      if (previousNewFiber === null) {
        // 上一个执行的节点为null，即代表这是第一次循环。做一下标记首个节点。
        // TODO: Move out of the loop. This only happens for the first run.
        resultingFirstChild = newFiber;
      } else {
        // TODO: Defer siblings if we're not at the right index for this slot.
        // I.e. if we had null values before, then we want to defer this
        // for each null value. However, we also don't want to call updateSlot
        // with the previous one.
        // 否则，就一定是第一个节点的兄弟节点了。
        previousNewFiber.sibling = newFiber;
      }
      // 标记上一个处理的节点。
      previousNewFiber = newFiber;
      // oldFiber是循环条件之一。
      oldFiber = nextOldFiber;
    }

    // 新节点已经处理完了。
    if (newIdx === newChildren.length) {
      // We've reached the end of the new children. We can delete the rest.
      // 翻译：我们到了新子节点数组的尽头。我们可以删除其余的（现有）。
      deleteRemainingChildren(returnFiber, oldFiber);
      return resultingFirstChild;
    }

    // 没有旧节点，但新建的还没处理完。
    if (oldFiber === null) {
      // If we don't have any more existing children we can choose a fast path
      // since the rest will all be insertions.
      // 翻译：如果我们没有更多的现有子节点，我们可以选择一条快速的处理路径，因为剩下的节点全部都是插入操作。
      for (; newIdx < newChildren.length; newIdx++) {
        const newFiber = createChild(
          returnFiber,
          newChildren[newIdx],
          expirationTime,
        );
        if (!newFiber) {
          continue;
        }
        lastPlacedIndex = placeChild(newFiber, lastPlacedIndex, newIdx);
        if (previousNewFiber === null) {
          // TODO: Move out of the loop. This only happens for the first run.
          resultingFirstChild = newFiber;
        } else {
          previousNewFiber.sibling = newFiber;
        }
        previousNewFiber = newFiber;
      }
      return resultingFirstChild;
    }

    // Add all children to a key map for quick lookups.
    // 翻译：将所有子节点添加到键映射中以快速查找。
    const existingChildren = mapRemainingChildren(returnFiber, oldFiber);

    // Keep scanning and use the map to restore deleted items as moves.
    // 翻译：继续扫描并使用Map将已删除的项目还原为移动操作。
    for (; newIdx < newChildren.length; newIdx++) {
      const newFiber = updateFromMap(
        existingChildren,
        returnFiber,
        newIdx,
        newChildren[newIdx],
        expirationTime,
      );
      if (newFiber) {
        if (shouldTrackSideEffects) {
          if (newFiber.alternate !== null) {
            // The new fiber is a work in progress, but if there exists a
            // current, that means that we reused the fiber. We need to delete
            // it from the child list so that we don't add it to the deletion
            // list.
            // 翻译：这个新的Fiber节点正在进行，但如果它已经存在（被渲染过），这意味着我们重用了该Fiber对象。
            //      我们需要将它从子节点列表里删除，以免将其添加到将要删除的列表中。
            existingChildren.delete(
              newFiber.key === null ? newIdx : newFiber.key,
            );
          }
        }
        lastPlacedIndex = placeChild(newFiber, lastPlacedIndex, newIdx);
        if (previousNewFiber === null) {
          resultingFirstChild = newFiber;
        } else {
          previousNewFiber.sibling = newFiber;
        }
        previousNewFiber = newFiber;
      }
    }

    if (shouldTrackSideEffects) {
      // Any existing children that weren't consumed above were deleted. We need
      // to add them to the deletion list.
      // 翻译：上面没有使用到的所有现有子节点都将被删除。我们需要将他们加入删除列表。
      existingChildren.forEach(child => deleteChild(returnFiber, child));
    }

    return resultingFirstChild;
  }

  function reconcileChildrenIterator(
    returnFiber: Fiber,
    currentFirstChild: Fiber | null,
    newChildrenIterable: Iterable<*>,
    expirationTime: ExpirationTime,
  ): Fiber | null {
    // This is the same implementation as reconcileChildrenArray(),
    // but using the iterator instead.

    const iteratorFn = getIteratorFn(newChildrenIterable);
    invariant(
      typeof iteratorFn === 'function',
      'An object is not an iterable. This error is likely caused by a bug in ' +
        'React. Please file an issue.',
    );

    if (__DEV__) {
      // We don't support rendering Generators because it's a mutation.
      // See https://github.com/facebook/react/issues/12995
      if (
        typeof Symbol === 'function' &&
        // $FlowFixMe Flow doesn't know about toStringTag
        newChildrenIterable[Symbol.toStringTag] === 'Generator'
      ) {
        warning(
          didWarnAboutGenerators,
          'Using Generators as children is unsupported and will likely yield ' +
            'unexpected results because enumerating a generator mutates it. ' +
            'You may convert it to an array with `Array.from()` or the ' +
            '`[...spread]` operator before rendering. Keep in mind ' +
            'you might need to polyfill these features for older browsers.',
        );
        didWarnAboutGenerators = true;
      }

      // Warn about using Maps as children
      if ((newChildrenIterable: any).entries === iteratorFn) {
        warning(
          didWarnAboutMaps,
          'Using Maps as children is unsupported and will likely yield ' +
            'unexpected results. Convert it to a sequence/iterable of keyed ' +
            'ReactElements instead.',
        );
        didWarnAboutMaps = true;
      }

      // First, validate keys.
      // We'll get a different iterator later for the main pass.
      const newChildren = iteratorFn.call(newChildrenIterable);
      if (newChildren) {
        let knownKeys = null;
        let step = newChildren.next();
        for (; !step.done; step = newChildren.next()) {
          const child = step.value;
          knownKeys = warnOnInvalidKey(child, knownKeys);
        }
      }
    }

    const newChildren = iteratorFn.call(newChildrenIterable);
    invariant(newChildren != null, 'An iterable object provided no iterator.');

    let resultingFirstChild: Fiber | null = null;
    let previousNewFiber: Fiber | null = null;

    let oldFiber = currentFirstChild;
    let lastPlacedIndex = 0;
    let newIdx = 0;
    let nextOldFiber = null;

    let step = newChildren.next();
    for (
      ;
      oldFiber !== null && !step.done;
      newIdx++, step = newChildren.next()
    ) {
      if (oldFiber.index > newIdx) {
        nextOldFiber = oldFiber;
        oldFiber = null;
      } else {
        nextOldFiber = oldFiber.sibling;
      }
      const newFiber = updateSlot(
        returnFiber,
        oldFiber,
        step.value,
        expirationTime,
      );
      if (newFiber === null) {
        // TODO: This breaks on empty slots like null children. That's
        // unfortunate because it triggers the slow path all the time. We need
        // a better way to communicate whether this was a miss or null,
        // boolean, undefined, etc.
        if (!oldFiber) {
          oldFiber = nextOldFiber;
        }
        break;
      }
      if (shouldTrackSideEffects) {
        if (oldFiber && newFiber.alternate === null) {
          // We matched the slot, but we didn't reuse the existing fiber, so we
          // need to delete the existing child.
          deleteChild(returnFiber, oldFiber);
        }
      }
      lastPlacedIndex = placeChild(newFiber, lastPlacedIndex, newIdx);
      if (previousNewFiber === null) {
        // TODO: Move out of the loop. This only happens for the first run.
        resultingFirstChild = newFiber;
      } else {
        // TODO: Defer siblings if we're not at the right index for this slot.
        // I.e. if we had null values before, then we want to defer this
        // for each null value. However, we also don't want to call updateSlot
        // with the previous one.
        previousNewFiber.sibling = newFiber;
      }
      previousNewFiber = newFiber;
      oldFiber = nextOldFiber;
    }

    if (step.done) {
      // We've reached the end of the new children. We can delete the rest.
      deleteRemainingChildren(returnFiber, oldFiber);
      return resultingFirstChild;
    }

    if (oldFiber === null) {
      // If we don't have any more existing children we can choose a fast path
      // since the rest will all be insertions.
      for (; !step.done; newIdx++, step = newChildren.next()) {
        const newFiber = createChild(returnFiber, step.value, expirationTime);
        if (newFiber === null) {
          continue;
        }
        lastPlacedIndex = placeChild(newFiber, lastPlacedIndex, newIdx);
        if (previousNewFiber === null) {
          // TODO: Move out of the loop. This only happens for the first run.
          resultingFirstChild = newFiber;
        } else {
          previousNewFiber.sibling = newFiber;
        }
        previousNewFiber = newFiber;
      }
      return resultingFirstChild;
    }

    // Add all children to a key map for quick lookups.
    const existingChildren = mapRemainingChildren(returnFiber, oldFiber);

    // Keep scanning and use the map to restore deleted items as moves.
    for (; !step.done; newIdx++, step = newChildren.next()) {
      const newFiber = updateFromMap(
        existingChildren,
        returnFiber,
        newIdx,
        step.value,
        expirationTime,
      );
      if (newFiber !== null) {
        if (shouldTrackSideEffects) {
          if (newFiber.alternate !== null) {
            // The new fiber is a work in progress, but if there exists a
            // current, that means that we reused the fiber. We need to delete
            // it from the child list so that we don't add it to the deletion
            // list.
            existingChildren.delete(
              newFiber.key === null ? newIdx : newFiber.key,
            );
          }
        }
        lastPlacedIndex = placeChild(newFiber, lastPlacedIndex, newIdx);
        if (previousNewFiber === null) {
          resultingFirstChild = newFiber;
        } else {
          previousNewFiber.sibling = newFiber;
        }
        previousNewFiber = newFiber;
      }
    }

    if (shouldTrackSideEffects) {
      // Any existing children that weren't consumed above were deleted. We need
      // to add them to the deletion list.
      existingChildren.forEach(child => deleteChild(returnFiber, child));
    }

    return resultingFirstChild;
  }

  /**
   * 调和单一的文本节点
   * @param returnFiber 当前处理中的节点的父节点
   * @param currentFirstChild returnFiber的第一个child
   * @param textContent 新生成的文本内容
   * @param expirationTime returnFiber所在的FiberRoot的nextExpirationTimeToWorkOn
   * @return {Fiber}
   */
  function reconcileSingleTextNode(
    returnFiber: Fiber,
    currentFirstChild: Fiber | null,
    textContent: string,
    expirationTime: ExpirationTime,
  ): Fiber {
    // There's no need to check for keys on text nodes since we don't have a
    // way to define them.
    // 翻译：无需检查文本节点上的key，因为我们没有定义它们的方法。
    if (currentFirstChild !== null && currentFirstChild.tag === HostText) {
      // We already have an existing node so let's just update it and delete
      // the rest.
      // 翻译：我们已经有一个现有节点，因此让我们对其进行更新，然后删除其余节点。
      deleteRemainingChildren(returnFiber, currentFirstChild.sibling);
      const existing = useFiber(currentFirstChild, textContent, expirationTime);
      existing.return = returnFiber;
      return existing;
    }
    // The existing first child is not a text node so we need to create one
    // and delete the existing ones.
    // 翻译：现有的第一个子节点不是文本节点，因此我们需要创建一个并删除现有的子节点。
    deleteRemainingChildren(returnFiber, currentFirstChild);
    const created = createFiberFromText(
      textContent,
      returnFiber.mode,
      expirationTime,
    );
    created.return = returnFiber;
    return created;
  }

  /**
   * 调和单一的React元素节点。
   * @param returnFiber 当前处理中的节点的父节点
   * @param currentFirstChild returnFiber的第一个child
   * @param element 新生成的React元素
   * @param expirationTime returnFiber所在的FiberRoot的nextExpirationTimeToWorkOn
   * @return {Fiber}
   */
  function reconcileSingleElement(
    returnFiber: Fiber,
    currentFirstChild: Fiber | null,
    element: ReactElement,
    expirationTime: ExpirationTime,
  ): Fiber {
    const key = element.key;
    let child = currentFirstChild;
    while (child !== null) {
      // TODO: If key === null and child.key === null, then this only applies to
      // the first item in the list.
      if (child.key === key) {
        if (
          child.tag === Fragment
            ? element.type === REACT_FRAGMENT_TYPE
            : child.elementType === element.type
        ) {
          deleteRemainingChildren(returnFiber, child.sibling);
          const existing = useFiber(
            child,
            element.type === REACT_FRAGMENT_TYPE
              ? element.props.children
              : element.props,
            expirationTime,
          );
          existing.ref = coerceRef(returnFiber, child, element);
          existing.return = returnFiber;
          if (__DEV__) {
            existing._debugSource = element._source;
            existing._debugOwner = element._owner;
          }
          return existing;
        } else {
          deleteRemainingChildren(returnFiber, child);
          break;
        }
      } else {
        deleteChild(returnFiber, child);
      }
      child = child.sibling;
    }

    if (element.type === REACT_FRAGMENT_TYPE) {
      const created = createFiberFromFragment(
        element.props.children,
        returnFiber.mode,
        expirationTime,
        element.key,
      );
      created.return = returnFiber;
      return created;
    } else {
      const created = createFiberFromElement(
        element,
        returnFiber.mode,
        expirationTime,
      );
      created.ref = coerceRef(returnFiber, currentFirstChild, element);
      created.return = returnFiber;
      return created;
    }
  }

  /**
   * 调和单一节点
   * @param returnFiber 父节点
   * @param currentFirstChild
   * @param portal
   * @param expirationTime
   * @return {Fiber}
   */
  function reconcileSinglePortal(
    returnFiber: Fiber,
    currentFirstChild: Fiber | null,
    portal: ReactPortal,
    expirationTime: ExpirationTime,
  ): Fiber {
    const key = portal.key;
    let child = currentFirstChild;
    while (child !== null) {
      // TODO: If key === null and child.key === null, then this only applies to
      // the first item in the list.
      if (child.key === key) {
        if (
          child.tag === HostPortal &&
          child.stateNode.containerInfo === portal.containerInfo &&
          child.stateNode.implementation === portal.implementation
        ) {
          deleteRemainingChildren(returnFiber, child.sibling);
          const existing = useFiber(
            child,
            portal.children || [],
            expirationTime,
          );
          existing.return = returnFiber;
          return existing;
        } else {
          deleteRemainingChildren(returnFiber, child);
          break;
        }
      } else {
        deleteChild(returnFiber, child);
      }
      child = child.sibling;
    }

    const created = createFiberFromPortal(
      portal,
      returnFiber.mode,
      expirationTime,
    );
    created.return = returnFiber;
    return created;
  }

  // This API will tag the children with the side-effect of the reconciliation
  // itself. They will be added to the side-effect list as we pass through the
  // children and the parent.
  // 翻译：此API将使用调和自身的副作用标记子节点。当我们通过子节点和父节点时，它们将被添加到副作用列表中。
  /**
   * 调和子节点，这个方法也是包装函数的结果。
   * @param returnFiber 当前处理中的节点的父节点
   * @param currentFirstChild returnFiber的第一个child
   * @param newChild 新生成的React元素
   * @param expirationTime returnFiber所在的FiberRoot的nextExpirationTimeToWorkOn
   * @return {Fiber|*}
   */
  function reconcileChildFibers(
    returnFiber: Fiber,
    currentFirstChild: Fiber | null,
    newChild: any,
    expirationTime: ExpirationTime,
  ): Fiber | null {
    // This function is not recursive.
    // If the top level item is an array, we treat it as a set of children,
    // not as a fragment. Nested arrays on the other hand will be treated as
    // fragment nodes. Recursion happens at the normal flow.
    // 翻译：此函数不是递归的。
    //      如果顶层项目是数组，则将其视为一组子项，而不是片段。另一方面，嵌套数组将被视为片段节点。
    //      递归以正常流发生。

    // Handle top level unkeyed fragments as if they were arrays.
    // This leads to an ambiguity between <>{[...]}</> and <>...</>.
    // We treat the ambiguous cases above the same.
    // 翻译：像对待数组一样处理顶级无key片段。
    //      这导致<> {[...]} </>和<> ... </>之间的歧义。
    //      我们处理歧义情况方式跟上面一样。
    const isUnkeyedTopLevelFragment =
      typeof newChild === 'object' &&
      newChild !== null &&
      newChild.type === REACT_FRAGMENT_TYPE &&
      newChild.key === null;
    if (isUnkeyedTopLevelFragment) {
      // 这里处理React.Fragment节点，这种节点没有实际作用，只是包裹。
      newChild = newChild.props.children;
    }

    // Handle object types
    // 翻译：处理对象类型。
    const isObject = typeof newChild === 'object' && newChild !== null;

    if (isObject) {
      // 单个react元素
      switch (newChild.$$typeof) {
        case REACT_ELEMENT_TYPE:
          // 通过createElement产生的节点。
          return placeSingleChild(
            reconcileSingleElement(
              returnFiber,
              currentFirstChild,
              newChild,
              expirationTime,
            ),
          );
        case REACT_PORTAL_TYPE:
          // 通过ReactDOM.Portal产生的节点。
          return placeSingleChild(
            reconcileSinglePortal(
              returnFiber,
              currentFirstChild,
              newChild,
              expirationTime,
            ),
          );
      }
    }

    if (typeof newChild === 'string' || typeof newChild === 'number') {
      // 文本节点。
      return placeSingleChild(
        reconcileSingleTextNode(
          returnFiber,
          currentFirstChild,
          '' + newChild,
          expirationTime,
        ),
      );
    }

    if (isArray(newChild)) {
      // 子节点是数组。
      return reconcileChildrenArray(
        returnFiber,
        currentFirstChild,
        newChild,
        expirationTime,
      );
    }

    if (getIteratorFn(newChild)) {
      // 子节点是Iterator对象。
      return reconcileChildrenIterator(
        returnFiber,
        currentFirstChild,
        newChild,
        expirationTime,
      );
    }

    if (isObject) {
      // 不符合上面的情况，就是异常情况。
      throwOnInvalidObjectType(returnFiber, newChild);
    }

    if (__DEV__) {
      if (typeof newChild === 'function') {
        warnOnFunctionType();
      }
    }
    if (typeof newChild === 'undefined' && !isUnkeyedTopLevelFragment) {
      // 处理没有新react元素的情况，就是运行完用户编写的函数后无返回值。
      // If the new child is undefined, and the return fiber is a composite
      // component, throw an error. If Fiber return types are disabled,
      // we already threw above.
      // 翻译：如果新子节点是undefined，并且返回Fiber对象是复合组件，则抛出错误。
      //      如果Fiber对象的返回类型是禁用类型，我们已经在上面提到了。
      switch (returnFiber.tag) {
        case ClassComponent: {
          if (__DEV__) {
            const instance = returnFiber.stateNode;
            if (instance.render._isMockFunction) {
              // We allow auto-mocks to proceed as if they're returning null.
              break;
            }
          }
        }
        // Intentionally fall through to the next case, which handles both
        // functions and classes
        // 翻译：故意进入下一个case，该情况同时处理函数和类。
        // eslint-disable-next-lined no-fallthrough
        case FunctionComponent: {
          const Component = returnFiber.type;
          invariant(
            false,
            '%s(...): Nothing was returned from render. This usually means a ' +
              'return statement is missing. Or, to render nothing, ' +
              'return null.',
            Component.displayName || Component.name || 'Component',
          );
        }
      }
    }

    // Remaining cases are all treated as empty.
    // 翻译：其余的情况都被视为空的。
    return deleteRemainingChildren(returnFiber, currentFirstChild);
  }

  return reconcileChildFibers;
}

export const reconcileChildFibers = ChildReconciler(true);
export const mountChildFibers = ChildReconciler(false);

/**
 * 将current的子节点复制到其workInProgress。
 * @param current 当前处理的Fiber对象
 * @param workInProgress 当前处理的Fiber对象的进行中副本
 */
export function cloneChildFibers(
  current: Fiber | null,
  workInProgress: Fiber,
): void {
  invariant(
    current === null || workInProgress.child === current.child,
    'Resuming work not yet implemented.',
  );

  // 这里的workInProgress.child还是指向current的child，如果为null就是没有子节点。
  if (workInProgress.child === null) {
    return;
  }

  let currentChild = workInProgress.child;
  // 生成新的子节点。
  let newChild = createWorkInProgress(
    currentChild,
    currentChild.pendingProps,
    currentChild.expirationTime,
  );
  // 挂载新生成的节点副本。
  workInProgress.child = newChild;

  newChild.return = workInProgress;
  // 循环处理兄弟节点。
  while (currentChild.sibling !== null) {
    currentChild = currentChild.sibling;
    newChild = newChild.sibling = createWorkInProgress(
      currentChild,
      currentChild.pendingProps,
      currentChild.expirationTime,
    );
    newChild.return = workInProgress;
  }
  newChild.sibling = null;
}
