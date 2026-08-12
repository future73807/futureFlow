import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { In, Repository } from 'typeorm';
import {
  MediaCredential,
  MediaProvider,
} from '../database/entities/media-credential.entity';
import { MediaJob } from '../database/entities/media-job.entity';
import { CreateMediaCredentialDto, UpdateMediaCredentialDto } from './dto/media.dto';
import { MediaCredentialCrypto } from './media-credential.crypto';

export interface DecryptedMediaCredential {
  id: string;
  provider: MediaProvider;
  apiKey: string;
}

@Injectable()
export class MediaCredentialService {
  constructor(
    @InjectRepository(MediaCredential)
    private readonly credentials: Repository<MediaCredential>,
    @InjectRepository(MediaJob)
    private readonly jobs: Repository<MediaJob>,
    private readonly crypto: MediaCredentialCrypto,
  ) {}

  async list(userId: string) {
    const rows = await this.credentials.find({
      where: { userId },
      order: { createdAt: 'DESC' },
    });
    return rows.map((row) => this.toPublic(row));
  }

  async create(userId: string, dto: CreateMediaCredentialDto) {
    const id = randomUUID();
    const encryptedApiKey = this.crypto.encrypt(dto.apiKey, {
      userId,
      provider: dto.provider,
      credentialId: id,
    });
    const row = this.credentials.create({
      id,
      userId,
      provider: dto.provider,
      label: dto.label,
      encryptedApiKey,
      fingerprint: this.crypto.fingerprint(dto.apiKey),
    });
    return this.toPublic(await this.credentials.save(row));
  }

  async update(userId: string, id: string, dto: UpdateMediaCredentialDto) {
    const row = await this.findOwnedWithSecret(userId, id);
    if (dto.label !== undefined) row.label = dto.label;
    if (dto.apiKey !== undefined) {
      row.encryptedApiKey = this.crypto.encrypt(dto.apiKey, {
        userId,
        provider: row.provider,
        credentialId: row.id,
      });
      row.fingerprint = this.crypto.fingerprint(dto.apiKey);
    }
    return this.toPublic(await this.credentials.save(row));
  }

  async remove(userId: string, id: string): Promise<void> {
    await this.credentials.manager.transaction(async (manager) => {
      const row = await manager
        .getRepository(MediaCredential)
        .createQueryBuilder('credential')
        .setLock('pessimistic_write')
        .where('credential.id = :id', { id })
        .andWhere('credential.userId = :userId', { userId })
        .getOne();
      if (!row) throw new NotFoundException('媒体凭据不存在');
      const active = await manager.getRepository(MediaJob).count({
        where: {
          userId,
          credentialId: id,
          status: In(['creating', 'queued', 'processing']),
        },
      });
      if (active > 0) throw new ConflictException('仍有媒体任务使用此凭据');
      await manager.getRepository(MediaCredential).delete({ id, userId });
    });
  }

  async decryptOwned(userId: string, id: string): Promise<DecryptedMediaCredential> {
    const row = await this.findOwnedWithSecret(userId, id);
    return {
      id: row.id,
      provider: row.provider,
      apiKey: this.crypto.decrypt(row.encryptedApiKey, {
        userId,
        provider: row.provider,
        credentialId: row.id,
      }),
    };
  }

  private async findOwnedWithSecret(userId: string, id: string): Promise<MediaCredential> {
    const row = await this.credentials
      .createQueryBuilder('credential')
      .addSelect('credential.encryptedApiKey')
      .where('credential.id = :id', { id })
      .andWhere('credential.userId = :userId', { userId })
      .getOne();
    if (!row) throw new NotFoundException('媒体凭据不存在');
    return row;
  }

  private toPublic(row: MediaCredential) {
    return {
      id: row.id,
      provider: row.provider,
      label: row.label,
      fingerprint: row.fingerprint,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
