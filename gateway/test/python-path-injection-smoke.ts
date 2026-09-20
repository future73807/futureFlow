import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { buildPythonPath, buildPythonPathFromEnv } from '../src/localtools/python-exec.controller';

/**
 * `buildPythonPath` 回归。
 *
 * 这是「Python 节点开箱连库」的核心机制：把随仓库携带的依赖目录注入子进程的
 * PYTHONPATH，从而不需要用户 pip install 也不会污染用户环境。它此前**没有任何
 * 测试**——唯一验证过它的是我临时写的一个探测脚本，脚本删掉后就没人守着了。
 * 一旦它悄悄失效（例如路径上溯层级写错、分隔符用错），表现会是「pg8000 找不
 * 到」而不是报错，属于典型的静默退化。
 */

const FAKE_VENDOR = join('C:', 'fake', 'vendor', 'does-not-exist');

function main() {
  // ── 1. 携带目录存在时被注入 ─────────────────────────────────────
  {
    const existing = mkdtempSync(join(tmpdir(), 'ff-pp-'));
    try {
      const path = buildPythonPath(null, existing, null);
      assert.ok(path, '应返回非空 PYTHONPATH');
      assert.ok(path.split(delimiter).includes(existing), '携带目录应在结果中');
    } finally {
      rmSync(existing, { recursive: true, force: true });
    }
  }

  // ── 2. 携带目录不存在时优雅降级（不报错、不塞入无效路径）─────────
  {
    const path = buildPythonPath(null, FAKE_VENDOR, null);
    assert.equal(path, undefined, '目录不存在且无其它来源时应返回 undefined');
  }

  // ── 3. 额外目录优先于携带目录，且保留原有 PYTHONPATH ──────────────
  {
    const vendor = mkdtempSync(join(tmpdir(), 'ff-pp-v-'));
    const extra = mkdtempSync(join(tmpdir(), 'ff-pp-e-'));
    try {
      const path = buildPythonPath(extra, vendor, '/existing/one');
      assert.ok(path, '应返回非空');
      const parts = path.split(delimiter);
      assert.equal(parts[0], extra, '用户指定的额外目录应排在最先（优先导入）');
      assert.equal(parts[1], vendor, '携带目录次之');
      assert.equal(parts[2], '/existing/one', '原有 PYTHONPATH 应被保留而非覆盖');
    } finally {
      rmSync(vendor, { recursive: true, force: true });
      rmSync(extra, { recursive: true, force: true });
    }
  }

  // ── 4. 原有 PYTHONPATH 含多段时逐段保留 ─────────────────────────
  {
    const vendor = mkdtempSync(join(tmpdir(), 'ff-pp-m-'));
    try {
      const path = buildPythonPath(null, vendor, ['/a', '/b'].join(delimiter));
      assert.ok(path, '应返回非空');
      const parts = path.split(delimiter);
      assert.ok(parts.includes('/a') && parts.includes('/b'), '多段原有值应逐段保留');
    } finally {
      rmSync(vendor, { recursive: true, force: true });
    }
  }

  // ── 5. 全部为空时返回 undefined（而不是空字符串，后者会污染子进程环境）──
  {
    assert.equal(buildPythonPath(null, FAKE_VENDOR, null), undefined);
    assert.equal(buildPythonPath('', FAKE_VENDOR, ''), undefined);
  }

  // ── 6. 真实集成：用组装出的 PYTHONPATH 跑 python，确认真的能 import ────
  // 这是最关键的一条——前面几条只验证字符串拼装，这条验证「拼出来的东西真的管用」。
  {
    const realVendor = join(__dirname, '..', 'vendor', 'python');
    const path = buildPythonPath(null, realVendor, null);
    if (!path) {
      console.log('  跳过真实 import 检查：gateway/vendor/python 不存在');
    } else {
      const probe = spawnSync(
        'python',
        ['-c', 'import pg8000.native, sys; print("OK", pg8000.__version__)'],
        { encoding: 'utf8', windowsHide: true, env: { ...process.env, PYTHONPATH: path } },
      );
      if (probe.error || probe.status !== 0) {
        // 本机可能没有 python；有 python 但 import 失败才是真问题
        if (/ENOENT/.test(String(probe.error))) {
          console.log('  跳过真实 import 检查：本机无 python');
        } else {
          assert.fail(`用注入的 PYTHONPATH 应能 import pg8000，实际: ${String(probe.stderr || '').slice(0, 200)}`);
        }
      } else {
        assert.match(probe.stdout, /^OK /, '应打印版本号');
        // 确认确实来自携带目录，而不是用户环境里恰好装了
        const origin = spawnSync(
          'python',
          ['-c', 'import pg8000, sys; print(pg8000.__file__)'],
          { encoding: 'utf8', windowsHide: true, env: { ...process.env, PYTHONPATH: path } },
        );
        assert.ok(
          String(origin.stdout).replace(/\\/g, '/').includes('/vendor/python/'),
          `pg8000 应从携带目录加载，实际: ${String(origin.stdout).trim()}`,
        );
      }
    }
  }

  // ── 7. 注入的路径不会污染父进程环境 ─────────────────────────────
  {
    const before = process.env.PYTHONPATH;
    const vendor = mkdtempSync(join(tmpdir(), 'ff-pp-n-'));
    try {
      buildPythonPath(null, vendor, before ?? null);
    } finally {
      rmSync(vendor, { recursive: true, force: true });
    }
    assert.equal(process.env.PYTHONPATH, before, 'buildPythonPath 不应修改父进程环境');
  }

  // ── 8. 生产入口 buildPythonPathFromEnv：读环境 + 拼接带目录 ──────
  {
    const vendor = mkdtempSync(join(tmpdir(), 'ff-pp-env-'));
    const backup = { extra: process.env.PYTHON_EXTRA_MODULES_PATH, path: process.env.PYTHONPATH };
    try {
      process.env.PYTHON_EXTRA_MODULES_PATH = vendor;
      process.env.PYTHONPATH = '/ambient';
      const path = buildPythonPathFromEnv();
      assert.ok(path, '生产入口应返回非空');
      const parts = path.split(delimiter);
      assert.equal(parts[0], vendor, 'PYTHON_EXTRA_MODULES_PATH 应生效并优先');
      assert.ok(parts.includes('/ambient'), '原有 PYTHONPATH 应保留');

      delete process.env.PYTHON_EXTRA_MODULES_PATH;
      const onlyVendor = buildPythonPathFromEnv();
      assert.ok(
        String(onlyVendor).includes(join('gateway', 'vendor', 'python').replace(/\\/g, '\\'))
          || String(onlyVendor).includes('vendor'),
        `未设额外目录时仍应带上携带目录，实际: ${onlyVendor}`,
      );
    } finally {
      if (backup.extra === undefined) delete process.env.PYTHON_EXTRA_MODULES_PATH;
      else process.env.PYTHON_EXTRA_MODULES_PATH = backup.extra;
      if (backup.path === undefined) delete process.env.PYTHONPATH;
      else process.env.PYTHONPATH = backup.path;
      rmSync(vendor, { recursive: true, force: true });
    }
  }

  console.log('buildPythonPath tests passed: 注入 / 缺失降级 / 优先级 / 多段保留 / 空值 / 真实 import / 无副作用 / 生产入口');
}

main();
