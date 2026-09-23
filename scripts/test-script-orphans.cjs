#!/usr/bin/env node
/**
 * 回归测试：`scripts/*.cjs` 不允许出现「无声的孤儿」。
 *
 * 背景：9d 那次「测试从未被执行」只扫了 `gateway/test/`，`scripts/` 从没扫过。
 * 补扫后发现 54 个脚本里 **14 个全仓库零引用** —— 其中 7 个是真正该跑却没接线的
 * 测试（见 9e），另外还藏着一处回归（P0-1 把字面量换成 `adminPassword()` 时，
 * 5 个 GUI 脚本的 `page.evaluate` 回调里引用了 Node 侧符号）。
 *
 * 孤儿本身不是错，**无声的孤儿**才是：没人知道它存在、坏了也没人发现。
 * 所以这个测试要求每个脚本都落到三类之一：
 *
 *   a) 被 `package.json` 的 scripts 引用
 *   b) 被其他脚本引用（含 `e2e-all.cjs` 的套件表）
 *   c) 在下面的 `INTENTIONAL` 白名单里 —— **每条必须写明理由**
 *
 * 并且**反向也检查**：白名单里的条目一旦变成被引用了，说明名单腐烂了，同样报错
 * （避免白名单变成「没人敢动」的垃圾堆）。
 *
 * 退出码：0 全部通过；1 有失败项。
 */
'use strict';

const assert = require('node:assert/strict');
const { readFileSync, readdirSync, existsSync } = require('node:fs');
const { join, resolve } = require('node:path');

const ROOT = resolve(__dirname, '..');
const SCRIPTS_DIR = join(ROOT, 'scripts');
const LIB_DIR = join(SCRIPTS_DIR, 'lib');

/**
 * 有意不接线的脚本。每条都必须说明**为什么**它是手动/一次性用途。
 * 新增条目时请连同理由一起写 —— 只写名字等于没说。
 */
const INTENTIONAL = new Map([
  // ── 测试夹具：需要人工在某个时刻手动启动/运行，不适合塞进自动化流水线 ──
  ['mcp-test-server.cjs', '测试夹具：验收用的最小 MCP 服务器（streamable HTTP，无 SSE），需手动起在固定端口'],
  ['acceptance-workflows.cjs', '测试夹具：通过 API 建三条覆盖全节点类型的工作流，供人工在画布上点击验收'],

  // ── 一次性开发工具：为某次具体排查/比对而写，不承担回归职责 ──
  ['crop-ref-image.cjs', '开发工具：从参考图裁剪循环卡片/循环体/配置面板三个区域，便于人工比对视觉细节'],
  ['shot-canvas.cjs', '开发工具：给画布拍截图，用于人工核对视觉，无断言'],
  ['shot-loop-node.cjs', '开发工具：给循环节点拍截图，用于人工核对视觉，无断言'],

  // ── 需要外部输入、无法自给自足的测试：只能手工跑 ──
  ['test-loop-body-drag.cjs', '需外部传入「含 loop_code 内节点的循环工作流 ID」，无法自建（断言基于该工作流的既有布局）'],
  ['test-loop-fixed-frame.cjs', '同上；且其边距断言（M={96,32,96,54}）是为特定布局调出的，换工作流会让断言失真'],

  // ── 待决策：同源分叉，去留需要人来定 ──
  ['e2e-test-with-retry.cjs', '⚠️ 待定：与 test:e2e（e2e-full-test.cjs）是同源分叉（35% 行重叠，多出 publishWorkflow / pageDataContractTests 两步），需决定合并还是删除'],
]);

/**
 * 本文件自身必须排除在「引用来源」之外。
 *
 * 否则白名单腐烂检查永远失效 —— 因为白名单里写着那些脚本名，
 * 于是 `isReferenced()` 总能在这个文件里找到它们，把每条都判成「已接线」。
 * （与 `test-docker-compose.cjs` 排除自身的做法一致。）
 */
const SELF = 'test-script-orphans.cjs';

/**
 * 去掉整行注释后再匹配。
 *
 * 必要：脚本的**说明注释**里经常会提到别的脚本名（解释「为什么改成这样」），
 * 那只是「提及」，不是「引用」。实测踩过两次：
 *   · 本文件的白名单本身就写着被保留的脚本名 → 每条都被判成「已接线」
 *   · test-docker-compose.cjs 的注释里提到 e2e-test-with-retry.cjs → 同款误判
 * 只剔除「整行就是注释」的行，不动行尾注释与字符串。
 */
function stripCommentLines(source) {
  return source
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'));
    })
    .join('\n');
}

/** 收集所有「可能引用脚本」的文本。 */
function referenceSources(scripts) {
  const sources = [];
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  sources.push({ name: 'package.json', text: Object.values(pkg.scripts).join('\n') });
  for (const name of scripts) {
    if (name === SELF) continue;
    sources.push({
      name: `scripts/${name}`,
      text: stripCommentLines(readFileSync(join(SCRIPTS_DIR, name), 'utf8')),
    });
  }
  if (existsSync(LIB_DIR)) {
    for (const name of readdirSync(LIB_DIR)) {
      sources.push({
        name: `scripts/lib/${name}`,
        text: stripCommentLines(readFileSync(join(LIB_DIR, name), 'utf8')),
      });
    }
  }
  // ⚠️ 只看**代码层**引用：package.json 的 scripts + 其他 .cjs 文件的**非注释**内容。
  // 不把 .md 文档算进来 —— 文档里「讨论」某个脚本不等于「接线」它。
  return sources;
}

let passed = 0;
let failed = 0;
function check(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`[PASS] ${label}`);
  } catch (error) {
    failed += 1;
    console.log(`[FAIL] ${label} :: ${error.message}`);
  }
}

const scripts = readdirSync(SCRIPTS_DIR).filter((f) => f.endsWith('.cjs')).sort();
const sources = referenceSources(scripts);

/** 某个脚本是否被「自身以外」的任意来源引用。 */
function isReferenced(name) {
  return sources.some((s) => s.name !== `scripts/${name}` && s.text.includes(name));
}

console.log(`扫描 ${scripts.length} 个 scripts/*.cjs，白名单 ${INTENTIONAL.size} 条\n`);

check('没有未登记的孤儿脚本', () => {
  const orphans = scripts.filter((name) => !isReferenced(name) && !INTENTIONAL.has(name));
  assert.deepEqual(
    orphans, [],
    '这些脚本全仓库零引用，也没登记为「有意保留」—— 孤儿本身不是错，'
      + '无声的孤儿才是（坏了没人发现）。请二选一：\n'
      + '  · 接进 e2e-all 或 package.json\n'
      + '  · 加进本文件顶部的 INTENTIONAL 并写明理由\n'
      + orphans.map((o) => `  - ${o}`).join('\n'),
  );
});

check('白名单没有腐烂（已接线的条目必须从名单移除）', () => {
  const stale = [...INTENTIONAL.keys()].filter((name) => isReferenced(name));
  assert.deepEqual(
    stale, [],
    '这些脚本已被引用，白名单条目已过期，请从 INTENTIONAL 移除：\n'
      + stale.map((s) => `  - ${s}`).join('\n'),
  );
});

check('白名单条目都真实存在', () => {
  const missing = [...INTENTIONAL.keys()].filter((name) => !scripts.includes(name));
  assert.deepEqual(
    missing, [],
    `白名单指向了不存在的脚本（改名/删除后忘了同步）：\n  ${missing.join('\n  ')}`,
  );
});

check('白名单每条都写了理由（不能只写名字）', () => {
  const thin = [...INTENTIONAL.entries()]
    .filter(([, reason]) => !reason || reason.trim().length < 10)
    .map(([name]) => name);
  assert.deepEqual(
    thin, [],
    `这些白名单条目没有说明理由 —— 只写名字等于没说，下次没人敢动它：\n  ${thin.join('\n  ')}`,
  );
});

check('白名单条目必须能被「实际找到」（防拼写错）', () => {
  // 单独校验一遍 isReferenced 的实现没把「自己引用自己」算进去
  const selfOnly = scripts.filter((name) => {
    const others = sources.filter((s) => s.name !== `scripts/${name}`);
    const inSelf = readFileSync(join(SCRIPTS_DIR, name), 'utf8').includes(name);
    const inOthers = others.some((s) => s.text.includes(name));
    return inSelf && !inOthers;
  });
  const wronglyReferenced = selfOnly.filter((name) => isReferenced(name));
  assert.deepEqual(
    wronglyReferenced, [],
    '这些脚本只在自己文件里提到过自己的名字，却被判为「已被引用」—— isReferenced 有 bug',
  );
});

console.log(`\n===== 脚本孤儿检查: ${passed}/${passed + failed} passed =====`);
process.exit(failed === 0 ? 0 : 1);
