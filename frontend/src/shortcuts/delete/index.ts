/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import {
  FreeLayoutPluginContext,
  ShortcutsHandler,
  WorkflowDocument,
  WorkflowLineEntity,
  WorkflowNodeEntity,
  WorkflowNodeMeta,
  WorkflowSelectService,
  HistoryService,
  PlaygroundConfigEntity,
} from '@flowgram.ai/free-layout-editor';
import { Toast } from '@douyinfe/semi-ui';

import { FlowCommandId } from '../constants';
import { WorkflowNodeType } from '../../nodes';

export class DeleteShortcut implements ShortcutsHandler {
  public commandId = FlowCommandId.DELETE;

  public shortcuts = ['backspace', 'delete'];

  private playgroundConfig: PlaygroundConfigEntity;

  private document: WorkflowDocument;

  private selectService: WorkflowSelectService;

  private historyService: HistoryService;

  /**
   * initialize delete shortcut - 初始化删除快捷键
   */
  constructor(context: FreeLayoutPluginContext) {
    this.playgroundConfig = context.playground.config;
    this.document = context.get(WorkflowDocument);
    this.selectService = context.get(WorkflowSelectService);
    this.historyService = context.get(HistoryService);
    this.execute = this.execute.bind(this);
  }

  /**
   * execute delete operation - 执行删除操作
   */
  public async execute(nodes?: WorkflowNodeEntity[]): Promise<void> {
    if (this.readonly) {
      return;
    }
    const selection = Array.isArray(nodes) ? nodes : this.selectService.selection;
    if (selection.some((entity) => (
      entity instanceof WorkflowLineEntity
      && [entity.from?.parent?.flowNodeType, entity.to?.parent?.flowNodeType]
        .includes(WorkflowNodeType.Loop)
    ))) {
      Toast.error({
        content: '循环体内的固定连线不能删除',
        showClose: false,
      });
      return;
    }
    if (
      !this.isValid(
        selection.filter((n) => n instanceof WorkflowNodeEntity) as WorkflowNodeEntity[]
      )
    ) {
      return;
    }
    // 循环体是「块开始 → … → 块结束」的单链：删掉链上的节点后要把前后接回去，
    // 否则块开始与块结束之间断链，循环体直接失效。先记下前后端点，删除后再补线。
    const relinks = selection
      .filter((entity) => entity instanceof WorkflowNodeEntity)
      .map((entity) => this.captureLoopBodyRelink(entity as WorkflowNodeEntity))
      .filter((relink): relink is () => void => Boolean(relink));
    // Merge actions to redo/undo
    this.historyService.startTransaction();
    // delete selected entities - 删除选中实体
    selection.forEach((entity) => {
      if (entity instanceof WorkflowNodeEntity) {
        this.removeNode(entity);
      } else if (entity instanceof WorkflowLineEntity) {
        this.removeLine(entity);
      } else {
        entity.dispose();
      }
    });
    relinks.forEach((relink) => relink());
    // filter out disposed entities - 过滤掉已删除的实体
    this.selectService.selection = this.selectService.selection.filter((s) => !s.disposed);
    this.historyService.endTransaction();
  }

  /** 循环体内的块开始 / 块结束是固定锚点，不允许删除 */
  private isLoopAnchor(node: WorkflowNodeEntity): boolean {
    return [WorkflowNodeType.BlockStart, WorkflowNodeType.BlockEnd].includes(
      node.flowNodeType as WorkflowNodeType
    );
  }

  /**
   * 记录「删掉这个循环体节点后把前后接起来」的动作；返回 undefined 表示不需要补线
   * （不是循环体内的节点，或它在链头/链尾）。
   */
  private captureLoopBodyRelink(node: WorkflowNodeEntity): (() => void) | undefined {
    if (node.parent?.flowNodeType !== WorkflowNodeType.Loop || this.isLoopAnchor(node)) {
      return undefined;
    }
    const inbound = node.lines?.inputLines?.[0] as any;
    const outbound = node.lines?.outputLines?.[0] as any;
    // 线实体上的 from / to 是节点实体，fromPort / toPort 是端口实体；
    // createLine 需要的是「节点 id + 端口 id」（与 WorkflowNodePanelUtils.buildLine 一致）。
    const from = inbound?.from?.id ?? inbound?.fromPort?.node?.id;
    const fromPort = inbound?.fromPort?.portID ?? inbound?.from?.portID;
    const to = outbound?.to?.id ?? outbound?.toPort?.node?.id;
    const toPort = outbound?.toPort?.portID ?? outbound?.to?.portID;
    if (!from || !to) {
      return undefined;
    }
    return () => {
      // 容器内部的连线不会跟着节点一起被清理，这里显式拆掉再补一条
      for (const line of [inbound, outbound]) {
        if (line && !line.disposed) {
          line.dispose();
        }
      }
      this.document.linesManager.createLine({ from, fromPort, to, toPort });
    };
  }

  /**
   * readonly - 是否只读
   */
  private get readonly(): boolean {
    return this.playgroundConfig.readonly;
  }

  /**
   * validate if nodes can be deleted - 验证节点是否可以删除
   */
  private isValid(nodes: WorkflowNodeEntity[]): boolean {
    const hasSystemNodes = nodes.some((n) =>
      [WorkflowNodeType.Start, WorkflowNodeType.End].includes(n.flowNodeType as WorkflowNodeType)
    );
    if (hasSystemNodes) {
      Toast.error({
        content: '开始节点和结束节点不能删除',
        showClose: false,
      });
      return false;
    }
    if (nodes.some((node) => (
      node.parent?.flowNodeType === WorkflowNodeType.Loop && this.isLoopAnchor(node)
    ))) {
      Toast.error({
        content: '循环体内的块开始 / 块结束节点不能删除',
        showClose: false,
      });
      return false;
    }
    return true;
  }

  /**
   * remove node from workflow - 从工作流中删除节点
   */
  private removeNode(node: WorkflowNodeEntity): void {
    if (!this.document.canRemove(node)) {
      return;
    }
    const nodeMeta = node.getNodeMeta<WorkflowNodeMeta>();
    const subCanvas = nodeMeta.subCanvas?.(node);
    if (subCanvas?.isCanvas) {
      subCanvas.parentNode.dispose();
      return;
    }
    node.dispose();
  }

  /**
   * remove line from workflow - 从工作流中删除连线
   */
  private removeLine(line: WorkflowLineEntity): void {
    if (!this.document.linesManager.canRemove(line)) {
      return;
    }
    line.dispose();
  }
}
