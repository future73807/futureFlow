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

@Entity('mcp_servers')
@Index('IDX_mcp_servers_user_created', ['userId', 'createdAt'])
export class McpServer {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ type: 'varchar', length: 80 })
  name: string;

  /** MCP streamable HTTP 端点（以 /mpt 或 /mcp 结尾的 HTTP(S) URL）。 */
  @Column({ type: 'varchar', length: 500 })
  url: string;

  /** 可选的 Bearer 令牌，AES-256-GCM 加密落库，永不回显。 */
  @Column({ type: 'text', select: false, nullable: true })
  encryptedToken: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
