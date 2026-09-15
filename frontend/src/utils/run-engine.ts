/**
 * 试运行引擎判定。
 * 本地开发时浏览器自带 JS 运行时直接跑图，服务器部署时改由网关调用 Dify 执行，
 * 两者是同一套画布语义下的不同执行后端，用户只需要一个「试运行」入口。
 * 部署方可用 .env 的 PUBLIC_RUN_ENGINE=local|cloud 显式指定，默认 auto 按访问域名判定。
 */

export type RunEngine = 'local' | 'cloud';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

const configuredEngine = (): RunEngine | 'auto' => {
  const value = String(typeof __RUN_ENGINE__ === 'string' ? __RUN_ENGINE__ : 'auto')
    .trim()
    .toLowerCase();
  return value === 'local' || value === 'cloud' ? value : 'auto';
};

export const resolveRunEngine = (): RunEngine => {
  const configured = configuredEngine();
  if (configured !== 'auto') return configured;
  if (typeof window === 'undefined') return 'cloud';
  return LOOPBACK_HOSTS.has(window.location.hostname) ? 'local' : 'cloud';
};

export const runEngineHint = (engine: RunEngine): string =>
  engine === 'local'
    ? '本机开发环境：在浏览器本地运行时执行，不消耗云端额度'
    : '已部署环境：由服务端调用 Dify 真实执行';
