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

  @CreateDateColumn()
  publishedAt: Date;
}
