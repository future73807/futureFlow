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
export class WorkflowRun {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  @Index()
  userId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ type: 'varchar', default: 'pending' })
  status: string; // pending / running / succeeded / failed

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
