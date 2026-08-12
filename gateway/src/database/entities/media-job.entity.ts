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
import { MediaCredential, MediaProvider } from './media-credential.entity';

export type MediaKind = 'image' | 'video';
export type MediaJobStatus =
  | 'creating'
  | 'queued'
  | 'processing'
  | 'succeeded'
  | 'failed';

@Entity('media_jobs')
@Index('IDX_media_jobs_user_created', ['userId', 'createdAt'])
@Index('IDX_media_jobs_user_idempotency', ['userId', 'idempotencyKey'], {
  unique: true,
})
export class MediaJob {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ type: 'uuid', nullable: true })
  credentialId: string | null;

  @ManyToOne(() => MediaCredential, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'credentialId' })
  credential: MediaCredential | null;

  @Column({ type: 'varchar', length: 32 })
  provider: MediaProvider;

  @Column({ type: 'varchar', length: 16 })
  kind: MediaKind;

  @Column({ type: 'varchar', length: 128 })
  idempotencyKey: string;

  /** Hash of the charge-affecting request. No prompt or secret is persisted. */
  @Column({ type: 'char', length: 64 })
  requestHash: string;

  @Column({ type: 'varchar', length: 160 })
  model: string;

  @Column({ type: 'uuid', nullable: true })
  @Index('IDX_media_jobs_execution_run')
  executionRunId: string | null;

  @Column({ type: 'uuid', nullable: true })
  executionWorkflowId: string | null;

  @Column({ type: 'int', nullable: true })
  executionWorkflowVersion: number | null;

  @Column({ type: 'varchar', length: 24, default: 'creating' })
  status: MediaJobStatus;

  @Column({ type: 'varchar', length: 512, nullable: true })
  providerTaskId: string | null;

  @Column({ type: 'uuid', nullable: true })
  assetId: string | null;

  /** A stable internal category only; provider response bodies are never stored. */
  @Column({ type: 'varchar', length: 80, nullable: true })
  errorCode: string | null;

  @Column({ type: 'timestamp', nullable: true })
  completedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
