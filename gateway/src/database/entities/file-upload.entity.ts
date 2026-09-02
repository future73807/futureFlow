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

@Entity('file_uploads')
@Index('IDX_file_uploads_user_created', ['userId', 'createdAt'])
export class FileUpload {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  /** 用户上传时的原始文件名，仅作展示。 */
  @Column({ type: 'varchar', length: 255 })
  originalName: string;

  @Column({ type: 'varchar', length: 120 })
  mimeType: string;

  @Column({ type: 'bigint' })
  sizeBytes: string;

  @Column({ type: 'char', length: 64 })
  sha256: string;

  /** 服务端生成的存储相对路径，绝不回显给客户端。 */
  @Column({ type: 'text', select: false })
  localPath: string;

  @CreateDateColumn()
  createdAt: Date;
}
