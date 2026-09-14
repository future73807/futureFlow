import { BadRequestException, Body, Controller, Post, Request, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { Client } from 'pg';
import { Logger } from '@nestjs/common';

interface DbQueryPayload {
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  database?: string;
  sql?: string;
}

const MAX_ROWS = 200;
const MAX_SQL_LENGTH = 10_000;
const CONNECT_TIMEOUT_MS = 8_000;
const STATEMENT_TIMEOUT_MS = 10_000;

/**
 * 本地数据库查询代理（「SQL 查询」节点专用）
 *
 * 节点在浏览器试运行时无法直连用户数据库（CORS/驱动限制），由网关代为执行：
 * - 仅允许单条 SELECT/WITH 只读查询（事务以 READ ONLY 打开，Postgres 层兜底）
 * - 连接信息随请求传入、用完即弃，不在网关落库或记录日志
 * - 最多返回 200 行，语句超时 10 秒
 */
@UseGuards(JwtAuthGuard)
@Controller('db')
export class DbQueryController {
  private readonly logger = new Logger(DbQueryController.name);

  @Post('query')
  async query(@Request() req: any, @Body() payload: DbQueryPayload) {
    if (!req?.user?.id) throw new BadRequestException('未认证');
    const host = (payload.host || '').trim();
    const username = (payload.username || '').trim();
    const database = (payload.database || '').trim();
    const port = Number(payload.port || 5432);
    const password = payload.password || '';
    const rawSql = (payload.sql || '').trim();

    if (!host || !database || !username) {
      throw new BadRequestException('请完整填写数据库主机、用户名和数据库名');
    }
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new BadRequestException('端口必须是 1-65535 的整数');
    }
    if (!rawSql) {
      throw new BadRequestException('SQL 不能为空');
    }
    if (rawSql.length > MAX_SQL_LENGTH) {
      throw new BadRequestException(`SQL 长度不能超过 ${MAX_SQL_LENGTH} 个字符`);
    }
    const sql = rawSql.replace(/;\s*$/, '');
    if (/;/.test(sql)) {
      throw new BadRequestException('一次只能执行一条查询语句（不能包含分号）');
    }
    if (!/^(select|with)\b/i.test(sql)) {
      throw new BadRequestException('仅支持 SELECT / WITH 只读查询');
    }

    const client = new Client({
      host,
      port,
      user: username,
      password,
      database,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      statement_timeout: STATEMENT_TIMEOUT_MS,
    });

    try {
      await client.connect();
      await client.query('BEGIN READ ONLY');
      let rows: any[];
      try {
        const result = await client.query(sql);
        rows = result.rows || [];
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
      }
      const truncated = rows.length > MAX_ROWS;
      if (truncated) rows = rows.slice(0, MAX_ROWS);
      return {
        rows,
        rowCount: rows.length,
        truncated,
      };
    } catch (error: any) {
      const message = String(error?.message || '数据库查询失败');
      this.logger.warn(`DB 查询失败(${host}:${port}/${database}): ${message.slice(0, 160)}`);
      throw new BadRequestException(`数据库查询失败: ${message}`);
    } finally {
      await client.end().catch(() => undefined);
    }
  }
}