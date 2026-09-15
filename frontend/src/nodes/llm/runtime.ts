import { GATEWAY_URL } from '../../utils/config';

/**
 * 浏览器「试运行」由 runtime-js 直接执行大语言模型节点，执行器要求
 * apiKey / apiHost 两个输入。模型服务商不允许浏览器跨域直连，且 API Key
 * 不能下发到前端，因此这里把节点输入指到网关的 LLM 直连代理：
 *
 *   POST ${GATEWAY_URL}/llm/chat/completions
 *
 * 网关使用服务端配置的 LLM_API_KEY / LLM_DEFAULT_MODEL 完成真实调用，
 * 用户无需（也不能）在画布上手工填写密钥。仅当节点没有填写过这些输入
 * 时才注入，保留显式自定义行为的可能。
 */
export const prepareLLMNodesForRuntime = <T extends { nodes?: any[] }>(schema: T): T => {
  if (!Array.isArray(schema.nodes)) return schema;

  const transformNode = (node: any): any => {
    const blocks = Array.isArray(node.blocks) ? node.blocks.map(transformNode) : node.blocks;
    if (node.type !== 'llm') {
      return blocks === node.blocks ? node : { ...node, blocks };
    }

    const inputs = { ...(node.data?.inputs || { type: 'object', properties: {} }) };
    inputs.properties = {
      ...(inputs.properties || {}),
      apiKey: { type: 'string', title: 'API 密钥' },
      apiHost: { type: 'string', title: 'API 地址' },
    };

    const inputsValues = { ...(node.data?.inputsValues || {}) };
    if (!inputsValues.apiHost) {
      inputsValues.apiHost = { type: 'constant', content: `${GATEWAY_URL}/llm` };
    }
    if (!inputsValues.apiKey) {
      inputsValues.apiKey = { type: 'constant', content: 'managed-by-gateway' };
    }

    return {
      ...node,
      blocks,
      data: {
        ...(node.data || {}),
        inputs,
        inputsValues,
      },
    };
  };

  return { ...schema, nodes: schema.nodes!.map(transformNode) };
};