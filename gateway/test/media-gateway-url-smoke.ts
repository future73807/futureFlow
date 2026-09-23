/**
 * 媒体回连地址（Dify → 宿主网关）专项冒烟测试。
 *
 * 为什么要有这个测试：
 *
 * SSRF 代理只放行**一个** host/port 组合，所以原生媒体节点和 MCP 代理节点算出来的
 * 回连地址必须是同一个。历史上有两份实现，fallback 主机还不一样——
 * `native-media-bridge` 用 `host.docker.internal`，`mcp-bridge` 用
 * `futureflow-gateway`，而后者在 docker 网络里**不存在**（仓库里它只是
 * `gateway/package.json` 的 pnpm 包名，compose 无同名服务）。
 * 只是因为 `.env` 显式钉了 `DIFY_MEDIA_GATEWAY_URL` 才一直没暴露——一旦那行没生成，
 * MCP 链路会静默指向一个不存在的主机。
 *
 * 这里既测行为（端口优先级、显式优先、非法地址拒绝），也做**源码级**断言：
 * 两个 bridge 模块不许再各自实现一份地址解析——分叉是根因，行为测试治不了根因。
 */
import 'reflect-metadata';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BadRequestException } from '@nestjs/common';

import { mediaGatewayBaseUrl } from '../src/converter/media-gateway-url';

const CONVERTER_DIR = join(__dirname, '..', 'src', 'converter');

async function main() {
  // 1. 显式配置优先
  assert.equal(
    mediaGatewayBaseUrl({ DIFY_MEDIA_GATEWAY_URL: 'http://host.docker.internal:3401' }),
    'http://host.docker.internal:3401',
    '显式 URL 必须优先',
  );

  // 2. 显式 URL 也会去掉结尾斜杠（拼路径时会多一个 /）
  assert.equal(
    mediaGatewayBaseUrl({ DIFY_MEDIA_GATEWAY_URL: 'http://host.docker.internal:3401///' }),
    'http://host.docker.internal:3401',
    '结尾斜杠要去掉',
  );

  // 3. 关键防回归：fallback 主机必须是 host.docker.internal。
  //    写死成 futureflow-gateway 时这里会红（历史上正是那样）。
  assert.equal(
    mediaGatewayBaseUrl({ GATEWAY_PORT: '3001' }),
    'http://host.docker.internal:3001',
    'fallback 主机必须是 host.docker.internal（compose 白名单的默认 host）；'
    + '不能是 futureflow-gateway——docker 网络里没有这个主机',
  );

  // 4. 端口优先级：DIFY_MEDIA_GATEWAY_PORT > GATEWAY_PORT > 3001
  assert.equal(
    mediaGatewayBaseUrl({ DIFY_MEDIA_GATEWAY_PORT: '9999', GATEWAY_PORT: '3401' }),
    'http://host.docker.internal:9999',
    'DIFY_MEDIA_GATEWAY_PORT 应优先于 GATEWAY_PORT',
  );
  assert.equal(
    mediaGatewayBaseUrl({ GATEWAY_PORT: '3401' }),
    'http://host.docker.internal:3401',
    '没设 DIFY_MEDIA_GATEWAY_PORT 时应跟随 GATEWAY_PORT',
  );
  assert.equal(
    mediaGatewayBaseUrl({}),
    'http://host.docker.internal:3001',
    '都没设时回退到 3001',
  );

  // 4b. `.env.example` 现在把这三项留空（`KEY=`），dotenv 会把它们设成**空字符串**
  //     而不是删除。空字符串必须与「未设置」等价，否则模板一生成就踩坑。
  assert.equal(
    mediaGatewayBaseUrl({
      DIFY_MEDIA_GATEWAY_URL: '',
      DIFY_MEDIA_GATEWAY_HOST: '',
      DIFY_MEDIA_GATEWAY_PORT: '',
      GATEWAY_PORT: '3401',
    }),
    'http://host.docker.internal:3401',
    '留空（空字符串）必须与未设置等价，并跟随 GATEWAY_PORT',
  );
  assert.equal(
    mediaGatewayBaseUrl({
      DIFY_MEDIA_GATEWAY_URL: '   ',
      DIFY_MEDIA_GATEWAY_PORT: '  ',
      GATEWAY_PORT: '3401',
    }),
    'http://host.docker.internal:3401',
    '只有空白字符也应视为未设置',
  );

  // 5. 非法地址必须拒绝：这类值会被写进 Dify 的 DSL，等于把凭据交给运行时
  assert.throws(
    () => mediaGatewayBaseUrl({ DIFY_MEDIA_GATEWAY_URL: 'ftp://host:3001' }),
    (error: unknown) => error instanceof BadRequestException,
    '非 HTTP(S) 协议必须拒绝',
  );
  assert.throws(
    () => mediaGatewayBaseUrl({ DIFY_MEDIA_GATEWAY_URL: 'http://user:pass@host.docker.internal:3001' }),
    (error: unknown) => error instanceof BadRequestException,
    '带内嵌凭据的地址必须拒绝',
  );
  assert.throws(
    () => mediaGatewayBaseUrl({ DIFY_MEDIA_GATEWAY_URL: 'not-a-url' }),
    (error: unknown) => error instanceof BadRequestException,
    '格式无效必须拒绝',
  );

  // 6. 源码级：两个 bridge 不许再各自实现一份地址解析
  for (const file of ['mcp-bridge.ts', 'native-media-bridge.ts']) {
    const source = readFileSync(join(CONVERTER_DIR, file), 'utf8');
    assert.match(
      source, /mediaGatewayBaseUrl/,
      `${file} 应使用共享的 mediaGatewayBaseUrl`,
    );
    assert.doesNotMatch(
      source, /function gatewayBaseUrl\(\): string \{\s*\n\s*const explicit =/,
      `${file} 不应再内联一份地址解析（分叉是历史上 host 不一致的根因）`,
    );
    assert.doesNotMatch(
      source, /futureflow-gateway/,
      `${file} 不应再出现 futureflow-gateway（docker 网络里没有这个主机）`,
    );
  }

  console.log('media gateway url smoke passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
