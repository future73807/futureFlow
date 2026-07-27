#!/usr/bin/env node
/**
 * Quick API test script - runs all API tests sequentially
 */

const http = require('node:http');

const BASE_URL = 'http://localhost:3001';

function makeRequest(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
    };
    
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ status: res.statusCode, data: json });
        } catch {
          resolve({ status: res.statusCode, data: data });
        }
      });
    });
    
    req.on('error', reject);
    
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function runTest(name, testFn) {
  const start = Date.now();
  try {
    const result = await testFn();
    const duration = Date.now() - start;
    console.log(`✅ ${name} - PASSED (${duration}ms)`);
    return { name, status: 'PASS', duration, result };
  } catch (err) {
    const duration = Date.now() - start;
    console.log(`❌ ${name} - FAILED (${duration}ms): ${err.message}`);
    return { name, status: 'FAIL', duration, error: err.message };
  }
}

async function main() {
  console.log('========================================');
  console.log('futureFlow API Test Suite');
  console.log('========================================\n');
  
  const results = [];
  let adminToken = null;
  let apiKey = null;
  let apiKeyId = null;
  let workflowId = null;
  
  // Test 1: Health Check
  await runTest('GET /workflows/health', async () => {
    const res = await makeRequest('GET', '/workflows/health');
    if (res.status !== 200) throw new Error(`Status: ${res.status}`);
    return res.data;
  }, results);
  
  // Test 2: Admin Login
  await runTest('POST /auth/login (admin)', async () => {
    const res = await makeRequest('POST', '/auth/login', {
      account: 'demo',
      password: 'demo123456'
    });
    if (res.status !== 201) throw new Error(`Status: ${res.status}`);
    if (!res.data.accessToken) throw new Error('No access token');
    if (res.data.user?.role !== 'admin') throw new Error('Not admin');
    adminToken = res.data.accessToken;
    return { token: res.data.accessToken.substring(0, 20) + '...', role: res.data.user.role };
  }, results);
  
  // Test 3: Get Profile
  await runTest('GET /auth/profile', async () => {
    const res = await makeRequest('GET', '/auth/profile', null, {
      Authorization: `Bearer ${adminToken}`
    });
    if (res.status !== 200) throw new Error(`Status: ${res.status}`);
    return { username: res.data.username, email: res.data.email };
  }, results);
  
  // Test 4: Admin Stats
  await runTest('GET /admin/stats', async () => {
    const res = await makeRequest('GET', '/admin/stats', null, {
      Authorization: `Bearer ${adminToken}`
    });
    if (res.status !== 200) throw new Error(`Status: ${res.status}`);
    return { users: res.data.userCount, workflows: res.data.workflowCount, runs: res.data.runCount };
  }, results);
  
  // Test 5: Dify Status
  await runTest('GET /admin/dify/status', async () => {
    const res = await makeRequest('GET', '/admin/dify/status', null, {
      Authorization: `Bearer ${adminToken}`
    });
    if (res.status !== 200) throw new Error(`Status: ${res.status}`);
    return { status: res.data.status, connection: res.data.connectionAuthorized };
  }, results);
  
  // Test 6: Create API Key
  await runTest('POST /user/api-keys', async () => {
    const res = await makeRequest('POST', '/user/api-keys', {
      name: `e2e-test-${Date.now()}`
    }, {
      Authorization: `Bearer ${adminToken}`
    });
    if (res.status !== 201) throw new Error(`Status: ${res.status}`);
    apiKey = res.data.plaintext;
    apiKeyId = res.data.id;
    return { id: res.data.id, key: res.data.plaintext.substring(0, 20) + '...' };
  }, results);
  
  // Test 7: Create Workflow
  await runTest('POST /workflows', async () => {
    const workflowJson = {
      nodes: [
        { id: 'start_0', type: 'start', data: { title: 'Start', outputs: { type: 'object', properties: { query: { type: 'string' } } } } },
        { id: 'llm_0', type: 'llm', data: { title: 'LLM', inputsValues: { modelName: { type: 'constant', content: 'deepseek-chat' }, prompt: { type: 'template', content: '{{start_0.query}}' } } } },
        { id: 'end_0', type: 'end', data: { title: 'End' } }
      ],
      edges: [
        { sourceNodeID: 'start_0', targetNodeID: 'llm_0' },
        { sourceNodeID: 'llm_0', targetNodeID: 'end_0' }
      ]
    };
    
    const res = await makeRequest('POST', '/workflows', {
      name: `E2E Test Workflow ${Date.now()}`,
      flowgram: JSON.stringify(workflowJson)
    }, {
      Authorization: `Bearer ${adminToken}`
    });
    if (res.status !== 201) throw new Error(`Status: ${res.status}`);
    workflowId = res.data.id;
    return { id: res.data.id, name: res.data.name };
  }, results);
  
  // Test 8: Get Workflow
  await runTest('GET /workflows/:id', async () => {
    const res = await makeRequest('GET', `/workflows/${workflowId}`, null, {
      Authorization: `Bearer ${adminToken}`
    });
    if (res.status !== 200) throw new Error(`Status: ${res.status}`);
    return { id: res.data.id, name: res.data.name };
  }, results);
  
  // Test 9: Publish Workflow
  await runTest('POST /workflows/:id/publish', async () => {
    const res = await makeRequest('POST', `/workflows/${workflowId}/publish`, {}, {
      Authorization: `Bearer ${adminToken}`
    });
    if (res.status !== 201) throw new Error(`Status: ${res.status}`);
    return { publishedVersion: res.data.workflow?.publishedVersion };
  }, results);
  
  // Test 10: Execute Workflow (with API Key)
  await runTest('POST /workflows/:id/execute', async () => {
    const http = require('node:http');
    const url = new URL(`/workflows/${workflowId}/execute`, BASE_URL);
    const postData = JSON.stringify({ inputs: { query: 'Hello from E2E test' } });
    
    const res = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'Accept': 'text/event-stream',
        },
      }, (response) => {
        let body = '';
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, body }));
      });
      req.on('error', reject);
      req.write(postData);
      req.end();
    });
    
    if (res.status !== 200) throw new Error(`Status: ${res.status}`);
    if (!res.body.includes('workflow_finished') && !res.body.includes('succeeded')) {
      throw new Error('Workflow did not complete: ' + res.body.substring(0, 200));
    }
    return { completed: true, length: res.body.length };
  }, results);
  
  // Test 11: Get Workflow Runs
  await runTest('GET /workflows/:id/runs', async () => {
    const res = await makeRequest('GET', `/workflows/${workflowId}/runs`, null, {
      Authorization: `Bearer ${adminToken}`
    });
    if (res.status !== 200) throw new Error(`Status: ${res.status}`);
    return { total: res.data.total };
  }, results);
  
  // Test 12: Update Workflow
  await runTest('PUT /workflows/:id', async () => {
    const workflowJson = {
      nodes: [
        { id: 'start_0', type: 'start', data: { title: 'Start' } },
        { id: 'end_0', type: 'end', data: { title: 'End' } }
      ],
      edges: [
        { sourceNodeID: 'start_0', targetNodeID: 'end_0' }
      ]
    };
    
    const res = await makeRequest('PUT', `/workflows/${workflowId}`, {
      name: `Updated E2E Workflow ${Date.now()}`,
      flowgram: JSON.stringify(workflowJson)
    }, {
      Authorization: `Bearer ${adminToken}`
    });
    if (res.status !== 200) throw new Error(`Status: ${res.status}`);
    return { version: res.data.version };
  }, results);
  
  // Test 13: Delete API Key
  await runTest('DELETE /user/api-keys/:id', async () => {
    const res = await makeRequest('DELETE', `/user/api-keys/${apiKeyId}`, null, {
      Authorization: `Bearer ${adminToken}`
    });
    if (res.status !== 200) throw new Error(`Status: ${res.status}`);
    return { deleted: true };
  }, results);
  
  // Test 14: Delete Workflow
  await runTest('DELETE /workflows/:id', async () => {
    const res = await makeRequest('DELETE', `/workflows/${workflowId}`, null, {
      Authorization: `Bearer ${adminToken}`
    });
    if (res.status !== 200) throw new Error(`Status: ${res.status}`);
    return { deleted: true };
  }, results);
  
  // Test 15: Get Users List
  await runTest('GET /admin/users', async () => {
    const res = await makeRequest('GET', '/admin/users?page=1&pageSize=10', null, {
      Authorization: `Bearer ${adminToken}`
    });
    if (res.status !== 200) throw new Error(`Status: ${res.status}`);
    return { total: res.data.total };
  }, results);
  
  // Summary
  const passed = results.filter(r => r.status === 'PASS').length;
  const total = results.length;
  
  console.log('\n========================================');
  console.log(`RESULTS: ${passed}/${total} tests passed`);
  console.log('========================================');
  
  if (passed === total) {
    console.log('🎉 ALL TESTS PASSED!');
    process.exit(0);
  } else {
    console.log('⚠️  SOME TESTS FAILED');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
