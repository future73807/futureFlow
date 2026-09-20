/**
 * 把任意 catch 到的值转成一句可诊断的日志文本。
 *
 * 为什么需要统一实现：项目里原先散落着 4 套等价写法
 * （`safeError` / `errorMessage` / 两处内联三元），它们都只取
 * `error.message`。驱动层错误（如 TypeORM 的 QueryFailedError）可能带**空
 * message**，此时日志会打印成「定时触发扫描失败: 」这样没有任何线索的一句，
 * 排查时既不知道异常类型也拿不到堆栈。
 *
 * 本函数按 message → stack → name 逐级回退，非 Error 值则尝试 JSON 序列化。
 *
 * ⚠️ **仅用于日志**。回退结果可能包含 stack（含服务器本地路径与调用栈），
 * 绝不能放进 HTTP 响应体或任何返回给客户端/浏览器的文本。面向用户的文案请用
 * {@link describeErrorBrief}。
 */
export function describeError(error: unknown, fallback = '未知错误'): string {
  if (error instanceof Error) {
    return error.message || error.stack || error.name || fallback;
  }
  if (typeof error === 'string') {
    return error.trim() || fallback;
  }
  if (error === undefined || error === null) {
    return fallback;
  }
  try {
    const json = JSON.stringify(error);
    // `{}` / `[]` 这类空壳序列化对排查没有帮助，退回到统一文案。
    if (!json || json === '{}' || json === '[]') return fallback;
    return json;
  } catch {
    // 循环引用等无法序列化的情况。
    return String(error) || fallback;
  }
}

/**
 * 面向用户/调用方的安全文案：只取 message，**永不回退到 stack**。
 *
 * 与 {@link describeError} 的区别只有一点：空 message 时返回 fallback 而不是
 * 堆栈。HTTP 响应体、SSE 事件、抛出给调用方的异常消息都应该用这个版本。
 */
export function describeErrorBrief(error: unknown, fallback = '未知错误'): string {
  if (error instanceof Error) {
    return error.message || fallback;
  }
  if (typeof error === 'string') {
    return error.trim() || fallback;
  }
  return fallback;
}
