type Environment = Record<string, string | undefined>;

function isPlaceholder(value?: string): boolean {
  if (!value) return true;
  return /change-me|replace-with|x{6,}|your[-_ ]?(key|secret|password)/i.test(value);
}

function requirePositiveInteger(
  environment: Environment,
  name: string,
  fallback: number,
) {
  const value = environment[name] || String(fallback);
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  environment[name] = value;
}

/** Reject unsafe production defaults before Nest opens a listening port. */
export function validateEnvironment(raw: Record<string, unknown>): Environment {
  const environment: Environment = {};
  for (const [key, value] of Object.entries(raw)) {
    environment[key] = value === undefined ? undefined : String(value);
  }

  const nodeEnv = environment.NODE_ENV || 'development';
  environment.NODE_ENV = nodeEnv;
  requirePositiveInteger(environment, 'GATEWAY_PORT', 3001);
  requirePositiveInteger(environment, 'WORKFLOW_MAX_CONCURRENT_PER_USER', 3);
  requirePositiveInteger(environment, 'WORKFLOW_MAX_RUNS_PER_MINUTE', 30);
  requirePositiveInteger(environment, 'WORKFLOW_SCHEDULE_TICK_SECONDS', 30);
  // 定时触发器失败重试：默认只额外重试一次、退避 2s，连续失败 3 次起升级为 error 日志。
  requirePositiveInteger(environment, 'WORKFLOW_TRIGGER_RUN_MAX_ATTEMPTS', 2);
  requirePositiveInteger(environment, 'WORKFLOW_TRIGGER_RETRY_BASE_MS', 2000);
  requirePositiveInteger(environment, 'WORKFLOW_TRIGGER_FAILURE_ALERT_THRESHOLD', 3);
  // 残留运行对账：回收进程崩溃后卡在 running 的记录（同时解除冻结与并发占用）。
  requirePositiveInteger(environment, 'WORKFLOW_STALE_RUN_MINUTES', 30);
  requirePositiveInteger(environment, 'WORKFLOW_STALE_RUN_SWEEP_SECONDS', 300);
  // 媒体任务对账：回收进程中断后卡在 creating/queued/processing 的任务。
  requirePositiveInteger(environment, 'MEDIA_STALE_JOB_MINUTES', 30);
  requirePositiveInteger(environment, 'MEDIA_STALE_JOB_SWEEP_SECONDS', 300);
  requirePositiveInteger(environment, 'LLM_REQUEST_TIMEOUT_MS', 120000);
  requirePositiveInteger(environment, 'MEDIA_PROVIDER_TIMEOUT_MS', 120000);
  requirePositiveInteger(environment, 'MEDIA_PROVIDER_JSON_MAX_BYTES', 41943040);
  requirePositiveInteger(environment, 'MEDIA_DOWNLOAD_TIMEOUT_MS', 120000);
  requirePositiveInteger(environment, 'MEDIA_IMAGE_MAX_BYTES', 26214400);
  requirePositiveInteger(environment, 'MEDIA_VIDEO_MAX_BYTES', 262144000);

  const jwtSecret = environment.GATEWAY_JWT_SECRET;
  if (isPlaceholder(jwtSecret) || (jwtSecret || '').length < 32) {
    throw new Error('GATEWAY_JWT_SECRET must be at least 32 characters and not a placeholder');
  }

  const postgresPassword = environment.POSTGRES_PASSWORD;
  if (isPlaceholder(postgresPassword) || (postgresPassword || '').length < 32) {
    throw new Error('POSTGRES_PASSWORD must be at least 32 characters and not a placeholder');
  }

  // 应用运行账号（可选）。给了密码就必须配用户名，且强度不能低于超级用户账号。
  const appUser = environment.POSTGRES_APP_USER;
  const appPassword = environment.POSTGRES_APP_PASSWORD;
  if (appPassword && (isPlaceholder(appPassword) || appPassword.length < 32)) {
    throw new Error('POSTGRES_APP_PASSWORD must be at least 32 characters and not a placeholder');
  }
  if (appPassword && !appUser) {
    throw new Error('POSTGRES_APP_USER is required when POSTGRES_APP_PASSWORD is set');
  }

  const mediaEncryptionSecret = environment.MEDIA_CREDENTIAL_ENCRYPTION_SECRET;
  if (mediaEncryptionSecret && (
    isPlaceholder(mediaEncryptionSecret)
    || mediaEncryptionSecret.length < 32
  )) {
    throw new Error('MEDIA_CREDENTIAL_ENCRYPTION_SECRET must be at least 32 characters and not a placeholder');
  }

  if (nodeEnv !== 'production') return environment;

  const corsOrigin = environment.CORS_ORIGIN;
  if (!corsOrigin || corsOrigin.split(',').some((origin) => origin.trim() === '*')) {
    throw new Error('CORS_ORIGIN must list explicit origins in production');
  }

  const hasDify = Boolean(environment.DIFY_API_KEY?.startsWith('app-')) && !isPlaceholder(environment.DIFY_API_KEY);
  const hasManagedDify =
    environment.DIFY_MANAGED_BRIDGE === 'true' &&
    Boolean(environment.DIFY_KEY_ENCRYPTION_SECRET) &&
    (environment.DIFY_KEY_ENCRYPTION_SECRET || '').length >= 32;
  const hasLlm = Boolean(environment.LLM_API_KEY) && !isPlaceholder(environment.LLM_API_KEY);
  if (!hasDify && !hasManagedDify && !hasLlm) {
    throw new Error('Configure a valid DIFY_API_KEY, managed Dify bridge, or LLM_API_KEY in production');
  }

  return environment;
}
