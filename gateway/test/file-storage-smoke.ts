/**
 * 文件上传（file_uploads）专项冒烟测试。
 *
 * 用内存仓储验证 FileStorageService 的存储契约：
 * 扩展名白名单、空文件拒绝、大小上限、用户隔离、路径不回显、删除清理。
 */
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';

import { ConfigService } from '@nestjs/config';
import {
  ForbiddenException,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

import { FileUpload } from '../src/database/entities/file-upload.entity';
import { FileStorageService } from '../src/files/file-storage.service';
import { FilesController } from '../src/files/files.controller';

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

/** 最小的 Express Response 替身：只要能接住 pipe 过来的字节即可。 */
function makeDownloadResponse() {
  const chunks: Buffer[] = [];
  const res = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  }) as any;
  res.headers = {} as Record<string, string>;
  res.setHeader = (name: string, value: string) => { res.headers[name] = value; };
  res.status = () => res;
  return { res, body: () => Buffer.concat(chunks).toString('utf8') };
}

/**
 * 下载路径：DB 行在、物理文件不在时**必须返回 404，而不是让进程退出**。
 *
 * 修复前的写法是 `createReadStream(path).pipe(res)` —— 没有 error 处理。
 * 文件缺失时流会发出一个没人处理的 'error'，在 Node 里等同于
 * uncaughtException，而本项目**没有全局 uncaughtException 兜底**，
 * 结果是网关进程直接退出（实测确认）。DB 行在、文件不在并不罕见：
 * 手工清盘、或从备份恢复时媒体目录不完整，都会造成这种状态。
 */
async function testDownloadWithMissingFile() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-dl-'));
  const presentFile = path.join(tmpRoot, 'present.txt');
  fs.writeFileSync(presentFile, 'download-body', 'utf8');
  const missingFile = path.join(tmpRoot, 'gone.txt');

  const record = {
    id: 'f1', userId: 'u1', originalName: 'a.txt',
    mimeType: 'text/plain', sizeBytes: 13, localPath: presentFile, createdAt: new Date(),
  };
  const controller = new FilesController({
    open: async () => ({ record, absolutePath: presentFile }),
  } as any);
  const req = { user: { id: 'u1', role: 'user' } };

  try {
    // 1. 文件缺失先测：这是本用例的核心。
    //    放第一个是为了让「修复被摘掉」时立刻在这里暴露 —— 未修复的写法不会
    //    抛错（流错误是异步发出的），断言会直接失败；严重时未处理的 ENOENT
    //    还会把整个测试进程掀掉。放在后面的话，前面那条断言会先失败，
    //    掩盖掉真正要守的行为。
    {
      const missingController = new FilesController({
        open: async () => ({
          record: { ...record, localPath: missingFile },
          absolutePath: missingFile,
        }),
      } as any);
      const { res } = makeDownloadResponse();
      await assert.rejects(
        () => missingController.download(req, 'f1', res),
        (error: unknown) => error instanceof NotFoundException,
        '物理文件缺失必须返回 404；修复前这里会因未处理的流错误让进程退出',
      );
    }

    // 2. 文件存在：正常流式返回，确认修复没有破坏正常路径
    {
      const { res, body } = makeDownloadResponse();
      await controller.download(req, 'f1', res);
      assert.equal(body(), 'download-body', '正常下载应返回文件内容');
      assert.equal(res.headers['Content-Length'], '13');
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
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

    await testDownloadWithMissingFile();

    console.log('file-storage smoke passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
