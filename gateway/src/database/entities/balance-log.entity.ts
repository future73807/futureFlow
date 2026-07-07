import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { User } from './user.entity';

/**
 * 余额变动流水
 * 记录每一笔扣费/充值/冻结/解冻
 */
@Entity('balance_logs')
export class BalanceLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  @Index()
  userId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ type: 'varchar' })
  type: string; // freeze(冻结) / deduct(扣费) / unfreeze(解冻) / refund(退款) / recharge(充值)

  @Column({ type: 'decimal', precision: 12, scale: 4 })
  amount: number; // 变动金额(正数为入账,负数为出账)

  @Column({ type: 'decimal', precision: 12, scale: 4 })
  balanceAfter: number; // 变动后余额

  @Column({ type: 'varchar', nullable: true })
  workflowRunId: string; // 关联的工作流运行 ID

  @Column({ type: 'text', nullable: true })
  remark: string; // 备注(如:LLM 节点消耗 1234 tokens)

  @CreateDateColumn()
  createdAt: Date;
}
