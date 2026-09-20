import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RUNNER_SOURCE } from '../src/localtools/python-exec.controller';

/**
 * 「Python 执行」节点的运行器契约回归。
 *
 * 历史缺陷：运行器调用的是 `main({'params': params})`，比文档与默认模板多包了
 * 一层。前端默认模板写的是 `def main(params): params.get("query")`，于是
 * query 永远取不到，节点「执行成功」却返回错误结果，而且不报任何错。
 * 这里用真实 Python 跑一遍默认模板，确保 params 是直接传进去的。
 */
const DEFAULT_TEMPLATE =
  'def main(params):\n    text = str(params.get("query", ""))\n    return {"length": len(text), "upper": text.upper()}';

function detectPython(): string | null {
  for (const candidate of ['python', 'python3', 'py']) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8', windowsHide: true });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return null;
}

function runRunner(python: string, code: string, params: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'ff-py-runner-'));
  try {
    const userFile = join(dir, 'main.py');
    const runnerFile = join(dir, 'runner.py');
    const paramsFile = join(dir, 'params.json');
    writeFileSync(userFile, code, 'utf8');
    writeFileSync(runnerFile, RUNNER_SOURCE, 'utf8');
    writeFileSync(paramsFile, JSON.stringify(params), 'utf8');

    const result = spawnSync(python, [runnerFile, paramsFile, userFile], {
      cwd: dir,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
    });
    return {
      status: result.status,
      stdout: String(result.stdout || ''),
      stderr: String(result.stderr || ''),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function parseResult(stdout: string) {
  const marker = '__FF_RESULT__';
  assert.ok(stdout.includes(marker), `运行器应输出结果标记，实际输出: ${stdout.slice(0, 200)}`);
  return JSON.parse(stdout.slice(stdout.indexOf(marker) + marker.length).trim());
}

function main() {
  const python = detectPython();
  if (!python) {
    console.log('python runner smoke skipped: 未检测到本机 Python');
    return;
  }

  // 1. 官方默认模板必须能取到工作流输入。
  const ok = runRunner(python, DEFAULT_TEMPLATE, { query: 'futureFlow' });
  assert.equal(ok.status, 0, `默认模板应执行成功，stderr=${ok.stderr.slice(0, 200)}`);
  assert.deepEqual(
    parseResult(ok.stdout),
    { length: 10, upper: 'FUTUREFLOW' },
    'params 必须直接交给 main（main(params)），多包一层会让默认模板静默返回空结果',
  );

  // 2. params 为空时安全返回，不报错。
  const empty = runRunner(python, DEFAULT_TEMPLATE, {});
  assert.equal(empty.status, 0);
  assert.deepEqual(parseResult(empty.stdout), { length: 0, upper: '' });

  // 3. 非字符串输入由脚本自己 str() 兜底（与默认模板一致）。
  const numeric = runRunner(python, DEFAULT_TEMPLATE, { query: 123 });
  assert.equal(numeric.status, 0);
  assert.deepEqual(parseResult(numeric.stdout), { length: 3, upper: '123' });

  // 4. 没有 main 函数时给出明确错误并退出码 2。
  const noMain = runRunner(python, 'x = 1', {});
  assert.equal(noMain.status, 2);
  assert.match(noMain.stdout, /必须定义 main 函数/);

  // 5. 脚本内部异常以退出码 3 + 可读错误回传。
  const boom = runRunner(python, 'def main(params):\n    raise ValueError("boom")', {});
  assert.equal(boom.status, 3);
  assert.match(boom.stdout, /ValueError: boom/);

  console.log('python runner smoke passed: params 契约、空输入、非字符串、无 main、运行时异常');
}

main();
