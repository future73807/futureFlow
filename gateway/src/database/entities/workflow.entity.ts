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

/**
 * 工作流实体
 * 用户保存的画布工作流
 */
@Entity('workflows')
export class Workflow {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  @Index()
  userId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ type: 'varchar', length: 128 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  @Column({ type: 'jsonb' })
  flowgramJson: Record<string, any>;

  @Column({ type: 'varchar', default: 'active' })
  status: string; // active / archived / deleted

  @Column({ type: 'int', default: 1 })
  version: number;

  /** 已发布版本的不可变快照，草稿继续编辑不会影响线上调用。 */
  @Column({ type: 'jsonb', nullable: true })
  publishedFlowgramJson: Record<string, any> | null;

  @Column({ type: 'int', nullable: true })
  publishedVersion: number | null;

  @Column({ type: 'timestamp', nullable: true })
  publishedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
