import { projectWorkContext, projectAbortSignal } from './project-work-units';
import { BadGatewayException, ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import type { HostConfig } from './host.config';
import type { HostProjectBinding } from './host.types';

export const projectBindingContext = new AsyncLocalStorage<HostProjectBinding | undefined>();
export interface HostFileReceipt { assetId: string; relativePath: string; version: string }
export interface HostFileMetadata extends HostFileReceipt { mimeType: string; sizeBytes: number }
export interface HostLayout { content: Record<string, any>; version: string }

export function parseProjectBinding(value: unknown): HostProjectBinding | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new ForbiddenException('项目绑定无效');
  const binding = value as Partial<HostProjectBinding>;
  if (!Number.isSafeInteger(binding.generation) || (binding.generation ?? 0) < 1 || binding.version !== 'v1' || typeof binding.projectId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(binding.projectId)
    || typeof binding.bindingToken !== 'string' || !binding.bindingToken.trim()
    || binding.bindingToken.length > 2048) {
    throw new ForbiddenException('项目绑定无效，请重新打开项目');
  }
  return { version: 'v1', projectId: binding.projectId, generation: binding.generation!, bindingToken: binding.bindingToken };
}

/** 模式选择只在 Provider 装配；消费者只看是否有宿主文件目标。 */
export interface HostProjectFiles {
  binding(value?: HostProjectBinding): HostProjectBinding | undefined;
  upload(binding: HostProjectBinding, input: { assetId: string; relativePath: string; mimeType: string; writeFingerprint: string }, data: Buffer | string): Promise<HostFileReceipt>;
  metadata(binding: HostProjectBinding, id: string): Promise<HostFileMetadata>;
  stream(binding: HostProjectBinding, id: string, version: string, range?: string): Promise<Readable>;
  move(binding: HostProjectBinding, id: string, input: { relativePath: string; expectedRelativePath: string; expectedVersion: string }): Promise<HostFileReceipt>;
  remove(binding: HostProjectBinding, id: string, version: string): Promise<void>;
  readLayout(binding: HostProjectBinding, id: string): Promise<HostLayout>;
  writeLayout(binding: HostProjectBinding, id: string, content: Record<string, any>, expectedVersion: string | null): Promise<HostLayout>;
}

export class StandaloneProjectFiles implements HostProjectFiles {
  binding(): undefined { return undefined; }
  private unavailable(): never { throw new ServiceUnavailableException('宿主文件服务未启用'); }
  upload(): Promise<HostFileReceipt> { return this.unavailable(); }
  metadata(): Promise<HostFileMetadata> { return this.unavailable(); }
  stream(): Promise<Readable> { return this.unavailable(); }
  move(): Promise<HostFileReceipt> { return this.unavailable(); }
  remove(): Promise<void> { return this.unavailable(); }
  readLayout(): Promise<HostLayout> { return this.unavailable(); }
  writeLayout(): Promise<HostLayout> { return this.unavailable(); }
}

export class EmbeddedProjectFiles implements HostProjectFiles {
  constructor(private readonly config: HostConfig) {}
  binding(value = projectBindingContext.getStore()): HostProjectBinding {
    if (!this.config.endpoints.projectFiles) throw new ServiceUnavailableException('请配置 HOST_PROJECT_FILES_URL');
    const binding = parseProjectBinding(value);
    if (!binding) throw new ForbiddenException('项目绑定缺失，请重新打开项目');
    return binding;
  }
  private async request(binding: HostProjectBinding, path: string, init: RequestInit = {}): Promise<Response> {
    this.binding(binding);
    await projectWorkContext.getStore()?.assertCurrent();
    let response: Response;
    try {
      response = await fetch(`${this.config.endpoints.projectFiles!.replace(/\/$/, '')}${path}`, {
        ...init,
        headers: { ...init.headers, authorization: `Bearer ${this.config.sharedSecret}`,
          'x-ff-project-binding': binding.bindingToken, 'x-ff-embed-protocol': this.config.protocolVersion },
        signal: projectAbortSignal() ? AbortSignal.any([AbortSignal.timeout(this.config.requestTimeoutMs), projectAbortSignal()!]) : AbortSignal.timeout(this.config.requestTimeoutMs), redirect: 'error',
      });
    } catch { throw new ServiceUnavailableException('项目文件服务不可达'); }
    // 不转发宿主正文：正文可能意外包含能力令牌或服务器路径。
    if (response.status === 404) throw new NotFoundException('项目文件不存在');
    if (response.status === 409) throw new ConflictException('文件已改变，请刷新后重试');
    if (response.status === 401 || response.status === 403) throw new ForbiddenException('项目文件授权失效，请重新打开项目');
    if (!response.ok) throw new BadGatewayException('项目文件服务请求失败');
    return response;
  }
  private async receipt(response: Response): Promise<HostFileReceipt> {
    const value = await response.json();
    if (!value || typeof value.assetId !== 'string' || typeof value.relativePath !== 'string'
      || !/^[a-f0-9]{64}$/.test(value.version)) throw new BadGatewayException('项目文件回执无效');
    return { assetId: value.assetId, relativePath: value.relativePath, version: value.version };
  }
  async upload(binding: HostProjectBinding, input: { assetId: string; relativePath: string; mimeType: string; writeFingerprint: string }, data: Buffer | string): Promise<HostFileReceipt> {
    if (!/^[0-9a-f-]{36}$/i.test(input.assetId) || !/^[a-f0-9]{64}$/.test(input.writeFingerprint)
      || Object.values(input).some((value) => /[\r\n]/.test(value))) throw new ForbiddenException('文件上传参数无效');
    // 临时媒体文件以流上传，避免视频在网关内存中再复制一份。
    const boundary = `ff-${input.assetId}`;
    const header = Buffer.from(Object.entries(input).map(([key, value]) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`).join('')
      + `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="asset"\r\nContent-Type: application/octet-stream\r\n\r\n`);
    async function* parts() {
      yield header;
      if (typeof data === 'string') { for await (const chunk of createReadStream(data)) yield chunk; }
      else yield data;
      yield Buffer.from(`\r\n--${boundary}--\r\n`);
    }
    const init = { method: 'POST', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, body: Readable.from(parts()), duplex: 'half' };
    const receipt = await this.receipt(await this.request(binding, '/upload', init as unknown as RequestInit));
    if (receipt.assetId !== input.assetId || receipt.relativePath !== input.relativePath || receipt.version !== input.writeFingerprint) throw new BadGatewayException('项目文件回执不匹配');
    return receipt;
  }
  async metadata(binding: HostProjectBinding, id: string): Promise<HostFileMetadata> {
    const response = await this.request(binding, `/${encodeURIComponent(id)}/metadata`);
    const value = await response.json();
    if (!value || value.assetId !== id || typeof value.relativePath !== 'string'
      || !/^[a-f0-9]{64}$/.test(value.version) || typeof value.mimeType !== 'string'
      || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 0) throw new BadGatewayException('项目文件元数据无效');
    return value;
  }
  async stream(binding: HostProjectBinding, id: string, version: string, range?: string): Promise<Readable> {
    const response = await this.request(binding, `/${encodeURIComponent(id)}?version=${encodeURIComponent(version)}`, { headers: range ? { range } : {} });
    if (!response.body) throw new BadGatewayException('项目文件响应为空');
    return Readable.fromWeb(response.body as any);
  }
  async move(binding: HostProjectBinding, id: string, input: { relativePath: string; expectedRelativePath: string; expectedVersion: string }): Promise<HostFileReceipt> {
    return this.receipt(await this.request(binding, `/${encodeURIComponent(id)}/move`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }));
  }
  async remove(binding: HostProjectBinding, id: string, version: string): Promise<void> {
    await this.request(binding, `/${encodeURIComponent(id)}?version=${encodeURIComponent(version)}`, { method: 'DELETE' });
  }
  async readLayout(binding: HostProjectBinding, id: string): Promise<HostLayout> {
    return this.layout(await this.request(binding, `/layouts/${encodeURIComponent(id)}`));
  }
  async writeLayout(binding: HostProjectBinding, id: string, content: Record<string, any>, expectedVersion: string | null): Promise<HostLayout> {
    return this.layout(await this.request(binding, `/layouts/${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content, expectedVersion }) }));
  }
  private async layout(response: Response): Promise<HostLayout> {
    if (!response.body) throw new BadGatewayException('工作流布局为空');
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of Readable.fromWeb(response.body as any)) {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) throw new BadGatewayException('工作流布局过大');
      chunks.push(Buffer.from(chunk));
    }
    let value: any;
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new BadGatewayException('工作流布局不是JSON'); }
    if (!value?.content || !Array.isArray(value.content.nodes) || !Array.isArray(value.content.edges)
      || !/^[a-f0-9]{64}$/.test(value.version)) throw new BadGatewayException('工作流布局无效');
    return { content: value.content, version: value.version };
  }
}

/** AsyncGenerator 的执行发生在 next() 时，必须逐次带上冻结的作用域。 */
export async function* projectBoundStream<T>(binding: HostProjectBinding | undefined, source: AsyncGenerator<T>): AsyncGenerator<T> {
  try {
    while (true) {
      const next = await projectBindingContext.run(binding, () => source.next());
      if (next.done) return;
      yield next.value;
    }
  } finally { await projectBindingContext.run(binding, () => source.return(undefined as any)); }
}
