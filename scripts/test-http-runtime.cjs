const assert = require('node:assert/strict');
const { createServer } = require('node:http');
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

const { prepareHttpNodesForRuntime } = require(resolve(
  __dirname,
  '../demo-free-layout/src/nodes/http/runtime.ts',
));

let TaskReportAPI;
let TaskRunAPI;
let TaskValidateAPI;

const received = [];

const readRequestBody = (request) => new Promise((resolveBody, reject) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
  request.on('error', reject);
});

const startEchoServer = async () => {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', 'http://127.0.0.1');
      const rawBody = await readRequestBody(request);
      const entry = {
        method: request.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        testHeader: request.headers['x-futureflow-test'],
        contentType: request.headers['content-type'],
        rawBody,
      };
      received.push(entry);

      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      if (request.method === 'GET' && url.pathname === '/get') {
        response.statusCode = 207;
        response.end(JSON.stringify({
          method: request.method,
          args: entry.query,
          testHeader: entry.testHeader,
        }));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/post') {
        response.statusCode = 201;
        response.end(JSON.stringify({
          method: request.method,
          json: rawBody ? JSON.parse(rawBody) : null,
          testHeader: entry.testHeader,
          contentType: entry.contentType,
        }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: 'not-found' }));
    } catch (error) {
      response.statusCode = 500;
      response.end(JSON.stringify({ error: error.message }));
    }
  });

  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
};

const closeServer = (server) => new Promise((resolveClose, reject) => {
  server.close((error) => (error ? reject(error) : resolveClose()));
});

const httpOutputs = {
  type: 'object',
  properties: {
    body: { type: 'string' },
    headers: { type: 'object' },
    statusCode: { type: 'integer' },
  },
};

const buildSchema = (baseUrl) => ({
  nodes: [
    {
      id: 'start',
      type: 'start',
      meta: { position: { x: 0, y: 0 } },
      data: {
        title: '开始',
        outputs: {
          type: 'object',
          properties: { query: { type: 'string' } },
        },
      },
    },
    {
      id: 'api_get',
      type: 'http',
      meta: { position: { x: 300, y: 0 } },
      data: {
        title: 'API GET 请求',
        api: {
          method: 'GET',
          url: { type: 'constant', content: `${baseUrl}/get` },
        },
        authorization: { type: 'none' },
        headers: {
          type: 'object',
          properties: { 'X-FutureFlow-Test': { type: 'string' } },
        },
        headersValues: {
          'X-FutureFlow-Test': { type: 'constant', content: 'get-runtime' },
        },
        params: {
          type: 'object',
          properties: {
            probe: { type: 'string' },
            query: { type: 'string' },
          },
        },
        paramsValues: {
          probe: { type: 'constant', content: 'get-query-v1' },
          query: { type: 'ref', content: ['start', 'query'] },
        },
        body: { bodyType: 'none' },
        timeout: { timeout: 5000, retryTimes: 0 },
        outputs: httpOutputs,
      },
    },
    {
      id: 'api_post',
      type: 'http',
      meta: { position: { x: 600, y: 0 } },
      data: {
        title: 'API POST 请求',
        api: {
          method: 'POST',
          url: { type: 'constant', content: `${baseUrl}/post` },
        },
        authorization: { type: 'none' },
        headers: {
          type: 'object',
          properties: { 'X-FutureFlow-Test': { type: 'string' } },
        },
        headersValues: {
          'X-FutureFlow-Test': { type: 'constant', content: 'post-runtime' },
        },
        params: { type: 'object', properties: {} },
        paramsValues: {},
        body: {
          bodyType: 'JSON',
          json: {
            type: 'template',
            content: '{"probe":"post-json-v1","message":"{{start.query}}","count":2,"nested":{"ok":true}}',
          },
        },
        timeout: { timeout: 5000, retryTimes: 0 },
        outputs: httpOutputs,
      },
    },
    {
      id: 'end',
      type: 'end',
      meta: { position: { x: 900, y: 0 } },
      data: {
        title: '结束',
        inputsValues: {
          getStatus: { type: 'ref', content: ['api_get', 'statusCode'] },
          getBody: { type: 'ref', content: ['api_get', 'body'] },
          postStatus: { type: 'ref', content: ['api_post', 'statusCode'] },
          postBody: { type: 'ref', content: ['api_post', 'body'] },
        },
        inputs: {
          type: 'object',
          properties: {
            getStatus: { type: 'integer' },
            getBody: { type: 'string' },
            postStatus: { type: 'integer' },
            postBody: { type: 'string' },
          },
        },
      },
    },
  ],
  edges: [
    { sourceNodeID: 'start', targetNodeID: 'api_get' },
    { sourceNodeID: 'api_get', targetNodeID: 'api_post' },
    { sourceNodeID: 'api_post', targetNodeID: 'end' },
  ],
});

const waitForReport = async (taskID) => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const report = await TaskReportAPI({ taskID });
    if (report?.workflowStatus?.terminated) return report;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(`本地 API GET/POST 运行超时: ${taskID}`);
};

(async () => {
  ({
    TaskReportAPI,
    TaskRunAPI,
    TaskValidateAPI,
  } = await import('../demo-free-layout/node_modules/@flowgram.ai/runtime-js/dist/esm/index.js'));

  const { server, baseUrl } = await startEchoServer();
  try {
    const original = buildSchema(baseUrl);
    const prepared = prepareHttpNodesForRuntime(original);
    assert.equal(original.nodes[1].data.api.url.type, 'constant', '原始画布不应被就地修改');
    assert.equal(prepared.nodes[1].data.api.url.type, 'template');
    assert.equal(prepared.nodes[2].data.api.url.type, 'template');

    const payload = {
      schema: JSON.stringify(prepared),
      inputs: { query: '中文变量值' },
    };
    const validation = await TaskValidateAPI(payload);
    assert.equal(validation.valid, true, JSON.stringify(validation.errors || []));
    const { taskID } = await TaskRunAPI(payload);
    const report = await waitForReport(taskID);
    assert.equal(report.workflowStatus.status, 'succeeded');
    assert.equal(report.outputs.getStatus, 207, 'GET 响应状态码未原样传递');
    assert.equal(report.outputs.postStatus, 201, 'POST 响应状态码未原样传递');

    const getResponse = JSON.parse(report.outputs.getBody);
    const postResponse = JSON.parse(report.outputs.postBody);
    assert.deepEqual(getResponse, {
      method: 'GET',
      args: { probe: 'get-query-v1', query: '中文变量值' },
      testHeader: 'get-runtime',
    });
    assert.deepEqual(postResponse, {
      method: 'POST',
      json: {
        probe: 'post-json-v1',
        message: '中文变量值',
        count: 2,
        nested: { ok: true },
      },
      testHeader: 'post-runtime',
      contentType: 'application/json',
    });

    assert.equal(received.length, 2, '应且只应发出一次 GET 和一次 POST');
    assert.deepEqual(received.map((entry) => [entry.method, entry.path]), [
      ['GET', '/get'],
      ['POST', '/post'],
    ]);
    assert.equal(received[0].query.query, '中文变量值');
    assert.deepEqual(JSON.parse(received[1].rawBody), postResponse.json);

    process.stdout.write(
      'http local runtime passed: GET 207 + query/header/body echo; POST 201 + nested JSON echo\n',
    );
  } finally {
    await closeServer(server);
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
