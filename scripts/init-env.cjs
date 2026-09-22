const { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } = require('node:fs');
const { dirname, resolve } = require('node:path');
const { randomBytes } = require('node:crypto');
const { adminPassword } = require('./lib/admin-credentials.cjs');

const root = process.cwd();
const configuredEnvPath = process.env.FUTUREFLOW_ENV_FILE?.trim();
const configuredExamplePath = process.env.FUTUREFLOW_ENV_EXAMPLE_FILE?.trim();
const envPath = resolve(root, configuredEnvPath || '.env');
const examplePath = resolve(root, configuredExamplePath || '.env.example');
const envDisplayName = configuredEnvPath ? envPath : '.env';
const secretNames = [
  'GATEWAY_JWT_SECRET',
  'DIFY_KEY_ENCRYPTION_SECRET',
  // 媒体凭据 / MCP 令牌 / 草稿沙箱凭据的独立主密钥。以前不生成它，导致这三类
  // 密文与 Dify 凭据共用 DIFY_KEY_ENCRYPTION_SECRET——一把泄露等于全解。
  // 现在生成独立值；存量密文仍由 DIFY_KEY_ENCRYPTION_SECRET 作只读回退解开
  // （见 gateway/src/common/encryption-key-ring.ts），因此换上新密钥不会让
  // 已有数据变得不可读，也不需要先做数据迁移。
  'MEDIA_CREDENTIAL_ENCRYPTION_SECRET',
  'DIFY_SANDBOX_API_KEY',
  'DIFY_ADMIN_PASSWORD',
  'DIFY_SECRET_KEY',
];
const databaseSecretNames = [
  'POSTGRES_PASSWORD',
  'DIFY_DB_PASSWORD',
  // 应用运行账号的密码（非超级用户）。存量卷不会自动轮换，需要时跑
  // `node scripts/db-grant-app-user.cjs`。
  'POSTGRES_APP_PASSWORD',
];
const rotateDatabaseSecrets = process.argv.includes('--rotate-database-secrets');
const currentEnvSchemaVersion = 2;
const settingDefaults = {
  GATEWAY_HOST: '127.0.0.1',
  GATEWAY_BOOTSTRAP_ADMIN_ENABLED: 'true',
  GATEWAY_BOOTSTRAP_ADMIN_USERNAME: 'admin',
  GATEWAY_BOOTSTRAP_ADMIN_EMAIL: 'admin@futureflow.local',
  POSTGRES_APP_USER: 'futureflow_app',
  // 开发期 synchronize 需要建表权限；生产部署请改成 false。
  POSTGRES_APP_ALLOW_DDL: 'true',
  DIFY_AUTO_BOOTSTRAP: 'true',
  DIFY_MANAGED_BRIDGE: 'true',
  DIFY_SSRF_SYNTHETIC_DNS_ALLOWED_DOMAINS: '.invalid',
};
const oneClickMigrationSettings = {
  GATEWAY_BOOTSTRAP_ADMIN_ENABLED: 'true',
  DIFY_AUTO_BOOTSTRAP: 'true',
  DIFY_MANAGED_BRIDGE: 'true',
};
const compatibilitySettings = {
  // Dify 0.15.3 always asks Sandbox to execute with networking enabled.
  // The container remains isolated and HTTP(S) egress is filtered by Squid.
  DIFY_SANDBOX_ENABLE_NETWORK: 'true',
};
const placeholderPattern = /^(replace-with-|change-me)/i;

function makeSecret() {
  return randomBytes(32).toString('hex');
}

function secretNeedsRepair(value) {
  const normalized = value.trim();
  return normalized.length < 32 || placeholderPattern.test(normalized);
}

function ensureSecret(content, secretName) {
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const pattern = new RegExp(`^(${secretName}=)([^\\r\\n]*)$`, 'm');
  const match = content.match(pattern);
  if (match && !secretNeedsRepair(match[2])) {
    return { content, changed: false };
  }

  const replacement = `${secretName}=${makeSecret()}`;
  if (match) {
    return { content: content.replace(pattern, replacement), changed: true };
  }

  const suffix = content.endsWith('\n') || content.endsWith('\r') ? '' : newline;
  return { content: `${content}${suffix}${replacement}${newline}`, changed: true };
}

function ensureSetting(content, settingName, defaultValue) {
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const pattern = new RegExp(`^${settingName}=`, 'm');
  if (pattern.test(content)) {
    return { content, changed: false };
  }

  const suffix = content.endsWith('\n') || content.endsWith('\r') ? '' : newline;
  return {
    content: `${content}${suffix}${settingName}=${defaultValue}${newline}`,
    changed: true,
  };
}

function ensureSettingValue(content, settingName, requiredValue) {
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const pattern = new RegExp(`^(${settingName}=)([^\\r\\n]*)$`, 'm');
  const match = content.match(pattern);
  if (match?.[2].trim().toLowerCase() === requiredValue.toLowerCase()) {
    return { content, changed: false };
  }
  if (match) {
    return {
      content: content.replace(pattern, `${settingName}=${requiredValue}`),
      changed: true,
    };
  }
  const suffix = content.endsWith('\n') || content.endsWith('\r') ? '' : newline;
  return {
    content: `${content}${suffix}${settingName}=${requiredValue}${newline}`,
    changed: true,
  };
}

const created = !existsSync(envPath);
const initial = created ? readFileSync(examplePath, 'utf8') : readFileSync(envPath, 'utf8');
let content = initial;
const repaired = [];
const existingSchemaVersion = Number.parseInt(
  initial.match(/^FUTUREFLOW_ENV_SCHEMA_VERSION=(\d+)$/m)?.[1] || '0',
  10,
);
for (const secretName of secretNames) {
  const result = ensureSecret(content, secretName);
  content = result.content;
  if (result.changed) repaired.push(secretName);
}
// 管理员初始密码必须每次安装随机生成。.env 里为空、仍是占位符、或仍是历史
// 公开默认值的，统一替换为随机值并只在终端打印一次（不写日志）。已有管理员
// 账号不会被覆盖——轮换存量账号请用 `node scripts/rotate-admin-password.cjs`。
const legacyPublicAdminPassword = ['futureFlow', '@'].join('');
const adminPasswordPattern = /^(GATEWAY_BOOTSTRAP_ADMIN_PASSWORD=)([^\r\n]*)$/m;
const adminPasswordMatch = content.match(adminPasswordPattern);
const currentAdminPassword = adminPasswordMatch?.[2].trim() || '';
let generatedAdminPassword = '';
if (
  !currentAdminPassword ||
  placeholderPattern.test(currentAdminPassword) ||
  currentAdminPassword === legacyPublicAdminPassword
) {
  generatedAdminPassword = makeAdminPassword();
  const passwordResult = adminPasswordMatch
    ? {
      content: content.replace(
        adminPasswordPattern,
        `GATEWAY_BOOTSTRAP_ADMIN_PASSWORD=${generatedAdminPassword}`,
      ),
    }
    : ensureSetting(content, 'GATEWAY_BOOTSTRAP_ADMIN_PASSWORD', generatedAdminPassword);
  content = passwordResult.content;
  repaired.push('GATEWAY_BOOTSTRAP_ADMIN_PASSWORD');
}
const databaseSecretsNeedingMigration = [];
for (const secretName of databaseSecretNames) {
  const pattern = new RegExp(`^${secretName}=([^\\r\\n]*)$`, 'm');
  const value = content.match(pattern)?.[1];
  if (created || rotateDatabaseSecrets) {
    const result = ensureSecret(content, secretName);
    content = result.content;
    if (result.changed) repaired.push(secretName);
  } else if (!value || secretNeedsRepair(value)) {
    databaseSecretsNeedingMigration.push(secretName);
  }
}
for (const [settingName, defaultValue] of Object.entries(settingDefaults)) {
  const result = ensureSetting(content, settingName, defaultValue);
  content = result.content;
  if (result.changed) repaired.push(settingName);
}
for (const [settingName, requiredValue] of Object.entries(compatibilitySettings)) {
  const result = ensureSettingValue(content, settingName, requiredValue);
  content = result.content;
  if (result.changed) repaired.push(settingName);
}

// Version 2 turns the former opt-in bootstrap features into the safe local
// quickstart defaults.  Apply this only once to older generated .env files so
// a user can still explicitly disable either feature after the migration.
if (existingSchemaVersion < currentEnvSchemaVersion) {
  for (const [settingName, requiredValue] of Object.entries(oneClickMigrationSettings)) {
    const result = ensureSettingValue(content, settingName, requiredValue);
    content = result.content;
    if (result.changed) repaired.push(settingName);
  }
  const versionResult = ensureSettingValue(
    content,
    'FUTUREFLOW_ENV_SCHEMA_VERSION',
    String(currentEnvSchemaVersion),
  );
  content = versionResult.content;
  if (versionResult.changed) repaired.push('FUTUREFLOW_ENV_SCHEMA_VERSION');
}

if (created || repaired.length > 0) {
  mkdirSync(dirname(envPath), { recursive: true });
  writeFileSync(envPath, content, { mode: 0o600 });
  try {
    chmodSync(envPath, 0o600);
  } catch {
    // Windows does not apply POSIX modes. The write still completed safely.
  }
}

if (created) {
  console.log(`${envDisplayName} created with random local gateway, database, and Dify secrets`);
} else if (repaired.length > 0) {
  console.log(`${envDisplayName} settings or secrets added/repaired: ${repaired.join(', ')}`);
} else {
  console.log(`${envDisplayName} already has valid gateway and Dify settings`);
}

if (generatedAdminPassword) {
  console.log(
    `管理员初始密码已随机生成并写入 ${envDisplayName}: ${generatedAdminPassword}`,
  );
  console.log('请妥善保存；这是唯一一次显示。' + '已有管理员账号不会被覆盖。');
}

if (databaseSecretsNeedingMigration.length > 0) {
  console.warn(
    `Database secrets need manual migration: ${databaseSecretsNeedingMigration.join(', ')}. ` +
    'They were not rotated automatically because an existing database volume may still use them.',
  );
}
