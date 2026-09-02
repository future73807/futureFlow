import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';

/**
 * 最小化的 MCP streamable-HTTP JSON-RPC 客户端：
 * initialize（建立会话）→ tools/list / tools/call。
 * 仅支持返回 application/json 的端点；SSE 流式响应按错误处理。
 */
export interface McpToolSummary {
  name: string;
  description: string;
}

interface RpcResult {
  sessionId: string | null;
  result: any;
}

export class McpJsonRpcClient {
  private constructor(
    private readonly url: string,
    private readonly bearerToken: string | null,
    private readonly sessionId: string | null,
  ) {}

  static async connect(url: string, bearerToken: string | null): Promise<McpJsonRpcClient> {
    const session = await McpJsonRpcClient.rpc(url, bearerToken, null, {
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'futureFlow', version: '0.1.0' },
      },
    });
    void session.result;
    const client = new McpJsonRpcClient(url, bearerToken, session.sessionId);
    // initialized 通知无需响应；失败不阻断（部分无状态端点直接忽略）。
    await McpJsonRpcClient.rpc(url, bearerToken, session.sessionId, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }).catch(() => undefined);
    return client;
  }

  async listTools(): Promise<McpToolSummary[]> {
    const { result } = await this.call('tools/list', {});
    const tools = Array.isArray(result?.tools) ? result.tools : [];
    return tools.map((tool: any) => ({
      name: String(tool?.name || ''),
      description: String(tool?.description || ''),
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const { result } = await this.call('tools/call', { name, arguments: args });
    return result;
  }

  private call(method: string, params: Record<string, unknown>) {
    return McpJsonRpcClient.rpc(this.url, this.bearerToken, this.sessionId, {
      jsonrpc: '2.0',
      id: Date.now(),
      method,
      params,
    });
  }

  private static async rpc(
    url: string,
    bearerToken: string | null,
    sessionId: string | null,
    body: Record<string, unknown>,
  ): Promise<RpcResult> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2024-11-05',
    };
    if (bearerToken) headers.Authorization = `Bearer ${bearerToken}`;
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new ServiceUnavailableException(
        `MCP 服务器不可达：${error instanceof Error ? error.message : '未知错误'}`,
      );
    }
    const nextSession = response.headers.get('mcp-session-id');
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      throw new ServiceUnavailableException(
        'MCP 服务器返回了不支持的响应格式（仅支持 JSON）',
      );
    }
    const payload = await response.json().catch(() => ({})) as any;
    if (!response.ok) {
      throw new BadRequestException(
        `MCP 服务器请求失败（HTTP ${response.status}）：${String(payload?.error?.message || '').slice(0, 200)}`,
      );
    }
    if (payload?.error) {
      throw new BadRequestException(
        `MCP 工具调用失败：${String(payload.error.message || JSON.stringify(payload.error)).slice(0, 200)}`,
      );
    }
    return { sessionId: nextSession || sessionId, result: payload?.result ?? payload };
  }
}
