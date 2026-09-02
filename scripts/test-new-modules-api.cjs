#!/usr/bin/env node
/**
 * 新模块（知识库 / 文件上传 / MCP 注册）API 级验收。
 * 依赖一键启动后的本地网关（3001）与管理员账号。
 * 退出码：0 全部通过；1 有失败项。
 */
'use strict';

const BASE = process.env.GATEWAY_URL || 'http://localhost:3001';
const ADMIN = process.env.ADMIN_USERNAME || 'admin';
const PASSWORD = process.argv[2] || 'futureFlow@';

const results = [];
function record(name, ok, detail = '') {
  results.push({ ok });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' :: ' + detail : ''}`);
}

async function main() {
  const loginRes = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: ADMIN, password: PASSWORD }),
  });
  const login = await loginRes.json().catch(() => ({}));
  const token = login.accessToken || login.data?.accessToken;
  record('登录获取管理员 JWT', Boolean(token));
  if (!token) process.exit(1);
  const auth = { Authorization: `Bearer ${token}` };
  const json = (res) => res.json().catch(() => ({}));

  // ---- 知识库模块 ----
  const created = await json(await fetch(`${BASE}/knowledge/datasets`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '验收知识库', description: 'API 冒烟' }),
  }));
  record('知识库：创建 dataset（Dify 代理）', Boolean(created.id), created.id || JSON.stringify(created).slice(0, 120));

  if (created.id) {
    const doc = await json(await fetch(`${BASE}/knowledge/datasets/${created.id}/documents`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '验收文档.txt', text: 'futureFlow 是一个 AI 工作流平台。' }),
    }));
    record('知识库：按文本创建文档', Boolean(doc.id), doc.id || JSON.stringify(doc).slice(0, 120));

    const docs = await json(await fetch(`${BASE}/knowledge/datasets/${created.id}/documents`, { headers: auth }));
    record('知识库：文档列表', Array.isArray(docs) && docs.length >= 1, `${Array.isArray(docs) ? docs.length : 0} 个文档`);

    const delDoc = await fetch(`${BASE}/knowledge/datasets/${created.id}/documents/${doc.id}`, { method: 'DELETE', headers: auth });
    record('知识库：删除文档', delDoc.ok);

    const delDs = await fetch(`${BASE}/knowledge/datasets/${created.id}`, { method: 'DELETE', headers: auth });
    record('知识库：删除 dataset', delDs.ok);
  }

  // ---- 文件模块 ----
  const form = new FormData();
  form.append('file', new Blob([Buffer.from('futureFlow 文件上传验收内容')], { type: 'text/plain' }), '验收.txt');
  const uploaded = await json(await fetch(`${BASE}/files/upload`, { method: 'POST', headers: auth, body: form }));
  record('文件：multipart 上传', Boolean(uploaded.id), uploaded.id || JSON.stringify(uploaded).slice(0, 120));

  if (uploaded.id) {
    const list = await json(await fetch(`${BASE}/files`, { headers: auth }));
    record('文件：列表含刚上传文件', Array.isArray(list) && list.some((f) => f.id === uploaded.id));
    record('文件：列表不回显存储路径', Array.isArray(list) && list.every((f) => f.localPath === undefined));

    const download = await fetch(`${BASE}/files/${uploaded.id}/download`, { headers: auth });
    const text = await download.text();
    record('文件：下载内容一致', download.ok && text.includes('文件上传验收内容'));

    const del = await fetch(`${BASE}/files/${uploaded.id}`, { method: 'DELETE', headers: auth });
    record('文件：删除', del.ok);
  }

  const badExt = await fetch(`${BASE}/files/upload`, {
    method: 'POST', headers: auth,
    body: (() => { const f = new FormData(); f.append('file', new Blob([Buffer.from('MZ')]), 'evil.exe'); return f; })(),
  });
  record('文件：危险扩展名被拒绝', badExt.status === 415 || badExt.status === 400, `HTTP ${badExt.status}`);

  // ---- MCP 模块 ----
  const server = await json(await fetch(`${BASE}/mcp/servers`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '验收 MCP', url: 'http://127.0.0.1:9/mcp' }),
  }));
  record('MCP：注册服务器', Boolean(server.id), server.id || JSON.stringify(server).slice(0, 120));

  if (server.id) {
    const list = await json(await fetch(`${BASE}/mcp/servers`, { headers: auth }));
    record('MCP：列表含注册项且不回显令牌', Array.isArray(list) && list.some((s) => s.id === server.id) && list.every((s) => s.encryptedToken === undefined));

    const tools = await fetch(`${BASE}/mcp/servers/${server.id}/tools`, { method: 'POST', headers: auth });
    record('MCP：不可达服务器工具列表明确报错（不悬挂）', tools.status >= 400, `HTTP ${tools.status}`);

    const del = await fetch(`${BASE}/mcp/servers/${server.id}`, { method: 'DELETE', headers: auth });
    record('MCP：删除服务器', del.ok);
  }

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n===== 新模块 API 验收: ${passed}/${results.length} passed =====`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((error) => {
  console.error('FATAL:', error.message);
  process.exit(1);
});
