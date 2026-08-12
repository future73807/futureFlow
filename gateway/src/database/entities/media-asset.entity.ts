import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from './user.entity';
import { MediaJob } from './media-job.entity';

@Entity('media_assets')
@Index('IDX_media_assets_user_created', ['userId', 'createdAt'])
export class MediaAsset {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ type: 'uuid', unique: true })
  jobId: string;

  @OneToOne(() => MediaJob, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'jobId' })
  job: MediaJob;

  @Column({ type: 'varchar', length: 80 })
  mimeType: string;

  @Column({ type: 'bigint' })
  sizeBytes: string;

  @Column({ type: 'char', length: 64 })
  sha256: string;

  @Column({ type: 'varchar', length: 180 })
  fileName: string;

  /** Server-generated path only. Responses are mapped and never expose it. */
  @Column({ type: 'text', select: false })
  localPath: string;

  @CreateDateColumn()
  createdAt: Date;
}
