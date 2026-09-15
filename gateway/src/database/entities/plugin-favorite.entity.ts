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
 * 插件收藏。
 * pluginId 存插件目录的 slug（如 llm、http），不是 uuid；
 * (userId, pluginId) 唯一，防止重复点击/并发请求产生多条收藏记录。
 */
@Entity('plugin_favorites')
@Index('IDX_plugin_favorites_user', ['userId'])
@Index('IDX_plugin_favorites_plugin', ['pluginId'])
@Index('UQ_plugin_favorites_user_plugin', ['userId', 'pluginId'], { unique: true })
export class PluginFavorite {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ type: 'varchar', length: 64 })
  pluginId: string;

  @CreateDateColumn()
  createdAt: Date;
}
