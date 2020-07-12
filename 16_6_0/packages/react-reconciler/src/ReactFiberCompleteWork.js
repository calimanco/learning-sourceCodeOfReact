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
import type {FiberRoot} from './ReactFiberRoot';
import type {
  Instance,
  Type,
  Props,
  Container,
  ChildSet,
} from './ReactFiberHostConfig';
import type {SuspenseState} from './ReactFiberSuspenseComponent';

import {
  IndeterminateComponent,
  FunctionComponent,
  ClassComponent,
  HostRoot,
  HostComponent,
  HostText,
  HostPortal,
  ContextProvider,
  ContextConsumer,
  ForwardRef,
  Fragment,
  Mode,
  Profiler,
  SuspenseComponent,
  MemoComponent,
  SimpleMemoComponent,
  LazyComponent,
  IncompleteClassComponent,
} from 'shared/ReactWorkTags';
import {Placement, Ref, Update} from 'shared/ReactSideEffectTags';
import invariant from 'shared/invariant';

import {
  createInstance,
  createTextInstance,
  createHiddenTextInstance,
  appendInitialChild,
  finalizeInitialChildren,
  prepareUpdate,
  supportsMutation,
  supportsPersistence,
  cloneInstance,
  cloneHiddenInstance,
  cloneUnhiddenInstance,
  createContainerChildSet,
  appendChildToContainerChildSet,
  finalizeContainerChildren,
} from './ReactFiberHostConfig';
import {
  getRootHostContainer,
  popHostContext,
  getHostContext,
  popHostContainer,
} from './ReactFiberHostContext';
import {
  isContextProvider as isLegacyContextProvider,
  popContext as popLegacyContext,
  popTopLevelContextObject as popTopLevelLegacyContextObject,
} from './ReactFiberContext';
import {popProvider} from './ReactFiberNewContext';
import {
  prepareToHydrateHostInstance,
  prepareToHydrateHostTextInstance,
  popHydrationState,
} from './ReactFiberHydrationContext';

function markUpdate(workInProgress: Fiber) {
  // Tag the fiber with an update effect. This turns a Placement into
  // a PlacementAndUpdate.
  workInProgress.effectTag |= Update;
}

function markRef(workInProgress: Fiber) {
  workInProgress.effectTag |= Ref;
}

let appendAllChildren;
let updateHostContainer;
let updateHostComponent;
let updateHostText;

// 下面会根据环境不同，为上面的函数定义。
if (supportsMutation) {
  // 浏览器环境将运行这一部分。
  // Mutation mode
  // 翻译：混合模式。

  appendAllChildren = function(
    parent: Instance,
    workInProgress: Fiber,
    needsVisibilityToggle: boolean,
    isHidden: boolean,
  ) {
    // We only have the top Fiber that was created but we need recurse down its
    // children to find all the terminal nodes.
    // 翻译：我们只有创建的顶级Fiber节点，但是我们需要递归其子级以找到所有终端节点。
    let node = workInProgress.child;
    // 找到第一层HostComponent并且执行append，并不会嵌套append。
    while (node !== null) {
      if (node.tag === HostComponent || node.tag === HostText) {
        // 处理HostComponent。
        // 在浏览器环境就是DOM的appendChild方法，将子节点append到当前的DOM里。
        appendInitialChild(parent, node.stateNode);
      } else if (node.tag === HostPortal) {
        // If we have a portal child, then we don't want to traverse
        // down its children. Instead, we'll get insertions from each child in
        // the portal directly.
        // 翻译：如果我们有一个portal类型的子节点，那么我们就不想遍历它的子节点。
        //      相反，我们将直接从portal节点中的每个子节点那里获得插入。
      } else if (node.child !== null) {
        node.child.return = node;
        node = node.child;
        continue;
      }
      if (node === workInProgress) {
        return;
      }
      while (node.sibling === null) {
        if (node.return === null || node.return === workInProgress) {
          return;
        }
        node = node.return;
      }
      node.sibling.return = node.return;
      node = node.sibling;
    }
  };

  updateHostContainer = function(workInProgress: Fiber) {
    // Noop
  };
  updateHostComponent = function(
    current: Fiber,
    workInProgress: Fiber,
    type: Type,
    newProps: Props,
    rootContainerInstance: Container,
  ) {
    // If we have an alternate, that means this is an update and we need to
    // schedule a side-effect to do the updates.
    // 翻译：如果我们有一个alternate，则意味着这是一个更新，我们需要安排一个side-effect来进行更新。
    const oldProps = current.memoizedProps;
    if (oldProps === newProps) {
      // In mutation mode, this is sufficient for a bailout because
      // we won't touch this node even if children changed.
      // 翻译：在mutation模式下，这足以进行处理，因为即使子代发生更改，我们也不会触摸此节点。
      return;
    }

    // If we get updated because one of our children updated, we don't
    // have newProps so we'll have to reuse them.
    // 翻译：如果我们由于其中一个子节点已更新而得到update，则我们没有newProps，因此我们将不得不重用它们。
    // TODO: Split the update API as separate for the props vs. children.
    // Even better would be if children weren't special cased at all tho.
    // DOM实例。
    const instance: Instance = workInProgress.stateNode;
    // context相关。
    const currentHostContext = getHostContext();
    // TODO: Experiencing an error where oldProps is null. Suggests a host
    // component is hitting the resume path. Figure out why. Possibly
    // related to `hidden`.
    // 调用diffProperties计算新旧props差异，获得updateQueue。
    const updatePayload = prepareUpdate(
      instance,
      type,
      oldProps,
      newProps,
      rootContainerInstance,
      currentHostContext,
    );
    // TODO: Type this specific to this type of component.
    workInProgress.updateQueue = (updatePayload: any);
    // If the update payload indicates that there is a change or if there
    // is a new ref we mark this as an update. All the work is done in commitWork.
    // 翻译：如果update有效负载表明存在更改，或者存在新ref，则将其标记为更新。
    //      所有工作都在commitWork中完成。
    if (updatePayload) {
      markUpdate(workInProgress);
    }
  };
  updateHostText = function(
    current: Fiber,
    workInProgress: Fiber,
    oldText: string,
    newText: string,
  ) {
    // If the text differs, mark it as an update. All the work in done in commitWork.
    // 翻译：如果文本不同，请将其标记为更新。 所有工作都在commitWork中完成。
    if (oldText !== newText) {
      markUpdate(workInProgress);
    }
  };
} else if (supportsPersistence) {
  // Persistent host tree mode
  // 翻译：永久根节点树模式。

  appendAllChildren = function(
    parent: Instance,
    workInProgress: Fiber,
    needsVisibilityToggle: boolean,
    isHidden: boolean,
  ) {
    // We only have the top Fiber that was created but we need recurse down its
    // children to find all the terminal nodes.
    let node = workInProgress.child;
    while (node !== null) {
      // eslint-disable-next-line no-labels
      branches: if (node.tag === HostComponent) {
        let instance = node.stateNode;
        if (needsVisibilityToggle) {
          const props = node.memoizedProps;
          const type = node.type;
          if (isHidden) {
            // This child is inside a timed out tree. Hide it.
            instance = cloneHiddenInstance(instance, type, props, node);
          } else {
            // This child was previously inside a timed out tree. If it was not
            // updated during this render, it may need to be unhidden. Clone
            // again to be sure.
            instance = cloneUnhiddenInstance(instance, type, props, node);
          }
          node.stateNode = instance;
        }
        appendInitialChild(parent, instance);
      } else if (node.tag === HostText) {
        let instance = node.stateNode;
        if (needsVisibilityToggle) {
          const text = node.memoizedProps;
          const rootContainerInstance = getRootHostContainer();
          const currentHostContext = getHostContext();
          if (isHidden) {
            instance = createHiddenTextInstance(
              text,
              rootContainerInstance,
              currentHostContext,
              workInProgress,
            );
          } else {
            instance = createTextInstance(
              text,
              rootContainerInstance,
              currentHostContext,
              workInProgress,
            );
          }
          node.stateNode = instance;
        }
        appendInitialChild(parent, instance);
      } else if (node.tag === HostPortal) {
        // If we have a portal child, then we don't want to traverse
        // down its children. Instead, we'll get insertions from each child in
        // the portal directly.
      } else if (node.tag === SuspenseComponent) {
        const current = node.alternate;
        if (current !== null) {
          const oldState: SuspenseState = current.memoizedState;
          const newState: SuspenseState = node.memoizedState;
          const oldIsHidden = oldState !== null && oldState.didTimeout;
          const newIsHidden = newState !== null && newState.didTimeout;
          if (oldIsHidden !== newIsHidden) {
            // The placeholder either just timed out or switched back to the normal
            // children after having previously timed out. Toggle the visibility of
            // the direct host children.
            const primaryChildParent = newIsHidden ? node.child : node;
            if (primaryChildParent !== null) {
              appendAllChildren(parent, primaryChildParent, true, newIsHidden);
            }
            // eslint-disable-next-line no-labels
            break branches;
          }
        }
        if (node.child !== null) {
          // Continue traversing like normal
          node.child.return = node;
          node = node.child;
          continue;
        }
      } else if (node.child !== null) {
        node.child.return = node;
        node = node.child;
        continue;
      }
      // $FlowFixMe This is correct but Flow is confused by the labeled break.
      node = (node: Fiber);
      if (node === workInProgress) {
        return;
      }
      while (node.sibling === null) {
        if (node.return === null || node.return === workInProgress) {
          return;
        }
        node = node.return;
      }
      node.sibling.return = node.return;
      node = node.sibling;
    }
  };

  // An unfortunate fork of appendAllChildren because we have two different parent types.
  const appendAllChildrenToContainer = function(
    containerChildSet: ChildSet,
    workInProgress: Fiber,
    needsVisibilityToggle: boolean,
    isHidden: boolean,
  ) {
    // We only have the top Fiber that was created but we need recurse down its
    // children to find all the terminal nodes.
    let node = workInProgress.child;
    while (node !== null) {
      // eslint-disable-next-line no-labels
      branches: if (node.tag === HostComponent) {
        let instance = node.stateNode;
        if (needsVisibilityToggle) {
          const props = node.memoizedProps;
          const type = node.type;
          if (isHidden) {
            // This child is inside a timed out tree. Hide it.
            instance = cloneHiddenInstance(instance, type, props, node);
          } else {
            // This child was previously inside a timed out tree. If it was not
            // updated during this render, it may need to be unhidden. Clone
            // again to be sure.
            instance = cloneUnhiddenInstance(instance, type, props, node);
          }
          node.stateNode = instance;
        }
        appendChildToContainerChildSet(containerChildSet, instance);
      } else if (node.tag === HostText) {
        let instance = node.stateNode;
        if (needsVisibilityToggle) {
          const text = node.memoizedProps;
          const rootContainerInstance = getRootHostContainer();
          const currentHostContext = getHostContext();
          if (isHidden) {
            instance = createHiddenTextInstance(
              text,
              rootContainerInstance,
              currentHostContext,
              workInProgress,
            );
          } else {
            instance = createTextInstance(
              text,
              rootContainerInstance,
              currentHostContext,
              workInProgress,
            );
          }
          node.stateNode = instance;
        }
        appendChildToContainerChildSet(containerChildSet, instance);
      } else if (node.tag === HostPortal) {
        // If we have a portal child, then we don't want to traverse
        // down its children. Instead, we'll get insertions from each child in
        // the portal directly.
      } else if (node.tag === SuspenseComponent) {
        const current = node.alternate;
        if (current !== null) {
          const oldState: SuspenseState = current.memoizedState;
          const newState: SuspenseState = node.memoizedState;
          const oldIsHidden = oldState !== null && oldState.didTimeout;
          const newIsHidden = newState !== null && newState.didTimeout;
          if (oldIsHidden !== newIsHidden) {
            // The placeholder either just timed out or switched back to the normal
            // children after having previously timed out. Toggle the visibility of
            // the direct host children.
            const primaryChildParent = newIsHidden ? node.child : node;
            if (primaryChildParent !== null) {
              appendAllChildrenToContainer(
                containerChildSet,
                primaryChildParent,
                true,
                newIsHidden,
              );
            }
            // eslint-disable-next-line no-labels
            break branches;
          }
        }
        if (node.child !== null) {
          // Continue traversing like normal
          node.child.return = node;
          node = node.child;
          continue;
        }
      } else if (node.child !== null) {
        node.child.return = node;
        node = node.child;
        continue;
      }
      // $FlowFixMe This is correct but Flow is confused by the labeled break.
      node = (node: Fiber);
      if (node === workInProgress) {
        return;
      }
      while (node.sibling === null) {
        if (node.return === null || node.return === workInProgress) {
          return;
        }
        node = node.return;
      }
      node.sibling.return = node.return;
      node = node.sibling;
    }
  };
  updateHostContainer = function(workInProgress: Fiber) {
    const portalOrRoot: {
      containerInfo: Container,
      pendingChildren: ChildSet,
    } =
      workInProgress.stateNode;
    const childrenUnchanged = workInProgress.firstEffect === null;
    if (childrenUnchanged) {
      // No changes, just reuse the existing instance.
    } else {
      const container = portalOrRoot.containerInfo;
      let newChildSet = createContainerChildSet(container);
      // If children might have changed, we have to add them all to the set.
      appendAllChildrenToContainer(newChildSet, workInProgress, false, false);
      portalOrRoot.pendingChildren = newChildSet;
      // Schedule an update on the container to swap out the container.
      markUpdate(workInProgress);
      finalizeContainerChildren(container, newChildSet);
    }
  };
  updateHostComponent = function(
    current: Fiber,
    workInProgress: Fiber,
    type: Type,
    newProps: Props,
    rootContainerInstance: Container,
  ) {
    const currentInstance = current.stateNode;
    const oldProps = current.memoizedProps;
    // If there are no effects associated with this node, then none of our children had any updates.
    // This guarantees that we can reuse all of them.
    const childrenUnchanged = workInProgress.firstEffect === null;
    if (childrenUnchanged && oldProps === newProps) {
      // No changes, just reuse the existing instance.
      // Note that this might release a previous clone.
      workInProgress.stateNode = currentInstance;
      return;
    }
    const recyclableInstance: Instance = workInProgress.stateNode;
    const currentHostContext = getHostContext();
    let updatePayload = null;
    if (oldProps !== newProps) {
      updatePayload = prepareUpdate(
        recyclableInstance,
        type,
        oldProps,
        newProps,
        rootContainerInstance,
        currentHostContext,
      );
    }
    if (childrenUnchanged && updatePayload === null) {
      // No changes, just reuse the existing instance.
      // Note that this might release a previous clone.
      workInProgress.stateNode = currentInstance;
      return;
    }
    let newInstance = cloneInstance(
      currentInstance,
      updatePayload,
      type,
      oldProps,
      newProps,
      workInProgress,
      childrenUnchanged,
      recyclableInstance,
    );
    if (
      finalizeInitialChildren(
        newInstance,
        type,
        newProps,
        rootContainerInstance,
        currentHostContext,
      )
    ) {
      markUpdate(workInProgress);
    }
    workInProgress.stateNode = newInstance;
    if (childrenUnchanged) {
      // If there are no other effects in this tree, we need to flag this node as having one.
      // Even though we're not going to use it for anything.
      // Otherwise parents won't know that there are new children to propagate upwards.
      markUpdate(workInProgress);
    } else {
      // If children might have changed, we have to add them all to the set.
      appendAllChildren(newInstance, workInProgress, false, false);
    }
  };
  updateHostText = function(
    current: Fiber,
    workInProgress: Fiber,
    oldText: string,
    newText: string,
  ) {
    if (oldText !== newText) {
      // If the text content differs, we'll create a new text instance for it.
      const rootContainerInstance = getRootHostContainer();
      const currentHostContext = getHostContext();
      workInProgress.stateNode = createTextInstance(
        newText,
        rootContainerInstance,
        currentHostContext,
        workInProgress,
      );
      // We'll have to mark it as having an effect, even though we won't use the effect for anything.
      // This lets the parents know that at least one of their children has changed.
      markUpdate(workInProgress);
    }
  };
} else {
  // No host operations
  // 翻译：无根节点树操作。
  updateHostContainer = function(workInProgress: Fiber) {
    // Noop
  };
  updateHostComponent = function(
    current: Fiber,
    workInProgress: Fiber,
    type: Type,
    newProps: Props,
    rootContainerInstance: Container,
  ) {
    // Noop
  };
  updateHostText = function(
    current: Fiber,
    workInProgress: Fiber,
    oldText: string,
    newText: string,
  ) {
    // Noop
  };
}

/**
 * 完成节点的工作。
 * @param current 当前处理的Fiber节点
 * @param workInProgress 当前处理的Fiber节点的进行中副本
 * @param renderExpirationTime 当前处理的Fiber所在的FiberRoot的nextExpirationTimeToWorkOn
 * @return {null}
 */
function completeWork(
  current: Fiber | null,
  workInProgress: Fiber,
  renderExpirationTime: ExpirationTime,
): Fiber | null {
  const newProps = workInProgress.pendingProps;

  // 分类型处理。
  switch (workInProgress.tag) {
    case IndeterminateComponent:
      break;
    case LazyComponent:
      break;
    case SimpleMemoComponent:
    case FunctionComponent:
      break;
    case ClassComponent: {
      const Component = workInProgress.type;
      if (isLegacyContextProvider(Component)) {
        popLegacyContext(workInProgress);
      }
      break;
    }
    case HostRoot: {
      // context相关处理。
      popHostContainer(workInProgress);
      popTopLevelLegacyContextObject(workInProgress);
      const fiberRoot = (workInProgress.stateNode: FiberRoot);
      if (fiberRoot.pendingContext) {
        fiberRoot.context = fiberRoot.pendingContext;
        fiberRoot.pendingContext = null;
      }
      if (current === null || current.child === null) {
        // If we hydrated, pop so that we can delete any remaining children
        // that weren't hydrated.
        // 翻译：如果我们已经hydrate，为了我们可以删除所有未hydrate的子节点，我们需要进行出栈操作。
        popHydrationState(workInProgress);
        // This resets the hacky state to fix isMounted before committing.
        // 翻译：这是一个hacky状态以修复
        // TODO: Delete this when we delete isMounted and findDOMNode.
        workInProgress.effectTag &= ~Placement;
      }
      // 这个方法在浏览器环境是空方法。
      updateHostContainer(workInProgress);
      break;
    }
    case HostComponent: {
      // context相关处理。
      popHostContext(workInProgress);
      const rootContainerInstance = getRootHostContainer();
      const type = workInProgress.type;
      if (current !== null && workInProgress.stateNode != null) {
        // 二次渲染。
        updateHostComponent(
          current,
          workInProgress,
          type,
          newProps,
          rootContainerInstance,
        );

        if (current.ref !== workInProgress.ref) {
          markRef(workInProgress);
        }
      } else {
        // 首次渲染。
        if (!newProps) {
          // 没有props，说明这个节点有问题，报错。
          invariant(
            workInProgress.stateNode !== null,
            'We must have new props for new mounts. This error is likely ' +
              'caused by a bug in React. Please file an issue.',
          );
          // This can happen when we abort work.
          // 翻译：当我们中止工作时，会发生这种情况。
          break;
        }

        // context相关。
        const currentHostContext = getHostContext();
        // TODO: Move createInstance to beginWork and keep it on a context
        // "stack" as the parent. Then append children as we go in beginWork
        // or completeWork depending on we want to add then top->down or
        // bottom->up. Top->down is faster in IE11.
        // Hydrate相关。
        let wasHydrated = popHydrationState(workInProgress);
        if (wasHydrated) {
          // TODO: Move this and createInstance step into the beginPhase
          // to consolidate.
          if (
            prepareToHydrateHostInstance(
              workInProgress,
              rootContainerInstance,
              currentHostContext,
            )
          ) {
            // If changes to the hydrated node needs to be applied at the
            // commit-phase we mark this as such.
            // 翻译：如果需要在提交阶段对hydrate节点进行更改，则将其标记为这样。
            markUpdate(workInProgress);
          }
        } else {
          // 创建DOM实例，这里返回的是一个DOM对象。
          let instance = createInstance(
            type,
            newProps,
            rootContainerInstance,
            currentHostContext,
            workInProgress,
          );

          // 将当前节点的子节点的DOM加入到父节点的DOM里。
          appendAllChildren(instance, workInProgress, false, false);

          // Certain renderers require commit-time effects for initial mount.
          // (eg DOM renderer supports auto-focus for certain elements).
          // Make sure such renderers get scheduled for later work.
          // 翻译：某些渲染器需要提交时效果才能进行初始挂载。
          //      (eg DOM渲染器支持某些元素的自动聚焦)
          //      确保安排此类渲染器用于以后的工作。
          if (
            // 初始化DOM节点，包括扩展属性、样式、事件。
            finalizeInitialChildren(
              instance,
              type,
              newProps,
              rootContainerInstance,
              currentHostContext,
            )
          ) {
            // 只有节点有autoFocus属性时才会执行。
            markUpdate(workInProgress);
          }
          // 将DOM挂载到Fiber的stateNode属性。
          workInProgress.stateNode = instance;
        }

        if (workInProgress.ref !== null) {
          // If there is a ref on a host node we need to schedule a callback
          // 翻译：如果根节点上有引用，我们需要安排回调。
          markRef(workInProgress);
        }
      }
      break;
    }
    case HostText: {
      let newText = newProps;
      if (current && workInProgress.stateNode != null) {
        // 二次渲染。
        const oldText = current.memoizedProps;
        // If we have an alternate, that means this is an update and we need
        // to schedule a side-effect to do the updates.
        // 翻译：如果我们有一个alternate，则意味着这是一个更新，我们需要安排一个side-effect来进行更新。
        updateHostText(current, workInProgress, oldText, newText);
      } else {
        // 首次渲染。
        if (typeof newText !== 'string') {
          invariant(
            workInProgress.stateNode !== null,
            'We must have new props for new mounts. This error is likely ' +
              'caused by a bug in React. Please file an issue.',
          );
          // This can happen when we abort work.
          // 翻译：这会在我们取消任务时发生。
        }
        const rootContainerInstance = getRootHostContainer();
        const currentHostContext = getHostContext();
        // Hydrate相关
        let wasHydrated = popHydrationState(workInProgress);
        if (wasHydrated) {
          if (prepareToHydrateHostTextInstance(workInProgress)) {
            markUpdate(workInProgress);
          }
        } else {
          workInProgress.stateNode = createTextInstance(
            newText,
            rootContainerInstance,
            currentHostContext,
            workInProgress,
          );
        }
      }
      break;
    }
    case ForwardRef:
      break;
    case SuspenseComponent: {
      const nextState = workInProgress.memoizedState;
      const prevState = current !== null ? current.memoizedState : null;
      const nextDidTimeout = nextState !== null && nextState.didTimeout;
      const prevDidTimeout = prevState !== null && prevState.didTimeout;
      if (nextDidTimeout !== prevDidTimeout) {
        // If this render commits, and it switches between the normal state
        // and the timed-out state, schedule an effect.
        // 翻译：如果此渲染提交，并且在正常状态和超时状态之间切换，请安排效果。
        workInProgress.effectTag |= Update;
      }
      break;
    }
    case Fragment:
      break;
    case Mode:
      break;
    case Profiler:
      break;
    case HostPortal:
      popHostContainer(workInProgress);
      updateHostContainer(workInProgress);
      break;
    case ContextProvider:
      // Pop provider fiber
      popProvider(workInProgress);
      break;
    case ContextConsumer:
      break;
    case MemoComponent:
      break;
    case IncompleteClassComponent: {
      // Same as class component case. I put it down here so that the tags are
      // sequential to ensure this switch is compiled to a jump table.
      const Component = workInProgress.type;
      if (isLegacyContextProvider(Component)) {
        popLegacyContext(workInProgress);
      }
      break;
    }
    default:
      invariant(
        false,
        'Unknown unit of work tag. This error is likely caused by a bug in ' +
          'React. Please file an issue.',
      );
  }

  return null;
}

export {completeWork};
