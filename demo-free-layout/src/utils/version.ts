/**
 * 版本号展示规则：内部自增序号 → major.minor（1.0 → 1.1 → … → 1.9 → 2.0 → 2.1）。
 * 网关的 workflow_versions 用同一公式产出 label 字段，这里只服务于拿不到 label
 * 的展示点（例如工作流列表的「已发布」标记、发布成功的 toast）。
 * 改公式时两边必须同步。
 */
export const formatVersionLabel = (version?: number | null): string | null => {
  const value = Number(version);
  if (!Number.isFinite(value) || value < 1) return null;
  return `${Math.floor((value - 1) / 10) + 1}.${(value - 1) % 10}`;
};
