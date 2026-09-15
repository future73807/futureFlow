import { WorkflowNodeType } from '../constants';

/**
 * runtime-js 原生支持 JavaScript 代码节点。媒体/文本节点在保存时保留
 * 独立类型，在浏览器试运行前无损转换为代码节点，因此既有清晰的画布
 * 语义，也无需在浏览器中引入另一套执行器。
 */
export const prepareContentNodesForRuntime = <T extends { nodes?: any[] }>(schema: T): T => {
  if (!Array.isArray(schema.nodes)) return schema;

  const transformNode = (node: any): any => {
    const blocks = Array.isArray(node.blocks) ? node.blocks.map(transformNode) : node.blocks;
    if (
      ![WorkflowNodeType.Text, WorkflowNodeType.Image, WorkflowNodeType.Video].includes(
        node.type as WorkflowNodeType,
      )
    ) {
      return blocks === node.blocks ? node : { ...node, blocks };
    }

    const isMediaNode = node.type === WorkflowNodeType.Image || node.type === WorkflowNodeType.Video;
    const isNativeGeneration = isMediaNode && node.data?.media?.mode === 'generate';
    const returnExpression = node.type === WorkflowNodeType.Text
      ? `{ text: String(params.text ?? '') }`
      : node.type === WorkflowNodeType.Image
        ? `{
      jobId: '',
      assetId: '',
      url: String(params.url ?? ''),
      poster: '',
      caption: String(params.caption ?? ''),
      mediaType: 'image',
      provider: 'passthrough',
      model: '',
      taskId: '',
      status: 'succeeded',
      mimeType: '',
      byteSize: 0,
      sha256: ''
    }`
        : `{
      jobId: '',
      assetId: '',
      url: String(params.url ?? ''),
      poster: String(params.poster ?? ''),
      caption: String(params.caption ?? ''),
      mediaType: 'video',
      provider: 'passthrough',
      model: '',
      taskId: '',
      status: 'succeeded',
      mimeType: '',
      byteSize: 0,
      sha256: ''
    }`;

    const scriptContent = isNativeGeneration
      ? `function main() {
  throw new Error('AI 原生媒体生成需由媒体网关执行，本地试运行不会伪造生成结果。');
}`
      : `function main({ params }) {
  return ${returnExpression};
}`;

    return {
      ...node,
      blocks,
      type: WorkflowNodeType.Code,
      data: {
        ...node.data,
        script: {
          language: 'javascript',
          content: scriptContent,
        },
      },
    };
  };

  const nodes = schema.nodes.map(transformNode);

  return { ...schema, nodes };
};
