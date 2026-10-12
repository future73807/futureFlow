import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { EmbeddedProjectFiles, projectBindingContext } from '../src/host/project-files.provider';
import { readHostConfig } from '../src/host/host.config';
import type { HostProjectBinding } from '../src/host/host.types';
import { FileStorageService } from '../src/files/file-storage.service';
import { WorkflowCrudService } from '../src/workflows/workflow-crud.service';
import { WorkflowTemplateService } from '../src/templates/workflow-template.service';

const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const bindingA: HostProjectBinding = { version: 'v1', generation: 1, projectId: randomUUID(), bindingToken: 'binding-a' };
const bindingB: HostProjectBinding = { version: 'v1', generation: 1, projectId: randomUUID(), bindingToken: 'binding-b' };
const bindings = new Map([[bindingA.bindingToken, bindingA], [bindingB.bindingToken, bindingB]]);
const hostFiles = new Map<string, { assetId: string; relativePath: string; version: string; mimeType: string; bytes: Buffer }>();
const hostLayouts = new Map<string, { content: Record<string, any>; version: string }>();
const conflictNextMove = new Set<string>();
const conflictNextDelete = new Set<string>();
const raceNextLayoutWrite = new Set<string>();
let layoutPutRequests = 0;

function key(projectId: string, assetId: string) { return `${projectId}:${assetId}`; }
function layoutKey(projectId: string, workflowId: string) { return `${projectId}:${workflowId}`; }
function sendJson(response: import('node:http').ServerResponse, status: number, body?: unknown) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(body === undefined ? undefined : JSON.stringify(body));
}
async function bodyOf(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
function parseMultipart(body: Buffer, boundary: string) {
  const marker = Buffer.from(`--${boundary}`);
  const fields = new Map<string, string>();
  let fileBytes: Buffer | undefined;
  let cursor = body.indexOf(marker);
  while (cursor >= 0) {
    cursor += marker.length;
    if (body.subarray(cursor, cursor + 2).toString() === '--') break;
    if (body.subarray(cursor, cursor + 2).toString() === '\r\n') cursor += 2;
    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), cursor);
    if (headerEnd < 0) break;
    const headers = body.subarray(cursor, headerEnd).toString('utf8');
    const valueStart = headerEnd + 4;
    const next = body.indexOf(Buffer.from(`\r\n--${boundary}`), valueStart);
    if (next < 0) break;
    const value = body.subarray(valueStart, next);
    const name = headers.match(/name="([^"]+)"/)?.[1];
    if (name === 'file') fileBytes = Buffer.from(value);
    else if (name) fields.set(name, value.toString('utf8'));
    cursor = next + 2;
  }
  return { fields, fileBytes };
}

function makeRepository(defaults: Record<string, unknown> = {}) {
  const rows: any[] = [];
  const matches = (row: any, where: any) => Object.entries(where ?? {}).every(([name, value]) => row[name] === value);
  const repository: any = {
    rows,
    create: (input: any) => ({ id: randomUUID(), createdAt: new Date(), updatedAt: new Date(), ...defaults, ...input }),
    save: async (input: any) => {
      const row = { ...input };
      const index = rows.findIndex((existing) => existing.id === row.id);
      if (index < 0) rows.push(row); else rows[index] = row;
      return { ...row };
    },
    find: async ({ where }: any) => rows.filter((row) => matches(row, where)).map((row) => ({ ...row })),
    findOne: async ({ where }: any) => {
      const row = rows.find((candidate) => matches(candidate, where));
      return row ? { ...row } : null;
    },
    count: async ({ where }: any) => rows.filter((row) => matches(row, where)).length,
    remove: async (row: any) => { const index = rows.findIndex((candidate) => candidate.id === row.id); if (index >= 0) rows.splice(index, 1); },
  };
  repository.manager = { getRepository: () => repository, transaction: async (work: any) => work(repository.manager) };
  return repository;
}

const server = createServer(async (request, response) => {
  const body = await bodyOf(request);
  const token = request.headers['x-ff-project-binding'];
  const binding = typeof token === 'string' ? bindings.get(token) : undefined;
  if (!binding || request.headers.authorization !== 'Bearer test-shared-secret'
    || request.headers['x-ff-embed-protocol'] !== 'v1') {
    sendJson(response, 403);
    return;
  }

  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname.replace(/^\/files/, '');
  if (path.startsWith('/layouts/')) {
    const workflowId = decodeURIComponent(path.slice('/layouts/'.length));
    const index = layoutKey(binding.projectId, workflowId);
    if (request.method === 'GET') {
      const layout = hostLayouts.get(index);
      if (!layout) { sendJson(response, 404); return; }
      const responseLayout = { ...layout };
      if (raceNextLayoutWrite.delete(workflowId)) {
        const external = { nodes: [{ id: 'racing-external', type: 'start' }], edges: [] };
        hostLayouts.set(index, { content: external, version: digest(JSON.stringify(external)) });
      }
      sendJson(response, 200, responseLayout);
      return;
    }
    if (request.method === 'PUT') {
      layoutPutRequests += 1;
      const input = JSON.parse(body.toString('utf8')) as { content: Record<string, any>; expectedVersion: string | null };
      const current = hostLayouts.get(index);
      if ((current?.version ?? null) !== input.expectedVersion) { sendJson(response, 409); return; }
      const next = { content: input.content, version: digest(JSON.stringify(input.content)) };
      hostLayouts.set(index, next);
      sendJson(response, 200, next);
      return;
    }
  }
  if (path === '/upload' && request.method === 'POST') {
    const boundary = request.headers['content-type']?.toString().match(/boundary=([^;]+)/)?.[1];
    if (!boundary) { sendJson(response, 400); return; }
    const multipart = parseMultipart(body, boundary);
    const assetId = multipart.fields.get('assetId')!;
    const row = {
      assetId,
      relativePath: multipart.fields.get('relativePath')!,
      version: multipart.fields.get('writeFingerprint')!,
      mimeType: multipart.fields.get('mimeType')!,
      bytes: multipart.fileBytes!,
    };
    if (!row.bytes || digest(row.bytes) !== row.version) { sendJson(response, 400); return; }
    hostFiles.set(key(binding.projectId, assetId), row);
    sendJson(response, 200, { assetId, relativePath: row.relativePath, version: row.version });
    return;
  }

  const assetId = decodeURIComponent(path.split('/')[1] ?? '');
  const row = hostFiles.get(key(binding.projectId, assetId));
  if (!row) { sendJson(response, 404); return; }
  if (path.endsWith('/metadata') && request.method === 'GET') {
    sendJson(response, 200, { assetId, relativePath: row.relativePath, version: row.version, mimeType: row.mimeType, sizeBytes: row.bytes.length });
    return;
  }
  if (path.endsWith('/move') && request.method === 'POST') {
    const input = JSON.parse(body.toString('utf8')) as { relativePath: string; expectedRelativePath: string; expectedVersion: string };
    if (conflictNextMove.delete(assetId)) row.version = digest('concurrent external write');
    if (input.expectedVersion !== row.version || input.expectedRelativePath !== row.relativePath) { sendJson(response, 409); return; }
    row.relativePath = input.relativePath;
    sendJson(response, 200, { assetId, relativePath: row.relativePath, version: row.version });
    return;
  }
  if (request.method === 'DELETE') {
    if (conflictNextDelete.delete(assetId)) row.version = digest('concurrent external delete race');
    if (url.searchParams.get('version') !== row.version) { sendJson(response, 409); return; }
    hostFiles.delete(key(binding.projectId, assetId));
    response.writeHead(204); response.end();
    return;
  }
  if (request.method === 'GET') {
    if (url.searchParams.get('version') !== row.version) { sendJson(response, 409); return; }
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': row.bytes.length });
    response.end(row.bytes);
    return;
  }
  sendJson(response, 404);
});

async function collect(stream: AsyncIterable<Buffer>) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
function isConflict(error: unknown) { return typeof (error as any)?.getStatus === 'function' && (error as any).getStatus() === 409; }

async function main() {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address() as { port: number };
    const base = `http://127.0.0.1:${address.port}`;
    const config = readHostConfig({ get: <T>(name: string) => ({
      HOST_MODE: 'embedded', HOST_SHARED_SECRET: 'test-shared-secret', HOST_IDENTITY_VERIFY_URL: `${base}/identity`, HOST_PROJECT_FILES_URL: `${base}/files`,
    }[name] as T) });
    const hostFilesPort = new EmbeddedProjectFiles(config);
    const fileRepo = makeRepository();
    const files = new FileStorageService(fileRepo, new ConfigService(), hostFilesPort);
    const bytes = Buffer.from([0, 255, 1, 128, 10, 13, 42, 0, 99]);

    const stored = await projectBindingContext.run(bindingA, () => files.store('same-user', 'archive.pdf', 'application/octet-stream', bytes));
    assert.equal(fileRepo.rows[0].hostProjectId, bindingA.projectId);
    assert.deepEqual(await projectBindingContext.run(bindingA, async () => {
      const opened = await files.open('same-user', stored.id);
      return collect(await files.downloadStream(opened));
    }), bytes);
    assert.deepEqual(await projectBindingContext.run(bindingA, () => files.list('same-user')).then((rows) => rows.map((row) => row.id)), [stored.id]);
    assert.deepEqual(await projectBindingContext.run(bindingB, () => files.list('same-user')), []);
    await assert.rejects(projectBindingContext.run(bindingB, () => files.open('same-user', stored.id)), /文件不存在/);

    await projectBindingContext.run(bindingA, () => files.rename('same-user', stored.id, 'renamed.pdf'));
    const movedKey = key(bindingA.projectId, stored.id);
    assert.equal(hostFiles.get(movedKey)?.relativePath, 'files/renamed.pdf');
    assert.deepEqual(hostFiles.get(movedKey)?.bytes, bytes);
    conflictNextMove.add(stored.id);
    await assert.rejects(projectBindingContext.run(bindingA, () => files.rename('same-user', stored.id, 'stale.pdf')), isConflict);
    assert.equal(fileRepo.rows[0].originalName, 'renamed.pdf', 'move conflict does not update the Flow index');
    assert.equal(hostFiles.get(movedKey)?.relativePath, 'files/renamed.pdf', 'move conflict does not change the path');

    const deleteCandidate = await projectBindingContext.run(bindingA, () => files.store('same-user', 'delete.pdf', 'application/octet-stream', bytes));
    conflictNextDelete.add(deleteCandidate.id);
    await assert.rejects(projectBindingContext.run(bindingA, () => files.remove('same-user', deleteCandidate.id)), isConflict);
    assert.ok(fileRepo.rows.some((row) => row.id === deleteCandidate.id), 'delete conflict preserves the Flow index');
    assert.ok(hostFiles.has(key(bindingA.projectId, deleteCandidate.id)), 'delete conflict preserves the host asset');

    const workflowRepo = makeRepository({ status: 'active', version: 1 });
    const workflowCrud = new WorkflowCrudService(workflowRepo, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, hostFilesPort);
    const flowgram = { nodes: [{ id: 'start', type: 'start' }], edges: [] };
    const workflow = await projectBindingContext.run(bindingA, () => workflowCrud.create('same-user', { name: 'Bound layout', flowgram: JSON.stringify(flowgram) }));
    assert.equal(workflowRepo.rows[0].hostProjectId, bindingA.projectId);
    assert.deepEqual(await projectBindingContext.run(bindingA, () => workflowCrud.listByUser('same-user')).then((rows) => rows.map((row) => row.id)), [workflow.id]);
    assert.deepEqual(await projectBindingContext.run(bindingB, () => workflowCrud.listByUser('same-user')), []);
    await assert.rejects(projectBindingContext.run(bindingB, () => workflowCrud.getById(workflow.id, 'same-user')), /工作流不存在/);

    const layoutId = layoutKey(bindingA.projectId, workflow.id);
    const layoutVersion = workflow.hostLayoutVersion!;
    raceNextLayoutWrite.add(workflow.id);
    await assert.rejects(projectBindingContext.run(bindingA, () => workflowCrud.update(workflow.id, 'same-user', {
      flowgram: JSON.stringify(flowgram), hostLayoutVersion: layoutVersion,
    })), isConflict);
    assert.equal(layoutPutRequests, 2, 'create plus the conflicting CAS both reach the host layout endpoint');
    assert.equal(hostLayouts.get(layoutId)?.content.nodes[0].id, 'racing-external', 'stale layout CAS preserves the concurrent host edit');

    const templateRepo = makeRepository();
    templateRepo.findOne = async ({ where }: any) => where.id === 'template-1' ? {
      id: 'template-1', status: 'active', name: 'Starter', description: 'starter template', flowgramJson: flowgram,
    } : null;
    const converter = { validateFlowGram: () => undefined };
    const templates = new WorkflowTemplateService(templateRepo, workflowRepo, converter as any, workflowCrud);
    const fromTemplate = await projectBindingContext.run(bindingA, () => templates.createWorkflow('same-user', 'template-1', 'From template'));
    assert.equal(fromTemplate.hostProjectId, bindingA.projectId);
    assert.deepEqual((await projectBindingContext.run(bindingA, () => workflowCrud.getById(fromTemplate.id, 'same-user'))).flowgramJson, flowgram, 'a template-created workflow is readable from the bound host layout');
    await assert.rejects(projectBindingContext.run(bindingB, () => workflowCrud.getById(fromTemplate.id, 'same-user')), /工作流不存在/);

    console.log('host-project-file-layout-smoke: PASS');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
