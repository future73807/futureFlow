/**
 * 文件上传（file_uploads）专项冒烟测试。
 *
 * 用内存仓储验证 FileStorageService 的存储契约：
 * 扩展名白名单、空文件拒绝、大小上限、用户隔离、路径不回显、删除清理。
 */
import assert from 'node:assert/strict';

import { ConfigService } from '@nestjs/config';
import { ForbiddenException, PayloadTooLargeException, UnsupportedMediaTypeException } from '@nestjs/common';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

import { FileUpload } from '../src/database/entities/file-upload.entity';
import { FileStorageService } from '../src/files/file-storage.service';

interface Row {
  id: string;
  userId: string;
  originalName: string;
  mimeType: string;
  sizeBytes: string;
  sha256: string;
  localPath: string;
  createdAt: Date;
}

/** 只实现 FileStorageService 用到的仓储方法，行为对齐 TypeORM 语义。 */
function makeRepo() {
  const rows: Row[] = [];
  let seq = 0;
  const repo: any = {
    create(data: Partial<Row>) {
      return { id: '', createdAt: new Date(), ...data } as Row;
    },
    async save(row: Row) {
      row.id = row.id || `id-${++seq}`;
      const existing = rows.findIndex((candidate) => candidate.id === row.id);
      if (existing >= 0) rows[existing] = row;
      else rows.push(row);
      return row;
    },
    async find(opts: any) {
      const list = rows.filter((row) => !opts?.where || Object.entries(opts.where).every(([key, value]) => (row as any)[key] === value));
      const sorted = [...list].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return opts?.take ? sorted.slice(0, opts.take) : sorted;
    },
    async findOne(opts: any) {
      return rows.find((row) => Object.entries(opts?.where || {}).every(([key, value]) => (row as any)[key] === value)) || null;
    },
    async count(opts?: any) {
      return rows.filter((row) => Object.entries(opts?.where || {}).every(([key, value]) => (row as any)[key] === value)).length;
    },
    async remove(row: Row) {
      const index = rows.findIndex((candidate) => candidate.id === row.id);
      if (index >= 0) rows.splice(index, 1);
      return row;
    },
  };
  return repo;
}

async function makeService() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-files-test-'));
  const config = {
    get: (key: string) => (key === 'FUTUREFLOW_FILES_DIR' ? root : undefined),
  } as unknown as ConfigService;
  return { service: new FileStorageService(makeRepo(), config), root };
}

async function main() {
  const { service, root } = await makeService();
  const userId = '11111111-1111-4111-8111-111111111111';
  const otherUser = '22222222-2222-4222-8222-222222222222';

  try {
    const stored = await service.store(userId, 'notes.txt', 'text/plain', Buffer.from('你好 futureFlow'));
    assert.equal(stored.originalName, 'notes.txt');
    assert.equal(stored.sizeBytes, Buffer.byteLength('你好 futureFlow'));
    assert.equal(stored.sha256.length, 64);

    const listed = await service.list(userId);
    assert.equal(listed.length, 1);
    assert.equal((listed[0] as any).localPath, undefined, '列表不得回显存储路径');

    const opened = await service.open(userId, stored.id);
    assert.equal(opened.record.id, stored.id);
    assert.ok(opened.absolutePath.startsWith(root), '文件必须落在配置的根目录内');

    await assert.rejects(
      () => service.open(otherUser, stored.id),
      (error: unknown) => error instanceof ForbiddenException,
    );
    await assert.doesNotReject(() => service.open(otherUser, stored.id, true), '管理员应可跨用户访问');

    await assert.rejects(
      () => service.store(userId, 'evil.exe', 'application/octet-stream', Buffer.from('MZ')),
      (error: unknown) => error instanceof UnsupportedMediaTypeException,
    );
    await assert.rejects(
      () => service.store(userId, 'noext', 'text/plain', Buffer.from('x')),
      (error: unknown) => error instanceof UnsupportedMediaTypeException,
    );
    await assert.rejects(
      () => service.store(userId, 'empty.txt', 'text/plain', Buffer.alloc(0)),
      (error: unknown) => error instanceof UnsupportedMediaTypeException,
    );
    await assert.rejects(
      () => service.store(userId, 'big.txt', 'text/plain', Buffer.alloc(10 * 1024 * 1024 + 1)),
      (error: unknown) => error instanceof PayloadTooLargeException,
    );

    await service.remove(userId, stored.id);
    assert.equal((await service.list(userId)).length, 0);
    await assert.rejects(() => service.open(userId, stored.id));

    console.log('file-storage smoke passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
