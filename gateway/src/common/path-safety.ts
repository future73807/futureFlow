import { isAbsolute, relative, resolve } from 'node:path';

/**
 * 判断一个路径是否确实位于根目录之内（纯函数）。
 *
 * 为什么不能直接 `candidate.startsWith(root)`：那是**前缀**比较，
 * `/data/uploads-evil/secret.txt` 同样以 `/data/uploads` 开头，于是根目录的同级
 * 目录（只要名字带这个前缀）里的文件全都能通过校验。仓库里就存在这种写法，
 * 目前因为路径都是服务端生成的相对路径而碰巧没被利用，但它是一道比设计意图弱
 * 的防线——只要哪天出现「导入已有文件」「迁移数据写入绝对路径」这类入口，就会
 * 立刻变成真实的目录穿越。
 *
 * 正确做法是先取相对路径再判 `..`：根目录自身算在内（返回 true）。
 */
export function isPathInside(root: string, candidate: string): boolean {
  const rootResolved = resolve(root);
  const candidateResolved = resolve(candidate);
  if (candidateResolved === rootResolved) return true;
  const rel = relative(rootResolved, candidateResolved);
  return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel);
}
