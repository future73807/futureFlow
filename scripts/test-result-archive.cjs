#!/usr/bin/env node

const assert = require('node:assert/strict');
const { resolve } = require('node:path');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({
  module: 'CommonJS',
  moduleResolution: 'Node',
  esModuleInterop: true,
  target: 'ES2022',
  lib: ['ES2022', 'DOM'],
});
process.env.TS_NODE_TRANSPILE_ONLY = 'true';

require(resolve(__dirname, '../gateway/node_modules/ts-node/register/transpile-only'));

const JSZip = require(resolve(__dirname, '../demo-free-layout/node_modules/jszip'));
const {
  createResultArchive,
  extractTextOutput,
} = require(resolve(__dirname, '../demo-free-layout/src/utils/result-archive.ts'));

const FIXED_TIME = new Date('2026-08-09T12:34:56.000Z');

async function readArchive(payload) {
  const archive = createResultArchive(payload, FIXED_TIME);
  const buffer = await archive.zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const loaded = await JSZip.loadAsync(buffer);
  return { archive, loaded };
}

async function main() {
  assert.equal(
    extractTextOutput({ media: { url: 'https://example.com/image.png' }, result: { text: '优先文本' } }),
    '优先文本',
  );
  assert.equal(extractTextOutput({ nested: { value: '回退文本' } }), '回退文本');
  assert.equal(extractTextOutput({ result: [2, 4, 6] }), undefined);

  const success = await readArchive({
    workflowName: '中文/全链路:验收',
    status: '执行成功',
    inputs: { query: '测试输入', apiToken: 'should-not-leak' },
    text: '测试文本输出',
    outputs: { imageUrl: 'https://example.com/image.png', ok: 1 },
    nodes: [{ nodeId: 'text', status: 'succeeded' }],
    statistics: { totalSteps: 7, elapsedTime: 1.2 },
  });

  const successFiles = Object.keys(success.loaded.files).sort();
  assert.deepEqual(successFiles, [
    'manifest.json',
    '完整结果.json',
    '工作流输入.json',
    '工作流输出.json',
    '文本输出.txt',
    '节点执行记录.json',
    '结果摘要.md',
  ].sort());
  assert.equal(success.archive.fileName, '中文-全链路-验收-2026-08-09T12-34-56.zip');

  const manifest = JSON.parse(await success.loaded.file('manifest.json').async('string'));
  assert.equal(manifest.format, 'futureFlow-result-archive');
  assert.equal(manifest.version, 1);
  assert.equal(manifest.status, '执行成功');
  assert.deepEqual(manifest.files.slice().sort(), successFiles);

  const completeText = await success.loaded.file('完整结果.json').async('string');
  assert.doesNotMatch(completeText, /should-not-leak/);
  const complete = JSON.parse(completeText);
  assert.equal(complete.inputs.query, '测试输入');
  assert.equal(complete.inputs.apiToken, '[已隐藏]');
  assert.equal(complete.outputs.ok, 1);
  assert.equal(complete.generatedAt, FIXED_TIME.toISOString());
  assert.equal(await success.loaded.file('文本输出.txt').async('string'), '测试文本输出');
  const archivedInputs = JSON.parse(await success.loaded.file('工作流输入.json').async('string'));
  assert.equal(archivedInputs.apiToken, '[已隐藏]');

  const echoedSecret = 'credential-echo-marker';
  const echoed = await readArchive({
    workflowName: `回显-${echoedSecret}`,
    status: '执行成功',
    inputs: { apiToken: echoedSecret },
    text: `上游正文回显 ${echoedSecret}`,
    outputs: { message: `嵌套输出 ${echoedSecret}` },
    nodes: [{ error: `节点错误 ${encodeURIComponent(echoedSecret)}` }],
    error: `失败详情 ${echoedSecret}`,
  });
  assert.doesNotMatch(echoed.archive.fileName, /credential-echo-marker/);
  for (const file of Object.values(echoed.loaded.files)) {
    if (file.dir) continue;
    assert.doesNotMatch(await file.async('string'), /credential-echo-marker/);
  }

  const opaqueCredential = 'ordinary-auth-input-marker';
  const opaque = await readArchive({
    workflowName: '普通字段认证值',
    status: '执行成功',
    inputs: { foo: opaqueCredential, query: '正常业务输入' },
    outputs: { echoed: `服务回显 ${opaqueCredential}` },
    sensitiveInputKeys: ['foo'],
  });
  for (const file of Object.values(opaque.loaded.files)) {
    if (file.dir) continue;
    const content = await file.async('string');
    assert.doesNotMatch(content, /ordinary-auth-input-marker/);
    assert.doesNotMatch(content, /sensitiveInputKeys/);
  }
  const opaqueInputs = JSON.parse(await opaque.loaded.file('工作流输入.json').async('string'));
  assert.equal(opaqueInputs.foo, '[已隐藏]');
  assert.equal(opaqueInputs.query, '正常业务输入');

  const failure = await readArchive({
    workflowName: '失败链路',
    status: '执行失败',
    error: '上游 API 超时',
  });
  const failureFiles = Object.keys(failure.loaded.files).sort();
  assert.deepEqual(failureFiles, [
    'manifest.json',
    '完整结果.json',
    '节点执行记录.json',
    '结果摘要.md',
  ].sort());
  const failureSummary = await failure.loaded.file('结果摘要.md').async('string');
  assert.match(failureSummary, /状态：执行失败/);
  assert.match(failureSummary, /错误：上游 API 超时/);

  console.log('结果 ZIP：成功包 7 个文件、失败包 4 个文件，内容与文件名校验通过');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
