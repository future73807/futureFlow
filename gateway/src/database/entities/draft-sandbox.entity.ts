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

/** 每用户一个的「草稿云端试运行」沙箱 Dify 应用绑定。 */
@Entity('draft_sandboxes')
@Index('IDX_draft_sandboxes_user', ['userId'], { unique: true })
export class DraftSandbox {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', unique: true })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ type: 'varchar', length: 64 })
  appId: string;

  /** 最近一次导入的 Dify DSL YAML 摘要；一致时跳过重新导入/发布。 */
  @Column({ type: 'char', length: 64 })
  dslHash: string;

  /** 沙箱应用 Service API Key，AES-256-GCM 加密落库，永不回显。 */
  @Column({ type: 'text', select: false })
  encryptedApiKey: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
