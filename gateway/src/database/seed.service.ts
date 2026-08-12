import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { User } from './entities/user.entity';

const LEGACY_DEMO_USERNAME = 'demo';
const LEGACY_DEMO_PASSWORD = 'demo123456';

/**
 * 数据库初始化种子服务
 * 本地一键启动默认创建首个管理员；部署方可显式关闭。
 */
@Injectable()
export class SeedService implements OnModuleInit {
  private readonly logger = new Logger(SeedService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit() {
    await this.disableUnsafeLegacyDemoAdmin();

    const enabled = this.config
      .get<string>('GATEWAY_BOOTSTRAP_ADMIN_ENABLED', 'true')
      .trim()
      .toLowerCase() === 'true';
    if (!enabled) {
      this.logger.log('管理员初始化未启用');
      return;
    }

    await this.createBootstrapAdmin();
  }

  /**
   * 升级旧数据库时，仅处置仍在使用历史公开密码的 demo 账号。
   * 暂停账号会让鉴权层在下一次请求时拒绝此前签发的 JWT。
   */
  private async disableUnsafeLegacyDemoAdmin() {
    const legacyUser = await this.userRepo.findOne({
      where: { username: LEGACY_DEMO_USERNAME },
    });
    if (!legacyUser?.passwordHash) return;

    let stillUsesPublicPassword = false;
    try {
      stillUsesPublicPassword = await bcrypt.compare(
        LEGACY_DEMO_PASSWORD,
        legacyUser.passwordHash,
      );
    } catch {
      this.logger.warn('旧 demo 账号的密码哈希无效，未自动修改账号');
      return;
    }
    if (!stillUsesPublicPassword) return;

    legacyUser.status = 'suspended';
    legacyUser.role = 'user';
    await this.userRepo.save(legacyUser);
    this.logger.warn(
      '检测到仍使用历史公开密码的 demo 管理员，账号已暂停并降权，现有 JWT 已失效',
    );
  }

  private async createBootstrapAdmin() {
    const username = this.config
      .get<string>('GATEWAY_BOOTSTRAP_ADMIN_USERNAME', '')
      .trim();
    const email = this.config
      .get<string>('GATEWAY_BOOTSTRAP_ADMIN_EMAIL', '')
      .trim()
      .toLowerCase();
    const password = this.config.get<string>('GATEWAY_BOOTSTRAP_ADMIN_PASSWORD', '');

    if (!username || !email || !password) {
      throw new Error(
        '启用管理员初始化时必须提供用户名、邮箱和密码',
      );
    }
    if (password.length < 8 || /change-me|replace-with/i.test(password)) {
      throw new Error('管理员初始化密码必须至少 8 个字符且不能使用示例密码');
    }

    const existingAdmin = await this.userRepo.findOne({
      where: { role: 'admin' },
    });
    if (existingAdmin) {
      this.logger.log('管理员账号已存在，跳过初始化');
      return;
    }

    const conflictingUser = await this.userRepo.findOne({
      where: [{ username }, { email }],
    });
    if (conflictingUser) {
      throw new Error('管理员初始化用户名或邮箱已被普通账号占用');
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const user = this.userRepo.create({
      username,
      email,
      passwordHash,
      vipLevel: 'pro',
      role: 'admin',
      balance: 100,
      frozenBalance: 0,
      status: 'active',
    });

    await this.userRepo.save(user);
    this.logger.log(`管理员账号已创建: username=${username}, role=admin`);
  }
}
