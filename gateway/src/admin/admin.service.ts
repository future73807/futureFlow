import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../database/entities/user.entity';
import { ApiKey } from '../database/entities/api-key.entity';
import { Workflow } from '../database/entities/workflow.entity';
import { WorkflowRun } from '../database/entities/workflow-run.entity';
import { BalanceLog } from '../database/entities/balance-log.entity';

@Injectable()
export class AdminService {
  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(ApiKey)
    private readonly apiKeyRepo: Repository<ApiKey>,
    @InjectRepository(Workflow)
    private readonly workflowRepo: Repository<Workflow>,
    @InjectRepository(WorkflowRun)
    private readonly runRepo: Repository<WorkflowRun>,
    @InjectRepository(BalanceLog)
    private readonly balanceLogRepo: Repository<BalanceLog>,
  ) {}

  /** 仪表盘统计 */
  async getStats() {
    const [userCount, apiKeyCount, workflowCount, runCount] = await Promise.all([
      this.userRepo.count(),
      this.apiKeyRepo.count({ where: { revoked: false } }),
      this.workflowRepo.count({ where: { status: 'active' } }),
      this.runRepo.count(),
    ]);

    // 最近 7 天每日运行数
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const recentRuns = await this.runRepo
      .createQueryBuilder('run')
      .select(`DATE(run.createdAt)`, 'date')
      .addSelect('COUNT(*)', 'count')
      .addSelect(`SUM(run.totalTokens)`, 'tokens')
      .where('run.createdAt >= :since', { since: sevenDaysAgo })
      .groupBy(`DATE(run.createdAt)`)
      .orderBy(`DATE(run.createdAt)`, 'ASC')
      .getRawMany<{ date: string; count: string; tokens: string }>();

    // 总 token 消耗与总费用
    const agg = await this.runRepo
      .createQueryBuilder('run')
      .select('COALESCE(SUM(run.totalTokens),0)', 'totalTokens')
      .addSelect('COALESCE(SUM(run.actualCost),0)', 'totalCost')
      .getRawOne<{ totalTokens: string; totalCost: string }>();

    return {
      userCount,
      apiKeyCount,
      workflowCount,
      runCount,
      totalTokens: parseInt(agg?.totalTokens || '0', 10),
      totalCost: parseFloat(agg?.totalCost || '0'),
      recentRuns: recentRuns.map((r) => ({
        date: r.date,
        count: parseInt(r.count, 10),
        tokens: parseInt(r.tokens || '0', 10),
      })),
    };
  }

  /** 用户列表（分页） */
  async listUsers(page = 1, pageSize = 20) {
    const [items, total] = await this.userRepo.findAndCount({
      order: { createdAt: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return {
      items: items.map((u) => this.sanitizeUser(u)),
      total,
      page,
      pageSize,
    };
  }

  /** 调整用户余额 */
  async adjustBalance(userId: string, delta: number, remark: string) {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('用户不存在');

    const newBalance = parseFloat(user.balance.toString()) + delta;
    if (newBalance < 0) {
      throw new Error('调整后余额不能为负');
    }

    user.balance = newBalance;
    await this.userRepo.save(user);

    // 记录流水
    const log = this.balanceLogRepo.create({
      userId,
      type: 'recharge',
      amount: delta,
      balanceAfter: newBalance,
      remark: remark || '管理员调整',
    });
    await this.balanceLogRepo.save(log);

    return { userId, balance: newBalance };
  }

  /** 修改用户 VIP 等级 */
  async updateVipLevel(userId: string, vipLevel: string) {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('用户不存在');
    user.vipLevel = vipLevel;
    await this.userRepo.save(user);
    return { userId, vipLevel };
  }

  /** 修改用户状态（封禁/解封） */
  async updateUserStatus(userId: string, status: string) {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('用户不存在');
    user.status = status;
    await this.userRepo.save(user);
    return { userId, status };
  }

  /** 删除用户 */
  async deleteUser(userId: string) {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('用户不存在');
    if (user.role === 'admin') {
      throw new Error('不能删除管理员账号');
    }
    await this.userRepo.remove(user);
    return { success: true };
  }

  /** 全部 API Key 列表 */
  async listApiKeys(page = 1, pageSize = 20) {
    const [items, total] = await this.apiKeyRepo.findAndCount({
      relations: ['user'],
      order: { createdAt: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return {
      items: items.map((k) => ({
        id: k.id,
        name: k.name,
        keyPrefix: k.keyPrefix,
        revoked: k.revoked,
        lastUsedAt: k.lastUsedAt,
        expiresAt: k.expiresAt,
        createdAt: k.createdAt,
        userId: k.userId,
        username: k.user?.username,
      })),
      total,
      page,
      pageSize,
    };
  }

  /** 管理员吊销 API Key */
  async revokeApiKey(id: string) {
    const key = await this.apiKeyRepo.findOne({ where: { id } });
    if (!key) throw new NotFoundException('API Key 不存在');
    key.revoked = true;
    await this.apiKeyRepo.save(key);
    return { success: true };
  }

  /** 全部工作流列表 */
  async listWorkflows(page = 1, pageSize = 20) {
    const [items, total] = await this.workflowRepo.findAndCount({
      relations: ['user'],
      order: { updatedAt: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return {
      items: items.map((w) => ({
        id: w.id,
        name: w.name,
        description: w.description,
        status: w.status,
        version: w.version,
        createdAt: w.createdAt,
        updatedAt: w.updatedAt,
        userId: w.userId,
        username: w.user?.username,
      })),
      total,
      page,
      pageSize,
    };
  }

  /** 工作流运行记录 */
  async listRuns(page = 1, pageSize = 20) {
    const [items, total] = await this.runRepo.findAndCount({
      relations: ['user'],
      order: { createdAt: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return {
      items: items.map((r) => ({
        id: r.id,
        status: r.status,
        totalTokens: r.totalTokens,
        totalSteps: r.totalSteps,
        estimatedCost: parseFloat(r.estimatedCost?.toString() || '0'),
        actualCost: parseFloat(r.actualCost?.toString() || '0'),
        elapsedTime: r.elapsedTime,
        errorMessage: r.errorMessage,
        createdAt: r.createdAt,
        userId: r.userId,
        username: r.user?.username,
      })),
      total,
      page,
      pageSize,
    };
  }

  /** 余额流水 */
  async listBalanceLogs(page = 1, pageSize = 50, userId?: string) {
    const where = userId ? { userId } : {};
    const [items, total] = await this.balanceLogRepo.findAndCount({
      relations: ['user'],
      where,
      order: { createdAt: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return {
      items: items.map((l) => ({
        id: l.id,
        type: l.type,
        amount: parseFloat(l.amount.toString()),
        balanceAfter: parseFloat(l.balanceAfter.toString()),
        remark: l.remark,
        workflowRunId: l.workflowRunId,
        createdAt: l.createdAt,
        userId: l.userId,
        username: l.user?.username,
      })),
      total,
      page,
      pageSize,
    };
  }

  private sanitizeUser(user: User) {
    return {
      id: user.id,
      username: user.username,
      email: user.email,
      vipLevel: user.vipLevel,
      role: user.role,
      status: user.status,
      balance: parseFloat(user.balance.toString()),
      frozenBalance: parseFloat(user.frozenBalance.toString()),
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }
}
