import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

/**
 * 宿主回调响应的 **schema 校验**（内嵌模式不信任宿主消息，服务端同样不信任宿主响应）。
 *
 * 为什么不用 `as` 断言：宿主可能是一个第三方应用，也可能是被改坏的自己的宿主。
 * 一句 `as HostIdentity` 之后，`subject` 为空串、`apiBase` 是 `file:///etc/passwd`
 * 这类值会一路流到建库 / 出网调用里，报错点离真因很远。这里统一在边界上校验，
 * 失败时给出**能直接照着改**的消息（哪个字段、期望什么、收到了什么）。
 */
export function parseHostPayload<T extends object>(
  cls: new () => T,
  raw: unknown,
  label: string,
): T {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      `宿主回调「${label}」的响应不是对象：${JSON.stringify(raw)?.slice(0, 200) ?? String(raw)}`,
    );
  }

  const instance = plainToInstance(cls, raw as Record<string, unknown>);
  const errors = validateSync(instance, {
    whitelist: true,
    forbidNonWhitelisted: false,
  });
  if (errors.length > 0) {
    const details = errors
      .flatMap((error) => Object.values(error.constraints ?? {}))
      .join('；');
    throw new Error(
      `宿主回调「${label}」的响应不符合 ff-embed 契约：${details || '字段校验失败'}`,
    );
  }
  return instance;
}
