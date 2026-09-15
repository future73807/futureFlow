import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Immutable publish record. Draft edits are deliberately not written here;
 * every row is a recoverable definition that was actually released.
 */
@Entity('workflow_versions')
@Index('UQ_workflow_versions_workflow_version', ['workflowId', 'version'], {
  unique: true,
})
@Index('IDX_workflow_versions_workflow_published_at', ['workflowId', 'publishedAt'])
export class WorkflowVersion {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  @Index()
  workflowId: string;

  /** Kept for efficient ownership checks without exposing another user's history. */
  @Column({ type: 'uuid' })
  @Index()
  userId: string;

  /** The workflow draft revision that was released. */
  @Column({ type: 'int' })
  version: number;

  @Column({ type: 'varchar', length: 128 })
  name: string;

  @Column({ type: 'text', default: '' })
  description: string;

  @Column({ type: 'jsonb' })
  flowgramJson: Record<string, any>;

  /** 用户为该次存档填写的说明；发布产生的版本由服务端写入「发布 v{label}」。 */
  @Column({ type: 'text', default: '' })
  comment: string;

  /**
   * 版本来源：publish（发布）/ manual（另存为版本）/ restore（回退）。
   * 历史行必须继续可读，所以这里用带默认值的非空列而不是 nullable。
   */
  @Column({ type: 'varchar', length: 16, default: 'publish' })
  source: string;

  @CreateDateColumn()
  publishedAt: Date;
}

/**
 * 版本号是内部单调递增整数，直接展示会出现「v10」这类与小数混淆的读法。
 * 统一换算成「轮次.序号」：1→1.0、10→1.9、11→2.0，保证永不出现 1.10。
 */
export function formatVersionLabel(version: number): string {
  const normalized = Math.max(1, Math.floor(version));
  return `${Math.floor((normalized - 1) / 10) + 1}.${(normalized - 1) % 10}`;
}
