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
