const content = (value: any): unknown => value?.content;

const asTemplateText = (value: any): string => {
  const raw = content(value);
  if (Array.isArray(raw)) return `{{${raw.join('.')}}}`;
  return String(raw ?? '');
};

const visitNodes = (nodes: any[]): any[] => nodes.map((node) => {
  const blocks = Array.isArray(node.blocks) ? visitNodes(node.blocks) : node.blocks;
  if (node.type !== 'http') return blocks === node.blocks ? node : { ...node, blocks };

  const data = { ...node.data };
  const api = { ...(data.api || {}) };
  if (api.url?.type === 'constant') {
    api.url = { type: 'template', content: String(api.url.content ?? '') };
  }
  const body = { ...(data.body || {}) };
  const method = String(api.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') {
    body.bodyType = 'none';
  }
  if (body.bodyType === 'raw-text' && body.rawText && !body.json) {
    // runtime-js 1.0.12 的纯文本执行路径读取 body.json。
    body.json = body.rawText;
  }

  const authorization = data.authorization || { type: 'none' };
  const headersValues = { ...(data.headersValues || {}) };
  const headerProperties = { ...(data.headers?.properties || {}) };
  let headerName = '';
  let headerValue = '';

  if (authorization.type === 'bearer') {
    headerName = 'Authorization';
    headerValue = `Bearer ${asTemplateText(authorization.token)}`;
  } else if (authorization.type === 'api-key') {
    headerName = asTemplateText(authorization.headerName) || 'X-API-Key';
    headerValue = asTemplateText(authorization.apiKey);
  } else if (authorization.type === 'basic') {
    const username = asTemplateText(authorization.username);
    const password = asTemplateText(authorization.password);
    if (!username.includes('{{') && !password.includes('{{')) {
      headerName = 'Authorization';
      headerValue = `Basic ${window.btoa(unescape(encodeURIComponent(`${username}:${password}`)))}`;
    }
  }

  if (headerName && headerValue) {
    headersValues[headerName] = { type: 'template', content: headerValue };
    headerProperties[headerName] = { type: 'string' };
  }

  return {
    ...node,
    blocks,
    data: {
      ...data,
      api,
      body,
      headersValues,
      headers: { type: 'object', ...(data.headers || {}), properties: headerProperties },
    },
  };
});

export const prepareHttpNodesForRuntime = <T extends { nodes?: any[] }>(schema: T): T => (
  Array.isArray(schema.nodes) ? { ...schema, nodes: visitNodes(schema.nodes) } : schema
);
