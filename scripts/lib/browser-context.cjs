#!/usr/bin/env node
/**
 * 静态检查：`page.evaluate(...)` 的**回调函数体**里是否引用了 Node 侧符号。
 *
 * 为什么需要它：`page.evaluate(fn)` 的 `fn` 会被序列化后送到**浏览器**里执行，
 * 看不到 Node 作用域。把 `adminPassword()`、`process.env.X`、`readFileSync()` 这类
 * Node 侧符号写进回调，运行时会抛 `ReferenceError: xxx is not defined`。
 *
 * 这个坑真实发生过：P0-1 安全加固把硬编码密码字面量
 *   `password: 'futureFlow@'`            ← 字面量，序列化后照样是数据，没问题
 * 换成
 *   `password: adminPassword()`          ← Node 函数调用，浏览器里不存在
 * 看起来是等价替换，实际把「数据」变成了「Node 调用」—— 5 个 GUI 脚本因此全挂。
 * 因为它们都是孤儿（全仓库零引用、从没被执行），回归一直没暴露。
 *
 * ⚠️ 关键实现细节：必须只检查**第一个实参**（回调），跳过其后的实参 ——
 * `page.evaluate(fn, adminPassword())` 里那个 `adminPassword()` 是**在 Node 侧求值**
 * 的，完全合法。第一版没区分，把合法实参也报了（假阳性）。
 */
'use strict';

/** 括号配平，找到从 `(` 起的配对 `)`，返回 [内部文本, 结束下标]。 */
function extractParens(text, openIndex) {
  let depth = 0;
  let inString = null;
  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i];
    const prev = text[i - 1];
    if (inString) {
      if (ch === inString && prev !== '\\') inString = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      inString = ch;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return [text.slice(openIndex + 1, i), i];
    }
  }
  return [null, -1];
}

/**
 * 取「第一个顶层实参」的文本。
 * 顶层 = 相对 evaluate 的括号而言，圆/花/方括号深度都为 0。
 * 这样 `fn, arg` 只返回 `fn`，而 `{ a: [1, 2], b: 3 }` 内部的逗号不会被误切。
 */
function firstArgument(content) {
  let depth = 0;
  let inString = null;
  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i];
    const prev = content[i - 1];
    if (inString) {
      if (ch === inString && prev !== '\\') inString = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      inString = ch;
      continue;
    }
    if (ch === '(' || ch === '{' || ch === '[') depth += 1;
    else if (ch === ')' || ch === '}' || ch === ']') depth -= 1;
    else if (ch === ',' && depth === 0) return content.slice(0, i);
  }
  return content;
}

/** 只在浏览器上下文里不存在的符号。 */
const NODE_ONLY_SYMBOLS = [
  'adminPassword',
  'adminUsername',
  'adminEmail',
  'adminCredentials',
  'randomBytes',
  'readFileSync',
  'writeFileSync',
  'existsSync',
  'mkdirSync',
  // 浏览器里没有 process（打包器可能注入 process.env 垫片，但这里是脚本、
  // 不经过打包，所以出现即是误用）
  'process',
];

/**
 * 扫描一段源码，返回违规点。
 * @param {string} source
 * @returns {Array<{line: number, symbol: string}>}
 */
function findBrowserContextLeaks(source) {
  const offenders = [];
  let idx = 0;
  while ((idx = source.indexOf('page.evaluate(', idx)) !== -1) {
    const open = source.indexOf('(', idx + 'page.evaluate'.length);
    const [inner] = extractParens(source, open);
    if (inner !== null) {
      const callback = firstArgument(inner);
      // 形参里出现的同名标识符（如 `({ password }) => ...`）不算引用
      const paramList = (callback.match(/^\s*(?:async\s*)?\(([^)]*)\)\s*=>/) || [])[1] || '';
      const params = new Set(
        paramList
          .replace(/[{}\s]/g, ' ')
          .split(',')
          .map((s) => s.split(':').pop().trim())
          .filter(Boolean),
      );
      for (const symbol of NODE_ONLY_SYMBOLS) {
        if (params.has(symbol)) continue;
        if (new RegExp(`(?<![\\w.$])${symbol}\\b`).test(callback)) {
          offenders.push({ line: source.slice(0, idx).split('\n').length, symbol });
        }
      }
    }
    idx = open + 1;
  }
  return offenders;
}

module.exports = { findBrowserContextLeaks, NODE_ONLY_SYMBOLS };
