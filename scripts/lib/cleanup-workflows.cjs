#!/usr/bin/env node
/**
 * 测试工作流清理工具（供各验收套件在 finally 里调用）。
 *
 * 为什么需要它：GUI 套件会通过画布或 API 建工作流，但此前大多不清理。实测库里
 * 堆积了约 109 个仍是 `active` 的测试工作流（`GUI 点击验收工作流` 58 个、
 * `本地扩展节点验收` 33 个，其余为 全流程验收-* / 验收B-* / 验收C-* 等），
 * 全部显示在用户的工作流列表里。`test-trigger-failure-display.cjs` 因为清理过
 * 头做得好，它的产物都是 `deleted`，反而是干净的——差异就在有没有这一步。
 *
 * 放在共享件而不是各脚本各写一遍：删除逻辑要处理分页形状差异、部分失败、
 * 以及「名字对不上时不要误删」，复制多份迟早会分叉。
 *
 * 用法：
 *   const { cleanupTestWorkflows } = require('./lib/cleanup-workflows.cjs');
 *   await cleanupTestWorkflows({ gateway, token, names: ['GUI 点击验收工作流'] });
 */
'use strict';

/** 从列表响应里取出工作流数组（兼容直接数组与 { data: [] } 两种形状）。 */
function extractList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

/**
 * 删除当前用户的测试工作流。
 *
 * 匹配方式刻意分成两个显式参数，而不是一个「模糊匹配」开关：
 * - `names`  —— **精确**匹配。默认手段，最安全。
 * - `prefixes` —— **前缀**匹配。只给「带时间戳生成的名字」用
 *   （如 `全流程验收-1789959700620`），这类无法用精确名匹配。
 *
 * 不提供 contains/正则：`contains` 一旦写错（比如填了「验收」）就会把用户真实
 * 工作流一起删掉，而清理测试产物这件事不值得冒这个风险。
 *
 * @returns {Promise<{matched:number, deleted:number, failed:string[]}>}
 */
async function cleanupTestWorkflows(options) {
  const { gateway, token, names, prefixes } = options || {};
  const wanted = new Set((names || []).filter(Boolean));
  const prefixList = (prefixes || []).filter(Boolean);
  const result = { matched: 0, deleted: 0, failed: [] };
  if (!gateway || !token) return result;
  if (wanted.size === 0 && prefixList.length === 0) return result;

  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  let list;
  try {
    const response = await fetch(`${gateway}/workflows`, { headers });
    if (!response.ok) return result;
    list = extractList(await response.json());
  } catch {
    // 清理失败不该让套件判定失败：它是收尾动作，不是验收项本身
    return result;
  }

  for (const item of list) {
    if (!item?.id) continue;
    const name = String(item.name || '');
    const hit = wanted.has(name) || prefixList.some((prefix) => name.startsWith(prefix));
    if (!hit) continue;
    result.matched += 1;
    try {
      const response = await fetch(`${gateway}/workflows/${item.id}`, { method: 'DELETE', headers });
      if (response.ok) result.deleted += 1;
      else result.failed.push(`${item.name}(${item.id}) -> HTTP ${response.status}`);
    } catch (error) {
      result.failed.push(`${item.name}(${item.id}) -> ${error?.message || error}`);
    }
  }
  return result;
}

/** 打印一行清理结果，便于在套件输出里确认清理确实发生了。 */
function reportCleanup(result, label) {
  if (!result) return;
  const suffix = result.failed.length ? `，${result.failed.length} 个失败：${result.failed.join('; ')}` : '';
  console.log(`已清理 ${label}：匹配 ${result.matched} 个，删除 ${result.deleted} 个${suffix}`);
}

module.exports = { cleanupTestWorkflows, reportCleanup };
