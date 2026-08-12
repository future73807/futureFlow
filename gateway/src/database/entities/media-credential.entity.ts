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

export const MEDIA_PROVIDERS = ['openai', 'google', 'doubao', 'minimax'] as const;
export type MediaProvider = (typeof MEDIA_PROVIDERS)[number];

/** A tenant-owned provider secret. The plaintext key never reaches this entity. */
@Entity('media_credentials')
@Index('IDX_media_credentials_user_provider', ['userId', 'provider'])
export class MediaCredential {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ type: 'varchar', length: 32 })
  provider: MediaProvider;

  @Column({ type: 'varchar', length: 80 })
  label: string;

  /** AES-256-GCM payload; excluded from ordinary repository selects. */
  @Column({ type: 'text', select: false })
  encryptedApiKey: string;

  @Column({ type: 'varchar', length: 24 })
  fingerprint: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
