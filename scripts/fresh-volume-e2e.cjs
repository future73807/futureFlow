#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const net = require('node:net');
const { basename, delimiter, dirname, join, resolve } = require('node:path');

const ROOT = resolve(__dirname, '..');
const BASE_COMPOSE = join(ROOT, 'docker-compose.yml');
const TEMP_ROOT = join(ROOT, '.codex-tmp');
const CONFIRM_FLAG = '--confirm-isolated-volumes';
const PREFLIGHT_ONLY = process.argv.includes('--preflight-only');
const KEEP_ON_FAILURE = process.argv.includes('--keep-on-failure');
const KEEP_RESOURCES = process.argv.includes('--keep-resources');
const PNPM = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
const LONG_LIVED_SERVICES = [
  'postgres',
  'dify-redis',
  'dify-postgres',
  'ssrf_proxy',
  'sandbox',
  'dify-api',
  'dify-worker',
  'dify-web',
  'dify-weaviate',
];
const ALL_SERVICES = [...LONG_LIVED_SERVICES, 'dify-init'];
const EXPECTED_VOLUMES = [
  'postgres-data',
  'dify-redis-data',
  'dify-postgres-data',
  'dify-storage',
  'dify-weaviate-data',
  'dify-sandbox-dependencies',
];

function printUsage() {
  console.log(`Usage:
  pnpm run test:fresh-volume -- ${CONFIRM_FLAG}

Options:
  ${CONFIRM_FLAG}  Required. Creates and later deletes only a randomly named,
                            isolated Compose project's test volumes.
  --keep-on-failure         Keep the isolated project after a failure for diagnosis.
  --keep-resources          Keep the isolated project even after success.
  --preflight-only          Resolve and validate isolation without creating containers/volumes.
  --help                    Show this help.

This test never calls /admin/dify/bootstrap or writes a Console token. It uses
random host ports, unique container names, an isolated dify-init workspace, and
checks the resolved Compose configuration before creating anything.`);
}

function secret() {
  return randomBytes(32).toString('hex');
}

function appendLimited(current, chunk) {
  const next = current + chunk;
  return next.length <= MAX_CAPTURE_BYTES
    ? next
    : next.slice(next.length - MAX_CAPTURE_BYTES);
}

function commandLabel(command, args) {
  return [command, ...args].join(' ');
}

async function runCommand(command, args, options = {}) {
  const {
    cwd = ROOT,
    env = process.env,
    echo = true,
    timeoutMs = 15 * 60_000,
  } = options;

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      shell: process.platform === 'win32' && command.toLowerCase().endsWith('.cmd'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout = appendLimited(stdout, text);
      if (echo) process.stdout.write(text);
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr = appendLimited(stderr, text);
      if (echo) process.stderr.write(text);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && !timedOut) {
        resolvePromise({ stdout, stderr });
        return;
      }
      const reason = timedOut
        ? `timed out after ${timeoutMs}ms`
        : code === null
          ? `terminated by ${signal || 'unknown signal'}`
          : `exited with code ${code}`;
      const detail = (stderr || stdout).trim().slice(-4_000);
      rejectPromise(new Error(
        `${commandLabel(command, args)} ${reason}${detail ? `\n${detail}` : ''}`,
      ));
    });
  });
}

function getFreePort() {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = net.createServer();
    server.unref();
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => {
        if (error) rejectPromise(error);
        else if (!port) rejectPromise(new Error('Unable to allocate a free local port'));
        else resolvePromise(port);
      });
    });
  });
}

function parseEnvFile(path) {
  if (!existsSync(path)) return {};
  const values = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match) values[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
  return values;
}

function setEnvValue(content, name, value) {
  assert.equal(/[\r\n]/.test(String(value)), false, `${name} contains a newline`);
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const pattern = new RegExp(`^${name}=.*$`, 'm');
  const line = `${name}=${value}`;
  if (pattern.test(content)) return content.replace(pattern, line);
  const suffix = content.endsWith('\n') || content.endsWith('\r') ? '' : newline;
  return `${content}${suffix}${line}${newline}`;
}

function buildLegacyEnv(template, settings) {
  let content = template;
  for (const [name, value] of Object.entries(settings)) {
    content = setEnvValue(content, name, value);
  }
  return content;
}

function withoutEnvironmentOverrides(environment, names) {
  const result = { ...environment };
  const normalizedNames = new Set(names.map((name) => name.toUpperCase()));
  for (const name of Object.keys(result)) {
    if (normalizedNames.has(name.toUpperCase())) delete result[name];
  }
  return result;
}

function fileSnapshot(path) {
  if (!existsSync(path)) return { exists: false, hash: null };
  return {
    exists: true,
    hash: createHash('sha256').update(readFileSync(path)).digest('hex'),
  };
}

function assertFileUnchanged(path, before) {
  assert.deepEqual(
    fileSnapshot(path),
    before,
    `Isolated acceptance test unexpectedly modified ${path}`,
  );
}

function normalizePath(path) {
  return resolve(path).replace(/\\/g, '/').toLowerCase();
}

function assertSafeProjectName(project) {
  assert.match(
    project,
    /^futureflow-fresh-e2e-[a-z0-9]+-[a-f0-9]{6}$/,
    'Refusing to manage a Compose project outside the isolated E2E namespace',
  );
}

function assertSafeTempDirectory(tempDir) {
  assert.equal(
    normalizePath(dirname(tempDir)),
    normalizePath(TEMP_ROOT),
    'Refusing to delete a temporary directory outside .codex-tmp',
  );
  assert.match(
    basename(tempDir),
    /^fresh-volume-e2e-/,
    'Refusing to delete an unexpected temporary directory',
  );
}

function containerName(project, service) {
  return `${project}-${service.replace(/_/g, '-')}`;
}

function buildOverride(project, initWorkspace) {
  const lines = ['services:'];
  for (const service of LONG_LIVED_SERVICES) {
    lines.push(`  ${service}:`, `    container_name: ${containerName(project, service)}`);
  }
  lines.push(
    '  dify-init:',
    `    container_name: ${containerName(project, 'dify-init')}`,
    '    volumes:',
    '      - type: bind',
    `        source: ${JSON.stringify(initWorkspace.replace(/\\/g, '/'))}`,
    '        target: /workspace',
    '',
  );
  return lines.join('\n');
}

function findPublishedPort(serviceConfig, target) {
  const entry = (serviceConfig.ports || []).find((port) => Number(port.target) === target);
  return entry ? Number(entry.published) : 0;
}

async function verifyResolvedCompose(composeArgs, env, project, initWorkspace, ports) {
  const { stdout } = await runCommand(
    'docker',
    [...composeArgs, 'config', '--format', 'json'],
    { env, echo: false, timeoutMs: 60_000 },
  );
  const config = JSON.parse(stdout.replace(/^\uFEFF/, ''));

  for (const service of ALL_SERVICES) {
    assert.equal(
      config.services?.[service]?.container_name,
      containerName(project, service),
      `Resolved ${service} container name is not isolated`,
    );
  }

  const initMounts = config.services['dify-init'].volumes || [];
  const workspaceMount = initMounts.find((mount) => mount.target === '/workspace');
  assert.equal(workspaceMount?.type, 'bind', 'dify-init /workspace must be an isolated bind mount');
  assert.equal(
    normalizePath(workspaceMount?.source || ''),
    normalizePath(initWorkspace),
    'dify-init would write into the repository instead of its isolated workspace',
  );

  for (const volume of EXPECTED_VOLUMES) {
    assert.equal(
      config.volumes?.[volume]?.name,
      `${project}_${volume}`,
      `Resolved volume ${volume} does not belong to the isolated project`,
    );
  }
  for (const network of Object.values(config.networks || {})) {
    assert.ok(
      String(network.name || '').startsWith(`${project}_`),
      `Resolved network ${network.name || '(unnamed)'} does not belong to the isolated project`,
    );
  }

  assert.equal(findPublishedPort(config.services.postgres, 5432), ports.postgres);
  assert.equal(findPublishedPort(config.services['dify-api'], 5001), ports.difyApi);
  assert.equal(findPublishedPort(config.services['dify-web'], 3000), ports.difyWeb);
  for (const service of ['postgres', 'dify-api', 'dify-web']) {
    const published = config.services[service].ports || [];
    assert.ok(
      published.every((port) => port.host_ip === '127.0.0.1'),
      `${service} published a port outside loopback`,
    );
  }
}

async function retry(label, action, timeoutMs, delayMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
    }
  }
  throw new Error(`${label} did not become ready in time: ${lastError?.message || 'unknown error'}`);
}

async function requestJson(baseUrl, path, options = {}) {
  const {
    method = 'GET',
    token,
    body,
    expected = [200],
    timeoutMs = 30_000,
  } = options;
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!expected.includes(response.status)) {
    throw new Error(`${method} ${path} returned HTTP ${response.status}: ${text.slice(0, 2_000)}`);
  }
  return data;
}

function startOneClickGateway(env, logs) {
  const entrypoint = join(ROOT, 'scripts', 'start-full-stack.cjs');
  const child = spawn(process.execPath, [entrypoint, '--gateway-only'], {
    cwd: ROOT,
    env,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    logs.stdout = appendLimited(logs.stdout, text);
    process.stdout.write(`[one-click] ${text}`);
  });
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    logs.stderr = appendLimited(logs.stderr, text);
    process.stderr.write(`[one-click] ${text}`);
  });
  child.once('error', (error) => {
    child.launchError = error;
    logs.stderr = appendLimited(logs.stderr, `\n${error.stack || error.message}`);
  });
  return child;
}

function isPortOpen(port) {
  return new Promise((resolvePromise) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const done = (open) => {
      socket.destroy();
      resolvePromise(open);
    };
    socket.setTimeout(1_000);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function waitForPortClosed(port) {
  await retry(
    `Gateway port ${port} shutdown`,
    async () => assert.equal(await isPortOpen(port), false, `port ${port} is still accepting connections`),
    30_000,
    500,
  );
}

async function stopOneClickGateway(child, gatewayPort) {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolvePromise) => child.once('exit', resolvePromise));
    if (process.platform === 'win32') {
      // Target only the starter PID and descendants created for this isolated run.
      await runCommand(
        'taskkill.exe',
        ['/PID', String(child.pid), '/T', '/F'],
        { echo: false, timeoutMs: 30_000 },
      ).catch(() => {});
    } else {
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      const graceful = await Promise.race([
        exited.then(() => true),
        new Promise((resolvePromise) => setTimeout(() => resolvePromise(false), 10_000)),
      ]);
      if (!graceful) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      }
    }
    await Promise.race([
      exited,
      new Promise((resolvePromise) => setTimeout(resolvePromise, 10_000)),
    ]);
  }
  if (gatewayPort) await waitForPortClosed(gatewayPort);
}

async function waitForGateway(baseUrl, child) {
  await retry(
    'Gateway',
    async () => {
      if (child.launchError) throw child.launchError;
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Gateway exited early (${child.exitCode ?? child.signalCode})`);
      }
      const result = await requestJson(baseUrl, '/healthz', { timeoutMs: 5_000 });
      assert.equal(result.status, 'ok');
    },
    15 * 60_000,
    1_000,
  );
}

async function loginAdmin(baseUrl, account, password) {
  return retry(
    'futureFlow administrator login',
    async () => {
      const result = await requestJson(baseUrl, '/auth/login', {
        method: 'POST',
        body: { account, password },
        expected: [201],
      });
      assert.ok(result.accessToken, 'Administrator login returned no access token');
      assert.equal(result.user?.role, 'admin', 'Bootstrap account is not an administrator');
      return result;
    },
    60_000,
    1_000,
  );
}

function simpleWorkflow(label) {
  return {
    nodes: [
      {
        id: 'start',
        type: 'start',
        meta: { position: { x: 0, y: 0 } },
        data: {
          title: 'Start',
          outputs: { type: 'object', properties: {} },
        },
      },
      {
        id: 'text',
        type: 'text',
        meta: { position: { x: 280, y: 0 } },
        data: {
          title: 'Static text',
          inputsValues: {
            text: { type: 'constant', content: `fresh-volume-${label}` },
          },
          outputs: { type: 'object', properties: { text: { type: 'string' } } },
        },
      },
      {
        id: 'end',
        type: 'end',
        meta: { position: { x: 560, y: 0 } },
        data: {
          title: 'End',
          inputsValues: {
            result: { type: 'ref', content: ['text', 'text'] },
          },
        },
      },
    ],
    edges: [
      { sourceNodeID: 'start', targetNodeID: 'text' },
      { sourceNodeID: 'text', targetNodeID: 'end' },
    ],
  };
}

async function createAndPublishWorkflow(baseUrl, token, label) {
  const created = await requestJson(baseUrl, '/workflows', {
    method: 'POST',
    token,
    body: {
      name: `Fresh Volume E2E ${label} ${Date.now()}`,
      description: 'No-model fresh-volume acceptance workflow',
      flowgram: JSON.stringify(simpleWorkflow(label)),
    },
    expected: [201],
  });
  assert.ok(created?.id, 'Workflow creation returned no ID');

  const published = await requestJson(baseUrl, `/workflows/${created.id}/publish`, {
    method: 'POST',
    token,
    body: {},
    expected: [201],
    timeoutMs: 3 * 60_000,
  });
  assert.equal(
    published.dify?.status,
    'synced',
    published.dify?.message || `Workflow ${label} did not synchronize to Dify`,
  );
  assert.ok(published.dify?.appId, `Workflow ${label} returned no Dify appId`);
  assert.ok(
    Number.isInteger(published.workflow?.publishedVersion),
    `Workflow ${label} returned no published version`,
  );
  return {
    workflowId: created.id,
    workflowVersion: published.workflow.publishedVersion,
    appId: published.dify.appId,
    expectedResult: `fresh-volume-${label}`,
  };
}

function parseSseEvents(body) {
  const normalized = String(body).replace(/\r\n/g, '\n');
  return normalized
    .split('\n\n')
    .map((frame) => frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
      .trim())
    .filter(Boolean)
    .map((payload) => JSON.parse(payload));
}

async function executePublishedWorkflow(baseUrl, token, workflow, phase) {
  const response = await fetch(`${baseUrl}/workflows/${workflow.workflowId}/execute`, {
    method: 'POST',
    headers: {
      Accept: 'text/event-stream',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `fresh-volume-${phase}-${randomUUID()}`,
    },
    body: JSON.stringify({
      inputs: {},
      publishedVersion: workflow.workflowVersion,
    }),
    signal: AbortSignal.timeout(3 * 60_000),
  });
  const body = await response.text();
  assert.equal(
    response.status,
    200,
    `${phase} execution returned HTTP ${response.status}: ${body.slice(0, 2_000)}`,
  );
  const events = parseSseEvents(body);
  const finished = events.find((event) => event.event === 'workflow_finished');
  assert.ok(finished, `${phase} execution returned no workflow_finished event`);
  assert.equal(
    finished.data?.status,
    'succeeded',
    `${phase} execution failed: ${finished.data?.error || finished.data?.status || 'unknown'}`,
  );
  assert.equal(
    events.some((event) => event.event === 'error'),
    false,
    `${phase} execution emitted an SSE error event`,
  );
  assert.equal(
    finished.data?.outputs?.result,
    workflow.expectedResult,
    `${phase} execution used the wrong Dify DSL or Service API key`,
  );
}

function assertManagedBindings(status, publishedWorkflows) {
  assert.equal(status.connectionAuthorized, true, 'Dify Console authorization was not saved automatically');
  assert.equal(
    status.managedWorkflowAppCount,
    publishedWorkflows.length,
    'Managed Dify app count does not match the published workflows',
  );
  assert.equal(
    status.managedWorkflowApps?.length,
    publishedWorkflows.length,
    'Managed Dify binding list length is incorrect',
  );

  for (const expected of publishedWorkflows) {
    const binding = status.managedWorkflowApps.find(
      (item) => item.workflowId === expected.workflowId
        && item.workflowVersion === expected.workflowVersion,
    );
    assert.ok(binding, `Missing managed binding for workflow ${expected.workflowId}`);
    assert.equal(binding.appId, expected.appId, 'Managed binding points at the wrong Dify app');
    assert.ok(binding.keyFingerprint, 'Managed binding has no Service API key fingerprint');
  }
  assert.equal(
    new Set(status.managedWorkflowApps.map((item) => item.keyFingerprint)).size,
    publishedWorkflows.length,
    'Managed workflows reused one Service API key fingerprint',
  );
}

function bindingSnapshot(status) {
  return (status.managedWorkflowApps || [])
    .map((item) => ({
      workflowId: item.workflowId,
      workflowVersion: item.workflowVersion,
      appId: item.appId,
      keyFingerprint: item.keyFingerprint,
    }))
    .sort((left, right) => left.workflowId.localeCompare(right.workflowId));
}

async function queryScalar(container, database, user, sql) {
  const { stdout } = await runCommand(
    'docker',
    ['exec', container, 'psql', '-U', user, '-d', database, '-Atc', sql],
    { echo: false, timeoutMs: 30_000 },
  );
  return stdout.trim().replace(/^\uFEFF/, '');
}

async function assertPersistedManagedCredentials(project, publishedWorkflows) {
  const appIds = publishedWorkflows.map((item) => {
    assert.match(item.appId, /^[0-9a-f-]{36}$/i, 'Dify returned an invalid managed app ID');
    return `'${item.appId}'`;
  });
  assert.equal(
    await queryScalar(
      containerName(project, 'dify-postgres'),
      'dify',
      'dify',
      `select count(*) from (
         select app_id from api_tokens
          where type = 'app' and app_id in (${appIds.join(',')})
          group by app_id having count(*) = 1
       ) as one_key_per_app;`,
    ),
    String(publishedWorkflows.length),
    'Each managed Dify app must own exactly one Service API key',
  );
  assert.equal(
    await queryScalar(
      containerName(project, 'dify-postgres'),
      'dify',
      'dify',
      `select count(distinct token) from api_tokens
        where type = 'app' and app_id in (${appIds.join(',')});`,
    ),
    String(publishedWorkflows.length),
    'Managed Dify apps must own distinct Service API key values',
  );
  assert.equal(
    await queryScalar(
      containerName(project, 'postgres'),
      'futureflow',
      'futureflow',
      `select count(*) from dify_integrations
       where "workflowId" is not null and status = 'active'
         and "encryptedApiKey" like 'v1:%';`,
    ),
    String(publishedWorkflows.length),
    'Managed Service API keys were not stored encrypted and active',
  );
  assert.equal(
    await queryScalar(
      containerName(project, 'postgres'),
      'futureflow',
      'futureflow',
      `select count(*) from dify_integrations
       where name = 'default' and status = 'active'
         and "encryptedConsoleToken" like 'v1:%'
         and "encryptedConsoleRefreshToken" like 'v1:%';`,
    ),
    '1',
    'Dify Console access and refresh authorization were not encrypted at rest',
  );
}

function assertDifyInitArtifacts(isolatedEnvPath) {
  const initialized = parseEnvFile(isolatedEnvPath);
  assert.match(initialized.DIFY_API_KEY || '', /^app-/, 'dify-init did not generate a Service API key');
  assert.ok(initialized.DIFY_APP_ID, 'dify-init did not persist its bridge app ID');
  assert.equal(
    initialized.DIFY_CONSOLE_TOKEN || '',
    '',
    'dify-init must not write a Console token',
  );
  return initialized;
}

async function assertSingleAdministrator(project, expected) {
  assert.equal(
    await queryScalar(
      containerName(project, 'postgres'),
      'futureflow',
      'futureflow',
      `select username || '|' || coalesce(email, '') || '|' || status
         from users where role = 'admin' order by username;`,
    ),
    `${expected.username}|${expected.email}|active`,
    'futureFlow must contain exactly one active administrator with the default identity',
  );
}

function assertMigratedEnvironment(isolatedEnvPath, expectedSecrets) {
  const migrated = parseEnvFile(isolatedEnvPath);
  assert.ok(
    Number.parseInt(migrated.FUTUREFLOW_ENV_SCHEMA_VERSION || '0', 10) >= 2,
    'The retained schema-v1 .env was not migrated to schema v2+',
  );
  for (const name of [
    'GATEWAY_BOOTSTRAP_ADMIN_ENABLED',
    'DIFY_AUTO_BOOTSTRAP',
    'DIFY_MANAGED_BRIDGE',
  ]) {
    assert.equal(migrated[name], 'true', `${name} was not enabled by the one-click migration`);
  }
  assert.equal(migrated.GATEWAY_BOOTSTRAP_ADMIN_USERNAME, 'admin');
  assert.equal(migrated.GATEWAY_BOOTSTRAP_ADMIN_EMAIL, 'admin@futureflow.local');
  assert.equal(migrated.LLM_API_KEY || '', '', 'The acceptance environment must not inject a model key');
  for (const [name, value] of Object.entries(expectedSecrets)) {
    assert.equal(migrated[name], value, `init-env unexpectedly rotated the valid ${name}`);
  }
  return migrated;
}

async function collectDiagnostics(composeArgs, env, gatewayLogs) {
  console.error('\n=== isolated fresh-volume diagnostics ===');
  try {
    await runCommand('docker', [...composeArgs, 'ps', '--all'], {
      env,
      timeoutMs: 30_000,
    });
  } catch {}
  try {
    await runCommand('docker', [...composeArgs, 'logs', '--no-color', '--tail', '200'], {
      env,
      timeoutMs: 60_000,
    });
  } catch {}
  const tail = `${gatewayLogs.stdout}\n${gatewayLogs.stderr}`.trim().slice(-8_000);
  if (tail) console.error(`\n=== gateway log tail ===\n${tail}`);
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printUsage();
    return;
  }
  if (!process.argv.includes(CONFIRM_FLAG) && !PREFLIGHT_ONLY) {
    printUsage();
    throw new Error(
      `Refusing to create disposable test volumes without ${CONFIRM_FLAG}`,
    );
  }

  mkdirSync(TEMP_ROOT, { recursive: true });
  const tempDir = mkdtempSync(join(TEMP_ROOT, 'fresh-volume-e2e-'));
  assertSafeTempDirectory(tempDir);
  const project = `futureflow-fresh-e2e-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  assertSafeProjectName(project);
  const [postgresPort, difyApiPort, difyWebPort, gatewayPort] = await Promise.all([
    getFreePort(), getFreePort(), getFreePort(), getFreePort(),
  ]);
  assert.equal(new Set([postgresPort, difyApiPort, difyWebPort, gatewayPort]).size, 4);
  const ports = { postgres: postgresPort, difyApi: difyApiPort, difyWeb: difyWebPort, gateway: gatewayPort };

  const isolatedEnvPath = join(tempDir, '.env');
  const isolatedExamplePath = join(tempDir, '.env.example');
  const isolatedRuntimePath = join(tempDir, '.futureflow.runtime.env');
  const overridePath = join(tempDir, 'compose.override.yml');
  mkdirSync(join(tempDir, 'scripts'), { recursive: true });
  copyFileSync(join(ROOT, '.env.example'), isolatedExamplePath);
  copyFileSync(join(ROOT, 'scripts', 'init-dify.cjs'), join(tempDir, 'scripts', 'init-dify.cjs'));
  writeFileSync(overridePath, buildOverride(project, tempDir), 'utf8');

  const expectedSecrets = {
    POSTGRES_PASSWORD: secret(),
    DIFY_DB_PASSWORD: secret(),
    DIFY_SECRET_KEY: secret(),
    DIFY_SANDBOX_API_KEY: secret(),
    DIFY_ADMIN_PASSWORD: secret(),
    DIFY_KEY_ENCRYPTION_SECRET: secret(),
    GATEWAY_JWT_SECRET: secret(),
    GATEWAY_BOOTSTRAP_ADMIN_PASSWORD: secret(),
    MEDIA_CREDENTIAL_ENCRYPTION_SECRET: secret(),
  };
  const legacyEnv = buildLegacyEnv(readFileSync(isolatedExamplePath, 'utf8'), {
    FUTUREFLOW_ENV_SCHEMA_VERSION: '1',
    NODE_ENV: 'development',
    POSTGRES_HOST: '127.0.0.1',
    POSTGRES_PORT: String(postgresPort),
    POSTGRES_DB: 'futureflow',
    POSTGRES_USER: 'futureflow',
    POSTGRES_PASSWORD: expectedSecrets.POSTGRES_PASSWORD,
    DIFY_DB_PASSWORD: expectedSecrets.DIFY_DB_PASSWORD,
    DIFY_SECRET_KEY: expectedSecrets.DIFY_SECRET_KEY,
    DIFY_SANDBOX_API_KEY: expectedSecrets.DIFY_SANDBOX_API_KEY,
    DIFY_SANDBOX_ENABLE_NETWORK: 'true',
    DIFY_API_PORT: String(difyApiPort),
    DIFY_WEB_PORT: String(difyWebPort),
    DIFY_API_BASE: `http://127.0.0.1:${difyApiPort}/v1`,
    DIFY_CONSOLE_BASE: `http://127.0.0.1:${difyApiPort}/console/api`,
    DIFY_ADMIN_EMAIL: 'admin@futureflow.local',
    DIFY_ADMIN_PASSWORD: expectedSecrets.DIFY_ADMIN_PASSWORD,
    DIFY_KEY_ENCRYPTION_SECRET: expectedSecrets.DIFY_KEY_ENCRYPTION_SECRET,
    DIFY_AUTO_BOOTSTRAP: 'false',
    DIFY_MANAGED_BRIDGE: 'false',
    DIFY_AUTO_BOOTSTRAP_ATTEMPTS: '60',
    DIFY_AUTO_BOOTSTRAP_RETRY_MS: '1000',
    DIFY_SYNC_LLM_PROVIDER: 'true',
    DIFY_FORCE_LLM_PROVIDER_SYNC: 'false',
    DIFY_CONSOLE_TOKEN: '',
    DIFY_API_KEY: '',
    DIFY_APP_ID: '',
    LLM_API_KEY: '',
    GATEWAY_HOST: '127.0.0.1',
    GATEWAY_PORT: String(gatewayPort),
    PUBLIC_GATEWAY_URL: `http://127.0.0.1:${gatewayPort}`,
    CORS_ORIGIN: 'http://127.0.0.1:3000',
    GATEWAY_JWT_SECRET: expectedSecrets.GATEWAY_JWT_SECRET,
    GATEWAY_BOOTSTRAP_ADMIN_ENABLED: 'false',
    GATEWAY_BOOTSTRAP_ADMIN_USERNAME: 'admin',
    GATEWAY_BOOTSTRAP_ADMIN_EMAIL: 'admin@futureflow.local',
    GATEWAY_BOOTSTRAP_ADMIN_PASSWORD: expectedSecrets.GATEWAY_BOOTSTRAP_ADMIN_PASSWORD,
    MEDIA_CREDENTIAL_ENCRYPTION_SECRET: expectedSecrets.MEDIA_CREDENTIAL_ENCRYPTION_SECRET,
    MEDIA_ASSET_ROOT: join(tempDir, 'media-assets').replace(/\\/g, '/'),
    DIFY_MEDIA_GATEWAY_URL: `http://host.docker.internal:${gatewayPort}`,
    DIFY_MEDIA_GATEWAY_HOST: 'host.docker.internal',
    DIFY_MEDIA_GATEWAY_PORT: String(gatewayPort),
  });
  writeFileSync(isolatedEnvPath, legacyEnv, { mode: 0o600 });

  const isolatedValues = parseEnvFile(isolatedEnvPath);
  assert.equal(isolatedValues.FUTUREFLOW_ENV_SCHEMA_VERSION, '1');
  assert.equal(isolatedValues.GATEWAY_BOOTSTRAP_ADMIN_ENABLED, 'false');
  assert.equal(isolatedValues.DIFY_AUTO_BOOTSTRAP, 'false');
  assert.equal(isolatedValues.DIFY_MANAGED_BRIDGE, 'false');

  const starterEnv = {
    ...withoutEnvironmentOverrides(process.env, [
      ...Object.keys(isolatedValues),
      'DIFY_API_KEY',
      'DIFY_APP_ID',
      'DIFY_CONSOLE_TOKEN',
      'COMPOSE_PROFILES',
    ]),
    NODE_ENV: 'development',
    FUTUREFLOW_ENV_FILE: isolatedEnvPath,
    FUTUREFLOW_ENV_EXAMPLE_FILE: isolatedExamplePath,
    FUTUREFLOW_RUNTIME_ENV_FILE: isolatedRuntimePath,
    COMPOSE_PROJECT_NAME: project,
    COMPOSE_FILE: [BASE_COMPOSE, overridePath].join(delimiter),
    COMPOSE_ENV_FILES: isolatedEnvPath,
  };
  for (const name of ['DIFY_API_KEY', 'DIFY_APP_ID', 'DIFY_CONSOLE_TOKEN']) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(starterEnv, name),
      false,
      `${name} must be absent from the starter process environment`,
    );
  }
  const composeArgs = ['compose', '--profile', 'bootstrap'];
  const rootEnvPath = join(ROOT, '.env');
  const runtimeEnvPath = join(ROOT, '.futureflow.runtime.env');
  const rootEnvBefore = fileSnapshot(rootEnvPath);
  const runtimeEnvBefore = fileSnapshot(runtimeEnvPath);
  const gatewayLogs = { stdout: '', stderr: '' };
  let starter = null;
  let resourcesStarted = false;
  let failed = false;
  let cleanupPromise = null;

  const cleanup = () => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      let cleanupError = null;
      const activeStarter = starter;
      starter = null;
      if (activeStarter) {
        try {
          await stopOneClickGateway(activeStarter, gatewayPort);
        } catch (error) {
          cleanupError = error;
        }
      }

      const keep = KEEP_RESOURCES || (failed && KEEP_ON_FAILURE);
      if (keep) {
        console.warn(`Isolated resources kept for diagnosis. Project: ${project}`);
        console.warn(`Temporary workspace (contains disposable secrets): ${tempDir}`);
        if (cleanupError) throw cleanupError;
        return;
      }

      if (resourcesStarted) {
        assertSafeProjectName(project);
        try {
          await runCommand(
            'docker',
            [...composeArgs, 'down', '--volumes', '--remove-orphans'],
            { env: starterEnv, timeoutMs: 3 * 60_000 },
          );
          const { stdout } = await runCommand(
            'docker',
            [...composeArgs, 'ps', '--all', '--quiet'],
            { env: starterEnv, echo: false, timeoutMs: 30_000 },
          );
          assert.equal(
            stdout.trim(),
            '',
            `Compose project ${project} still owns containers after cleanup`,
          );
        } catch (error) {
          cleanupError ||= error;
        }
      }

      if (cleanupError) {
        console.warn(`Cleanup was incomplete; temporary workspace retained: ${tempDir}`);
        throw cleanupError;
      }
      assertSafeTempDirectory(tempDir);
      rmSync(tempDir, { recursive: true, force: true });
    })();
    return cleanupPromise;
  };

  const signalHandler = async (signal) => {
    failed = true;
    console.error(`Received ${signal}; cleaning isolated resources...`);
    try { await cleanup(); } finally { process.exit(130); }
  };
  process.once('SIGINT', signalHandler);
  process.once('SIGTERM', signalHandler);

  try {
    console.log(`Isolated Compose project: ${project}`);
    console.log(`Ports: PostgreSQL=${postgresPort}, Dify API=${difyApiPort}, Dify Web=${difyWebPort}, Gateway=${gatewayPort}`);
    await runCommand('docker', ['version', '--format', '{{.Server.Version}}'], {
      echo: false,
      timeoutMs: 30_000,
    });
    await runCommand(PNPM, ['--version'], { echo: false, timeoutMs: 30_000 });
    await verifyResolvedCompose(composeArgs, starterEnv, project, tempDir, ports);
    console.log('Compose isolation preflight passed. Existing project, volumes, and .env are out of scope.');
    if (PREFLIGHT_ONLY) {
      console.log('Preflight-only mode completed; no containers or volumes were created.');
      return;
    }

    const gatewayBase = `http://127.0.0.1:${gatewayPort}`;
    resourcesStarted = true;
    starter = startOneClickGateway(starterEnv, gatewayLogs);
    await waitForGateway(gatewayBase, starter);

    assertMigratedEnvironment(isolatedEnvPath, expectedSecrets);
    const initialDify = assertDifyInitArtifacts(isolatedEnvPath);
    assert.equal(
      parseEnvFile(isolatedRuntimePath).POSTGRES_PORT,
      String(postgresPort),
      'The one-click starter did not write its runtime port to the isolated file',
    );
    assert.equal(
      await queryScalar(
        containerName(project, 'dify-postgres'),
        'dify',
        'dify',
        'select count(*) from apps;',
      ),
      '1',
      'Fresh Dify should contain only the idempotent bridge app after dify-init',
    );
    assertFileUnchanged(rootEnvPath, rootEnvBefore);
    assertFileUnchanged(runtimeEnvPath, runtimeEnvBefore);
    console.log('The real one-click starter migrated the retained .env and initialized Dify before Gateway readiness.');

    let login = await loginAdmin(
      gatewayBase,
      'admin',
      expectedSecrets.GATEWAY_BOOTSTRAP_ADMIN_PASSWORD,
    );
    await assertSingleAdministrator(project, {
      username: 'admin',
      email: 'admin@futureflow.local',
    });
    let status = await requestJson(gatewayBase, '/admin/dify/status', {
      token: login.accessToken,
    });
    assert.equal(status.connectionAuthorized, true, 'Gateway did not automatically save Dify authorization');
    assert.equal(status.managedWorkflowAppCount, 0, 'Fresh Gateway unexpectedly has managed workflow bindings');
    assert.equal(
      status.managedWorkflowApps?.length || 0,
      0,
      'Fresh Gateway unexpectedly returned a managed workflow binding',
    );
    console.log('Gateway administrator login and automatic Dify authorization passed.');

    const published = [
      await createAndPublishWorkflow(gatewayBase, login.accessToken, `A-${randomUUID()}`),
      await createAndPublishWorkflow(gatewayBase, login.accessToken, `B-${randomUUID()}`),
    ];
    assert.notEqual(published[0].appId, published[1].appId, 'Published workflows reused one Dify app');
    assert.ok(
      published.every((item) => item.appId !== initialDify.DIFY_APP_ID),
      'A managed workflow reused the dify-init bridge app',
    );
    status = await requestJson(gatewayBase, '/admin/dify/status', {
      token: login.accessToken,
    });
    assertManagedBindings(status, published);
    await assertPersistedManagedCredentials(project, published);
    for (const workflow of published) {
      await executePublishedWorkflow(gatewayBase, login.accessToken, workflow, 'cold-start');
    }
    const beforeRestartBindings = bindingSnapshot(status);
    assert.equal(
      await queryScalar(
        containerName(project, 'dify-postgres'),
        'dify',
        'dify',
        'select count(*) from apps;',
      ),
      '3',
      'Dify should contain one bridge app and two isolated workflow apps',
    );
    console.log('Two no-model workflows synchronized and executed through distinct Dify apps.');

    await stopOneClickGateway(starter, gatewayPort);
    starter = null;
    assert.equal(await isPortOpen(gatewayPort), false, 'Gateway port remained open after stopping the starter');
    await runCommand('docker', [...composeArgs, 'down', '--remove-orphans'], {
      env: starterEnv,
      timeoutMs: 3 * 60_000,
    });

    starter = startOneClickGateway(starterEnv, gatewayLogs);
    await waitForGateway(gatewayBase, starter);
    assertMigratedEnvironment(isolatedEnvPath, expectedSecrets);
    const restartedDify = assertDifyInitArtifacts(isolatedEnvPath);
    assert.equal(restartedDify.DIFY_APP_ID, initialDify.DIFY_APP_ID, 'dify-init duplicated its bridge app');
    assert.equal(restartedDify.DIFY_API_KEY, initialDify.DIFY_API_KEY, 'dify-init rotated its key on restart');
    assert.equal(
      parseEnvFile(isolatedRuntimePath).POSTGRES_PORT,
      String(postgresPort),
      'The restarted one-click starter changed its isolated runtime port',
    );

    login = await loginAdmin(
      gatewayBase,
      'admin',
      expectedSecrets.GATEWAY_BOOTSTRAP_ADMIN_PASSWORD,
    );
    await assertSingleAdministrator(project, {
      username: 'admin',
      email: 'admin@futureflow.local',
    });
    status = await requestJson(gatewayBase, '/admin/dify/status', {
      token: login.accessToken,
    });
    assertManagedBindings(status, published);
    await assertPersistedManagedCredentials(project, published);
    for (const workflow of published) {
      await executePublishedWorkflow(gatewayBase, login.accessToken, workflow, 'restart');
    }
    assert.deepEqual(bindingSnapshot(status), beforeRestartBindings, 'Gateway restart changed managed bindings');
    assert.equal(
      await queryScalar(
        containerName(project, 'dify-postgres'),
        'dify',
        'dify',
        'select count(*) from apps;',
      ),
      '3',
      'Full restart duplicated a Dify app',
    );
    assertFileUnchanged(rootEnvPath, rootEnvBefore);
    assertFileUnchanged(runtimeEnvPath, runtimeEnvBefore);

    console.log('\nFresh-volume one-click acceptance passed:');
    console.log('- the real one-click entrypoint migrated schema-v1 defaults without rotating valid secrets');
    console.log('- dify-init completed before Gateway readiness and did not persist a Console token');
    console.log('- the default futureFlow administrator was created and can log in');
    console.log('- Dify authorization was saved automatically');
    console.log('- two no-model workflows own distinct synchronized apps/keys and execute successfully');
    console.log('- the same one-click entrypoint restarted cleanly without duplicate admin, app, key, or binding');
  } catch (error) {
    failed = true;
    await collectDiagnostics(composeArgs, starterEnv, gatewayLogs);
    throw error;
  } finally {
    process.removeListener('SIGINT', signalHandler);
    process.removeListener('SIGTERM', signalHandler);
    await cleanup();
  }
}

main().catch((error) => {
  console.error(`\nFresh-volume acceptance failed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
