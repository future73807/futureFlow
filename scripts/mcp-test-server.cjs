#!/usr/bin/env node
/**
 * 验收用的最小 MCP 服务器（streamable HTTP + JSON 响应，无 SSE）。
 *
 * 网关的 MCP 客户端只接受 application/json 的 JSON-RPC 响应，因此这里
 * 用原生 http 实现 initialize / notifications/initialized / tools/list / tools/call，
 * 便于在没有外网依赖的情况下真实跑通「MCP 工具」节点。
 *
 * 用法：node scripts/mcp-test-server.cjs [port]   （默认 3921）
 */
'use strict';

const http = require('node:http');

const port = Number(process.argv[2] || 3921);
let sessionCounter = 0;

const TOOLS = [
  {
    name: 'get_time',
    description: '返回服务器当前时间的 ISO 字符串与时间戳',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'echo',
    description: '回显传入的 text 参数，用于验证参数透传',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: '要回显的文本' } },
      required: ['text'],
    },
  },
  {
    name: 'add',
    description: '把 a 与 b 相加返回 a+b',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
  },
];

const callTool = (name, args = {}) => {
  switch (name) {
    case 'get_time': {
      const now = new Date();
      return { content: [{ type: 'text', text: `server_time=${now.toISOString()} epoch_ms=${now.getTime()}` }] };
    }
    case 'echo':
      return { content: [{ type: 'text', text: `echo:${String(args.text ?? '')}` }] };
    case 'add': {
      const sum = Number(args.a || 0) + Number(args.b || 0);
      return { content: [{ type: 'text', text: `sum=${sum}` }] };
    }
    default:
      return null;
  }
};

const send = (res, status, body, headers = {}) => {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
};

const server = http.createServer((req, res) => {
  if (req.method === 'GET') {
    // 健康检查，便于验收脚本确认服务已就绪
    return send(res, 200, { status: 'ok', tools: TOOLS.map((tool) => tool.name) });
  }
  if (req.method !== 'POST') {
    return send(res, 405, { error: 'method not allowed' });
  }

  let raw = '';
  req.on('data', (chunk) => {
    raw += chunk;
  });
  req.on('end', () => {
    let message;
    try {
      message = JSON.parse(raw || '{}');
    } catch {
      return send(res, 400, { error: 'invalid json' });
    }

    const { id, method, params } = message;
    const reply = (result) => send(res, 200, { jsonrpc: '2.0', id, result });

    switch (method) {
      case 'initialize': {
        sessionCounter += 1;
        return reply({
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'futureflow-mcp-test', version: '1.0.0' },
        });
      }
      case 'notifications/initialized':
        return send(res, 202, undefined);
      case 'tools/list':
        return reply({ tools: TOOLS });
      case 'tools/call': {
        const name = params?.name;
        const result = callTool(name, params?.arguments || {});
        if (!result) {
          return send(res, 200, {
            jsonrpc: '2.0',
            id,
            error: { code: -32602, message: `unknown tool: ${name}` },
          });
        }
        return reply(result);
      }
      default:
        return send(res, 200, {
          jsonrpc: '2.0',
          id: id ?? null,
          error: { code: -32601, message: `method not found: ${method}` },
        });
    }
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[mcp-test-server] listening on http://127.0.0.1:${port}/mcp`);
});
