import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { isPathInside } from '../src/common/path-safety';

/**
 * 目录穿越校验回归。
 *
 * 仓库里曾经（局部仍在）用 `candidate.startsWith(root)` 判断「文件是否在根目录内」。
 * 那是**前缀**比较：`/data/uploads-evil/secret.txt` 同样以 `/data/uploads` 开头，
 * 于是根目录的同级目录——只要名字带这个前缀——里的文件全都能通过校验。
 *
 * 目前这些路径都是服务端生成的相对路径，所以碰巧没被利用；但这是一道比设计意图
 * 弱的防线：`open()` 里还有 `isAbsolute(localPath) ? localPath : ...` 的分支，一旦
 * 库里出现绝对路径（迁移、手工修数据、将来的「导入已有文件」），就会立刻变成真实
 * 的目录穿越。
 *
 * 下面第 3 条同时断言「朴素前缀写法确实会放过它」，用来证明这条测试不是空跑。
 */

const ROOT = resolve(join(tmpdir(), 'ff-ps-root'));
const SIBLING = resolve(join(tmpdir(), 'ff-ps-root-evil'));

function main() {
  // ── 1. 正常情况：根目录内的文件与子目录 ──────────────────────────
  assert.equal(isPathInside(ROOT, join(ROOT, 'a.txt')), true, '根目录内的文件应在内');
  assert.equal(
    isPathInside(ROOT, join(ROOT, 'tenant', 'sub', 'a.txt')),
    true,
    '深层子目录应在内',
  );

  // ── 2. 根目录自身算在内 ──────────────────────────────────────────
  assert.equal(isPathInside(ROOT, ROOT), true, '根目录自身应算在内');

  // ── 3. 修复点：根目录的同级目录（名字带相同前缀）──────────────────
  // 先确认朴素写法确实会放过它——否则这条测试可能只是在验证一个不存在的风险。
  assert.ok(
    join(SIBLING, 'secret.txt').startsWith(ROOT),
    '前置：朴素前缀写法确实会把这个路径判为「在内」（本测试因此不是空跑）',
  );
  assert.equal(
    isPathInside(ROOT, join(SIBLING, 'secret.txt')),
    false,
    '同级目录（名字带根前缀）不应被判为在内',
  );

  // ── 4. 经典穿越 ──────────────────────────────────────────────────
  assert.equal(isPathInside(ROOT, join(ROOT, '..', 'secret.txt')), false, '.. 逃逸应被拒绝');
  assert.equal(
    isPathInside(ROOT, join(ROOT, '..', '..', 'etc', 'passwd')),
    false,
    '多级 .. 逃逸应被拒绝',
  );

  // ── 5. 完全无关的目录 ────────────────────────────────────────────
  assert.equal(isPathInside(ROOT, resolve(tmpdir())), false, '上级目录不应被判为在内');
  assert.equal(isPathInside(ROOT, join(tmpdir(), 'other')), false, '无关目录应被拒绝');

  // ── 6. 根目录带尾部分隔符时结论不变 ───────────────────────────────
  assert.equal(isPathInside(`${ROOT}/`, join(ROOT, 'a.txt')), true, '根带尾斜杠不影响判定');
  assert.equal(isPathInside(`${ROOT}/`, join(SIBLING, 'a.txt')), false, '根带尾斜杠时仍应拒绝同级目录');

  console.log(
    '路径安全测试通过: 根内文件 / 深层子目录 / 根自身 / 同级前缀目录拒绝（含朴素写法对照）/ '
    + '.. 逃逸拒绝 / 无关目录拒绝 / 尾部斜杠不影响',
  );
}

main();
