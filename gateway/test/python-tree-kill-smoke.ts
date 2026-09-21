import assert from 'node:assert/strict';
import { spawn, ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  RUNNER_SOURCE,
  buildPythonExecEnv,
  killProcessTree,
} from '../src/localtools/python-exec.controller';

/**
 * 进程树回收回归。
 *
 * 缺陷背景：`child.kill()`（以及 Node spawn 的 timeout 选项）只杀直接子进程，
 * 用户代码里 `subprocess.Popen(...)` 出来的孙进程会活下来。实测父进程退出后，
 * 孙进程照样在 20 秒后写了文件——「15 秒超时强杀」因此是空话。
 *
 * 这里守住**真正能保证**的那件事：超时发生时父进程还活着，整棵树必须一起结束。
 *   - 实验组：父进程长跑 + 派生孙进程 → 杀进程树 → 孙进程必须消失
 *   - 对照组：同样长跑但不杀 → 孙进程必须活着（证明上面不是假通过）
 *
 * 另有两条平台相关的断言，把各自的实际保证钉住：
 *   - POSIX：父进程**已退出**后仍能靠进程组收掉后代（detached 的整组还在）
 *   - Windows：做不到这一点（taskkill /T 需要活着的父进程），已在源码注释写明，
 *     不在这里假装有保证
 *
 * 主动脱离的后代（DETACHED_PROCESS / start_new_session）两平台都杀不掉，属已知
 * 边界，不是本测试的失败条件。
 */

const GRANDCHILD_SLEEP_SECONDS = 4;
const SETTLE_MS = (GRANDCHILD_SLEEP_SECONDS + 2) * 1000;
const KILL_AFTER_MS = 1500;

const wait = (ms: number) => new Promise((r) => { setTimeout(r, ms); });

/**
 * 起一个「父进程 + 普通派生孙进程」的组合。
 *
 * @param parentSleepSeconds 父进程在 main() 里再睡多久。>0 时父进程保持存活
 *   （模拟超时路径）；=0 时 main() 立即返回、父进程随即退出（模拟正常结束）。
 */
function spawnWithGrandchild(
  tag: string,
  parentSleepSeconds: number,
): { child: ChildProcess; marker: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), `ff-tree-${tag}-`));
  const marker = join(dir, 'grandchild-alive.txt');
  const runnerFile = join(dir, 'runner.py');
  const userFile = join(dir, 'main.py');
  const paramsFile = join(dir, 'params.json');

  writeFileSync(paramsFile, JSON.stringify({ marker }), 'utf8');
  writeFileSync(runnerFile, RUNNER_SOURCE, 'utf8');
  // 标记路径走 params：直接把 Windows 路径拼进源码，里面的 \U 会被 Python
  // 当成 Unicode 转义而变成语法错误（踩过一次，表现为「测试假通过」）。
  writeFileSync(
    userFile,
    [
      'import subprocess, sys, time',
      'def main(params):',
      '    marker = params["marker"]',
      `    code = "import time; time.sleep(${GRANDCHILD_SLEEP_SECONDS}); open(r'" + marker + "', 'w').write('alive')"`,
      '    subprocess.Popen([sys.executable, "-c", code])',
      parentSleepSeconds > 0 ? `    time.sleep(${parentSleepSeconds})` : '    pass',
      '    return {"spawned": True}',
    ].join('\n'),
    'utf8',
  );

  const child = spawn('python', [runnerFile, paramsFile, userFile], {
    cwd: dir,
    windowsHide: true,
    detached: process.platform !== 'win32',
    env: buildPythonExecEnv(undefined, process.env),
  });
  return { child, marker, dir };
}

/**
 * 收尾：先杀进程树，稍等再删目录。
 * 直接删会 EBUSY —— 进程刚收到终止信号时还握着目录句柄（踩过）。
 */
async function cleanup(child: ChildProcess | null, dir: string): Promise<void> {
  killProcessTree(child);
  await wait(400);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // 进程尚未完全退出：残留的是临时目录，不影响断言结论
  }
}

function exited(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once('close', () => resolve());
  });
}

async function main() {
  // ── 1. 兜底：空句柄 / 已退出进程都不能抛错 ────────────────────────
  {
    killProcessTree(null);
    killProcessTree({ pid: undefined } as unknown as ChildProcess);
    killProcessTree({ pid: 999999 } as unknown as ChildProcess);
    console.log('  killProcessTree 对空句柄/已退出进程不抛错');
  }

  // ── 2/3. 超时路径（父进程仍存活）：实验组 + 对照组 ─────────────────
  const control = spawnWithGrandchild('ctrl', 30);
  const subject = spawnWithGrandchild('kill', 30);

  await wait(KILL_AFTER_MS);
  killProcessTree(subject.child);
  await wait(SETTLE_MS);

  try {
    assert.ok(
      existsSync(control.marker),
      '对照组：不杀进程树时孙进程应存活（否则下一条断言是假通过）',
    );
    assert.equal(
      existsSync(subject.marker),
      false,
      '杀进程树后孙进程不应存活，否则超时保证形同虚设',
    );
  } finally {
    await cleanup(control.child, control.dir);
    await cleanup(subject.child, subject.dir);
  }

  // ── 4. POSIX 专属：父进程已退出后仍能靠进程组收掉后代 ──────────────
  // Windows 上做不到（taskkill /T 需要活着的父进程），源码注释已写明。
  if (process.platform !== 'win32') {
    const afterExit = spawnWithGrandchild('after', 0);
    await exited(afterExit.child);
    killProcessTree(afterExit.child);
    await wait(SETTLE_MS);
    try {
      assert.equal(
        existsSync(afterExit.marker),
        false,
        'POSIX：父进程退出后仍应靠进程组收掉后代',
      );
    } finally {
      await cleanup(afterExit.child, afterExit.dir);
    }
    console.log('  POSIX：父进程退出后仍能回收后代');
  } else {
    console.log('  Windows 跳过「父进程退出后回收」：taskkill /T 需要活着的父进程（已知缺口）');
  }

  console.log(
    'python 进程树回收测试通过: 空句柄不抛错 / 对照组孙进程存活 / 超时路径孙进程被回收',
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
