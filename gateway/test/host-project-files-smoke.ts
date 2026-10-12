import { WorkflowTriggerService } from '../src/triggers/workflow-trigger.service';
import { projectBoundStream } from '../src/host/project-files.provider';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { EmbeddedProjectFiles, projectBindingContext } from '../src/host/project-files.provider';
import { readHostConfig } from '../src/host/host.config';
import type { HostProjectBinding } from '../src/host/host.types';
import { FileStorageService } from '../src/files/file-storage.service';
import { WorkflowCrudService } from '../src/workflows/workflow-crud.service';
import { MediaAssetService } from '../src/media/media-asset.service';
import { MediaJobService } from '../src/media/media-job.service';
import { EmbeddedIdentityProvider } from '../src/host/embedded-identity.provider';
import { HostHttpClient } from '../src/host/host-http.client';
import { hostCapabilities } from '../src/host/host.config';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const a: HostProjectBinding = { version: 'v1', generation: 1, projectId: randomUUID(), bindingToken: 'binding-a' };
const b: HostProjectBinding = { version: 'v1', generation: 1, projectId: randomUUID(), bindingToken: 'binding-b' };
const replacement = { ...a, bindingToken: 'binding-a-new' };
const revoked = new Set<string>();
const layouts = new Map<string, { content: any; version: string }>();
const files = new Map<string, { assetId: string; relativePath: string; version: string; mimeType: string; sizeBytes: number }>();
const requests: { project: string; path: string; method: string }[] = [];
function repo() {
  const rows: any[] = [];
  const matches = (row: any, where: any) => Object.entries(where || {}).every(([key, value]) => row[key] === value);
  const repository: any = {
    rows,
    create: (input: any) => ({ id: randomUUID(), createdAt: new Date(), updatedAt: new Date(), version: 1, status: 'active', ...input }),
    save: async (input: any) => {
      const row = { ...input }; const existing = rows.findIndex((item) => item.id === row.id);
      if (existing >= 0) rows[existing] = row; else rows.push(row);
      return { ...row };
    },
    find: async ({ where }: any) => rows.filter((row) => matches(row, where)).map((row) => ({ ...row })),
    findOne: async ({ where }: any) => { const row = rows.find((item) => matches(item, where)); return row ? { ...row } : null; },
    update: async (id: string, input: any) => { const row = rows.find((item) => item.id === id); if (row) Object.assign(row, input); return { affected: row ? 1 : 0 }; },
    count: async ({ where }: any) => rows.filter((row) => matches(row, where)).length,
    remove: async (row: any) => { rows.splice(rows.findIndex((item) => item.id === row.id), 1); },
  };
  repository.manager = { getRepository: () => repository, transaction: async (run: any) => run(repository.manager) };
  return repository;
}
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString();
  const send = (status: number, body?: any) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(body ? JSON.stringify(body) : undefined); };
  if (request.url === '/identity') { send(200, { subject: 'instance', projectFiles: a }); return; }
  const token = request.headers['x-ff-project-binding'];
  const binding = typeof token === 'string' && !revoked.has(token)
    ? token === a.bindingToken ? a : token === b.bindingToken ? b : token === replacement.bindingToken ? replacement : undefined : undefined;
  if (!binding || request.headers.authorization !== 'Bearer shared-secret-123456') { send(403); return; }
  requests.push({ project: binding.projectId, path: request.url!, method: request.method! });
  const path = new URL(request.url!, 'http://host').pathname.replace('/files', '');
  if (path.startsWith('/layouts/')) {
    const key = `${binding.projectId}:${path}`;
    if (request.method === 'GET') { const row = layouts.get(key); send(row ? 200 : 404, row); return; }
    const input = JSON.parse(raw); const previous = layouts.get(key);
    if ((previous?.version ?? null) !== input.expectedVersion) { send(409); return; }
    const row = { content: input.content, version: hash(input.content) }; layouts.set(key, row); send(200, row); return;
  }
  if (path === '/upload') {
    const field = (name: string) => raw.match(new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]+)`))![1];
    const row = { assetId: field('assetId'), relativePath: field('relativePath'), version: field('writeFingerprint'), mimeType: field('mimeType'), sizeBytes: 3 };
    files.set(`${binding.projectId}:${row.assetId}`, row); send(200, row); return;
  }
  const id = path.split('/')[1]; const row = files.get(`${binding.projectId}:${id}`);
  if (!row) { send(404); return; }
  if (path.endsWith('/metadata')) { send(200, row); return; }
  if (path.endsWith('/move')) {
    const input = JSON.parse(raw);
    if (input.expectedVersion !== row.version || input.expectedRelativePath !== row.relativePath) { send(409); return; }
    row.relativePath = input.relativePath; send(200, row); return;
  }
  if (request.method === 'DELETE') { files.delete(`${binding.projectId}:${id}`); send(204); return; }
  response.writeHead(200); response.end('abc');
});

async function main() {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  const config = readHostConfig({ get: <T>(key: string) => ({ HOST_MODE: 'embedded', HOST_SHARED_SECRET: 'shared-secret-123456', HOST_IDENTITY_VERIFY_URL: `${base}/identity`, HOST_PROJECT_FILES_URL: `${base}/files` }[key] as T) });
  const port = new EmbeddedProjectFiles(config);
  assert.throws(() => port.binding(), /项目绑定缺失/);
  const identity = new EmbeddedIdentityProvider(config, new HostHttpClient(config), hostCapabilities(config).capabilities);
  assert.deepEqual((await identity.resolveIdentity('ticket')).projectFiles, a);
  const uploads = repo(); const storage = new FileStorageService(uploads, new ConfigService(), port);
  const uploaded = await projectBindingContext.run(a, () => storage.store('user', 'a.txt', 'text/plain', Buffer.from('abc')));
  assert.equal(uploads.rows[0].hostProjectId, a.projectId);
  assert.equal((await projectBindingContext.run(a, () => storage.list('user'))).length, 1);
  assert.equal((await projectBindingContext.run(b, () => storage.list('user'))).length, 0);
  await assert.rejects(projectBindingContext.run(b, () => storage.open('user', uploaded.id)), /文件不存在/);
  await projectBindingContext.run(a, () => storage.rename('user', uploaded.id, 'renamed.txt'));
  assert.equal(files.get(`${a.projectId}:${uploaded.id}`)?.relativePath, 'files/renamed.txt');

  const workflows = repo();
  const crud = new WorkflowCrudService(workflows, repo(), repo(), {} as any, {} as any, {} as any, {} as any, {} as any, port);
  const created = await projectBindingContext.run(a, () => crud.create('user', { name: 'flow', flowgram: '{"nodes":[],"edges":[]}' }));
  assert.deepEqual(workflows.rows[0].flowgramJson, {}, '数据库不是embedded草稿权威');
  const layoutKey = `${a.projectId}:/layouts/${created.id}`;
  layouts.set(layoutKey, { content: { nodes: [{ id: 'external', type: 'start' }], edges: [] }, version: hash('external') });
  assert.equal((await projectBindingContext.run(a, () => crud.getById(created.id, 'user'))).flowgramJson.nodes[0].id, 'external');
  await assert.rejects(projectBindingContext.run(a, () => crud.update(created.id, 'user', { flowgram: '{"nodes":[],"edges":[]}', hostLayoutVersion: created.hostLayoutVersion! })), /工作流已改变/);
  await assert.rejects(projectBindingContext.run(b, () => crud.getById(created.id, 'user')), /工作流不存在/);
  const fresh = await projectBindingContext.run(a, () => crud.getById(created.id, 'user'));
  await projectBindingContext.run(a, () => crud.update(created.id, 'user', { flowgram: '{"nodes":[],"edges":[]}', hostLayoutVersion: fresh.hostLayoutVersion! }));
  await Promise.all([a, b].map((binding) => projectBindingContext.run(binding, async () => {
    await Promise.resolve(); assert.equal(port.binding().projectId, binding.projectId);
  })));

  workflows.rows[0].publishedFlowgramJson = { nodes: [], edges: [] };
  workflows.rows[0].publishedVersion = 1;
  const triggerRepo = repo(); const users = repo(); await users.save({ id: 'user', status: 'active' });
  const triggers = new WorkflowTriggerService(triggerRepo, workflows, users, new ConfigService(), crud, port);
  const triggerReceipt = await projectBindingContext.run(a, () => triggers.create('user', created.id, { name: 'timer', type: 'schedule', intervalMinutes: 5 }));
  assert.equal('hostProjectBinding' in triggerReceipt.trigger, false);
  const runnable = await triggers.toRunnableById(triggerReceipt.trigger.id);
  assert.deepEqual(runnable.projectBinding, a);
  async function* observedBinding() { yield port.binding().projectId; }
  const observed: string[] = [];
  for await (const value of projectBoundStream(runnable.projectBinding, observedBinding())) observed.push(value);
  assert.deepEqual(observed, [a.projectId]);
  revoked.add(a.bindingToken);
  await assert.rejects(triggers.toRunnableById(triggerReceipt.trigger.id), /手动重新启用/);
  assert.equal(triggerRepo.rows[0].status, 'paused');
  assert.equal(triggerRepo.rows[0].lastRunStatus, 'authorization_required');
  await triggers.recordResult(triggerReceipt.trigger.id, false);
  assert.equal(triggerRepo.rows[0].lastRunStatus, 'authorization_required');
  await assert.rejects(projectBindingContext.run(b, () => triggers.update('user', triggerReceipt.trigger.id, { status: 'active' })), /工作流不存在/);
  await projectBindingContext.run(replacement, () => triggers.update('user', triggerReceipt.trigger.id, { status: 'active' }));
  assert.equal(triggerRepo.rows[0].hostProjectBinding.bindingToken, replacement.bindingToken);
  assert.ok(triggerRepo.rows[0].nextRunAt > new Date(), '手动恢复只安排未来，不补跑');
  revoked.delete(a.bindingToken);

  const root = await mkdtemp(join(tmpdir(), 'ff-host-media-'));
  try {
    const assets = repo(); const jobs = repo();
    const media = new MediaAssetService(assets, new ConfigService({ MEDIA_ASSET_ROOT: root }), port);
    const adapter = { createVideo: async () => ({ taskId: 'provider-task', status: 'queued' }), getVideoStatus: async () => ({ status: 'succeeded', source: { type: 'base64', data: 'AAAAHGZ0eXBpc29tAAAAAGlzb21pc28y' } }) };
    const service = new MediaJobService(jobs, { decryptOwned: async () => ({ provider: 'doubao', apiKey: 'key' }) } as any, { get: () => adapter } as any, media, port);
    const job = await projectBindingContext.run(a, () => service.generateVideo('user', 'same-key', { credentialId: randomUUID(), model: 'model', prompt: 'video' }));
    assert.deepEqual(jobs.rows[0].hostProjectBinding, a);
    assert.equal('hostProjectBinding' in job, false);
    await assert.rejects(projectBindingContext.run(b, () => service.getAndPoll('user', job.id)), /媒体任务不存在/);
    const completed = await projectBindingContext.run(a, () => service.getAndPoll('user', job.id));
    assert.equal(completed.status, 'succeeded');
    assert.equal(assets.rows[0].hostProjectId, a.projectId);
    assert.deepEqual(await readdir(root), [], '网关只保留临时媒体，成功后清理');
  } finally { await rm(root, { recursive: true, force: true }); }
  console.log('host-project-files-smoke: PASS');
}
main().finally(() => server.close()).catch((error) => { console.error(error); process.exitCode = 1; });
