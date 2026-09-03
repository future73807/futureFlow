import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from './user.entity';

/**
 * 知识库归属映射：Dify dataset 由受控账号统一持有，平台侧用本表
 * 记录「哪个平台用户创建了它」，实现列表过滤与删除权限校验。
 */
@Entity('knowledge_dataset_owners')
@Index('IDX_knowledge_dataset_owners_user', ['userId'])
export class KnowledgeDatasetOwner {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 64, unique: true })
  datasetId: string;

  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @CreateDateColumn()
  createdAt: Date;
}
