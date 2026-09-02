import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { Repository } from 'typeorm';
import { FileUpload } from '../database/entities/file-upload.entity';

/** 允许上传的扩展名白名单：文档、表格、配置与常见图片。 */
const ALLOWED_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'pdf', 'csv', 'tsv', 'json', 'yaml', 'yml', 'html', 'xml',
  'docx', 'xlsx', 'pptx',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg',
]);

const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** 单用户文件数量上限，超过后需先删除。 */
const MAX_FILES_PER_USER = 200;

export interface StoredFile {
  id: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: Date;
}

@Injectable()
export class FileStorageService {
  private readonly root: string;

  constructor(
    @InjectRepository(FileUpload)
    private readonly repo: Repository<FileUpload>,
    config: ConfigService,
  ) {
    this.root = resolve(configuredRoot(config) || join(process.cwd(), '.futureflow-files'));
  }

  async store(userId: string, originalName: string, declaredType: string, buffer: Buffer): Promise<StoredFile> {
    if (buffer.byteLength === 0) {
      throw new UnsupportedMediaTypeException('不能上传空文件');
    }
    if (buffer.byteLength > MAX_FILE_BYTES) {
      throw new PayloadTooLargeException('单个文件不能超过 10 MB');
    }
    const extension = this.safeExtension(originalName);
    if (!extension || !ALLOWED_EXTENSIONS.has(extension)) {
      throw new UnsupportedMediaTypeException(
        `不支持的文件类型 .${extension || '（无扩展名）'}；允许：${[...ALLOWED_EXTENSIONS].join(', ')}`,
      );
    }
    const count = await this.repo.count({ where: { userId } });
    if (count >= MAX_FILES_PER_USER) {
      throw new ForbiddenException(`每个用户最多保存 ${MAX_FILES_PER_USER} 个文件，请先删除不需要的文件`);
    }

    const tenantDir = join(this.root, userId);
    await mkdir(tenantDir, { recursive: true, mode: 0o700 });
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const fileName = `${randomUUID()}.${extension}`;
    const absolutePath = join(tenantDir, fileName);
    await writeFile(absolutePath, buffer, { mode: 0o600 });

    const record = await this.repo.save(this.repo.create({
      userId,
      originalName: originalName.slice(0, 255),
      mimeType: declaredType.slice(0, 120) || 'application/octet-stream',
      sizeBytes: String(buffer.byteLength),
      sha256,
      localPath: relative(this.root, absolutePath),
    }));
    return this.toStored(record);
  }

  async list(userId: string): Promise<StoredFile[]> {
    const rows = await this.repo.find({
      where: { userId },
      order: { createdAt: 'DESC' },
      take: MAX_FILES_PER_USER,
    });
    return rows.map((row) => this.toStored(row));
  }

  async open(userId: string, fileId: string, requireAdmin = false) {
    const record = await this.repo.findOne({
      where: { id: fileId },
      select: ['id', 'userId', 'originalName', 'mimeType', 'sizeBytes', 'localPath', 'createdAt'],
    });
    if (!record) throw new NotFoundException('文件不存在或已被删除');
    if (record.userId !== userId && !requireAdmin) {
      throw new ForbiddenException('只能访问自己的文件');
    }
    const absolutePath = isAbsolute(record.localPath) ? record.localPath : join(this.root, record.localPath);
    const checked = resolve(absolutePath);
    if (!checked.startsWith(this.root)) {
      throw new ForbiddenException('文件路径无效');
    }
    return { record, absolutePath: checked };
  }

  async remove(userId: string, fileId: string, requireAdmin = false): Promise<void> {
    const { record, absolutePath } = await this.open(userId, fileId, requireAdmin);
    await unlink(absolutePath).catch(() => undefined);
    await this.repo.remove(record);
  }

  async countAll(): Promise<number> {
    return this.repo.count();
  }

  private safeExtension(originalName: string): string {
    const base = originalName.split(/[\\/]/).pop() || '';
    const dot = base.lastIndexOf('.');
    if (dot <= 0 || dot === base.length - 1) return '';
    return base.slice(dot + 1).toLowerCase();
  }

  private toStored(row: FileUpload): StoredFile {
    return {
      id: row.id,
      originalName: row.originalName,
      mimeType: row.mimeType,
      sizeBytes: Number(row.sizeBytes),
      sha256: row.sha256,
      createdAt: row.createdAt,
    };
  }
}

function configuredRoot(config: ConfigService): string {
  return (config.get<string>('FUTUREFLOW_FILES_DIR') || '').trim();
}
