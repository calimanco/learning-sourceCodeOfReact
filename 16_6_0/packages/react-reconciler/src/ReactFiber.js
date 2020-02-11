/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {ReactElement, Source} from 'shared/ReactElementType';
import type {ReactFragment, ReactPortal, RefObject} from 'shared/ReactTypes';
import type {WorkTag} from 'shared/ReactWorkTags';
import type {TypeOfMode} from './ReactTypeOfMode';
import type {SideEffectTag} from 'shared/ReactSideEffectTags';
import type {ExpirationTime} from './ReactFiberExpirationTime';
import type {UpdateQueue} from './ReactUpdateQueue';
import type {ContextDependency} from './ReactFiberNewContext';

import invariant from 'shared/invariant';
import warningWithoutStack from 'shared/warningWithoutStack';
import {enableProfilerTimer} from 'shared/ReactFeatureFlags';
import {NoEffect} from 'shared/ReactSideEffectTags';
import {
  IndeterminateComponent,
  ClassComponent,
  HostRoot,
  HostComponent,
  HostText,
  HostPortal,
  ForwardRef,
  Fragment,
  Mode,
  ContextProvider,
  ContextConsumer,
  Profiler,
  SuspenseComponent,
  FunctionComponent,
  MemoComponent,
  LazyComponent,
} from 'shared/ReactWorkTags';
import getComponentName from 'shared/getComponentName';

import {isDevToolsPresent} from './ReactFiberDevToolsHook';
import {NoWork} from './ReactFiberExpirationTime';
import {
  NoContext,
  ConcurrentMode,
  ProfileMode,
  StrictMode,
} from './ReactTypeOfMode';
import {
  REACT_FORWARD_REF_TYPE,
  REACT_FRAGMENT_TYPE,
  REACT_STRICT_MODE_TYPE,
  REACT_PROFILER_TYPE,
  REACT_PROVIDER_TYPE,
  REACT_CONTEXT_TYPE,
  REACT_CONCURRENT_MODE_TYPE,
  REACT_SUSPENSE_TYPE,
  REACT_MEMO_TYPE,
  REACT_LAZY_TYPE,
} from 'shared/ReactSymbols';

let hasBadMapPolyfill;

if (__DEV__) {
  hasBadMapPolyfill = false;
  try {
    const nonExtensibleObject = Object.preventExtensions({});
    const testMap = new Map([[nonExtensibleObject, null]]);
    const testSet = new Set([nonExtensibleObject]);
    // This is necessary for Rollup to not consider these unused.
    // https://github.com/rollup/rollup/issues/1771
    // TODO: we can remove these if Rollup fixes the bug.
    testMap.set(0, 0);
    testSet.add(0);
  } catch (e) {
    // TODO: Consider warning about bad polyfills
    hasBadMapPolyfill = true;
  }
}

// A Fiber is work on a Component that needs to be done or was done. There can
// be more than one per component.
// 翻译：Fiber对应一个需要被处理或者已经处理了的组件。一个组件可以有一个或者多个Fiber
export type Fiber = {|
  // These first fields are conceptually members of an Instance. This used to
  // be split into a separate type and intersected with the other Fiber fields,
  // but until Flow fixes its intersection bugs, we've merged them into a
  // single type.
  // 翻译：从概念上讲，这些首要字段是实例的成员。本来应该将其拆分为单独的类型并与其他Fiber字段合并，
  //      但是在Flow修复其合并错误之前，我们将它们合并为单个类型。

  // An Instance is shared between all versions of a component. We can easily
  // break this out into a separate object to avoid copying so much to the
  // alternate versions of the tree. We put this on a single object for now to
  // minimize the number of objects created during the initial render.
  // 翻译：实例在组件的所有版本之间共享。我们可以轻松地将其分解为一个单独的对象，
  //      以避免将太多内容复制到节点树的副本中。现在，我们将其放在单个对象上，
  //      以最小化在初始渲染期间创建的对象数量。

  // Tag identifying the type of fiber.
  // 翻译：标识Fiber对象类型
  tag: WorkTag,

  // Unique identifier of this child.
  // 翻译：此child的唯一标识符。
  key: null | string,

  // The value of element.type which is used to preserve the identity during
  // reconciliation of this child.
  // 翻译：element.type的值，用于在协调此子对象期间所保留的属性。
  // 也就是我们调用`createElement`的第一个参数。
  elementType: any,

  // The resolved function/class/ associated with this fiber.
  // 翻译：与这个Fiber对象关联的resolved状态的函数或类。
  // 异步组件resolved之后返回的内容，一般是`function`或者`class`
  type: any,

  // The local state associated with this fiber.
  // 翻译：与此Fiber对象关联的本地状态。
  stateNode: any,

  // Conceptual aliases
  // parent : Instance -> return The parent happens to be the same as the
  // return fiber since we've merged the fiber and instance.
  // 翻译：概念别名
  //      parent：Instance -> return 父级节点恰好与Fiber对象的return属性指向相同，
  //      因为我们已经合并了Fiber对象和实例。

  // Remaining fields belong to Fiber
  // 翻译：其余字段属于Fiber对象本身。

  // The Fiber to return to after finishing processing this one.
  // This is effectively the parent, but there can be multiple parents (two)
  // so this is only the parent of the thing we're currently processing.
  // It is conceptually the same as the return address of a stack frame.
  // 翻译：Fiber对象在完成这一处理后返回。
  //      这实际上就是父级节点，但这可以有多个父级节点（两个），所以这只是我们当前正在处理的对象的父级节点。
  //      从概念上讲，它与堆栈帧的返回地址相同。
  return: Fiber | null,

  // Singly Linked List Tree Structure.
  // 翻译：单链接列表树结构。
  child: Fiber | null,
  sibling: Fiber | null,
  index: number,

  // The ref last used to attach this node.
  // I'll avoid adding an owner field for prod and model that as functions.
  // 翻译：ref属性最后一次用于附加该节点。
  //      我将避免为生产模式和模型添加函数的所有者字段。
  ref: null | (((handle: mixed) => void) & {_stringRef: ?string}) | RefObject,

  // Input is the data coming into process this fiber. Arguments. Props.
  // 翻译：输入的是正在处理该Fiber对象的数据。
  pendingProps: any, // This type will be more specific once we overload the tag.
  // 翻译：一旦我们重载了标签，此类型将更加具体。
  // 新的变动带来的新的props。
  memoizedProps: any, // The props used to create the output.
  // 翻译：用于创建输出的props。
  // 上一次渲染完成之后的props。

  // A queue of state updates and callbacks.
  // 翻译：状态更新和回调的队列。
  // 该Fiber对应的组件产生的Update会存放在这个队列里面。
  updateQueue: UpdateQueue<any> | null,

  // The state used to create the output
  // 翻译：用于创建输出的state。
  // 上一次渲染的时候的state。
  memoizedState: any,

  // A linked-list of contexts that this fiber depends on
  // 翻译：一个存放这个Fiber对象依赖的context的链接列表。
  firstContextDependency: ContextDependency<mixed> | null,

  // Bitfield that describes properties about the fiber and its subtree. E.g.
  // the ConcurrentMode flag indicates whether the subtree should be async-by-
  // default. When a fiber is created, it inherits the mode of its
  // parent. Additional flags can be set at creation time, but after that the
  // value should remain unchanged throughout the fiber's lifetime, particularly
  // before its child fibers are created.
  // 翻译：用来描述当前Fiber对象和他子树的属性的`Bitfield`。
  //      比如：ConcurrentMode的标志指示子树是否应默认为异步。当Fiber对象被创建时，它继承其父节点的mode字段。
  //      可以在创建时设置其他标志，但是此后，该值应在Fiber对象的整个生命周期中保持不变，尤其是在创建其子节点之前。
  mode: TypeOfMode,

  // Effect
  // 翻译：副作用。
  effectTag: SideEffectTag,

  // Singly linked list fast path to the next fiber with side-effects.
  // 翻译：单链表用来快速查找下一个side effect
  nextEffect: Fiber | null,

  // The first and last fiber with side-effect within this subtree. This allows
  // us to reuse a slice of the linked list when we reuse the work done within
  // this fiber.
  // 翻译：该子树中具有副作用的第一个和最后一个Fiber对象。当我们在此Fiber对象中完成重用工作时，
  //      这允许我们可以重用链表的一部分。
  firstEffect: Fiber | null,
  lastEffect: Fiber | null,

  // Represents a time in the future by which this work should be completed.
  // Does not include work found in its subtree.
  // 翻译：表示将来此任务在哪个时间点完成。
  //      不包括他的子树产生的任务。
  expirationTime: ExpirationTime,

  // This is used to quickly determine if a subtree has no pending changes.
  // 翻译：这用于快速确定子树是否有不在挂起状态的更改。
  childExpirationTime: ExpirationTime,

  // This is a pooled version of a Fiber. Every fiber that gets updated will
  // eventually have a pair. There are cases when we can clean up pairs to save
  // memory if we need to.
  // 翻译：这是Fiber对象的混合版本。每个更新的Fiber对象最终都会有一对。
  //      在某些情况下，我们可以清理配对以节省内存。
  // 在Fiber树更新的过程中，每个Fiber都会有一个跟其对应的Fiber。
  // 我们称他为`current <==> workInProgress`。
  // 在渲染完成之后他们会交换位置。
  alternate: Fiber | null,

  // Time spent rendering this Fiber and its descendants for the current update.
  // This tells us how well the tree makes use of sCU for memoization.
  // It is reset to 0 each time we render and only updated when we don't bailout.
  // This field is only set when the enableProfilerTimer flag is enabled.
  // 翻译：为当前更新渲染此Fiber对象及其子代所花费的时间。
  //      这告诉我们树使用sCU进行记忆的程度。
  //      每次渲染时，它将重置为0，并且仅在不进行'bailout'时更新。
  //      仅在启用enableProfilerTimer标志时才会设置此字段。
  // 下面是调试相关的，收集每个Fiber和子树渲染时间的。
  actualDuration?: number,

  // If the Fiber is currently active in the "render" phase,
  // This marks the time at which the work began.
  // This field is only set when the enableProfilerTimer flag is enabled.
  // 翻译：如果Fiber对象当前在“渲染”阶段，这标志着工作开始的时间。
  //      仅在启用enableProfilerTimer标志时才会设置此字段。
  actualStartTime?: number,

  // Duration of the most recent render time for this Fiber.
  // This value is not updated when we bailout for memoization purposes.
  // This field is only set when the enableProfilerTimer flag is enabled.
  // 翻译：该Fiber对象的最新渲染的持续时间。
  //      当我们出于记忆目的而进行'bailout'时，此值不会更新。
  //      仅在启用enableProfilerTimer标志时才会设置此字段。
  selfBaseDuration?: number,

  // Sum of base times for all descedents of this Fiber.
  // This value bubbles up during the "complete" phase.
  // This field is only set when the enableProfilerTimer flag is enabled.
  // 翻译：该Fiber对象所有后代的基准时间总和。该值在“完成”阶段写入。
  //      仅在启用enableProfilerTimer标志时才会设置此字段。
  treeBaseDuration?: number,

  // Conceptual aliases
  // 翻译：概念别名。
  // workInProgress : Fiber ->  alternate The alternate used for reuse happens
  // to be the same as work in progress.
  // 翻译：workInProgress : Fiber ->  alternate 用于重用的备用项恰好与进行中的Fiber对象相同。
  // __DEV__ only
  _debugID?: number,
  _debugSource?: Source | null,
  _debugOwner?: Fiber | null,
  _debugIsCurrentlyTiming?: boolean,
|};

let debugCounter;

if (__DEV__) {
  debugCounter = 1;
}

/**
 * Fiber对象的构造函数。
 * @param tag
 * @param pendingProps
 * @param key
 * @param mode
 * @constructor
 */
function FiberNode(
  tag: WorkTag,
  pendingProps: mixed,
  key: null | string,
  mode: TypeOfMode,
) {
  // Instance
  // 翻译：实例
  this.tag = tag;
  this.key = key;
  this.elementType = null;
  this.type = null;
  this.stateNode = null;

  // Fiber
  // 翻译：Fiber实例。
  // 这些是Fiber树的基础。
  this.return = null;
  this.child = null;
  this.sibling = null;
  this.index = 0;

  this.ref = null;

  this.pendingProps = pendingProps;
  this.memoizedProps = null;
  this.updateQueue = null;
  this.memoizedState = null;
  this.firstContextDependency = null;

  this.mode = mode;

  // Effects
  // 翻译：副作用。
  this.effectTag = NoEffect;
  this.nextEffect = null;

  this.firstEffect = null;
  this.lastEffect = null;

  this.expirationTime = NoWork;
  this.childExpirationTime = NoWork;

  this.alternate = null;

  if (enableProfilerTimer) {
    this.actualDuration = 0;
    this.actualStartTime = -1;
    this.selfBaseDuration = 0;
    this.treeBaseDuration = 0;
  }

  if (__DEV__) {
    this._debugID = debugCounter++;
    this._debugSource = null;
    this._debugOwner = null;
    this._debugIsCurrentlyTiming = false;
    if (!hasBadMapPolyfill && typeof Object.preventExtensions === 'function') {
      Object.preventExtensions(this);
    }
  }
}

// This is a constructor function, rather than a POJO constructor, still
// please ensure we do the following:
// 1) Nobody should add any instance methods on this. Instance methods can be
//    more difficult to predict when they get optimized and they are almost
//    never inlined properly in static compilers.
// 2) Nobody should rely on `instanceof Fiber` for type testing. We should
//    always know when it is a fiber.
// 3) We might want to experiment with using numeric keys since they are easier
//    to optimize in a non-JIT environment.
// 4) We can easily go from a constructor to a createFiber object literal if that
//    is faster.
// 5) It should be easy to port this to a C struct and keep a C implementation
//    compatible.
// 这个构造函数，而不是一个类，仍然请确保我们执行以下操作：
// 1) 禁止向此添加任何实例方法。优化实例方法时，很难预测它们，并且在静态编译器中几乎永远不会正确地插入它们。
// 2) 禁止依靠`instanceof Fiber`进行类型测试。我们应该始终知道它何时是Fiber对象。
// 3) 我们可能想尝试使用数字类型的key，因为它们在非JIT环境中更容易优化。
// 4) 为了更便捷，我们可以容易地从构造函数到createFiber函数。
// 5) 很容易将其移植到C结构并保持C实现兼容。
/**
 * 生成Fiber实例的方法。
 * @param tag
 * @param pendingProps
 * @param key
 * @param mode
 * @return {FiberNode}
 */
const createFiber = function(
  tag: WorkTag,
  pendingProps: mixed,
  key: null | string,
  mode: TypeOfMode,
): Fiber {
  // $FlowFixMe: the shapes are exact here but Flow doesn't like constructors
  // 翻译：对象结构在这里是精确的，但是Flow不喜欢构造函数。
  return new FiberNode(tag, pendingProps, key, mode);
};

function shouldConstruct(Component: Function) {
  const prototype = Component.prototype;
  return !!(prototype && prototype.isReactComponent);
}

export function isSimpleFunctionComponent(type: any) {
  return (
    typeof type === 'function' &&
    !shouldConstruct(type) &&
    type.defaultProps === undefined
  );
}

export function resolveLazyComponentTag(Component: Function): WorkTag {
  if (typeof Component === 'function') {
    return shouldConstruct(Component) ? ClassComponent : FunctionComponent;
  } else if (Component !== undefined && Component !== null) {
    const $$typeof = Component.$$typeof;
    if ($$typeof === REACT_FORWARD_REF_TYPE) {
      return ForwardRef;
    }
    if ($$typeof === REACT_MEMO_TYPE) {
      return MemoComponent;
    }
  }
  return IndeterminateComponent;
}

// This is used to create an alternate fiber to do work on.
// 翻译：这用于创建任务执行过程中的Fiber对象副本。
/**
 * 创建一个Fiber对象副本并返回，用于更新任务（也可以叫WorkInProgress）。
 * @param current Fiber对象
 * @param pendingProps 待处理的props
 * @param expirationTime 过期时间（无效参数）
 * @return {Fiber}
 */
export function createWorkInProgress(
  current: Fiber,
  pendingProps: any,
  expirationTime: ExpirationTime,
): Fiber {
  let workInProgress = current.alternate;
  if (workInProgress === null) {
    // 如果当前Fiber对象上的workInProgress不存在。
    // We use a double buffering pooling technique because we know that we'll
    // only ever need at most two versions of a tree. We pool the "other" unused
    // node that we're free to reuse. This is lazily created to avoid allocating
    // extra objects for things that are never updated. It also allow us to
    // reclaim the extra memory if needed.
    // 翻译：我们使用双重缓冲池技术，因为我们知道我们最多只需要一棵树的两个版本。
    //      我们汇集了可以自由重用的“其他”未使用节点。惰性地创建它是为了避免为永不更新的节点分配额外的对象。
    //      如果需要，它还允许我们回收额外的内存。
    // 使用与当前Fiber对象一样的参数创建一个新的workInProgress（也就是Fiber对象）。
    workInProgress = createFiber(
      current.tag,
      pendingProps,
      current.key,
      current.mode,
    );
    workInProgress.elementType = current.elementType;
    workInProgress.type = current.type;
    workInProgress.stateNode = current.stateNode;

    if (__DEV__) {
      // DEV-only fields
      workInProgress._debugID = current._debugID;
      workInProgress._debugSource = current._debugSource;
      workInProgress._debugOwner = current._debugOwner;
    }

    // 这里可以看出workInProgress的alternate和current的alternate是循环引用的关系
    workInProgress.alternate = current;
    current.alternate = workInProgress;
  } else {
    // 如果当前Fiber对象上的workInProgress存在。
    // 更新pendingProps。
    workInProgress.pendingProps = pendingProps;

    // We already have an alternate.
    // Reset the effect tag.
    // 翻译：我们已经有一个副本。重置effectTag。
    workInProgress.effectTag = NoEffect;

    // The effect list is no longer valid.
    // 翻译：effectList不再有效。
    workInProgress.nextEffect = null;
    workInProgress.firstEffect = null;
    workInProgress.lastEffect = null;

    if (enableProfilerTimer) {
      // We intentionally reset, rather than copy, actualDuration & actualStartTime.
      // This prevents time from endlessly accumulating in new commits.
      // This has the downside of resetting values for different priority renders,
      // But works for yielding (the common case) and should support resuming.
      // 翻译：我们故意重置而不是复制actualDuration和actualStartTime。
      //      这样可以防止时间无休止地累积在新提交中。
      //      这具有为不同的优先级渲染重置值的缺点，但可用于中断（常见情况）并且应支持恢复。
      workInProgress.actualDuration = 0;
      workInProgress.actualStartTime = -1;
    }
  }

  workInProgress.childExpirationTime = current.childExpirationTime;
  workInProgress.expirationTime = current.expirationTime;

  workInProgress.child = current.child;
  workInProgress.memoizedProps = current.memoizedProps;
  workInProgress.memoizedState = current.memoizedState;
  workInProgress.updateQueue = current.updateQueue;
  workInProgress.firstContextDependency = current.firstContextDependency;

  // These will be overridden during the parent's reconciliation
  // 翻译：在父节点调和期间，这些将被覆盖。
  workInProgress.sibling = current.sibling;
  workInProgress.index = current.index;
  workInProgress.ref = current.ref;

  if (enableProfilerTimer) {
    workInProgress.selfBaseDuration = current.selfBaseDuration;
    workInProgress.treeBaseDuration = current.treeBaseDuration;
  }

  // 返回生成的workInProgress。
  return workInProgress;
}

/**
 * 为FiberRoot对象的current属性创建Fiber对象
 * @param isConcurrent 是否异步
 * @return {Fiber}
 */
export function createHostRootFiber(isConcurrent: boolean): Fiber {
  let mode = isConcurrent ? ConcurrentMode | StrictMode : NoContext;

  if (enableProfilerTimer && isDevToolsPresent) {
    // Always collect profile timings when DevTools are present.
    // This enables DevTools to start capturing timing at any point–
    // Without some nodes in the tree having empty base times.
    // 翻译：存在DevTools时，请始终收集配置的时序。这使DevTools可以在任何时候开始捕获时序，
    //      除了节点树中的某些没有基准时间的节点。
    mode |= ProfileMode;
  }

  return createFiber(HostRoot, null, null, mode);
}

/**
 * 依据React元素的type个props生成Fiber对象
 * @param type React元素的type
 * @param key React元素的key
 * @param pendingProps React元素的props
 * @param owner dev下用到的_owner
 * @param mode 父级Fiber的mode
 * @param expirationTime 所在的FiberRoot的nextExpirationTimeToWorkOn
 * @return {Fiber|*}
 */
export function createFiberFromTypeAndProps(
  type: any, // React$ElementType
  key: null | string,
  pendingProps: any,
  owner: null | Fiber,
  mode: TypeOfMode,
  expirationTime: ExpirationTime,
): Fiber {
  let fiber;

  let fiberTag = IndeterminateComponent;
  // The resolved type is set if we know what the final type will be. I.e. it's not lazy.
  // 翻译：如果我们知道最终的类型，则将设置解析类型。 即 这不是偷懒。
  let resolvedType = type;
  if (typeof type === 'function') {
    if (shouldConstruct(type)) {
      fiberTag = ClassComponent;
    }
  } else if (typeof type === 'string') {
    fiberTag = HostComponent;
  } else {
    getTag: switch (type) {
      case REACT_FRAGMENT_TYPE:
        return createFiberFromFragment(
          pendingProps.children,
          mode,
          expirationTime,
          key,
        );
      case REACT_CONCURRENT_MODE_TYPE:
        return createFiberFromMode(
          pendingProps,
          mode | ConcurrentMode | StrictMode,
          expirationTime,
          key,
        );
      case REACT_STRICT_MODE_TYPE:
        return createFiberFromMode(
          pendingProps,
          mode | StrictMode,
          expirationTime,
          key,
        );
      case REACT_PROFILER_TYPE:
        return createFiberFromProfiler(pendingProps, mode, expirationTime, key);
      case REACT_SUSPENSE_TYPE:
        return createFiberFromSuspense(pendingProps, mode, expirationTime, key);
      default: {
        if (typeof type === 'object' && type !== null) {
          switch (type.$$typeof) {
            case REACT_PROVIDER_TYPE:
              fiberTag = ContextProvider;
              break getTag;
            case REACT_CONTEXT_TYPE:
              // This is a consumer
              // 翻译：这是一个consumer标签
              fiberTag = ContextConsumer;
              break getTag;
            case REACT_FORWARD_REF_TYPE:
              fiberTag = ForwardRef;
              break getTag;
            case REACT_MEMO_TYPE:
              fiberTag = MemoComponent;
              break getTag;
            case REACT_LAZY_TYPE:
              fiberTag = LazyComponent;
              resolvedType = null;
              break getTag;
          }
        }
        let info = '';
        if (__DEV__) {
          if (
            type === undefined ||
            (typeof type === 'object' &&
              type !== null &&
              Object.keys(type).length === 0)
          ) {
            info +=
              ' You likely forgot to export your component from the file ' +
              "it's defined in, or you might have mixed up default and " +
              'named imports.';
          }
          const ownerName = owner ? getComponentName(owner.type) : null;
          if (ownerName) {
            info += '\n\nCheck the render method of `' + ownerName + '`.';
          }
        }
        invariant(
          false,
          'Element type is invalid: expected a string (for built-in ' +
            'components) or a class/function (for composite components) ' +
            'but got: %s.%s',
          type == null ? type : typeof type,
          info,
        );
      }
    }
  }

  fiber = createFiber(fiberTag, pendingProps, key, mode);
  fiber.elementType = type;
  fiber.type = resolvedType;
  fiber.expirationTime = expirationTime;

  return fiber;
}

/**
 * 使用React元素创建Fiber对象
 * @param element React元素
 * @param mode 父级Fiber的mode
 * @param expirationTime 所在的FiberRoot的nextExpirationTimeToWorkOn
 * @return {Fiber}
 */
export function createFiberFromElement(
  element: ReactElement,
  mode: TypeOfMode,
  expirationTime: ExpirationTime,
): Fiber {
  let owner = null;
  if (__DEV__) {
    owner = element._owner;
  }
  const type = element.type;
  const key = element.key;
  const pendingProps = element.props;
  const fiber = createFiberFromTypeAndProps(
    type,
    key,
    pendingProps,
    owner,
    mode,
    expirationTime,
  );
  if (__DEV__) {
    fiber._debugSource = element._source;
    fiber._debugOwner = element._owner;
  }
  return fiber;
}

export function createFiberFromFragment(
  elements: ReactFragment,
  mode: TypeOfMode,
  expirationTime: ExpirationTime,
  key: null | string,
): Fiber {
  const fiber = createFiber(Fragment, elements, key, mode);
  fiber.expirationTime = expirationTime;
  return fiber;
}

function createFiberFromProfiler(
  pendingProps: any,
  mode: TypeOfMode,
  expirationTime: ExpirationTime,
  key: null | string,
): Fiber {
  if (__DEV__) {
    if (
      typeof pendingProps.id !== 'string' ||
      typeof pendingProps.onRender !== 'function'
    ) {
      warningWithoutStack(
        false,
        'Profiler must specify an "id" string and "onRender" function as props',
      );
    }
  }

  const fiber = createFiber(Profiler, pendingProps, key, mode | ProfileMode);
  // TODO: The Profiler fiber shouldn't have a type. It has a tag.
  fiber.elementType = REACT_PROFILER_TYPE;
  fiber.type = REACT_PROFILER_TYPE;
  fiber.expirationTime = expirationTime;

  return fiber;
}

function createFiberFromMode(
  pendingProps: any,
  mode: TypeOfMode,
  expirationTime: ExpirationTime,
  key: null | string,
): Fiber {
  const fiber = createFiber(Mode, pendingProps, key, mode);

  // TODO: The Mode fiber shouldn't have a type. It has a tag.
  const type =
    (mode & ConcurrentMode) === NoContext
      ? REACT_STRICT_MODE_TYPE
      : REACT_CONCURRENT_MODE_TYPE;
  fiber.elementType = type;
  fiber.type = type;

  fiber.expirationTime = expirationTime;
  return fiber;
}

export function createFiberFromSuspense(
  pendingProps: any,
  mode: TypeOfMode,
  expirationTime: ExpirationTime,
  key: null | string,
) {
  const fiber = createFiber(SuspenseComponent, pendingProps, key, mode);

  // TODO: The SuspenseComponent fiber shouldn't have a type. It has a tag.
  const type = REACT_SUSPENSE_TYPE;
  fiber.elementType = type;
  fiber.type = type;

  fiber.expirationTime = expirationTime;
  return fiber;
}

export function createFiberFromText(
  content: string,
  mode: TypeOfMode,
  expirationTime: ExpirationTime,
): Fiber {
  const fiber = createFiber(HostText, content, null, mode);
  fiber.expirationTime = expirationTime;
  return fiber;
}

export function createFiberFromHostInstanceForDeletion(): Fiber {
  const fiber = createFiber(HostComponent, null, null, NoContext);
  // TODO: These should not need a type.
  fiber.elementType = 'DELETED';
  fiber.type = 'DELETED';
  return fiber;
}

export function createFiberFromPortal(
  portal: ReactPortal,
  mode: TypeOfMode,
  expirationTime: ExpirationTime,
): Fiber {
  const pendingProps = portal.children !== null ? portal.children : [];
  const fiber = createFiber(HostPortal, pendingProps, portal.key, mode);
  fiber.expirationTime = expirationTime;
  fiber.stateNode = {
    containerInfo: portal.containerInfo,
    pendingChildren: null, // Used by persistent updates
    implementation: portal.implementation,
  };
  return fiber;
}

// Used for stashing WIP properties to replay failed work in DEV.
export function assignFiberPropertiesInDEV(
  target: Fiber | null,
  source: Fiber,
): Fiber {
  if (target === null) {
    // This Fiber's initial properties will always be overwritten.
    // We only use a Fiber to ensure the same hidden class so DEV isn't slow.
    target = createFiber(IndeterminateComponent, null, null, NoContext);
  }

  // This is intentionally written as a list of all properties.
  // We tried to use Object.assign() instead but this is called in
  // the hottest path, and Object.assign() was too slow:
  // https://github.com/facebook/react/issues/12502
  // This code is DEV-only so size is not a concern.

  target.tag = source.tag;
  target.key = source.key;
  target.elementType = source.elementType;
  target.type = source.type;
  target.stateNode = source.stateNode;
  target.return = source.return;
  target.child = source.child;
  target.sibling = source.sibling;
  target.index = source.index;
  target.ref = source.ref;
  target.pendingProps = source.pendingProps;
  target.memoizedProps = source.memoizedProps;
  target.updateQueue = source.updateQueue;
  target.memoizedState = source.memoizedState;
  target.firstContextDependency = source.firstContextDependency;
  target.mode = source.mode;
  target.effectTag = source.effectTag;
  target.nextEffect = source.nextEffect;
  target.firstEffect = source.firstEffect;
  target.lastEffect = source.lastEffect;
  target.expirationTime = source.expirationTime;
  target.childExpirationTime = source.childExpirationTime;
  target.alternate = source.alternate;
  if (enableProfilerTimer) {
    target.actualDuration = source.actualDuration;
    target.actualStartTime = source.actualStartTime;
    target.selfBaseDuration = source.selfBaseDuration;
    target.treeBaseDuration = source.treeBaseDuration;
  }
  target._debugID = source._debugID;
  target._debugSource = source._debugSource;
  target._debugOwner = source._debugOwner;
  target._debugIsCurrentlyTiming = source._debugIsCurrentlyTiming;
  return target;
}
