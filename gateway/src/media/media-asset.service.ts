import {
  BadGatewayException,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { lookup as dnsLookup } from 'node:dns/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  mkdir,
  open,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { request as httpsRequest, RequestOptions } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { Repository } from 'typeorm';
import { MediaAsset } from '../database/entities/media-asset.entity';
import type { MediaKind } from '../database/entities/media-job.entity';
import type { ProviderMediaSource } from './media.types';
import type { MediaExecutionScope } from './media-execution.guard';

type Resolver = (
  hostname: string,
) => Promise<ReadonlyArray<{ address: string; family: number }>>;

interface DownloadResult {
  path: string;
  size: number;
  sha256: string;
  head: Buffer;
  declaredType?: string;
}

interface DetectedMedia {
  kind: MediaKind;
  mimeType: string;
  extension: string;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const BLOCKED_IPS = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as Array<[string, number]>) {
  BLOCKED_IPS.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 96], ['fc00::', 7], ['fe80::', 10],
  ['ff00::', 8], ['2001:db8::', 32],
] as Array<[string, number]>) {
  BLOCKED_IPS.addSubnet(network, prefix, 'ipv6');
}

/** Reject private, loopback, link-local, multicast and documentation ranges. */
export function isPublicIpAddress(raw: string): boolean {
  let address = raw.toLowerCase().split('%')[0];
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) address = mapped[1];
  else if (address.startsWith('::ffff:')) return false;
  const family = isIP(address);
  if (family === 4) {
    if (BLOCKED_IPS.check(address, 'ipv4')) return false;
    const parts = address.split('.').map(Number);
    const [a, b, c] = parts;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0 && c === 0) return false;
    if (a === 192 && b === 0 && c === 2) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a === 198 && b === 51 && c === 100) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }
  if (family === 6) {
    if (BLOCKED_IPS.check(address, 'ipv6')) return false;
    if (address === '::' || address === '::1') return false;
    if (/^f[cd]/.test(address) || /^fe[89ab]/.test(address) || /^ff/.test(address)) return false;
    if (/^2001:db8(?::|$)/.test(address)) return false;
    return true;
  }
  return false;
}

export async function resolvePublicAddress(
  hostname: string,
  resolver: Resolver = async (name) => dnsLookup(name, { all: true, verbatim: true }),
): Promise<{ address: string; family: number }> {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  if (
    normalized === 'localhost'
    || normalized.endsWith('.localhost')
    || normalized.endsWith('.local')
    || normalized.endsWith('.internal')
  ) {
    throw new BadGatewayException('媒体资源地址不安全');
  }
  const literalFamily = isIP(normalized);
  const addresses = literalFamily
    ? [{ address: normalized, family: literalFamily }]
    : await resolver(normalized).catch(() => []);
  // Reject the whole hostname if any answer is unsafe; this avoids selecting a
  // public answer from a mixed public/private DNS response.
  if (!addresses.length || addresses.some((entry) => !isPublicIpAddress(entry.address))) {
    throw new BadGatewayException('媒体资源地址不安全');
  }
  return addresses[0];
}

@Injectable()
export class MediaAssetService {
  private readonly root: string;

  constructor(
    @InjectRepository(MediaAsset)
    private readonly assets: Repository<MediaAsset>,
    private readonly config: ConfigService,
  ) {
    const configured = config.get<string>('MEDIA_ASSET_ROOT')?.trim();
    this.root = resolve(configured || join(process.cwd(), '.futureflow-media'));
  }

  async persist(
    userId: string,
    jobId: string,
    kind: MediaKind,
    source: ProviderMediaSource,
  ): Promise<MediaAsset> {
    const existing = await this.assets.findOne({ where: { userId, jobId } });
    if (existing) return existing;
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const temporary = join(this.root, `.download-${randomUUID()}.tmp`);
    try {
      const downloaded = source.type === 'base64'
        ? await this.writeBase64(temporary, source.data, this.maxBytes(kind))
        : await this.downloadUrl(temporary, source.url, source.headers || {}, this.maxBytes(kind));
      const detected = detectMedia(downloaded.head);
      if (!detected || detected.kind !== kind) {
        throw new UnsupportedMediaTypeException('供应商返回的媒体格式不受支持');
      }
      const assetId = randomUUID();
      const tenantDir = resolve(this.root, userId);
      this.assertWithinRoot(tenantDir);
      await mkdir(tenantDir, { recursive: true, mode: 0o700 });
      const fileName = `${assetId}.${detected.extension}`;
      const finalPath = resolve(tenantDir, fileName);
      this.assertWithinRoot(finalPath);
      await rename(downloaded.path, finalPath);
      const row = this.assets.create({
        id: assetId,
        userId,
        jobId,
        mimeType: detected.mimeType,
        sizeBytes: String(downloaded.size),
        sha256: downloaded.sha256,
        fileName,
        localPath: relative(this.root, finalPath),
      });
      try {
        return await this.assets.save(row);
      } catch (error: any) {
        await unlink(finalPath).catch(() => undefined);
        if (error?.code === '23505') {
          const concurrent = await this.assets.findOne({ where: { userId, jobId } });
          if (concurrent) return concurrent;
        }
        throw error;
      }
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  async ownedFile(userId: string, id: string, scope?: MediaExecutionScope): Promise<{
    asset: MediaAsset;
    absolutePath: string;
    size: number;
  }> {
    const query = this.assets
      .createQueryBuilder('asset')
      .addSelect('asset.localPath')
      .innerJoin('asset.job', 'job')
      .where('asset.id = :id', { id })
      .andWhere('asset.userId = :userId', { userId });
    if (scope) {
      query
        .andWhere('job.executionRunId = :runId', { runId: scope.runId })
        .andWhere('job.executionWorkflowId = :workflowId', { workflowId: scope.workflowId })
        .andWhere('job.executionWorkflowVersion = :workflowVersion', {
          workflowVersion: scope.workflowVersion,
        })
        .andWhere('job.credentialId IN (:...credentialIds)', {
          credentialIds: scope.credentialIds,
        });
    }
    const asset = await query.getOne();
    if (!asset) throw new NotFoundException('媒体资产不存在');
    const absolutePath = resolve(this.root, asset.localPath);
    this.assertWithinRoot(absolutePath);
    const metadata = await stat(absolutePath).catch(() => null);
    if (!metadata?.isFile()) throw new NotFoundException('媒体资产文件不存在');
    return { asset, absolutePath, size: metadata.size };
  }

  async findByJob(userId: string, jobId: string): Promise<MediaAsset | null> {
    return this.assets.findOne({ where: { userId, jobId } });
  }

  createReadStream(path: string, start?: number, end?: number) {
    return createReadStream(path, { start, end });
  }

  private maxBytes(kind: MediaKind): number {
    const name = kind === 'image' ? 'MEDIA_IMAGE_MAX_BYTES' : 'MEDIA_VIDEO_MAX_BYTES';
    const fallback = kind === 'image' ? 25 * 1024 * 1024 : 250 * 1024 * 1024;
    const parsed = Number.parseInt(this.config.get<string>(name, String(fallback)), 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
  }

  private async writeBase64(path: string, raw: string, maxBytes: number): Promise<DownloadResult> {
    let value = raw.trim();
    const dataUri = value.match(/^data:([^;,]+);base64,(.*)$/s);
    if (dataUri) value = dataUri[2];
    if (
      value.length > Math.ceil(maxBytes / 3) * 4 + 4
      || value.length % 4 === 1
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
    ) {
      throw new PayloadTooLargeException('媒体数据无效或超过大小限制');
    }
    const data = Buffer.from(value, 'base64');
    if (!data.length || data.length > maxBytes) {
      throw new PayloadTooLargeException('媒体数据无效或超过大小限制');
    }
    await writeFile(path, data, { flag: 'wx', mode: 0o600 });
    return {
      path,
      size: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
      head: data.subarray(0, 32),
    };
  }

  private async downloadUrl(
    path: string,
    rawUrl: string,
    initialHeaders: Readonly<Record<string, string>>,
    maxBytes: number,
  ): Promise<DownloadResult> {
    let url = this.parseAssetUrl(rawUrl);
    let headers = { ...initialHeaders };
    const timeoutMs = Number.parseInt(
      this.config.get<string>('MEDIA_DOWNLOAD_TIMEOUT_MS', '120000'),
      10,
    );
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      const endpoint = await resolvePublicAddress(url.hostname);
      const response = await this.openPinnedRequest(url, endpoint, headers, timeoutMs);
      if (REDIRECT_STATUSES.has(response.statusCode || 0)) {
        const location = response.headers.location;
        response.resume();
        if (!location || redirects === 3) {
          throw new BadGatewayException('媒体资源重定向无效');
        }
        const next = this.parseAssetUrl(new URL(location, url).toString());
        if (next.origin !== url.origin) headers = {};
        url = next;
        continue;
      }
      if (response.statusCode !== 200) {
        response.resume();
        throw new BadGatewayException('媒体资源下载失败');
      }
      const declaredLength = Number.parseInt(response.headers['content-length'] || '0', 10);
      if (declaredLength > maxBytes) {
        response.destroy();
        throw new PayloadTooLargeException('媒体资源超过大小限制');
      }
      return this.writeResponse(path, response, maxBytes);
    }
    throw new BadGatewayException('媒体资源重定向过多');
  }

  private parseAssetUrl(raw: string): URL {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new BadGatewayException('媒体资源地址无效');
    }
    if (
      url.protocol !== 'https:'
      || url.username
      || url.password
      || url.href.length > 8192
    ) {
      throw new BadGatewayException('媒体资源地址无效');
    }
    url.hash = '';
    return url;
  }

  private openPinnedRequest(
    url: URL,
    endpoint: { address: string; family: number },
    headers: Readonly<Record<string, string>>,
    timeoutMs: number,
  ): Promise<IncomingMessage> {
    const options: RequestOptions = {
      protocol: 'https:',
      hostname: endpoint.address,
      family: endpoint.family,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      servername: isIP(url.hostname) ? undefined : url.hostname,
      headers: {
        accept: 'image/*,video/*,application/octet-stream',
        ...headers,
        host: url.host,
      },
      agent: false,
      timeout: timeoutMs,
    };
    return new Promise((resolveRequest, reject) => {
      const request = httpsRequest(options, resolveRequest);
      request.once('timeout', () => request.destroy(new Error('timeout')));
      request.once('error', () => reject(new BadGatewayException('媒体资源下载失败')));
      request.end();
    });
  }

  private async writeResponse(
    path: string,
    response: IncomingMessage,
    maxBytes: number,
  ): Promise<DownloadResult> {
    const handle = await open(path, 'wx', 0o600);
    const hash = createHash('sha256');
    const head: Buffer[] = [];
    let headBytes = 0;
    let size = 0;
    try {
      for await (const rawChunk of response) {
        const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
        size += chunk.length;
        if (size > maxBytes) {
          response.destroy();
          throw new PayloadTooLargeException('媒体资源超过大小限制');
        }
        if (headBytes < 32) {
          const part = chunk.subarray(0, 32 - headBytes);
          head.push(part);
          headBytes += part.length;
        }
        hash.update(chunk);
        await handle.write(chunk);
      }
      if (!size) throw new UnsupportedMediaTypeException('供应商返回了空媒体');
      await handle.sync();
      return {
        path,
        size,
        sha256: hash.digest('hex'),
        head: Buffer.concat(head),
        declaredType: String(response.headers['content-type'] || '').split(';')[0],
      };
    } finally {
      await handle.close();
    }
  }

  private assertWithinRoot(path: string): void {
    const rel = relative(this.root, path);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
      if (resolve(path) === this.root) return;
      throw new Error('unsafe media asset path');
    }
  }
}

export function detectMedia(data: Buffer): DetectedMedia | null {
  const ascii = data.toString('ascii');
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { kind: 'image', mimeType: 'image/png', extension: 'png' };
  }
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return { kind: 'image', mimeType: 'image/jpeg', extension: 'jpg' };
  }
  if (ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a')) {
    return { kind: 'image', mimeType: 'image/gif', extension: 'gif' };
  }
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') {
    return { kind: 'image', mimeType: 'image/webp', extension: 'webp' };
  }
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'AVI ') {
    return { kind: 'video', mimeType: 'video/x-msvideo', extension: 'avi' };
  }
  if (data.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    return { kind: 'video', mimeType: 'video/webm', extension: 'webm' };
  }
  if (ascii.slice(4, 8) === 'ftyp') {
    const brand = ascii.slice(8, 16).toLowerCase();
    if (brand.includes('avif') || brand.includes('avis')) {
      return { kind: 'image', mimeType: 'image/avif', extension: 'avif' };
    }
    if (brand.includes('qt')) {
      return { kind: 'video', mimeType: 'video/quicktime', extension: 'mov' };
    }
    return { kind: 'video', mimeType: 'video/mp4', extension: 'mp4' };
  }
  if (
    data.subarray(0, 4).equals(Buffer.from([0x00, 0x00, 0x01, 0xba]))
    || data.subarray(0, 3).equals(Buffer.from([0x00, 0x00, 0x01]))
  ) {
    return { kind: 'video', mimeType: 'video/mpeg', extension: 'mpeg' };
  }
  return null;
}
