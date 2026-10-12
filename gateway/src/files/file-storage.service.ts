import { Inject, Optional, ConflictException } from '@nestjs/common';
import { HOST_PROJECT_FILES } from '../host/host.types';
import { StandaloneProjectFiles, type HostProjectFiles } from '../host/project-files.provider';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { Repository } from 'typeorm';
import { isPathInside } from '../common/path-safety';
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
    @Optional() @Inject(HOST_PROJECT_FILES) private readonly projectFiles: HostProjectFiles = new StandaloneProjectFiles(),
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
    const binding = this.projectFiles.binding();
    const count = await this.repo.count({ where: { userId, ...(binding ? { hostProjectId: binding.projectId } : {}) } });
    if (count >= MAX_FILES_PER_USER) {
      throw new ForbiddenException(`每个用户最多保存 ${MAX_FILES_PER_USER} 个文件，请先删除不需要的文件`);
    }

    const id = randomUUID();
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    if (binding) {
      const receipt = await this.projectFiles.upload(binding, {
        assetId: id, relativePath: `files/${id}.${extension}`,
        mimeType: declaredType.slice(0, 120) || 'application/octet-stream', writeFingerprint: sha256,
      }, buffer);
      const record = await this.repo.save(this.repo.create({ id, userId, hostProjectId: binding.projectId,
        originalName: originalName.slice(0, 255), mimeType: declaredType.slice(0, 120) || 'application/octet-stream',
        sizeBytes: String(buffer.byteLength), sha256: receipt.version, localPath: receipt.relativePath }));
      return this.toStored(record);
    }
    const tenantDir = join(this.root, userId);
    await mkdir(tenantDir, { recursive: true, mode: 0o700 });
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
    const binding = this.projectFiles.binding();
    const rows = await this.repo.find({
      where: { userId, ...(binding ? { hostProjectId: binding.projectId } : {}) },
      order: { createdAt: 'DESC' },
      take: MAX_FILES_PER_USER,
    });
    if (binding) {
      for (const row of rows) {
        const metadata = await this.projectFiles.metadata(binding, row.id);
        if (metadata.version !== row.sha256) throw new ConflictException('文件已改变，请重新关联');
        row.sha256 = metadata.version; row.sizeBytes = String(metadata.sizeBytes); row.mimeType = metadata.mimeType;
      }
    }
    return rows.map((row) => this.toStored(row));
  }

  async open(userId: string, fileId: string, requireAdmin = false, inspectHost = true) {
    const record = await this.repo.findOne({
      where: { id: fileId },
      select: ['id', 'userId', 'originalName', 'mimeType', 'sizeBytes', 'localPath', 'createdAt', 'sha256', 'hostProjectId'],
    });
    if (!record) throw new NotFoundException('文件不存在或已被删除');
    if (record.userId !== userId && !requireAdmin) {
      throw new ForbiddenException('只能访问自己的文件');
    }
    const binding = this.projectFiles.binding();
    if (binding) {
      if (record.hostProjectId !== binding.projectId) throw new NotFoundException('文件不存在');
      if (!inspectHost) return { record, absolutePath: '', binding };
      const metadata = await this.projectFiles.metadata(binding, record.id);
      if (metadata.version !== record.sha256) throw new ConflictException('文件已改变，请重新关联');
      record.localPath = metadata.relativePath; record.sha256 = metadata.version;
      record.sizeBytes = String(metadata.sizeBytes); record.mimeType = metadata.mimeType;
      return { record, absolutePath: '', binding };
    }
    if (record.hostProjectId) throw new ForbiddenException('文件属于宿主项目');
    const absolutePath = isAbsolute(record.localPath) ? record.localPath : join(this.root, record.localPath);
    const checked = resolve(absolutePath);
    // 不能用 startsWith：根目录的同级目录（如 uploads-evil）会以同样前缀通过
    if (!isPathInside(this.root, checked)) {
      throw new ForbiddenException('文件路径无效');
    }
    return { record, absolutePath: checked };
  }

  async remove(userId: string, fileId: string, requireAdmin = false): Promise<void> {
    const { record, absolutePath, binding } = await this.open(userId, fileId, requireAdmin, false);
    if (binding) {
      await this.projectFiles.remove(binding, record.id, record.sha256);
      await this.repo.remove(record); return;
    }
    await unlink(absolutePath).catch(() => undefined);
    await this.repo.remove(record);
  }

  /** 改名：只更新展示名（originalName），存储路径不变。 */
  async rename(
    userId: string,
    fileId: string,
    name: string,
    requireAdmin = false,
  ): Promise<StoredFile> {
    const trimmed = name.trim();
    if (!trimmed) throw new BadRequestException('文件名不能为空');
    const { record, binding } = await this.open(userId, fileId, requireAdmin);
    if (binding) {
      const base = trimmed.split(/[\\/]/).pop() || '';
      if (base !== trimmed || !this.safeExtension(base)) throw new BadRequestException('文件名无效');
      const directory = record.localPath.slice(0, record.localPath.lastIndexOf('/') + 1);
      const moved = await this.projectFiles.move(binding, record.id, { relativePath: directory + base,
        expectedRelativePath: record.localPath, expectedVersion: record.sha256 });
      record.localPath = moved.relativePath;
    }
    record.originalName = trimmed;
    const saved = await this.repo.save(record);
    return this.toStored(saved);
  }

  /** 副本：同一存储内容落一条新记录（新 id），展示名加「 副本」后缀。 */
  async duplicate(userId: string, fileId: string, requireAdmin = false): Promise<StoredFile> {
    const { record, binding } = await this.open(userId, fileId, requireAdmin);
    const buffer = binding ? await this.readHostBytes(binding, record.id, record.sha256) : await readFile(
      isAbsolute(record.localPath) ? record.localPath : join(this.root, record.localPath),
    );
    const dot = record.originalName.lastIndexOf('.');
    const copyName = binding && dot > 0
      ? `${record.originalName.slice(0, dot)} 副本${record.originalName.slice(dot)}`
      : `${record.originalName} 副本`;
    return this.store(userId, copyName, record.mimeType, buffer);
  }

  private async readHostBytes(binding: import('../host/host.types').HostProjectBinding, id: string, version: string): Promise<Buffer> {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of await this.projectFiles.stream(binding, id, version)) {
      size += chunk.length;
      if (size > MAX_FILE_BYTES) throw new PayloadTooLargeException('单个文件不能超过 10 MB');
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  async downloadStream(file: Awaited<ReturnType<FileStorageService['open']>>) {
    if (file.binding) return this.projectFiles.stream(file.binding, file.record.id, file.record.sha256);
    return (await import('node:fs')).createReadStream(file.absolutePath);
  }

  async countAll(): Promise<number> {
    return this.repo.count();
  }

  /** 删除用户前清理其全部上传文件：DB 行随用户级联删除，物理文件需在此显式移除。 */
  async removeAllByUser(userId: string): Promise<number> {
    const rows = await this.repo.find({
      where: { userId },
      select: ['id', 'userId', 'localPath', 'hostProjectId'],
    });
    let removed = 0;
    for (const row of rows) {
      if (row.hostProjectId) throw new ForbiddenException('请先在宿主项目内删除文件');
      const absolutePath = isAbsolute(row.localPath) ? row.localPath : join(this.root, row.localPath);
      const checked = resolve(absolutePath);
      if (!isPathInside(this.root, checked)) continue;
      await unlink(checked).catch(() => undefined);
      removed += 1;
    }
    return removed;
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
