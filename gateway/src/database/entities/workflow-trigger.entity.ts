import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { User } from './user.entity';

/** A workflow can be invoked through an isolated webhook or fixed cadence. */
@Entity('workflow_triggers')
@Index('IDX_workflow_triggers_due', ['type', 'status', 'nextRunAt'])
export class WorkflowTrigger {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  @Index()
  userId: string;

  @Column({ type: 'uuid' })
  @Index()
  workflowId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ type: 'varchar', length: 96 })
  name: string;

  @Column({ type: 'varchar', length: 16 })
  type: 'webhook' | 'schedule';

  @Column({ type: 'varchar', default: 'active' })
  status: 'active' | 'paused';

  /** SHA-256 of the bearer-like webhook token; plaintext is returned once. */
  @Column({ type: 'varchar', nullable: true, unique: true })
  webhookSecretHash: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  webhookSecretPrefix: string | null;

  /** Fixed cadence is intentionally explicit in v1; no hidden in-memory cron. */
  @Column({ type: 'int', nullable: true })
  intervalMinutes: number | null;

  /** interval = 固定分钟间隔；daily = 每天在 dailyTime（网关本地时区）执行一次。 */
  @Column({ type: 'varchar', length: 16, default: 'interval' })
  scheduleType: 'interval' | 'daily';

  /** HH:MM（00:00-23:59），仅 scheduleType=daily 时使用。 */
  @Column({ type: 'varchar', length: 5, nullable: true })
  dailyTime: string | null;

  @Column({ type: 'jsonb', nullable: true })
  staticInputs: Record<string, string | number | boolean> | null;

  @Column({ type: 'timestamp', nullable: true })
  @Index()
  nextRunAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  lastTriggeredAt: Date | null;

  @Column({ type: 'varchar', nullable: true })
  lastRunStatus: string | null;

  @Column({ type: 'int', default: 0 })
  failureCount: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
