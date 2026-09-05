/**
 * 5 字段 cron 解析器专项冒烟测试。
 *
 * 覆盖：基础解析、步进/范围/列表、月与星期英文别名、next 计算
 * （含 日/周 OR 语义）、以及各类非法表达式的拒绝。
 */
import 'reflect-metadata';

import assert from 'node:assert/strict';

import { nextCronDate, parseCron, validateCron } from '../src/triggers/cron.parser';

function main() {
  // 1. 基础解析与 next 计算：每天 09:30 等价于 "30 9 * * *"。
  const daily = parseCron('30 9 * * *');
  const from = new Date(2026, 8, 5, 10, 0, 0);
  const next = nextCronDate(daily, from);
  assert.equal(next.getHours(), 9);
  assert.equal(next.getMinutes(), 30);
  assert.equal(next.getDate(), 6, '10:00 已过 09:30，下一次应为次日');

  // 2. 工作日 9 点（周一至周五）。
  const weekdays = parseCron('0 9 * * mon-fri');
  const friday = new Date(2026, 8, 4, 12, 0); // 2026-09-04 是周五
  const nextWorkday = nextCronDate(weekdays, friday);
  assert.equal(nextWorkday.getDay(), 1, '周五之后应跳到周一');
  assert.equal(nextWorkday.getDate(), 7);

  // 3. 步进：每 15 分钟。
  const step = parseCron('0/15 * * * *');
  const stepNext = nextCronDate(step, new Date(2026, 8, 5, 10, 7));
  assert.equal(stepNext.getMinutes(), 15, '10:07 之后的下一个 15 分钟刻度');

  // 4. 列表 + 范围：每月 1 号和 15 号的 0 点。
  const list = parseCron('0 0 1,15 * *');
  const listNext = nextCronDate(list, new Date(2026, 8, 5, 0, 30));
  assert.equal(listNext.getMonth() + 1, 9);
  assert.equal(listNext.getDate(), 15);

  // 5. 日与周同时受限时遵循 OR 语义。
  const both = parseCron('0 0 1 * mon');
  const bothNext = nextCronDate(both, new Date(2026, 8, 6, 12, 0)); // 9/6 周日
  assert.equal(bothNext.getDay(), 1, '应命中下一个周一');
  assert.equal(bothNext.getDate(), 7);

  // 6. 拒绝路径。
  assert.equal(validateCron('30 9 * *'), 'cron 表达式必须是 5 个字段（分 时 日 月 周）');
  assert.match(validateCron('60 9 * * *')!, /字段值无效/);
  assert.match(validateCron('30 9 * * sundayx')!, /无效/);
  assert.match(validateCron('a b c d e')!, /无效/);
  assert.match(validateCron('30 9 40 * *')!, /字段值无效/);

  // 7. 秒级粒度不可用（分钟刻度已足够触发器场景）。
  const withinMinute = nextCronDate(parseCron('30 9 * * *'), new Date(2026, 8, 5, 9, 30, 30));
  assert.equal(withinMinute.getDate(), 6, '同一分钟内已过，下一次应排次日');

  console.log('cron parser smoke passed');
}

main();
