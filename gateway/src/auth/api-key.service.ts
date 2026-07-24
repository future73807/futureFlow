import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createHash, randomBytes } from 'crypto';
import { ApiKey } from '../database/entities/api-key.entity';
import { User } from '../database/entities/user.entity';

@Injectable()
export class ApiKeyService {
  constructor(
    @InjectRepository(ApiKey)
    private readonly apiKeyRepo: Repository<ApiKey>,
  ) {}

  async listByUser(userId: string): Promise<ApiKey[]> {
    return this.apiKeyRepo.find({
      where: { userId, revoked: false },
      order: { createdAt: 'DESC' },
    });
  }

  async create(userId: string, name: string): Promise<{ apiKey: ApiKey; plaintext: string }> {
    const normalizedName = name.trim() || 'default';
    if (normalizedName.length > 64) {
      throw new BadRequestException('API Key 名称不能超过 64 个字符');
    }

    // 生成 API Key: ff-<32 hex chars>
    const raw = randomBytes(16).toString('hex');
    const plaintext = `ff-${raw}`;
    const keyPrefix = plaintext.slice(0, 11);
    const keyHash = createHash('sha256').update(plaintext).digest('hex');

    const apiKey = this.apiKeyRepo.create({
      userId,
      name: normalizedName,
      keyPrefix,
      keyHash,
    });
    await this.apiKeyRepo.save(apiKey);
    return { apiKey, plaintext };
  }

  async revoke(id: string, userId: string): Promise<void> {
    const key = await this.apiKeyRepo.findOne({ where: { id, userId } });
    if (!key) throw new NotFoundException('API Key 不存在');
    key.revoked = true;
    await this.apiKeyRepo.save(key);
  }

  /** 通过哈希查找有效的 API Key（供鉴权中间件使用） */
  async findByHash(hash: string): Promise<ApiKey | null> {
    return this.apiKeyRepo.findOne({
      where: { keyHash: hash, revoked: false },
      relations: ['user'],
    });
  }

  /** 校验明文 API Key，并更新最后使用时间。 */
  async authenticate(plaintext: string): Promise<User | null> {
    if (!plaintext.startsWith('ff-')) return null;

    const hash = createHash('sha256').update(plaintext).digest('hex');
    const apiKey = await this.findByHash(hash);
    if (!apiKey?.user || apiKey.user.status !== 'active') return null;
    if (apiKey.expiresAt && apiKey.expiresAt.getTime() <= Date.now()) return null;

    await this.apiKeyRepo.update(apiKey.id, { lastUsedAt: new Date() });
    return apiKey.user;
  }
}
