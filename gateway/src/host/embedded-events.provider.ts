import { Logger } from '@nestjs/common';

import type { HostConfig } from './host.config';
import { HostHttpClient } from './host-http.client';
import type { HostCapabilities, HostEventSink, HostRunEvent } from './host.types';

/** 攒够这么多条就立刻外发（避免一次 run 把宿主打成一串单条请求）。 */
const MAX_BATCH = 25;
/** 不足一批时最多等这么久。 */
const FLUSH_INTERVAL_MS = 250;

/**
 * 内嵌形态的事件 Sink：把运行事件按批透出给宿主通道（宿主据此发 `flowRun.*` 事件）。
 *
 * 三条口径：
 *  ① **带 seq**：每条事件带该 run 内单调递增的序号，宿主做断线重放（`lastSeq`）；
 *  ② **失败不拖垮 run**：事件是旁路，外发失败只记警告 + 计数（run 照常跑完），
 *     下次 flush 把新事件继续发出去；宿主通道的可靠性由宿主的重放机制兜；
 *  ③ **有界**：批次外发失败即丢弃该批（不无限重排），并在日志里给出丢弃条数——
 *     宁可如实丢，也不要让一次长时间 run 把网关内存吃满。
 */
export class EmbeddedEventSink implements HostEventSink {
  readonly kind = 'embedded' as const;
  private readonly logger = new Logger(EmbeddedEventSink.name);
  private queue: HostRunEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dropped = 0;
  /** 归属键缺失的丢弃计数（与「外发失败丢弃」分开计，日志里不混因由）。 */
  private unattributed = 0;

  constructor(
    private readonly config: HostConfig,
    private readonly http: HostHttpClient,
    readonly capabilities: HostCapabilities,
  ) {}

  async publish(event: HostRunEvent): Promise<void> {
    if (!this.config.endpoints.events) return;
    // 归属键缺失的事件宿主无法投递（契约里 hostSubject 必填）：丢弃并计数，
    // 不让一条无归属事件把整批打成 400（旁路纪律，与「失败有界丢弃」同一口径）。
    if (!event.hostSubject?.trim()) {
      this.unattributed += 1;
      this.logger.warn(
        `宿主事件通道：事件缺少 hostSubject（runId=${event.runId}, seq=${event.seq}），已丢弃（累计 ${this.unattributed} 条）。`,
      );
      return;
    }
    this.queue.push(event);
    if (this.queue.length >= MAX_BATCH) {
      await this.flush();
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, FLUSH_INTERVAL_MS);
      // 别让一个待冲刷的定时器吊住进程退出。
      this.timer.unref?.();
    }
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.queue.length === 0) {
      if (this.dropped > 0) {
        this.logger.warn(`宿主事件通道：上一批丢弃 ${this.dropped} 条（外发失败）。`);
        this.dropped = 0;
      }
      return;
    }

    const batch = this.queue;
    this.queue = [];
    try {
      await this.http.postJson<unknown>(
        this.config.endpoints.events,
        {
          protocolVersion: this.config.protocolVersion,
          events: batch,
        },
        { label: '事件透出' },
      );
      if (this.dropped > 0) {
        this.logger.warn(`宿主事件通道：此前丢弃 ${this.dropped} 条（外发失败）。`);
        this.dropped = 0;
      }
    } catch (err) {
      // 旁路失败不冒泡：run 的成败只由引擎与计费决定。
      this.dropped += batch.length;
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `宿主事件透出失败（已丢弃 ${batch.length} 条，累计 ${this.dropped} 条）：${reason}`,
      );
    }
  }
}
