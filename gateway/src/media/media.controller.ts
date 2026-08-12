import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Request,
  Res,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  CreateMediaCredentialDto,
  GenerateImageDto,
  GenerateVideoDto,
  UpdateMediaCredentialDto,
} from './dto/media.dto';
import { MediaAssetService } from './media-asset.service';
import { MediaCredentialService } from './media-credential.service';
import { MediaJobService } from './media-job.service';
import {
  MediaAuthenticatedRequest,
  MediaExecutionGuard,
  mediaExecutionScope,
} from './media-execution.guard';

const strictValidation = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

@Controller('media')
@UseGuards(MediaExecutionGuard)
@UsePipes(strictValidation)
export class MediaController {
  constructor(
    private readonly credentials: MediaCredentialService,
    private readonly jobs: MediaJobService,
    private readonly assets: MediaAssetService,
  ) {}

  @Get('credentials')
  listCredentials(@Request() req: MediaAuthenticatedRequest) {
    return this.credentials.list(req.user!.id);
  }

  @Post('credentials')
  createCredential(@Request() req: MediaAuthenticatedRequest, @Body() dto: CreateMediaCredentialDto) {
    return this.credentials.create(req.user!.id, dto);
  }

  @Patch('credentials/:id')
  updateCredential(
    @Request() req: MediaAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateMediaCredentialDto,
  ) {
    return this.credentials.update(req.user!.id, id, dto);
  }

  @Delete('credentials/:id')
  async deleteCredential(
    @Request() req: MediaAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.credentials.remove(req.user!.id, id);
    return { success: true };
  }

  @Post('images/generate')
  generateImage(
    @Request() req: MediaAuthenticatedRequest,
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: GenerateImageDto,
  ) {
    return this.jobs.generateImage(
      req.user!.id,
      this.idempotencyKey(key),
      dto,
      mediaExecutionScope(req),
    );
  }

  @Post('videos/generate')
  generateVideo(
    @Request() req: MediaAuthenticatedRequest,
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: GenerateVideoDto,
  ) {
    return this.jobs.generateVideo(
      req.user!.id,
      this.idempotencyKey(key),
      dto,
      mediaExecutionScope(req),
    );
  }

  @Get('jobs/:id')
  getJob(
    @Request() req: MediaAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.jobs.getAndPoll(req.user!.id, id, mediaExecutionScope(req));
  }

  @Get('assets/:id')
  async downloadAsset(
    @Request() req: MediaAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('range') range: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    const file = await this.assets.ownedFile(req.user!.id, id, mediaExecutionScope(req));
    const selected = this.parseRange(range, file.size);
    response.setHeader('Accept-Ranges', 'bytes');
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('Content-Type', file.asset.mimeType);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Disposition', `inline; filename="${file.asset.fileName}"`);
    response.setHeader('ETag', `"sha256-${file.asset.sha256}"`);
    if (selected === null) {
      response.status(HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE);
      response.setHeader('Content-Range', `bytes */${file.size}`);
      response.end();
      return;
    }
    const { start, end, partial } = selected;
    response.status(partial ? HttpStatus.PARTIAL_CONTENT : HttpStatus.OK);
    response.setHeader('Content-Length', end - start + 1);
    if (partial) response.setHeader('Content-Range', `bytes ${start}-${end}/${file.size}`);
    const stream = this.assets.createReadStream(file.absolutePath, start, end);
    await new Promise<void>((resolve, reject) => {
      stream.once('error', reject);
      response.once('finish', resolve);
      response.once('close', resolve);
      stream.pipe(response);
    });
  }

  private idempotencyKey(value?: string): string {
    const key = value?.trim() || '';
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) {
      throw new BadRequestException('Idempotency-Key 必须为 8-128 位安全字符');
    }
    return key;
  }

  private parseRange(
    value: string | undefined,
    size: number,
  ): { start: number; end: number; partial: boolean } | null {
    if (!value) return size > 0 ? { start: 0, end: size - 1, partial: false } : null;
    const match = value.match(/^bytes=(\d*)-(\d*)$/);
    if (!match || (!match[1] && !match[2]) || size <= 0) return null;
    let start: number;
    let end: number;
    if (!match[1]) {
      const suffix = Number(match[2]);
      if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
      start = Math.max(0, size - suffix);
      end = size - 1;
    } else {
      start = Number(match[1]);
      end = match[2] ? Number(match[2]) : size - 1;
      if (
        !Number.isSafeInteger(start)
        || !Number.isSafeInteger(end)
        || start < 0
        || start >= size
        || end < start
      ) return null;
      end = Math.min(end, size - 1);
    }
    return { start, end, partial: true };
  }
}
