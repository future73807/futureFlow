/**
 * FlowGram JSON 类型定义
 */

/** 输入值:支持常量和模板(可含变量插值) */
export interface FlowInputValue {
  type: 'constant' | 'template' | 'ref';
  content: string | number | boolean | string[] | number[] | boolean[] | Record<string, any>;
}

/** FlowGram 表单使用的 JSON Schema 子集。节点输出会包含默认值、数组项和嵌套对象。 */
export interface FlowValueSchema {
  type: string;
  title?: string;
  default?: unknown;
  items?: FlowValueSchema;
  properties?: Record<string, FlowValueSchema>;
  required?: string[];
  extra?: Record<string, any>;
  [key: string]: any;
}

export interface FlowObjectSchema {
  type: string;
  required?: string[];
  properties?: Record<string, FlowValueSchema>;
}

/** FlowGram 节点 data */
export interface FlowNodeData {
  title: string;
  inputsValues?: Record<string, FlowInputValue>;
  inputs?: FlowObjectSchema;
  outputs?: FlowObjectSchema;
  conditions?: Array<{
    key: string;
    value: {
      left?: FlowInputValue;
      operator?: string;
      right?: FlowInputValue;
    };
  }>;
  branch?: Array<{
    key?: string;
    logic?: 'and' | 'or';
    conditions: Array<{
      key: string;
      value: {
        left?: FlowInputValue;
        operator?: string;
        right?: FlowInputValue;
      };
    }>;
  }>;
  /** 各节点可声明自己的扩展配置，例如 api/script/body/authorization。 */
  [key: string]: any;
}

/** FlowGram 节点 */
export interface FlowNodeJSON {
  id: string;
  type: string; // start / end / llm / http / code ...
  meta?: {
    position?: { x: number; y: number };
    [key: string]: any;
  };
  data: FlowNodeData;
  /** 容器节点的子画布节点。首期数组批处理仅允许固定的三节点结构。 */
  blocks?: FlowNodeJSON[];
  /** 容器节点内部连线，与顶层 edges 使用相同结构。 */
  edges?: FlowEdgeJSON[];
}

/** FlowGram 边 */
export interface FlowEdgeJSON {
  sourceNodeID: string;
  targetNodeID: string;
  sourcePortID?: string;
  targetPortID?: string;
}

/** FlowGram 完整 JSON */
export interface FlowGramJSON {
  nodes: FlowNodeJSON[];
  edges: FlowEdgeJSON[];
}

/**
 * Dify DSL 类型定义
 */

/** Dify 节点 data - 公共部分 */
export interface DifyNodeDataBase {
  type: string;
  title: string;
  desc?: string;
  selected?: boolean;
}

/** Dify Start 节点 data */
export interface DifyStartNodeData extends DifyNodeDataBase {
  type: 'start';
  variables: DifyVariable[];
}

/** Dify 变量定义 */
export interface DifyVariable {
  variable: string;
  label: string;
  type: string; // text-input / paragraph / select / number
  required: boolean;
  max_length?: number;
  options?: string[];
}

/** Dify LLM 节点 data */
export interface DifyLLMNodeData extends DifyNodeDataBase {
  type: 'llm';
  model: {
    provider: string;
    name: string;
    mode: 'chat' | 'completion';
    completion_params: {
      temperature?: number;
      top_p?: number;
      max_tokens?: number;
      [key: string]: any;
    };
  };
  prompt_template: DifyPromptItem[];
  context: {
    enabled: boolean;
    variable_selector: any[];
  };
  vision: {
    enabled: boolean;
  };
  variables: any[];
}

/** Dify End 节点 data */
export interface DifyEndNodeData extends DifyNodeDataBase {
  type: 'end';
  outputs: {
    variable: string;
    value_selector: string[];
  }[];
}

/** Dify Prompt 模板项 */
export interface DifyPromptItem {
  id: string;
  role: 'system' | 'user' | 'assistant';
  text: string;
}

/** Dify 节点(外层) */
export interface DifyNode {
  id: string;
  type: 'custom' | 'custom-iteration-start';
  position: { x: number; y: number };
  positionAbsolute: { x: number; y: number };
  sourcePosition: 'right';
  targetPosition: 'left';
  width: number;
  height: number;
  data: DifyNodeDataBase & Record<string, any>;
  /** Dify 子画布节点所属的 iteration 节点。 */
  parentId?: string;
  extent?: 'parent';
  selected?: boolean;
  draggable?: boolean;
  selectable?: boolean;
  zIndex?: number;
}

/** Dify 边 */
export interface DifyEdge {
  id: string;
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
  type: 'custom';
  zIndex: number;
  data: {
    isInIteration: boolean;
    iteration_id?: string;
    sourceType: string;
    targetType: string;
  };
}

/** Dify DSL 顶层 */
export interface DifyDSL {
  app: {
    description: string;
    icon: string;
    icon_background: string;
    mode: 'workflow';
    name: string;
  };
  kind: 'app';
  version: string;
  workflow: {
    features: Record<string, any>;
    graph: {
      nodes: DifyNode[];
      edges: DifyEdge[];
      viewport: { x: number; y: number; zoom: number };
    };
  };
}
