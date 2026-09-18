/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { FC, useCallback, useState, type MouseEvent } from 'react';

import {
  delay,
  useClientContext,
  usePlaygroundTools,
  useService,
  WorkflowDragService,
  WorkflowDocument,
  WorkflowLinesManager,
  WorkflowNodeEntity,
  WorkflowNodeMeta,
  WorkflowSelectService,
} from '@flowgram.ai/free-layout-editor';
import { NodeIntoContainerService } from '@flowgram.ai/free-container-plugin';
import { IconButton, Dropdown } from '@douyinfe/semi-ui';
import { IconMore } from '@douyinfe/semi-icons';

import { FlowNodeRegistry } from '../../typings';
import { PasteShortcut } from '../../shortcuts/paste';
import { CopyShortcut } from '../../shortcuts/copy';
import { WorkflowNodeType } from '../../nodes';

interface NodeMenuProps {
  node: WorkflowNodeEntity;
  updateTitleEdit?: (setEditing: boolean) => void;
  deleteNode: () => void;
}

export const NodeMenu: FC<NodeMenuProps> = ({ node, deleteNode, updateTitleEdit }) => {
  const [visible, setVisible] = useState(true);
  const clientContext = useClientContext();
  const registry = node.getNodeRegistry<FlowNodeRegistry>();
  const nodeIntoContainerService = useService(NodeIntoContainerService);
  const selectService = useService(WorkflowSelectService);
  const dragService = useService(WorkflowDragService);
  const linesManager = useService(WorkflowLinesManager);
  const document = useService(WorkflowDocument);
  const canMoveOut = nodeIntoContainerService.canMoveOutContainer(node);
  const isBatchInnerNode = node.parent?.flowNodeType === WorkflowNodeType.Loop;
  /** 循环体里的块开始 / 块结束是固定锚点，不能移出 */
  const isLoopAnchor = [WorkflowNodeType.BlockStart, WorkflowNodeType.BlockEnd].includes(
    node.flowNodeType as WorkflowNodeType
  );
  // 容器插件的 canMoveOutContainer 对循环体子节点会返回 false（拖放校验走的是另一条路径），
  // 这里按父节点类型直接判定，保证「移出循环体」对普通节点始终可用
  const showMoveOut = isBatchInnerNode ? !isLoopAnchor : canMoveOut;
  const tools = usePlaygroundTools();

  const rerenderMenu = useCallback(() => {
    // force destroy component - 强制销毁组件触发重新渲染
    setVisible(false);
    requestAnimationFrame(() => {
      setVisible(true);
    });
  }, []);

  /**
   * 循环体是「块开始 → … → 块结束」的单链：把节点从链上摘掉（删除 / 移出循环体）后
   * 必须把前后两个节点接起来，否则块开始与块结束之间会断链，循环体直接失效。
   * 返回值是「摘掉之后恢复链路」的函数。
   */
  const relinkLoopBodyChain = useCallback(() => {
    if (!isBatchInnerNode || isLoopAnchor) return undefined;
    const inbound = node.lines?.inputLines?.[0] as any;
    const outbound = node.lines?.outputLines?.[0] as any;
    // 线实体上的 from / to 是节点实体，fromPort / toPort 是端口实体；
    // createLine 需要的是「节点 id + 端口 id」（与 WorkflowNodePanelUtils.buildLine 一致）。
    const from = inbound?.from?.id ?? inbound?.fromPort?.node?.id;
    const fromPort = inbound?.fromPort?.portID ?? inbound?.from?.portID;
    const to = outbound?.to?.id ?? outbound?.toPort?.node?.id;
    const toPort = outbound?.toPort?.portID ?? outbound?.to?.portID;
    if (!from || !to) return undefined;
    return () => {
      linesManager.createLine({ from, fromPort, to, toPort });
    };
  }, [isBatchInnerNode, isLoopAnchor, linesManager, node]);

  const handleMoveOut = useCallback(
    async (e: MouseEvent) => {
      e.stopPropagation();
      const sourceParent = node.parent;
      // 移出容器前后都要保证循环体单链完整
      const restoreChain = relinkLoopBodyChain();
      // move out of container - 移出容器
      nodeIntoContainerService.moveOutContainer({ node });
      await delay(16);
      // clear invalid lines - 清除非法线条
      await nodeIntoContainerService.clearInvalidLines({
        dragNode: node,
        sourceParent,
      });
      restoreChain?.();
      rerenderMenu();
      // select node - 选中节点
      selectService.selectNode(node);
      // start drag node - 开始拖拽
      dragService.startDragSelectedNodes(e);
    },
    [nodeIntoContainerService, node, relinkLoopBodyChain, rerenderMenu]
  );

  /**
   * 创建副本时副本相对原节点的偏移：默认右下 40px；如果那个位置已经有节点，
   * 就沿对角线继续找空位，避免连续创建时两份副本完全重叠。
   */
  const resolveCopyOffset = useCallback(
    (source: WorkflowNodeEntity): { x: number; y: number } => {
      const step = 40;
      const sourceJSON = document.toNodeJSON(source);
      const origin = sourceJSON?.meta?.position;
      if (!origin) return { x: step, y: step };
      const siblings = (source.parent?.children ?? []).filter((child) => child.id !== source.id);
      const occupied = new Set(
        siblings
          .map((child) => {
            const position = document.toNodeJSON(child)?.meta?.position;
            return position ? `${Math.round(position.x)},${Math.round(position.y)}` : '';
          })
          .filter(Boolean),
      );
      for (let index = 1; index <= 10; index += 1) {
        const candidate = {
          x: Math.round(origin.x + step * index),
          y: Math.round(origin.y + step * index),
        };
        if (!occupied.has(`${candidate.x},${candidate.y}`)) {
          return { x: step * index, y: step * index };
        }
      }
      return { x: step, y: step };
    },
    [document]
  );

  const handleCopy = useCallback(
    (e: React.MouseEvent) => {
      const copyShortcut = new CopyShortcut(clientContext);
      const pasteShortcut = new PasteShortcut(clientContext);
      const data = copyShortcut.toClipboardData([node]);
      // 副本落在原节点右下方一点（菜单是在画布外的浮层里点的，鼠标位置不可靠）；
      // 源节点在循环体里时，副本同样留在循环体内。
      const parentMeta = node.parent?.getNodeMeta<WorkflowNodeMeta>();
      pasteShortcut.apply(data, {
        parent: parentMeta?.isContainer ? node.parent : undefined,
        offset: resolveCopyOffset(node),
      });
      e.stopPropagation(); // Disable clicking prevents the sidebar from opening
    },
    [clientContext, node, resolveCopyOffset]
  );

  const handleDelete = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation(); // Disable clicking prevents the sidebar from opening
      // 删除命令本身会在循环体里补回单链（见 DeleteShortcut）
      deleteNode();
    },
    [deleteNode]
  );
  const handleEditTitle = useCallback(
    (e: React.MouseEvent) => {
      updateTitleEdit?.(true);
      e.stopPropagation(); // Disable clicking prevents the sidebar from opening
    },
    [updateTitleEdit]
  );

  const handleAutoLayout = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation(); // Disable clicking prevents the sidebar from opening
      tools.autoLayout({
        containerNode: node,
        enableAnimation: true,
        animationDuration: 1000,
        disableFitView: true,
      });
    },
    [tools]
  );

  if (!visible) {
    return <></>;
  }

  return (
    <Dropdown
      trigger="hover"
      position="bottomRight"
      render={
        <Dropdown.Menu>
          <Dropdown.Item onClick={handleEditTitle}>编辑标题</Dropdown.Item>
          {showMoveOut && (
            <Dropdown.Item onClick={handleMoveOut}>
              {isBatchInnerNode ? '移出循环体' : '移出容器'}
            </Dropdown.Item>
          )}
          <Dropdown.Item
            onClick={handleCopy}
            disabled={registry.meta!.copyDisable === true}
          >
            创建副本
          </Dropdown.Item>
          {registry.meta.isContainer && (
            <Dropdown.Item onClick={handleAutoLayout}>自动布局</Dropdown.Item>
          )}
          <Dropdown.Item
            onClick={handleDelete}
            disabled={!!(registry.canDelete?.(clientContext, node) || registry.meta!.deleteDisable)}
          >
            删除
          </Dropdown.Item>
        </Dropdown.Menu>
      }
    >
      <IconButton
        aria-label="节点操作"
        color="secondary"
        size="small"
        theme="borderless"
        icon={<IconMore aria-hidden="true" />}
        onClick={(e) => e.stopPropagation()}
      />
    </Dropdown>
  );
};
