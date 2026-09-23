import { BadRequestException } from '@nestjs/common';

/**
 * Dify 从容器内**回连宿主网关**的地址。
 *
 * 为什么必须是同一份实现：
 *
 * 原生媒体节点和 MCP 代理节点都要让 Dify 回调到宿主网关，而 SSRF 代理只放行
 * **一个** host/port 组合（见 `docker-compose.yml` 的 `MEDIA_GATEWAY_HOST` /
 * `MEDIA_GATEWAY_PORT`）。两处各算一份地址，就等于埋了一个「改一处漏一处」的坑。
 *
 * 之前确实是两份：`native-media-bridge.ts` 的 fallback 用
 * `http://host.docker.internal:${port}`，`mcp-bridge.ts` 用
 * `http://futureflow-gateway:${port}` —— 后者在 docker 网络里**根本不存在**
 * （仓库里 `futureflow-gateway` 只是 `gateway/package.json` 的 pnpm 包名，
 * compose 没有同名服务）。只是因为 `.env` 显式钉了 `DIFY_MEDIA_GATEWAY_URL`
 * 才一直没暴露：一旦那行被删或没生成，MCP 链路会静默指向一个不存在的主机。
 *
 * 统一到这里，fallback 主机固定为 `host.docker.internal`（与 compose 白名单的
 * 默认值一致）。端口的优先级：`DIFY_MEDIA_GATEWAY_PORT` > `GATEWAY_PORT` > `3001`，
 * 这样不配置时也能自动跟随网关监听端口。
 *
 * @param env 默认 `process.env`；暴露成参数是为了单测能直接喂变量，不用改进程环境。
 */
export function mediaGatewayBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = String(env.DIFY_MEDIA_GATEWAY_URL || '').trim();
  // 每一级都先 trim 再判空：`.env` 里写成 `KEY=` 时 dotenv 给的是空字符串，
  // 写成 `KEY=   ` 时给的是纯空白。后者若不 trim 就会被当成「已设置」，
  // 拼出 `http://host.docker.internal:` 这种没有端口的畸形地址 —— 实测踩到过。
  const port = String(env.DIFY_MEDIA_GATEWAY_PORT || '').trim()
    || String(env.GATEWAY_PORT || '').trim()
    || '3001';
  const raw = (explicit || `http://host.docker.internal:${port}`).replace(/\/+$/, '');

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new BadRequestException('DIFY_MEDIA_GATEWAY_URL 格式无效');
  }
  // 显式配置了也照校验：带凭据的地址会被写进 Dify 的 DSL，等于把密钥交给运行时。
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new BadRequestException('DIFY_MEDIA_GATEWAY_URL 必须是无内嵌凭据的 HTTP(S) 地址');
  }
  return raw;
}
