import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from './user.entity';

/** 单行输入：批量任务的一行数据对应一次工作流运行。 */
export type BatchTaskInputRow = Record<string, string | number | boolean>;

/** 单行执行结果；outputText 截断存储，避免大批量任务把 jsonb 撑爆。 */
export interface BatchTaskRowResult {
  index: number;
  status: 'succeeded' | 'failed';
  error?: string;
  outputText?: string;
  tokens?: number;
}

/**
 * 批量任务：把同一工作流的多行输入依次执行（同一任务内不并发）。
 * 列表接口只读概要字段，体积较大的 inputs/results 仅由详情接口返回。
 */
@Entity('batch_tasks')
@Index('IDX_batch_tasks_user_created_at', ['userId', 'createdAt'])
@Index('IDX_batch_tasks_user_status', ['userId', 'status'])
export class BatchTask {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  @Index('IDX_batch_tasks_user')
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ type: 'uuid', nullable: true })
  workflowId: string | null;

  /** 创建时快照工作流名称：工作流被删除后历史任务列表仍可渲染。 */
  @Column({ type: 'varchar', length: 128 })
  workflowName: string;

  @Column({ type: 'varchar', length: 128 })
  name: string;

  /** published（已发布快照） / draft（草稿沙箱试运行）。 */
  @Column({ type: 'varchar', length: 20, default: 'published' })
  mode: string;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status: string; // pending / running / succeeded / failed / cancelled

  @Column({ type: 'int', default: 0 })
  totalCount: number;

  @Column({ type: 'int', default: 0 })
  succeededCount: number;

  @Column({ type: 'int', default: 0 })
  failedCount: number;

  @Column({ type: 'jsonb' })
  inputs: BatchTaskInputRow[];

  @Column({ type: 'jsonb', nullable: true })
  results: BatchTaskRowResult[] | null;

  /** 仅记录任务级致命错误；行级错误在各行 result.error 中。 */
  @Column({ type: 'text', nullable: true })
  error: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  finishedAt: Date | null;
}
