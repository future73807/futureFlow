import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Patch,
  NotFoundException,
  Param,
  Post,
  Request,
  Res,
  UnauthorizedException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { FILE_ID_PIPE } from '../security/uuid-param.pipe';
import { FileStorageService } from './file-storage.service';

const MAX_FILE_BYTES = 10 * 1024 * 1024;

@UseGuards(JwtAuthGuard)
@Controller('files')
export class FilesController {
  constructor(private readonly storage: FileStorageService) {}

  private currentUserId(req: any): string {
    const userId = req?.user?.id;
    if (!userId) throw new UnauthorizedException('未认证');
    return String(userId);
  }

  private isAdmin(req: any): boolean {
    return req?.user?.role === 'admin';
  }

  @Post('upload')
  @UseInterceptors(FileInterceptor('file', {
    limits: { fileSize: MAX_FILE_BYTES, files: 1 },
  }))
  async upload(@Request() req: any, @UploadedFile() file: any) {
    if (!file?.buffer?.byteLength) {
      throw new BadRequestException('请通过 multipart/form-data 的 file 字段上传文件');
    }
    if ((file.size || file.buffer.byteLength) > MAX_FILE_BYTES) {
      throw new BadRequestException('单个文件不能超过 10 MB');
    }
    const originalName = String(file.originalname || 'upload');
    return this.storage.store(
      this.currentUserId(req),
      originalName,
      String(file.mimetype || ''),
      file.buffer,
    );
  }

  @Get()
  list(@Request() req: any) {
    return this.storage.list(this.currentUserId(req));
  }

  @Get(':fileId/download')
  async download(@Request() req: any, @Param('fileId', FILE_ID_PIPE) fileId: string, @Res() res: Response) {
    const { record, absolutePath } = await this.storage.open(
      this.currentUserId(req),
      fileId,
      this.isAdmin(req),
    );

    // 先确认物理文件真的在盘上，再发响应头。
    //
    // 少了这一步，文件缺失时 createReadStream 会发出一个**没人处理**的 'error'，
    // 在 Node 里等同于 uncaughtException —— 网关进程直接退出（本项目没有全局
    // uncaughtException 兜底）。而且那时响应头已经发出去，客户端只会拿到一个
    // 半截的 200，看不到任何有用信息。DB 行在、文件不在并不罕见：手工清盘、
    // 或从备份恢复时媒体目录不完整，都会造成这种状态。
    try {
      await stat(absolutePath);
    } catch {
      throw new NotFoundException('文件内容已丢失，请重新上传');
    }

    res.setHeader('Content-Type', record.mimeType || 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(record.originalName)}"`,
    );
    res.setHeader('Content-Length', String(record.sizeBytes));

    // 再给流挂一个 error 处理作为兜底：stat 通过之后、读取之前文件仍可能被删掉
    // （TOCTOU）。没有它，同一个未处理错误依旧会掀掉进程。
    // 写法与 media.controller.ts 的 Range 下载保持一致。
    const stream = createReadStream(absolutePath);
    await new Promise<void>((resolve, reject) => {
      stream.once('error', reject);
      res.once('finish', resolve);
      res.once('close', resolve);
      stream.pipe(res);
    });
  }

  @Patch(':fileId')
  async rename(
    @Request() req: any,
    @Param('fileId', FILE_ID_PIPE) fileId: string,
    @Body() body: { name?: string },
  ) {
    return this.storage.rename(
      this.currentUserId(req),
      fileId,
      String(body?.name || ''),
      this.isAdmin(req),
    );
  }

  @Post(':fileId/duplicate')
  async duplicate(@Request() req: any, @Param('fileId', FILE_ID_PIPE) fileId: string) {
    return this.storage.duplicate(this.currentUserId(req), fileId, this.isAdmin(req));
  }

  @Delete(':fileId')
  async remove(@Request() req: any, @Param('fileId', FILE_ID_PIPE) fileId: string) {
    await this.storage.remove(this.currentUserId(req), fileId, this.isAdmin(req));
    return { ok: true };
  }
}
