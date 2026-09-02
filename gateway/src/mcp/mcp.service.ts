import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsIn } from 'class-validator';
import { Repository } from 'typeorm';
import { McpServer } from '../database/entities/mcp-server.entity';
import { McpCrypto } from './mcp-crypto.service';
import { McpJsonRpcClient, McpToolSummary } from './mcp-jsonrpc.client';

export interface McpServerSummary {
  id: string;
  name: string;
  url: string;
  hasToken: boolean;
  createdAt: Date;
}

@Injectable()
export class McpService {
  constructor(
    @InjectRepository(McpServer)
    private readonly repo: Repository<McpServer>,
    private readonly crypto: McpCrypto,
  ) {}

  async listServers(userId: string): Promise<McpServerSummary[]> {
    const rows = await this.repo.find({ where: { userId }, order: { createdAt: 'DESC' } });
    return rows.map((row) => this.toSummary(row));
  }

  async createServer(userId: string, name: string, url: string, token: string): Promise<McpServerSummary> {
    const normalizedUrl = this.normalizeUrl(url);
    const record = await this.repo.save(this.repo.create({
      userId,
      name: name.slice(0, 80),
      url: normalizedUrl,
      encryptedToken: token ? '' : null,
    }));
    if (token) {
      record.encryptedToken = this.crypto.encrypt(token, { userId, serverId: record.id });
      await this.repo.save(record);
    }
    return this.toSummary(record);
  }

  async deleteServer(userId: string, serverId: string, requireAdmin = false): Promise<void> {
    const record = await this.ownedServer(userId, serverId, requireAdmin);
    await this.repo.remove(record);
  }

  async listTools(userId: string, serverId: string, requireAdmin = false): Promise<McpToolSummary[]> {
    const record = await this.ownedServer(userId, serverId, requireAdmin);
    const client = await this.connect(record);
    return client.listTools();
  }

  async callTool(
    userId: string,
    input: { serverId: string; tool: string; arguments?: Record<string, unknown> },
    requireAdmin = false,
  ): Promise<unknown> {
    const record = await this.ownedServer(userId, input.serverId, requireAdmin);
    if (!input.tool || typeof input.tool !== 'string') {
      throw new BadRequestException('工具名称不能为空');
    }
    const client = await this.connect(record);
    return client.callTool(input.tool, input.arguments || {});
  }

  async ownedServerRecord(userId: string, serverId: string, requireAdmin = false): Promise<McpServer> {
    return this.ownedServer(userId, serverId, requireAdmin);
  }

  decryptToken(record: McpServer): string | null {
    if (!record.encryptedToken) return null;
    return this.crypto.decrypt(record.encryptedToken, { userId: record.userId, serverId: record.id });
  }

  private async connect(record: McpServer): Promise<McpJsonRpcClient> {
    return McpJsonRpcClient.connect(record.url, this.decryptToken(record));
  }

  private async ownedServer(userId: string, serverId: string, requireAdmin: boolean): Promise<McpServer> {
    const record = await this.repo.findOne({ where: { id: serverId } });
    if (!record) throw new NotFoundException('MCP 服务器不存在或已被删除');
    if (record.userId !== userId && !requireAdmin) {
      throw new ForbiddenException('只能访问自己的 MCP 服务器');
    }
    return record;
  }

  private normalizeUrl(url: string): string {
    const trimmed = String(url || '').trim();
    try {
      const parsed = new URL(trimmed);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('protocol');
      if (parsed.username || parsed.password) throw new Error('credentials');
      return trimmed.replace(/\/+$/, '');
    } catch {
      throw new BadRequestException('MCP 服务器地址必须是有效的 HTTP(S) URL');
    }
  }

  private toSummary(row: McpServer): McpServerSummary {
    return {
      id: row.id,
      name: row.name,
      url: row.url,
      hasToken: Boolean(row.encryptedToken),
      createdAt: row.createdAt,
    };
  }
}

/** DTO 校验辅助：仅允许 streamable HTTP 传输类型占位声明。 */
export class McpTransportDto {
  @IsIn(['http'], { message: '当前仅支持 streamable HTTP 传输' })
  transport: string = 'http';
}
