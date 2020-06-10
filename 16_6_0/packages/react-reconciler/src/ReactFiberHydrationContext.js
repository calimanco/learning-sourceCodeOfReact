/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {Fiber} from './ReactFiber';
import type {
  Instance,
  TextInstance,
  HydratableInstance,
  Container,
  HostContext,
} from './ReactFiberHostConfig';

import {HostComponent, HostText, HostRoot} from 'shared/ReactWorkTags';
import {Deletion, Placement} from 'shared/ReactSideEffectTags';
import invariant from 'shared/invariant';

import {createFiberFromHostInstanceForDeletion} from './ReactFiber';
import {
  shouldSetTextContent,
  supportsHydration,
  canHydrateInstance,
  canHydrateTextInstance,
  getNextHydratableSibling,
  getFirstHydratableChild,
  hydrateInstance,
  hydrateTextInstance,
  didNotMatchHydratedContainerTextInstance,
  didNotMatchHydratedTextInstance,
  didNotHydrateContainerInstance,
  didNotHydrateInstance,
  didNotFindHydratableContainerInstance,
  didNotFindHydratableContainerTextInstance,
  didNotFindHydratableInstance,
  didNotFindHydratableTextInstance,
} from './ReactFiberHostConfig';

// The deepest Fiber on the stack involved in a hydration context.
// This may have been an insertion or a hydration.
let hydrationParentFiber: null | Fiber = null;
let nextHydratableInstance: null | HydratableInstance = null;
let isHydrating: boolean = false;

function enterHydrationState(fiber: Fiber): boolean {
  // supportsHydration固定为true。
  if (!supportsHydration) {
    return false;
  }

  // DOM节点。
  const parentInstance = fiber.stateNode.containerInfo;
  // 找parentInstance下的第一层所有子节点里nodeType是ELEMENT_NODE和TEXT_NODE的节点。
  // 返回找到的第一个DOM节点。
  nextHydratableInstance = getFirstHydratableChild(parentInstance);
  // 保存当前要hydrate的Fiber。
  hydrationParentFiber = fiber;
  // 标记开始hydrate流程。
  isHydrating = true;
  return true;
}

function deleteHydratableInstance(
  returnFiber: Fiber,
  instance: HydratableInstance,
) {
  if (__DEV__) {
    switch (returnFiber.tag) {
      case HostRoot:
        didNotHydrateContainerInstance(
          returnFiber.stateNode.containerInfo,
          instance,
        );
        break;
      case HostComponent:
        didNotHydrateInstance(
          returnFiber.type,
          returnFiber.memoizedProps,
          returnFiber.stateNode,
          instance,
        );
        break;
    }
  }

  const childToDelete = createFiberFromHostInstanceForDeletion();
  childToDelete.stateNode = instance;
  childToDelete.return = returnFiber;
  childToDelete.effectTag = Deletion;

  // This might seem like it belongs on progressedFirstDeletion. However,
  // these children are not part of the reconciliation list of children.
  // Even if we abort and rereconcile the children, that will try to hydrate
  // again and the nodes are still in the host tree so these will be
  // recreated.
  if (returnFiber.lastEffect !== null) {
    returnFiber.lastEffect.nextEffect = childToDelete;
    returnFiber.lastEffect = childToDelete;
  } else {
    returnFiber.firstEffect = returnFiber.lastEffect = childToDelete;
  }
}

function insertNonHydratedInstance(returnFiber: Fiber, fiber: Fiber) {
  fiber.effectTag |= Placement;
  if (__DEV__) {
    switch (returnFiber.tag) {
      case HostRoot: {
        const parentContainer = returnFiber.stateNode.containerInfo;
        switch (fiber.tag) {
          case HostComponent:
            const type = fiber.type;
            const props = fiber.pendingProps;
            didNotFindHydratableContainerInstance(parentContainer, type, props);
            break;
          case HostText:
            const text = fiber.pendingProps;
            didNotFindHydratableContainerTextInstance(parentContainer, text);
            break;
        }
        break;
      }
      case HostComponent: {
        const parentType = returnFiber.type;
        const parentProps = returnFiber.memoizedProps;
        const parentInstance = returnFiber.stateNode;
        switch (fiber.tag) {
          case HostComponent:
            const type = fiber.type;
            const props = fiber.pendingProps;
            didNotFindHydratableInstance(
              parentType,
              parentProps,
              parentInstance,
              type,
              props,
            );
            break;
          case HostText:
            const text = fiber.pendingProps;
            didNotFindHydratableTextInstance(
              parentType,
              parentProps,
              parentInstance,
              text,
            );
            break;
        }
        break;
      }
      default:
        return;
    }
  }
}

/**
 * 尝试进行hydrate操作。
 * @param fiber 要处理的Fiber节点
 * @param nextInstance 要处理的DOM节点
 * @return {boolean}
 */
function tryHydrate(fiber, nextInstance) {
  switch (fiber.tag) {
    case HostComponent: {
      const type = fiber.type;
      const props = fiber.pendingProps;
      // 如果nodeType不等于ELEMENT_NODE，或nodeName不一致，则返回null，否则返回nextInstance本身。
      const instance = canHydrateInstance(nextInstance, type, props);
      if (instance !== null) {
        fiber.stateNode = (instance: Instance);
        return true;
      }
      return false;
    }
    case HostText: {
      const text = fiber.pendingProps;
      // 如果text为空字符串，或nodeType不等于TEXT_NODE，则返回null，否则返回nextInstance本身。
      const textInstance = canHydrateTextInstance(nextInstance, text);
      if (textInstance !== null) {
        fiber.stateNode = (textInstance: TextInstance);
        return true;
      }
      return false;
    }
    default:
      return false;
  }
}

/**
 * 检查实例是否可以进行hydrate操作。
 * @param fiber 要处理的Fiber对象
 */
function tryToClaimNextHydratableInstance(fiber: Fiber): void {
  if (!isHydrating) {
    return;
  }
  let nextInstance = nextHydratableInstance;
  if (!nextInstance) {
    // Nothing to hydrate. Make it an insertion.
    // 翻译：没有需要hydrate。将其插入。
    insertNonHydratedInstance((hydrationParentFiber: any), fiber);
    isHydrating = false;
    hydrationParentFiber = fiber;
    return;
  }
  const firstAttemptedInstance = nextInstance;
  if (!tryHydrate(fiber, nextInstance)) {
    // If we can't hydrate this instance let's try the next one.
    // We use this as a heuristic. It's based on intuition and not data so it
    // might be flawed or unnecessary.
    // 翻译：我们不能hydrate这个实例，让我们尝试下一个。
    //      我们将其用作启发式方法。它基于直觉而不是数据，因此可能存在缺陷或不必要。
    nextInstance = getNextHydratableSibling(firstAttemptedInstance);
    if (!nextInstance || !tryHydrate(fiber, nextInstance)) {
      // Nothing to hydrate. Make it an insertion.
      // 翻译：没有需要hydrate。将其插入。
      insertNonHydratedInstance((hydrationParentFiber: any), fiber);
      isHydrating = false;
      hydrationParentFiber = fiber;
      return;
    }
    // We matched the next one, we'll now assume that the first one was
    // superfluous and we'll delete it. Since we can't eagerly delete it
    // we'll have to schedule a deletion. To do that, this node needs a dummy
    // fiber associated with it.
    // 翻译：我们匹配了下一个，现在假设第一个是多余的，然后将其删除。
    //      由于我们不能急切地删除它，因此我们必须安排删除Effect。
    //      为此，该节点需要虚拟Fiber节点与之关联。
    deleteHydratableInstance(
      (hydrationParentFiber: any),
      firstAttemptedInstance,
    );
  }
  hydrationParentFiber = fiber;
  nextHydratableInstance = getFirstHydratableChild((nextInstance: any));
}

/**
 * 准备对原生节点执行hydrate操作。
 * @param fiber 要处理的Fiber对象
 * @param rootContainerInstance 根节点的容器实例，如DOM元素或Document
 * @param hostContext 宿主节点（DOM节点）
 * @return {boolean}
 */
function prepareToHydrateHostInstance(
  fiber: Fiber,
  rootContainerInstance: Container,
  hostContext: HostContext,
): boolean {
  if (!supportsHydration) {
    invariant(
      false,
      'Expected prepareToHydrateHostInstance() to never be called. ' +
        'This error is likely caused by a bug in React. Please file an issue.',
    );
  }

  const instance: Instance = fiber.stateNode;
  // 执行hydrate操作，生成updateQueue。
  const updatePayload = hydrateInstance(
    instance,
    fiber.type,
    fiber.memoizedProps,
    rootContainerInstance,
    hostContext,
    fiber,
  );
  // TODO: Type this specific to this type of component.
  fiber.updateQueue = (updatePayload: any);
  // If the update payload indicates that there is a change or if there
  // is a new ref we mark this as an update.
  // 翻译：如果更新有效负载表明存在更改，或者存在新引用，则将其标记为更新。
  if (updatePayload !== null) {
    return true;
  }
  return false;
}

function prepareToHydrateHostTextInstance(fiber: Fiber): boolean {
  if (!supportsHydration) {
    invariant(
      false,
      'Expected prepareToHydrateHostTextInstance() to never be called. ' +
        'This error is likely caused by a bug in React. Please file an issue.',
    );
  }

  const textInstance: TextInstance = fiber.stateNode;
  const textContent: string = fiber.memoizedProps;
  const shouldUpdate = hydrateTextInstance(textInstance, textContent, fiber);
  if (__DEV__) {
    if (shouldUpdate) {
      // We assume that prepareToHydrateHostTextInstance is called in a context where the
      // hydration parent is the parent host component of this host text.
      const returnFiber = hydrationParentFiber;
      if (returnFiber !== null) {
        switch (returnFiber.tag) {
          case HostRoot: {
            const parentContainer = returnFiber.stateNode.containerInfo;
            didNotMatchHydratedContainerTextInstance(
              parentContainer,
              textInstance,
              textContent,
            );
            break;
          }
          case HostComponent: {
            const parentType = returnFiber.type;
            const parentProps = returnFiber.memoizedProps;
            const parentInstance = returnFiber.stateNode;
            didNotMatchHydratedTextInstance(
              parentType,
              parentProps,
              parentInstance,
              textInstance,
              textContent,
            );
            break;
          }
        }
      }
    }
  }
  return shouldUpdate;
}

function popToNextHostParent(fiber: Fiber): void {
  let parent = fiber.return;
  while (
    parent !== null &&
    parent.tag !== HostComponent &&
    parent.tag !== HostRoot
  ) {
    parent = parent.return;
  }
  hydrationParentFiber = parent;
}

/**
 * 配合completeUnitWork，向上移动nextHydratableInstance和hydrationParentFiber指针。
 * 返回是否需要对当前的Fiber执行hydrate操作。
 * @param fiber 要处理的Fiber对象
 * @return {boolean}
 */
function popHydrationState(fiber: Fiber): boolean {
  if (!supportsHydration) {
    return false;
  }
  if (fiber !== hydrationParentFiber) {
    // We're deeper than the current hydration context, inside an inserted
    // tree.
    // 翻译：在插入的树中，我们比当前的hydrate上下文更深入。
    return false;
  }
  if (!isHydrating) {
    // If we're not currently hydrating but we're in a hydration context, then
    // we were an insertion and now need to pop up reenter hydration of our
    // siblings.
    // 翻译：如果我们不是正在执行hydrate流程，但我们处于hydrate的上下文中，然后我们是一个插入，
    //      现在需要弹出我们的兄弟节点重新进入hydrate状态。
    // 向上找HostComponent或HostRoot的父级。
    popToNextHostParent(fiber);
    // 当前节点不可以执行hydrate，但它的父节点可以。
    isHydrating = true;
    return false;
  }

  const type = fiber.type;

  // If we have any remaining hydratable nodes, we need to delete them now.
  // We only do this deeper than head and body since they tend to have random
  // other nodes in them. We also ignore components with pure text content in
  // side of them.
  // 翻译：如果还有剩余hydrate的节点，则需要立即将其删除。
  //      我们只比头部和主体做得更深，因为它们倾向于在其中随机包含其他节点。
  //      我们也将忽略其中包含纯文本内容的组件。
  // TODO: Better heuristic.
  if (
    // 不是原生节点，那就是文本节点。
    fiber.tag !== HostComponent ||
    (type !== 'head' &&
      type !== 'body' &&
      // 判断是不是一些特殊的标签，包括内部是纯文本的情况。
      !shouldSetTextContent(type, fiber.memoizedProps))
  ) {
    let nextInstance = nextHydratableInstance;
    while (nextInstance) {
      // 生成一个假的Fiber对象，添加Deletion的EffectTag，并加入节点的Effect链。
      deleteHydratableInstance(fiber, nextInstance);
      nextInstance = getNextHydratableSibling(nextInstance);
    }
  }

  popToNextHostParent(fiber);
  nextHydratableInstance = hydrationParentFiber
    ? getNextHydratableSibling(fiber.stateNode)
    : null;
  return true;
}

function resetHydrationState(): void {
  if (!supportsHydration) {
    return;
  }

  hydrationParentFiber = null;
  nextHydratableInstance = null;
  isHydrating = false;
}

export {
  enterHydrationState,
  resetHydrationState,
  tryToClaimNextHydratableInstance,
  prepareToHydrateHostInstance,
  prepareToHydrateHostTextInstance,
  popHydrationState,
};
