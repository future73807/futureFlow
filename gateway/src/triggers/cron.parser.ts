/**
 * 最小化 5 字段 cron 解析器（分 时 日 月 周），网关本地时区。
 * 支持：星号、步进（star + slash n）、范围（a-b）、列表（a,b,c）。
 * 仅计算下一次触发时间；不允许秒/年字段与关键字（@daily 等）。
 */

export interface ParsedCron {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number> | null;
  months: Set<number>;
  daysOfWeek: Set<number> | null;
}

const RANGE = /^(\d+|\*)$|^(\d+)-(\d+)$/;

function parseField(
  field: string,
  min: number,
  max: number,
  aliases?: Record<string, number>,
): Set<number> {
  const values = new Set<number>();
  for (const part of field.split(',')) {
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`cron 步进无效: ${part}`);
    }
    const range = rangePart === '*' ? { start: min, end: max } : parseRange(rangePart, min, max, aliases);
    if (range.start > range.end) {
      throw new Error(`cron 范围无效: ${part}`);
    }
    // 标准 vixie 语义：`a/b` 从 a 开始步进到字段上限（不止于 a）。
    const end = stepPart === undefined ? range.end : max;
    for (let value = range.start; value <= end; value += step) {
      values.add(value);
    }
  }
  if (values.size === 0) {
    throw new Error(`cron 字段为空: ${field}`);
  }
  return values;
}

function parseRange(
  part: string,
  min: number,
  max: number,
  aliases?: Record<string, number>,
): { start: number; end: number } {
  const endpoints = part.split('-').map((endpoint) => {
    const resolved = aliases?.[endpoint.toLowerCase()] ?? endpoint;
    const value = Number(resolved);
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error(`cron 字段值无效: ${part}`);
    }
    return value;
  });
  if (endpoints.length === 1) {
    return { start: endpoints[0], end: endpoints[0] };
  }
  const [start, end] = endpoints;
  if (start > end) {
    throw new Error(`cron 范围无效: ${part}`);
  }
  return { start, end };
}

export function parseCron(expression: string): ParsedCron {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error('cron 表达式必须是 5 个字段（分 时 日 月 周）');
  }
  const monthNames: Record<string, number> = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  };
  const dayNames: Record<string, number> = {
    sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
  };
  return {
    minutes: parseField(fields[0], 0, 59),
    hours: parseField(fields[1], 0, 23),
    daysOfMonth: fields[2] === '*' ? null : parseField(fields[2], 1, 31),
    months: parseField(fields[3], 1, 12, monthNames),
    daysOfWeek: fields[4] === '*' ? null : parseField(fields[4], 0, 7, dayNames),
  };
}

/**
 * 计算 cron 的下一次触发时间（网关本地时区，秒归零）。
 * daysOfMonth 与 daysOfWeek 同时受限时遵循标准 cron 语义：任一匹配即触发（OR）。
 * 最多向前扫描 5 年，避免永不下匹配的表达式死循环。
 */
export function nextCronDate(cron: ParsedCron, from: Date): Date {
  const candidate = new Date(from.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);
  const limit = new Date(from.getTime() + 5 * 366 * 24 * 60 * 60_000);

  while (candidate <= limit) {
    if (!cron.months.has(candidate.getMonth() + 1)) {
      candidate.setMonth(candidate.getMonth() + 1, 1);
      candidate.setHours(0, 0, 0, 0);
      continue;
    }
    const dayMatches =
      (cron.daysOfMonth === null || cron.daysOfMonth.has(candidate.getDate()))
      && (cron.daysOfWeek === null || cron.daysOfWeek.has(candidate.getDay()));
    const domRestricted = cron.daysOfMonth !== null;
    const dowRestricted = cron.daysOfWeek !== null;
    const bothRestricted = domRestricted && dowRestricted;
    const dayOk = bothRestricted
      ? cron.daysOfMonth!.has(candidate.getDate()) || cron.daysOfWeek!.has(candidate.getDay())
      : dayMatches;
    if (!dayOk) {
      candidate.setDate(candidate.getDate() + 1);
      candidate.setHours(0, 0, 0, 0);
      continue;
    }
    if (!cron.hours.has(candidate.getHours())) {
      candidate.setHours(candidate.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!cron.minutes.has(candidate.getMinutes())) {
      candidate.setMinutes(candidate.getMinutes() + 1, 0, 0);
      continue;
    }
    return new Date(candidate.getTime());
  }
  throw new Error('cron 表达式在 5 年内没有下一次触发时间');
}

/** 校验表达式；有效则返回 null，无效返回中文错误消息。 */
export function validateCron(expression: string): string | null {
  try {
    parseCron(expression);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'cron 表达式无效';
  }
}
