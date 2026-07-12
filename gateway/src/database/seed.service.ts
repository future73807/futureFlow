import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
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

    const passwordHash = await bcrypt.hash('demo123456', 10);

    const user = this.userRepo.create({
      username: 'demo',
      email: 'demo@futureflow.ai',
      passwordHash,
      apiKey: 'demo-api-key-001',
      vipLevel: 'pro',
      balance: 100,
      frozenBalance: 0,
      status: 'active',
    });

    await this.userRepo.save(user);
    this.logger.log(
      '默认用户已创建: username=demo, password=demo123456, apiKey=demo-api-key-001, balance=100, vip=pro',
    );
  }
}
