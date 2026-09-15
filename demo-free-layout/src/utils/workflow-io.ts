/**
 * 工作流导入 / 导出格式。
 * 用带 kind 标记的信封包住 flowgram，导入时可以据此识别文件来源，
 * 同时兼容直接拖入裸 flowgram（{ nodes, edges }）的场景。
 */

export const WORKFLOW_FILE_KIND = 'futureFlow.workflow';
export const WORKFLOW_FILE_SCHEMA = 1;

export interface WorkflowExportEnvelope {
  kind: typeof WORKFLOW_FILE_KIND;
  schema: number;
  name: string;
  description: string;
  exportedAt: string;
  flowgram: Record<string, unknown>;
}

export interface ParsedWorkflowFile {
  name: string;
  description: string;
  flowgram: Record<string, unknown>;
}

export const buildWorkflowExport = (
  name: string,
  description: string,
  flowgram: Record<string, unknown>,
): WorkflowExportEnvelope => ({
  kind: WORKFLOW_FILE_KIND,
  schema: WORKFLOW_FILE_SCHEMA,
  name,
  description: description || '',
  exportedAt: new Date().toISOString(),
  flowgram,
});

/** 触发浏览器下载；文件名去掉不适合做文件名的字符 */
export const downloadJsonFile = (name: string, data: unknown): void => {
  const safeName = (name || 'workflow').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${safeName}.futureflow.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
};

/**
 * 解析导入文件：既能吃本平台的导出文件，也接受裸 flowgram。
 * 只做结构自检，语义校验（节点类型、引用关系）交给网关，避免前后端两套规则。
 */
export const parseWorkflowFile = (
  text: string,
  fallbackName: string,
): { data?: ParsedWorkflowFile; error?: string } => {
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    return { error: '文件不是合法的 JSON' };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: '文件内容应为 JSON 对象' };
  }

  const flowgram = raw.flowgram && typeof raw.flowgram === 'object' ? raw.flowgram : raw;
  if (!Array.isArray(flowgram.nodes) || flowgram.nodes.length === 0) {
    return { error: '文件里没有节点（nodes），不像是工作流文件' };
  }
  if (flowgram.edges !== undefined && !Array.isArray(flowgram.edges)) {
    return { error: 'edges 字段必须是数组' };
  }

  const name =
    typeof raw.name === 'string' && raw.name.trim()
      ? raw.name.trim().slice(0, 128)
      : fallbackName.slice(0, 128);

  return {
    data: {
      name,
      description: typeof raw.description === 'string' ? raw.description : '',
      flowgram,
    },
  };
};
