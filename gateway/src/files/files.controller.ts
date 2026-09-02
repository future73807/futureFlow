import {
  BadRequestException,
  Controller,
  Delete,
  Get,
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
import { JwtAuthGuard } from '../auth/jwt.guard';
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
  async download(@Request() req: any, @Param('fileId') fileId: string, @Res() res: Response) {
    if (!/^[0-9a-f-]{36}$/i.test(fileId)) {
      throw new BadRequestException('文件 ID 格式无效');
    }
    const { record, absolutePath } = await this.storage.open(
      this.currentUserId(req),
      fileId,
      this.isAdmin(req),
    );
    res.setHeader('Content-Type', record.mimeType || 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(record.originalName)}"`,
    );
    res.setHeader('Content-Length', String(record.sizeBytes));
    createReadStream(absolutePath).pipe(res);
  }

  @Delete(':fileId')
  async remove(@Request() req: any, @Param('fileId') fileId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(fileId)) {
      throw new BadRequestException('文件 ID 格式无效');
    }
    await this.storage.remove(this.currentUserId(req), fileId, this.isAdmin(req));
    return { ok: true };
  }
}
