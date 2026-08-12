#!/usr/bin/env node

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

// 仅加载纯解析/校验函数；不会发起网络请求或读取用户凭据。
global.__GATEWAY_URL__ = 'http://127.0.0.1:3001';
global.document = { cookie: '' };
process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({
  module: 'CommonJS',
  moduleResolution: 'Node',
  esModuleInterop: true,
  target: 'ES2022',
  lib: ['ES2022', 'DOM'],
});
process.env.TS_NODE_TRANSPILE_ONLY = 'true';
require(resolve(__dirname, '../gateway/node_modules/ts-node/register/transpile-only'));

const {
  isMediaCredentialId,
  parseMediaCredentialSummaries,
} = require(resolve(__dirname, '../demo-free-layout/src/services/media-credentials.ts'));

const credentialId = '11111111-1111-4111-8111-111111111111';
const keyMarker = 'media-ui-key-marker-do-not-persist';

assert.equal(isMediaCredentialId(credentialId), true);
assert.equal(isMediaCredentialId('cred_media_production'), false);
assert.equal(isMediaCredentialId('sk-not-a-credential'), false);
assert.equal(isMediaCredentialId('11111111-1111-4111-8111-11111111111z'), false);

const summaries = parseMediaCredentialSummaries([{
  id: credentialId,
  provider: 'openai',
  label: '生产主账号',
  fingerprint: 'sha256:abc123',
  createdAt: '2026-08-10T00:00:00.000Z',
  updatedAt: '2026-08-10T00:00:00.000Z',
  apiKey: keyMarker,
  encryptedApiKey: keyMarker,
}]);
assert.deepEqual(Object.keys(summaries[0]).sort(), [
  'createdAt', 'fingerprint', 'id', 'label', 'provider', 'updatedAt',
]);
assert.doesNotMatch(JSON.stringify(summaries), new RegExp(keyMarker));
assert.throws(
  () => parseMediaCredentialSummaries([{ id: 'not-a-uuid', provider: 'openai', label: 'x' }]),
  /数据不完整/,
);

const formMeta = readFileSync(
  resolve(__dirname, '../demo-free-layout/src/nodes/content/form-meta.tsx'),
  'utf8',
);
const selector = readFileSync(
  resolve(__dirname, '../demo-free-layout/src/nodes/content/media-credential-selector.tsx'),
  'utf8',
);
assert.match(formMeta, /MediaCredentialSelector/);
assert.match(formMeta, /isMediaCredentialId/);
assert.doesNotMatch(formMeta, /apiKey/);
assert.match(formMeta, /video: \['MiniMax-H3'\]/);
assert.match(formMeta, /清晰度（MiniMax H3）/);
assert.match(formMeta, /图片比例暂不支持 auto/);
assert.doesNotMatch(formMeta, /name="negativePrompt"/);
assert.doesNotMatch(formMeta, /name="referenceUrl"/);
assert.match(selector, /listMediaCredentials\(\)/);
assert.match(selector, /createMediaCredential\(/);
assert.match(selector, /previousProviderRef/);
assert.doesNotMatch(selector, /name=["']media\./);

console.log('媒体凭据 UI：UUID 校验、公开摘要白名单与画布密钥隔离测试通过');
