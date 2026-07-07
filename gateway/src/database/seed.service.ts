import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './entities/user.entity';

/**
 * 数据库初始化种子服务
 * 应用启动时自动创建默认测试用户(如不存在)
 */
@Injectable()
export class SeedService implements OnModuleInit {
  private readonly logger = new Logger(SeedService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  async onModuleInit() {
    await this.createDefaultUser();
  }

  private async createDefaultUser() {
    const existing = await this.userRepo.findOne({
      where: { username: 'demo' },
    });

    if (existing) {
      this.logger.log('默认用户已存在,跳过创建');
      return;
    }

    const user = this.userRepo.create({
      username: 'demo',
      apiKey: 'demo-api-key-001',
      vipLevel: 'pro',
      balance: 100, // 初始余额 100 元
      frozenBalance: 0,
    });

    await this.userRepo.save(user);
    this.logger.log(
      '默认用户已创建: username=demo, apiKey=demo-api-key-001, balance=100, vip=pro',
    );
  }
}
