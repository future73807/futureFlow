import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { User } from './user.entity';

/**
 * 工作流运行记录
 * 跟踪每次工作流执行的状态、token 用量和费用
 */
@Entity('workflow_runs')
@Index('IDX_workflow_runs_user_status', ['userId', 'status'])
@Index('IDX_workflow_runs_user_created_at', ['userId', 'createdAt'])
@Index('IDX_workflow_runs_user_idempotency_key', ['userId', 'idempotencyKey'], {
  unique: true,
  where: '"idempotencyKey" IS NOT NULL',
})
export class WorkflowRun {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  @Index()
  userId: string;

  /** 由已发布工作流 API 发起时关联工作流；画布临时试运行可为空。 */
  @Column({ type: 'uuid', nullable: true })
  @Index()
  workflowId: string | null;

  /** api / webhook / schedule / manual-canvas */
  @Column({ type: 'varchar', default: 'manual' })
  source: string;

  @Column({ type: 'uuid', nullable: true })
  @Index()
  triggerId: string | null;

  /** A retried public request can never create a second billable run. */
  @Column({ type: 'varchar', length: 128, nullable: true })
  idempotencyKey: string | null;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ type: 'varchar', default: 'pending' })
  status: string; // pending / running / succeeded / failed / cancelled

  @Column({ type: 'jsonb', nullable: true })
  flowgramJson: Record<string, any>; // 原始 FlowGram JSON

  @Column({ type: 'text', nullable: true })
  difyWorkflowId: string; // Dify 返回的工作流执行 ID

  @Column({ type: 'text', nullable: true })
  difyTaskId: string; // Dify 返回的任务 ID

  @Column({ type: 'int', default: 0 })
  totalTokens: number; // 总 token 消耗

  @Column({ type: 'int', default: 0 })
  totalSteps: number; // 执行步数

  @Column({ type: 'decimal', precision: 12, scale: 4, default: 0 })
  estimatedCost: number; // 预估费用

  @Column({ type: 'decimal', precision: 12, scale: 4, default: 0 })
  actualCost: number; // 实际扣费

  @Column({ type: 'float', default: 0 })
  elapsedTime: number; // 执行耗时(秒)

  @Column({ type: 'text', nullable: true })
  errorMessage: string;

  @CreateDateColumn()
  createdAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  finishedAt: Date;
}
