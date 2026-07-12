/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { useMemo } from 'react';

import { debounce } from 'lodash-es';
import { createMinimapPlugin } from '@flowgram.ai/minimap-plugin';
import { createFreeStackPlugin } from '@flowgram.ai/free-stack-plugin';
import { createFreeSnapPlugin } from '@flowgram.ai/free-snap-plugin';
import { createFreeNodePanelPlugin } from '@flowgram.ai/free-node-panel-plugin';
import { createFreeLinesPlugin } from '@flowgram.ai/free-lines-plugin';
import {
  FlowNodeBaseType,
  FreeLayoutPluginContext,
  FreeLayoutProps,
  WorkflowNodeEntity,
} from '@flowgram.ai/free-layout-editor';
import { createFreeGroupPlugin } from '@flowgram.ai/free-group-plugin';
import { createContainerNodePlugin } from '@flowgram.ai/free-container-plugin';
import { createDownloadPlugin } from '@flowgram.ai/export-plugin';

import { canContainNode, onDragLineEnd } from '../utils';
import { FlowNodeRegistry, FlowDocumentJSON } from '../typings';
import { shortcuts } from '../shortcuts';
import { CustomService, ValidateService } from '../services';
import { GetGlobalVariableSchema } from '../plugins/variable-panel-plugin';
import { WorkflowRuntimeService } from '../plugins/runtime-plugin/runtime-service';
import {
  createRuntimePlugin,
  createContextMenuPlugin,
  createVariablePanelPlugin,
  createPanelManagerPlugin,
} from '../plugins';
import { defaultFormMeta } from '../nodes/default-form-meta';
import { WorkflowNodeType } from '../nodes';
import { SelectorBoxPopover } from '../components/selector-box-popover';
import { BaseNode, CommentRender, GroupNodeRender, LineAddButton, NodePanel } from '../components';

export function useEditorProps(
  initialData: FlowDocumentJSON,
  nodeRegistries: FlowNodeRegistry[]
): FreeLayoutProps {
  return useMemo<FreeLayoutProps>(
    () => ({
      /**
       * Whether to enable the background
       */
      background: true,
      /**
       * 画布相关配置
       * Canvas-related configurations
       */
      playground: {
        /**
         * Prevent Mac browser gestures from turning pages
         * 阻止 mac 浏览器手势翻页
         */
        preventGlobalGesture: true,
      },
      /**
       * Whether it is read-only or not, the node cannot be dragged in read-only mode
       */
      readonly: false,
      /**
       * Line support both-way connection (default true)
       * 线条支持双向连接
       */
      twoWayConnection: true,
      /**
       * Enable dragging of read-only nodes (default false)
       * 允许拖拽只读节点
       */
      enableReadonlyNodeDragging: false,
      /**
       * Initial data
       * 初始化数据
       */
      initialData,
      /**
       * Node registries
       * 节点注册
       */
      nodeRegistries,
      /**
       * Get the default node registry, which will be merged with the 'nodeRegistries'
       * 提供默认的节点注册，这个会和 nodeRegistries 做合并
       */
      getNodeDefaultRegistry(type) {
        return {
          type,
          meta: {
            defaultExpanded: true,
          },
          formMeta: defaultFormMeta,
        };
      },
      /**
       * 节点数据转换, 由 ctx.document.fromJSON 调用
       * Node data transformation, called by ctx.document.fromJSON
       * @param node
       * @param json
       */
      fromNodeJSON(node, json) {
        return json;
      },
      /**
       * 节点数据转换, 由 ctx.document.toJSON 调用
       * Node data transformation, called by ctx.document.toJSON
       * @param node
       * @param json
       */
      toNodeJSON(node, json) {
        return json;
      },
      lineColor: {
        hidden: 'var(--g-workflow-line-color-hidden,transparent)',
        default: 'var(--g-workflow-line-color-default,#4d53e8)',
        drawing: 'var(--g-workflow-line-color-drawing, #5DD6E3)',
        hovered: 'var(--g-workflow-line-color-hover,#37d0ff)',
        selected: 'var(--g-workflow-line-color-selected,#37d0ff)',
        error: 'var(--g-workflow-line-color-error,red)',
        flowing: 'var(--g-workflow-line-color-flowing,#4d53e8)',
      },
      /*
       * Check whether the line can be added
       * 判断是否连线
       */
      canAddLine(ctx, fromPort, toPort) {
        // Cannot be a self-loop on the same node / 不能是同一节点自循环
        if (fromPort.node === toPort.node) {
          return false;
        }
        // Cannot be in different containers - 不能在不同容器
        if (
          fromPort.node.parent?.id !== toPort.node.parent?.id &&
          ![fromPort.node.parent?.flowNodeType, toPort.node.parent?.flowNodeType].includes(
            FlowNodeBaseType.GROUP
          )
        ) {
          return false;
        }
        /**
         * 线条环检测，不允许连接到前面的节点
         * Line loop detection, which is not allowed to connect to the node in front of it
         */
        return !fromPort.node.lines.allInputNodes.includes(toPort.node);
      },
      /**
       * Check whether the line can be deleted, this triggers on the default shortcut `Bakspace` or `Delete`
       * 判断是否能删除连线, 这个会在默认快捷键 (Backspace or Delete) 触发
       */
      canDeleteLine(ctx, line, newLineInfo, silent) {
        return true;
      },
      /**
       * Check whether the node can be deleted, this triggers on the default shortcut `Bakspace` or `Delete`
       * 判断是否能删除节点, 这个会在默认快捷键 (Backspace or Delete) 触发
       */
      canDeleteNode(ctx, node) {
        return true;
      },
      /**
       * 是否允许拖入子画布 (loop or group)
       * Whether to allow dragging into the sub-canvas (loop or group)
       */
      canDropToNode: (ctx, params) => canContainNode(params.dragNodeType!, params.dropNodeType!),
      /**
       * Whether to reset line
       * 是否允许重连
       * @param ctx
       * @param oldLine
       * @param newLineInfo
       */
      canResetLine: (ctx, oldLine, newLineInfo) => true,
      /**
       * Drag the end of the line to create an add panel (feature optional)
       * 拖拽线条结束需要创建一个添加面板 （功能可选）
       * 希望提供控制线条粗细的配置项
       */
      onDragLineEnd,
      /**
       * SelectBox config
       */
      selectBox: {
        SelectorBoxPopover,
      },
      scroll: {
        /**
         * Whether to restrict the node from rolling out of the canvas needs to be closed because there is a running results pane
         * 是否限制节点不能滚出画布，由于有运行结果面板，所以需要关闭
         */
        enableScrollLimit: false,
      },
      materials: {
        components: {},
        /**
         * Render Node
         */
        renderDefaultNode: BaseNode,
        renderNodes: {
          [WorkflowNodeType.Comment]: CommentRender,
        },
      },
      /**
       * Node engine enable, you can configure formMeta in the FlowNodeRegistry
       */
      nodeEngine: {
        enable: true,
      },
      /**
       * Variable engine enable
       */
      variableEngine: {
        enable: true,
      },
      /**
       * Redo/Undo enable
       */
      history: {
        enable: true,
        /**
         * Listen form data change, default true
         */
        enableChangeNode: true,
      },
      /**
       * Content change
       */
      onContentChange: debounce((ctx: FreeLayoutPluginContext, event) => {
        if (ctx.document.disposed) return;

        console.log('Auto Save: ', event, {
          ...ctx.document.toJSON(),
          globalVariable: ctx.get<GetGlobalVariableSchema>(GetGlobalVariableSchema)(),
        });
      }, 1000),
      /**
       * Running line
       */
      isFlowingLine: (ctx, line) => ctx.get(WorkflowRuntimeService).isFlowingLine(line),
      /**
       * Shortcuts
       */
      shortcuts,
      /**
       * Bind custom service
       */
      onBind: ({ bind }) => {
        bind(CustomService).toSelf().inSingletonScope();
        bind(ValidateService).toSelf().inSingletonScope();
      },
      /**
       * Playground init
       */
      onInit(ctx) {
        console.log('--- Playground init ---');
      },
      /**
       * Playground render
       */
      onAllLayersRendered(ctx) {
        // ctx.tools.autoLayout(); // init auto layout
        ctx.tools.fitView(false);
        console.log('--- Playground rendered ---');
      },
      /**
       * Playground dispose
       */
      onDispose() {
        console.log('---- Playground Dispose ----');
      },
      i18n: {
        locale: 'zh-CN',
        languages: {
          'zh-CN': {
            'Never Remind': '不再提示',
            'Hold {{key}} to drag node out': '按住 {{key}} 可以将节点拖出',
            'Add Node': '添加节点',
            'Search': '搜索',
            'Start': '开始节点',
            'End': '结束节点',
            'LLM': '大语言模型',
            'HTTP': 'HTTP 请求',
            'Code': '代码执行',
            'Variable': '变量赋值',
            'Condition': '条件分支',
            'Loop': '循环',
            'Comment': '注释',
            'Delete': '删除',
            'Copy': '复制',
            'Paste': '粘贴',
            'Cut': '剪切',
            'Select All': '全选',
            'Undo': '撤销',
            'Redo': '重做',
            'Zoom In': '放大',
            'Zoom Out': '缩小',
            'Fit View': '适应视图',
            'Auto Layout': '自动布局',
            'Readonly': '只读模式',
            'Download': '下载',
            'Minimap': '小地图',
            'Interactive': '交互模式',
            'Switch Line': '切换连线',
            'Test Run': '试运行',
            'Problems': '问题检查',
            'Inputs': '输入',
            'Outputs': '输出',
            'Properties': '属性',
            'Title': '标题',
            'Description': '描述',
            'Variable Name': '变量名',
            'Type': '类型',
            'Required': '必填',
            'Default Value': '默认值',
            'Model Name': '模型名称',
            'API Key': 'API 密钥',
            'API Host': 'API 地址',
            'Temperature': '温度',
            'System Prompt': '系统提示词',
            'Prompt': '提示词',
            'Result': '结果',
            'Add': '添加',
            'Remove': '移除',
            'Clear': '清空',
            'Run': '运行',
            'Stop': '停止',
            'Save': '保存',
            'Cancel': '取消',
            'Confirm': '确认',
            'OK': '确定',
            'Close': '关闭',
            'Edit': '编辑',
            'Duplicate': '复制',
            'Expand': '展开',
            'Collapse': '折叠',
            'Drag': '拖拽',
            'Drop': '放置',
            'Connect': '连接',
            'Disconnect': '断开',
            'Enable': '启用',
            'Disable': '禁用',
            'On': '开',
            'Off': '关',
            'Yes': '是',
            'No': '否',
            'True': '真',
            'False': '假',
            'Null': '空',
            'None': '无',
            'Empty': '空',
            'Loading': '加载中',
            'Error': '错误',
            'Warning': '警告',
            'Info': '信息',
            'Success': '成功',
            'Failed': '失败',
            'Pending': '等待中',
            'Running': '运行中',
            'Completed': '已完成',
            'Cancelled': '已取消',
            'Timeout': '超时',
            'Retry': '重试',
            'Continue': '继续',
            'Break': '中断',
            'Return': '返回',
            'Export': '导出',
            'Import': '导入',
            'Settings': '设置',
            'Options': '选项',
            'Configuration': '配置',
            'Parameter': '参数',
            'Value': '值',
            'Name': '名称',
            'Label': '标签',
            'Path': '路径',
            'URL': '地址',
            'Method': '方法',
            'Header': '请求头',
            'Body': '请求体',
            'Response': '响应',
            'Status Code': '状态码',
            'Content Type': '内容类型',
            'Authorization': '认证',
            'Bearer Token': 'Bearer 令牌',
            'API': 'API',
            'Endpoint': '端点',
            'Request': '请求',
            'Response Body': '响应体',
            'Response Headers': '响应头',
            'Global Variables': '全局变量',
            'Local Variables': '局部变量',
            'Environment Variables': '环境变量',
            'Reference': '引用',
            'Constant': '常量',
            'Expression': '表达式',
            'Template': '模板',
            'String': '字符串',
            'Number': '数字',
            'Boolean': '布尔值',
            'Object': '对象',
            'Array': '数组',
            'Integer': '整数',
            'Float': '浮点数',
            'Date': '日期',
            'Time': '时间',
            'DateTime': '日期时间',
            'Format': '格式',
            'Validate': '验证',
            'Required Field': '必填字段',
            'Invalid Value': '无效值',
            'Field': '字段',
            'Fields': '字段列表',
            'Schema': '结构',
            'Items': '列表项',
            'Branch': '分支',
            'Conditions': '条件列表',
            'Operator': '运算符',
            'AND': '且',
            'OR': '或',
            'NOT': '非',
            'IF': '如果',
            'THEN': '则',
            'ELSE': '否则',
            'ELSE IF': '否则如果',
            'Iteration': '迭代',
            'Iterations': '迭代次数',
            'For': '对于',
            'While': '当',
            'Do': '执行',
            'End Loop': '结束循环',
            'Start Loop': '开始循环',
            'Script': '脚本',
            'Language': '语言',
            'JavaScript': 'JavaScript',
            'Python': 'Python',
            'Execute': '执行',
            'Execution Result': '执行结果',
            'Console Output': '控制台输出',
            'Logs': '日志',
            'Debug': '调试',
            'Variables': '变量',
            'Assign': '赋值',
            'Declare': '声明',
            'Ungroup': '取消分组',
            'Align': '对齐',
            'Distribute': '分布',
            'Lock': '锁定',
            'Unlock': '解锁',
            'Visible': '可见',
            'Hidden': '隐藏',
            'Show': '显示',
            'Hide': '隐藏',
            'Expand All': '全部展开',
            'Collapse All': '全部折叠',
            'Fit to Screen': '适应屏幕',
            'Actual Size': '实际大小',
            'Reset Zoom': '重置缩放',
            'Background': '背景',
            'Grid': '网格',
            'Snap': '吸附',
            'Guide Line': '辅助线',
            'Port': '端口',
            'Ports': '端口',
            'Input Port': '输入端口',
            'Output Port': '输出端口',
            'Connected': '已连接',
            'Disconnected': '未连接',
            'Connection': '连接',
            'Connections': '连接',
            'No Data': '暂无数据',
            'No Results': '暂无结果',
            'Search...': '搜索...',
            'Drag to add node': '拖拽添加节点',
            'Click to select': '点击选择',
            'Double click to edit': '双击编辑',
            'Right click for menu': '右键打开菜单',
            'Hold {{key}} to drag': '按住 {{key}} 拖拽',
            'Release to drop': '释放放置',
            'Invalid connection': '无效连接',
            'Cannot connect to self': '不能连接自身',
            'Cannot connect across containers': '不能跨容器连接',
            'Would you like to delete this node?': '确定要删除此节点吗？',
            'Would you like to delete this line?': '确定要删除此连线吗？',
            'Cannot delete readonly node': '无法删除只读节点',
            'Cannot delete start node': '无法删除起始节点',
            'Cannot delete end node': '无法删除结束节点',
          },
          'en-US': {},
        },
      },
      plugins: () => [
        /**
         * Custom node sorting, the code below will make the comment nodes always below the normal nodes
         * 自定义节点排序，下边的代码会让 comment 节点永远在普通节点下边
         */
        createFreeStackPlugin({
          sortNodes: (nodes: WorkflowNodeEntity[]) => {
            const commentNodes: WorkflowNodeEntity[] = [];
            const otherNodes: WorkflowNodeEntity[] = [];
            nodes.forEach((node) => {
              if (node.flowNodeType === WorkflowNodeType.Comment) {
                commentNodes.push(node);
              } else {
                otherNodes.push(node);
              }
            });
            return [...commentNodes, ...otherNodes];
          },
        }),
        /**
         * Line render plugin
         * 连线渲染插件
         */
        createFreeLinesPlugin({
          renderInsideLine: LineAddButton,
        }),
        /**
         * Minimap plugin
         * 缩略图插件
         */
        createMinimapPlugin({
          disableLayer: true,
          canvasStyle: {
            canvasWidth: 182,
            canvasHeight: 102,
            canvasPadding: 50,
            canvasBackground: 'rgba(242, 243, 245, 1)',
            canvasBorderRadius: 10,
            viewportBackground: 'rgba(255, 255, 255, 1)',
            viewportBorderRadius: 4,
            viewportBorderColor: 'rgba(6, 7, 9, 0.10)',
            viewportBorderWidth: 1,
            viewportBorderDashLength: undefined,
            nodeColor: 'rgba(0, 0, 0, 0.10)',
            nodeBorderRadius: 2,
            nodeBorderWidth: 0.145,
            nodeBorderColor: 'rgba(6, 7, 9, 0.10)',
            overlayColor: 'rgba(255, 255, 255, 0.55)',
          },
        }),
        /**
         * Download plugin
         * 下载插件
         */
        createDownloadPlugin({}),
        /**
         * Snap plugin
         * 自动对齐及辅助线插件
         */
        createFreeSnapPlugin({
          edgeColor: '#00B2B2',
          alignColor: '#00B2B2',
          edgeLineWidth: 1,
          alignLineWidth: 1,
          alignCrossWidth: 8,
        }),
        /**
         * NodeAddPanel render plugin
         * 节点添加面板渲染插件
         */
        createFreeNodePanelPlugin({
          renderer: NodePanel,
        }),
        /**
         * This is used for the rendering of the loop node sub-canvas
         * 这个用于 loop 节点子画布的渲染
         */
        createContainerNodePlugin({}),
        /**
         * Group plugin
         */
        createFreeGroupPlugin({
          groupNodeRender: GroupNodeRender,
        }),
        /**
         * ContextMenu plugin
         */
        createContextMenuPlugin({}),
        /**
         * Runtime plugin
         * ⚠️ Browser mode is for demo only; for production, please deploy the server-side runtime
         * https://flowgram.ai/guide/runtime/introduction.html
         */
        createRuntimePlugin({
          mode: 'browser', // browser mode is for demo only!
          // mode: 'server',
          // serverConfig: {
          //   domain: 'localhost',
          //   port: 4000,
          //   protocol: 'http',
          // },
        }),

        /**
         * Variable panel plugin
         * 变量面板插件
         */
        createVariablePanelPlugin({
          initialData: initialData.globalVariable,
        }),
        /** Float layout plugin */
        createPanelManagerPlugin(),
      ],
    }),
    []
  );
}
