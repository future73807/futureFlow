import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/**
 * 用户实体
 * 存储用户基本信息、VIP 等级和余额
 */
@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  @Index()
  username: string;

  @Column({ unique: true, nullable: true })
  @Index()
  email: string; // 用户邮箱（注册用户必填，API Key 用户可空）

  @Column({ nullable: true })
  passwordHash: string; // bcrypt 密码哈希（注册用户必填，API Key 用户可空）

  @Column({ nullable: true })
  apiKey: string; // 用户调用网关的 API Key（向后兼容）

  @Column({ type: 'varchar', default: 'free' })
  vipLevel: string; // free / pro / enterprise

  @Column({ type: 'varchar', default: 'user' })
  role: string; // user / admin

  @Column({ type: 'varchar', default: 'active' })
  status: string; // active / banned / suspended

  @Column({ type: 'decimal', precision: 12, scale: 4, default: 0 })
  balance: number; // 余额(元)

  @Column({ type: 'decimal', precision: 12, scale: 4, default: 0 })
  frozenBalance: number; // 冻结余额(执行中预扣)

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
