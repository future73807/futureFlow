import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { PluginFavorite } from '../database/entities/plugin-favorite.entity';
import { WorkflowRun } from '../database/entities/workflow-run.entity';
import { PLUGIN_CATALOG, PluginCatalogEntry, PluginTool } from './plugin-catalog';

export interface PluginStats {
  runs: number;
  /** 0..1，保留 3 位小数 */
  successRate: number;
  avgDurationMs: number;
  tokens: number;
  lastRunAt: string | null;
}

export interface PluginFavoriteState {
  /** 当前用户是否已收藏。 */
  favorited: boolean;
  /** 全平台收藏总数。 */
  favoriteCount: number;
}

export interface PluginSummary {
  id: string;
  nodeType: string;
  name: string;
  category: string;
  summary: string;
  tags: string[];
  icon?: string;
  toolCount: number;
  stats: PluginStats;
  favorited: boolean;
  favoriteCount: number;
}

export interface PluginDetail extends PluginSummary {
  description: string;
  capability: string;
  tools: PluginTool[];
}

/** 只扫描最近一段运行记录，避免全表聚合拖慢接口。 */
const STATS_WINDOW = 2000;
/** 列表页每次加载都要看统计，60 秒内的结果直接复用。 */
const STATS_CACHE_TTL_MS = 60_000;
/** 单条 flowgramJson 的节点数上限，异常/超大快照直接跳过，保证单次扫描有界。 */
const MAX_NODES_PER_RUN = 3000;

interface StatsAccumulator {
  runs: number;
  succeeded: number;
  durationMs: number;
  durationSamples: number;
  tokens: number;
  lastRunAt: Date | null;
}

@Injectable()
export class PluginsService {
  private readonly logger = new Logger(PluginsService.name);
  private cachedStats: { at: number; value: Map<string, PluginStats> } | null = null;
  private pendingStats: Promise<Map<string, PluginStats>> | null = null;

  constructor(
    @InjectRepository(WorkflowRun)
    private readonly runRepo: Repository<WorkflowRun>,
    @InjectRepository(PluginFavorite)
    private readonly favoriteRepo: Repository<PluginFavorite>,
  ) {}

  async list(userId: string): Promise<PluginSummary[]> {
    const stats = await this.loadStats();
    const favorites = await this.loadFavorites(
      userId,
      PLUGIN_CATALOG.map((entry) => entry.id),
    );
    return PLUGIN_CATALOG.map((entry) =>
      this.toSummary(entry, stats.get(entry.nodeType), favorites.get(entry.id)),
    );
  }

  async detail(id: string, userId: string): Promise<PluginDetail> {
    const entry = PLUGIN_CATALOG.find((item) => item.id === id);
    if (!entry) {
      throw new NotFoundException(`插件不存在: ${id}`);
    }
    const stats = await this.loadStats();
    const favorites = await this.loadFavorites(userId, [entry.id]);
    return {
      ...this.toSummary(entry, stats.get(entry.nodeType), favorites.get(entry.id)),
      description: entry.description,
      capability: entry.capability,
      tools: entry.tools,
    };
  }

  /**
   * 收藏 / 取消收藏：已收藏则删除，未收藏则插入，返回切换后的最新状态。
   * 收藏是即时交互，不用缓存；并发重复点击由唯一索引兜底，插入冲突静默忽略。
   */
  async toggleFavorite(userId: string, pluginId: string): Promise<PluginFavoriteState> {
    if (!PLUGIN_CATALOG.some((item) => item.id === pluginId)) {
      throw new NotFoundException('插件不存在');
    }

    const existing = await this.favoriteRepo.findOne({ where: { userId, pluginId } });
    if (existing) {
      await this.favoriteRepo.delete({ id: existing.id });
    } else {
      await this.favoriteRepo
        .createQueryBuilder()
        .insert()
        .into(PluginFavorite)
        .values({ userId, pluginId })
        .orIgnore()
        .execute();
    }

    const favoriteCount = await this.favoriteRepo.count({ where: { pluginId } });
    return { favorited: !existing, favoriteCount };
  }

  private toSummary(
    entry: PluginCatalogEntry,
    stats: PluginStats | undefined,
    favorite: PluginFavoriteState | undefined,
  ): PluginSummary {
    return {
      id: entry.id,
      nodeType: entry.nodeType,
      name: entry.name,
      category: entry.category,
      summary: entry.summary,
      tags: entry.tags,
      // icon 是可选展示字段，没有匹配资源时不输出空字符串
      ...(entry.icon ? { icon: entry.icon } : {}),
      toolCount: entry.tools.length,
      stats: stats || this.emptyStats(),
      favorited: favorite?.favorited ?? false,
      favoriteCount: favorite?.favoriteCount ?? 0,
    };
  }

  /**
   * 收藏不参与 60 秒统计缓存：用户点完收藏必须立即生效。
   * 一次 IN 查询取回全部相关收藏行后在内存聚合，
   * 同时得到全平台收藏数与本用户是否收藏，不逐插件查库。
   */
  private async loadFavorites(
    userId: string,
    pluginIds: string[],
  ): Promise<Map<string, PluginFavoriteState>> {
    const result = new Map<string, PluginFavoriteState>();
    if (pluginIds.length === 0) return result;

    const rows = await this.favoriteRepo.find({
      where: { pluginId: In(pluginIds) },
      select: ['userId', 'pluginId'],
    });

    for (const row of rows) {
      const state = result.get(row.pluginId) ?? { favorited: false, favoriteCount: 0 };
      state.favoriteCount += 1;
      if (row.userId === userId) state.favorited = true;
      result.set(row.pluginId, state);
    }
    return result;
  }

  private emptyStats(): PluginStats {
    return { runs: 0, successRate: 0, avgDurationMs: 0, tokens: 0, lastRunAt: null };
  }

  /**
   * 用时间戳缓存 + 进行中 Promise 复用，避免页面连续请求重复扫表。
   * 缓存失效后若已有扫描在途，直接复用同一个 Promise。
   */
  private async loadStats(): Promise<Map<string, PluginStats>> {
    const now = Date.now();
    if (this.cachedStats && now - this.cachedStats.at < STATS_CACHE_TTL_MS) {
      return this.cachedStats.value;
    }
    if (!this.pendingStats) {
      this.pendingStats = this.aggregateStats()
        .then((value) => {
          this.cachedStats = { at: Date.now(), value };
          return value;
        })
        .catch((err) => {
          this.logger.warn(`插件统计聚合失败，返回空统计: ${err?.message || err}`);
          return new Map<string, PluginStats>();
        })
        .finally(() => {
          this.pendingStats = null;
        });
    }
    return this.pendingStats;
  }

  /**
   * 单次查询取最近 STATS_WINDOW 条运行记录，在内存中按节点类型聚合。
   * 不做逐插件查询，插件数量增加也不会放大数据库压力。
   */
  private async aggregateStats(): Promise<Map<string, PluginStats>> {
    const runs = await this.runRepo.find({
      select: ['id', 'status', 'createdAt', 'elapsedTime', 'totalTokens', 'flowgramJson'],
      order: { createdAt: 'DESC' },
      take: STATS_WINDOW,
    });

    const accumulators = new Map<string, StatsAccumulator>();

    for (const run of runs) {
      const nodeTypes = this.extractNodeTypes(run.flowgramJson);
      if (nodeTypes.size === 0) continue;

      const succeeded = run.status === 'succeeded';
      // elapsedTime 单位为秒（float）；0 表示没有耗时数据（如尚未结束的运行），
      // 参与均值会把平均值拉低，因此只统计 > 0 的样本。
      const durationSeconds =
        typeof run.elapsedTime === 'number' && Number.isFinite(run.elapsedTime) && run.elapsedTime > 0
          ? run.elapsedTime
          : null;
      const tokens =
        typeof run.totalTokens === 'number' && Number.isFinite(run.totalTokens) ? run.totalTokens : 0;
      const createdAt = this.toDate(run.createdAt);

      for (const nodeType of nodeTypes) {
        let acc = accumulators.get(nodeType);
        if (!acc) {
          acc = {
            runs: 0,
            succeeded: 0,
            durationMs: 0,
            durationSamples: 0,
            tokens: 0,
            lastRunAt: null,
          };
          accumulators.set(nodeType, acc);
        }
        acc.runs += 1;
        if (succeeded) acc.succeeded += 1;
        if (durationSeconds !== null) {
          acc.durationMs += durationSeconds * 1000;
          acc.durationSamples += 1;
        }
        acc.tokens += tokens;
        if (createdAt && (!acc.lastRunAt || createdAt > acc.lastRunAt)) {
          acc.lastRunAt = createdAt;
        }
      }
    }

    const result = new Map<string, PluginStats>();
    for (const [nodeType, acc] of accumulators) {
      result.set(nodeType, {
        runs: acc.runs,
        successRate: acc.runs > 0 ? Math.round((acc.succeeded / acc.runs) * 1000) / 1000 : 0,
        avgDurationMs: acc.durationSamples > 0 ? Math.round(acc.durationMs / acc.durationSamples) : 0,
        tokens: acc.tokens,
        lastRunAt: acc.lastRunAt ? acc.lastRunAt.toISOString() : null,
      });
    }
    return result;
  }

  /**
   * flowgramJson 为可空 jsonb，历史数据也可能异常，逐层防御解析；
   * 只需节点 type 集合，不保留整份快照，避免长期占用内存。
   */
  private extractNodeTypes(flowgram: unknown): Set<string> {
    const types = new Set<string>();
    const parsed = this.parseFlowgram(flowgram);
    if (!parsed || typeof parsed !== 'object') return types;

    const nodes = (parsed as { nodes?: unknown }).nodes;
    if (!Array.isArray(nodes) || nodes.length > MAX_NODES_PER_RUN) return types;

    for (const node of nodes) {
      const type = (node as { type?: unknown } | null)?.type;
      if (typeof type === 'string' && type) {
        types.add(type);
      }
    }
    return types;
  }

  /** 兼容 jsonb 正常返回对象、以及历史数据以字符串存放两种情况。 */
  private parseFlowgram(flowgram: unknown): unknown {
    if (flowgram === null || flowgram === undefined) return null;
    if (typeof flowgram !== 'string') return flowgram;
    try {
      return JSON.parse(flowgram);
    } catch {
      return null;
    }
  }

  private toDate(value: Date | string | null | undefined): Date | null {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
}
