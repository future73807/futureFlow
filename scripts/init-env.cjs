const { existsSync, readFileSync, writeFileSync, chmodSync } = require('node:fs');
const { resolve } = require('node:path');
const { randomBytes } = require('node:crypto');

const root = process.cwd();
const envPath = resolve(root, '.env');
const examplePath = resolve(root, '.env.example');
const secretName = 'DIFY_KEY_ENCRYPTION_SECRET';
const placeholderPattern = /^(replace-with-|change-me)/i;

function makeSecret() {
  return randomBytes(32).toString('hex');
}

function secretNeedsRepair(value) {
  const normalized = value.trim();
  return normalized.length < 32 || placeholderPattern.test(normalized);
}

function ensureDifyEncryptionSecret(content) {
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

const created = !existsSync(envPath);
const initial = created ? readFileSync(examplePath, 'utf8') : readFileSync(envPath, 'utf8');
const result = ensureDifyEncryptionSecret(initial);

if (created || result.changed) {
  writeFileSync(envPath, result.content, { mode: 0o600 });
  try {
    chmodSync(envPath, 0o600);
  } catch {
    // Windows does not apply POSIX modes. The write still completed safely.
  }
}

if (created) {
  console.log('.env created with a local Dify credential-encryption secret');
} else if (result.changed) {
  console.log('.env Dify credential-encryption secret was added or repaired');
} else {
  console.log('.env already has a valid Dify credential-encryption secret');
}
