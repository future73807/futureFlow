/**
 * 插件商店
 * 列表：浏览平台内置工具插件
 * 详情：单个插件的工具、参数与真实运行统计（对齐参考图的插件详情布局）
 */

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button, Input, Spin, Tag, Toast, Typography } from '@douyinfe/semi-ui';
import {
  IconArrowLeft,
  IconCopy,
  IconPlus,
  IconSearch,
  IconStar,
  IconStarStroked,
} from '@douyinfe/semi-icons';
import styled from 'styled-components';

import { apiJson } from '../../utils/api';
import { nodeRegistries } from '../../nodes';
import { PluginIconGlyph, pluginTint } from '../../components/plugin-icons';

interface PluginToolParam {
  name: string;
  type: string;
  required?: boolean;
  description?: string;
  default?: unknown;
}

interface PluginTool {
  name: string;
  description?: string;
  params?: PluginToolParam[];
  outputs?: Array<{ name: string; type?: string; description?: string }>;
}

interface PluginStats {
  runs?: number;
  successRate?: number;
  avgDurationMs?: number;
  tokens?: number;
  lastRunAt?: string | null;
}

interface PluginSummary {
  id: string;
  nodeType: string;
  name: string;
  category?: string;
  summary?: string;
  tags?: string[];
  icon?: string;
  toolCount?: number;
  favorited?: boolean;
  favoriteCount?: number;
  stats?: PluginStats;
}

interface PluginDetail extends PluginSummary {
  description?: string;
  capability?: string;
  tools?: PluginTool[];
}

const formatCount = (value?: number) => {
  const count = Number(value || 0);
  if (count >= 10000) return `${(count / 10000).toFixed(1)}万`;
  return String(count);
};

const formatDuration = (ms?: number) => {
  const value = Number(ms || 0);
  if (value <= 0) return '—';
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(1)}s`;
};

const formatPercent = (rate?: number) => {
  if (rate === undefined || rate === null) return '—';
  return `${(Number(rate) * 100).toFixed(1)}%`;
};

const formatTime = (value?: string | null) => {
  if (!value) return '暂无';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '暂无';
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
};

/** 按参数的默认值/类型生成一段可直接粘进请求体的示例 JSON */
const buildSampleBody = (tool?: PluginTool) => {
  if (!tool?.params?.length) return '{}';
  const sample: Record<string, unknown> = {};
  tool.params.forEach((param) => {
    if (param.default !== undefined && param.default !== null && param.default !== '') {
      sample[param.name] = param.default;
      return;
    }
    if (param.type === 'number' || param.type === 'integer') sample[param.name] = 0;
    else if (param.type === 'boolean') sample[param.name] = false;
    else if (param.type === 'array') sample[param.name] = [];
    else sample[param.name] = '';
  });
  return JSON.stringify(sample, null, 2);
};

const buildSampleOutputs = (tool?: PluginTool) => {
  const outputs = tool?.outputs || [];
  if (!outputs.length) return '{\n  "text": ""\n}';
  const sample: Record<string, unknown> = {};
  outputs.forEach((output) => {
    if (output.type === 'number' || output.type === 'integer') sample[output.name] = 0;
    else if (output.type === 'boolean') sample[output.name] = false;
    else if (output.type === 'array') sample[output.name] = [];
    else if (output.type === 'object') sample[output.name] = {};
    else sample[output.name] = '';
  });
  return JSON.stringify(sample, null, 2);
};

export const PluginStorePage = () => {
  const { pluginId } = useParams<{ pluginId: string }>();
  const navigate = useNavigate();
  const [items, setItems] = useState<PluginSummary[]>([]);
  const [detail, setDetail] = useState<PluginDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [keyword, setKeyword] = useState('');
  const [category, setCategory] = useState('全部');
  const [activeToolIndex, setActiveToolIndex] = useState(0);
  const [creating, setCreating] = useState(false);

  const loadPlugins = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await apiJson<{ items: PluginSummary[] }>('/plugins');
      setItems(response?.items || []);
    } catch (err: any) {
      setError(err?.message || '加载插件列表失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (pluginId) return;
    void loadPlugins();
  }, [loadPlugins, pluginId]);

  useEffect(() => {
    if (!pluginId) {
      setDetail(null);
      setActiveToolIndex(0);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    apiJson<PluginDetail>(`/plugins/${pluginId}`)
      .then((response) => {
        if (cancelled) return;
        setDetail(response);
        setActiveToolIndex(0);
      })
      .catch((err: any) => {
        if (cancelled) return;
        Toast.error(err?.message || '加载插件详情失败');
        navigate('/plugins', { replace: true });
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [navigate, pluginId]);

  const categories = useMemo(() => {
    const unique = Array.from(new Set(items.map((item) => item.category).filter(Boolean)));
    return ['全部', ...(unique as string[])];
  }, [items]);

  const visibleItems = useMemo(() => {
    const normalized = keyword.trim().toLowerCase();
    return items.filter((item) => {
      if (category !== '全部' && item.category !== category) return false;
      if (!normalized) return true;
      return [item.name, item.summary, item.id, ...(item.tags || [])]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(normalized));
    });
  }, [category, items, keyword]);

  /**
   * 把插件节点加进一张新画布：节点的默认数据取自画布注册表的 onAdd()，
   * 与「添加节点」面板创建的节点完全一致，避免前端维护第二份默认值。
   */
  const handleToggleFavorite = useCallback(async () => {
    if (!detail) return;
    try {
      const result = await apiJson<{ favorited: boolean; favoriteCount: number }>(
        `/plugins/${detail.id}/favorite`,
        { method: 'POST' },
      );
      setDetail((previous) =>
        previous
          ? { ...previous, favorited: result.favorited, favoriteCount: result.favoriteCount }
          : previous,
      );
      Toast.success(result.favorited ? '已收藏' : '已取消收藏');
    } catch (err: any) {
      Toast.error(err?.message || '操作失败');
    }
  }, [detail]);

  const handleAddToCanvas = useCallback(async () => {
    if (!detail) return;
    setCreating(true);
    try {
      const registry = nodeRegistries.find((item) => String(item.type) === detail.nodeType);
      // 所有节点注册表的 onAdd() 都不读上下文参数，商店页没有画布上下文，传空即可。
      const added = (registry?.onAdd?.(undefined as any) || {}) as any;
      // 注册表默认值里存在「空模板」字段（如 LLM 的用户提示词）。空提示词会一路传到
      // 模型接口并被拒（messages 参数非法），所以接上开始节点的输入，
      // 让「添加到我的工作流」建出来的画布可以直接跑通。
      const promptField = added?.data?.inputsValues?.prompt;
      if (
        promptField
        && promptField.type === 'template'
        && !String(promptField.content || '').trim()
      ) {
        promptField.content = '{{start_0.query}}';
      }
      const nodeId: string = added.id || `${detail.nodeType}_0`;
      const outputKeys = Object.keys(added?.data?.outputs?.properties || {});
      const flowgram = {
        nodes: [
          {
            id: 'start_0',
            type: 'start',
            meta: { position: { x: 80, y: 200 } },
            data: {
              title: '开始',
              outputs: {
                type: 'object',
                properties: { query: { type: 'string', default: '你好，请介绍一下你自己。' } },
              },
            },
          },
          {
            ...added,
            id: nodeId,
            type: detail.nodeType,
            meta: { position: { x: 480, y: 220 } },
          },
          {
            id: 'end_0',
            type: 'end',
            meta: { position: { x: 900, y: 220 } },
            data: {
              title: '结束',
              ...(outputKeys.length
                ? {
                    inputsValues: {
                      [outputKeys[0]]: { type: 'ref', content: [nodeId, outputKeys[0]] },
                    },
                    inputs: { type: 'object', properties: { [outputKeys[0]]: { type: 'string' } } },
                  }
                : {}),
            },
          },
        ],
        edges: [
          { sourceNodeID: 'start_0', targetNodeID: nodeId },
          { sourceNodeID: nodeId, targetNodeID: 'end_0' },
        ],
      };

      const workflow = await apiJson<{ id: string }>('/workflows', {
        method: 'POST',
        body: JSON.stringify({
          name: detail.name,
          description: `由插件商店创建：${detail.name}`,
          flowgram: JSON.stringify(flowgram),
        }),
      });
      Toast.success('已创建画布');
      navigate(`/canvas/${workflow.id}`);
    } catch (err: any) {
      Toast.error(err?.message || '创建画布失败');
    } finally {
      setCreating(false);
    }
  }, [detail, navigate]);

  if (loading && !pluginId) {
    return (
      <PageContainer>
        <LoadingCenter>
          <div className="loading-inline">
            <Spin size="small" />
            <span>加载插件商店</span>
          </div>
        </LoadingCenter>
      </PageContainer>
    );
  }

  if (error && !pluginId) {
    return (
      <PageContainer>
        <ErrorState>
          <Typography.Text type="danger">{error}</Typography.Text>
          <Button onClick={() => void loadPlugins()}>重试</Button>
        </ErrorState>
      </PageContainer>
    );
  }

  if (pluginId) {
    if (detailLoading || !detail) {
      return (
        <PageContainer>
          <LoadingCenter>
            <div className="loading-inline">
              <Spin size="small" />
              <span>加载插件详情</span>
            </div>
          </LoadingCenter>
        </PageContainer>
      );
    }
    return (
      <DetailView
        detail={detail}
        activeToolIndex={activeToolIndex}
        onToolSelect={setActiveToolIndex}
        onBack={() => navigate('/plugins')}
        onAddToCanvas={handleAddToCanvas}
        onToggleFavorite={handleToggleFavorite}
        creating={creating}
      />
    );
  }

  return (
    <PageContainer className="page-shell">
      <header className="page-head page-fixed">
        <h1>插件商店</h1>
        <p className="page-sub">平台内置工具插件，查看参数与运行统计，一键创建含该工具的画布。</p>
      </header>

      {/* 工具条：分类 chips 在左、搜索在右，两簇同一行；标题区不动 */}
      <div className="list-toolbar page-fixed">
        <div className="toolbar-actions">
          <CategoryRow>
            {categories.map((item) => (
              <CategoryChip
                key={item}
                type="button"
                $active={item === category}
                onClick={() => setCategory(item)}
              >
                {item}
              </CategoryChip>
            ))}
          </CategoryRow>
        </div>
        <div className="toolbar-filters">
          {/* 限定宽度：Semi 输入框默认 width:100%，不限定会把分类 chips 挤换行 */}
          <Input
            className="plugin-search"
            style={{ flex: '0 1 240px', minWidth: 180 }}
            prefix={<IconSearch />}
            placeholder="搜索插件名称、说明或标签"
            value={keyword}
            onChange={setKeyword}
            showClear
          />
        </div>
      </div>

      <ScrollArea className="page-scroll">
        {visibleItems.length === 0 ? (
          <EmptyState>没有匹配的插件，换个关键词试试。</EmptyState>
        ) : (
          <PluginGrid>
            {visibleItems.map((item) => (
              <PluginCard key={item.id} type="button" onClick={() => navigate(`/plugins/${item.id}`)}>
                <CardTop>
                  <PluginIcon>
                    <PluginMark item={item} size={30} />
                  </PluginIcon>
                  <div>
                    <strong>{item.name}</strong>
                    <small>{item.category || '内置工具'}</small>
                  </div>
                </CardTop>
                <CardSummary>{item.summary || '暂无说明'}</CardSummary>
                <TagRow>
                  {(item.tags || []).slice(0, 3).map((tag) => (
                    <Tag key={tag} size="small" type="ghost">
                      {tag}
                    </Tag>
                  ))}
                </TagRow>
                <CardStats>
                  <span>
                    调用量 <b>{formatCount(item.stats?.runs)}</b>
                  </span>
                  <span>
                    成功率 <b>{formatPercent(item.stats?.successRate)}</b>
                  </span>
                  <span>
                    平均耗时 <b>{formatDuration(item.stats?.avgDurationMs)}</b>
                  </span>
                </CardStats>
              </PluginCard>
            ))}
          </PluginGrid>
        )}
      </ScrollArea>
    </PageContainer>
  );
};

const PluginMark = ({
  item,
  size,
  labelSize,
}: {
  item: PluginSummary;
  size: number;
  /** 保留首字母兜底图标的字号参数，供详情页大图标复用同一处样式 */
  labelSize?: number;
}) => {
  // 图标与画布节点共用 components/plugin-icons 的图形与取色，改一处两边同时生效
  const tint = pluginTint(item.id || item.nodeType || item.name || '');
  const glyphSize = Math.round(size * 0.66);
  return (
    <LetterMark
      $labelSize={labelSize}
      style={{ width: size, height: size, background: tint.bg, color: tint.fg }}
    >
      <PluginIconGlyph id={item.id || item.nodeType || item.name || ''} size={glyphSize} />
    </LetterMark>
  );
};


const DetailView = ({
  detail,
  activeToolIndex,
  onToolSelect,
  onBack,
  onAddToCanvas,
  onToggleFavorite,
  creating,
}: {
  detail: PluginDetail;
  activeToolIndex: number;
  onToolSelect: (index: number) => void;
  onBack: () => void;
  onAddToCanvas: () => void;
  onToggleFavorite: () => void;
  creating: boolean;
}) => {
  const tools = detail.tools || [];
  const activeTool = tools[activeToolIndex] || tools[0];
  const stats = detail.stats || {};
  const [activeTab, setActiveTab] = useState<'desc' | 'tools'>('desc');
  const [jsonMode, setJsonMode] = useState<'body' | 'output'>('body');
  const toolsTabActive = activeTab === 'tools';
  const activeJson =
    jsonMode === 'body' ? buildSampleBody(activeTool) : buildSampleOutputs(activeTool);

  const handleCopyJson = async () => {
    try {
      await navigator.clipboard.writeText(activeJson);
      Toast.success('已复制');
    } catch {
      Toast.error('复制失败');
    }
  };

  return (
    <PageContainer className="page-shell">
      <header className="page-head page-fixed">
        <h1 style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <PluginMark item={detail} size={36} labelSize={16} />
          {detail.name}
        </h1>
        <p className="page-sub">
          futureFlow 官方 · 内置工具 · {detail.category || '通用'}
        </p>
        <TagRow>
          <Tag size="small" color="blue">
            官方
          </Tag>
          <Tag size="small" type="ghost">
            免费
          </Tag>
          {(detail.tags || []).map((tag) => (
            <Tag key={tag} size="small" type="ghost">
              {tag}
            </Tag>
          ))}
        </TagRow>
        <div className="page-actions">
          <Button
            theme="borderless"
            icon={<IconArrowLeft aria-hidden="true" />}
            aria-label="返回插件列表"
            onClick={onBack}
          />
          <Button
            theme={detail.favorited ? 'light' : 'borderless'}
            aria-label={detail.favorited ? '取消收藏' : '收藏该插件'}
            icon={
              detail.favorited ? (
                <IconStar aria-hidden="true" />
              ) : (
                <IconStarStroked aria-hidden="true" />
              )
            }
            onClick={onToggleFavorite}
          >
            {detail.favorited ? '已收藏' : '收藏'}
            {detail.favoriteCount ? `(${detail.favoriteCount})` : ''}
          </Button>
          <Button theme="solid" type="primary" loading={creating} onClick={onAddToCanvas}>
            添加到我的工作流
          </Button>
        </div>
      </header>

      {/* 概览统计属于详情页头部信息，保持常驻；工具页签行同样固定 */}
      <StatStrip className="page-fixed">
        <StatCell>
          <b>{detail.toolCount ?? tools.length}</b>
          <span>工具</span>
        </StatCell>
        <StatCell>
          <b>{formatCount(stats.runs)}</b>
          <span>调用量</span>
        </StatCell>
        <StatCell>
          <b>{formatPercent(stats.successRate)}</b>
          <span>成功率</span>
        </StatCell>
        <StatCell>
          <b>{formatDuration(stats.avgDurationMs)}</b>
          <span>平均耗时</span>
        </StatCell>
        <StatCell>
          <b>{formatCount(stats.tokens)}</b>
          <span>令牌用量</span>
        </StatCell>
        <StatCell>
          <b>{formatTime(stats.lastRunAt)}</b>
          <span>最近运行</span>
        </StatCell>
      </StatStrip>

      <TabBar role="tablist" aria-label="插件详情" className="page-fixed">
        <TabButton
          type="button"
          role="tab"
          aria-selected={activeTab === 'desc'}
          onClick={() => setActiveTab('desc')}
        >
          插件描述
        </TabButton>
        <TabButton
          type="button"
          role="tab"
          aria-selected={activeTab === 'tools'}
          onClick={() => setActiveTab('tools')}
        >
          插件工具
        </TabButton>
      </TabBar>

      <ScrollArea $topGap={14} className="page-scroll">
      {/*
        两个面板始终挂载：冒烟测试读取 body.innerText 断言详情页文案，
        而 display:none / visibility:hidden 会把文案从 innerText 里剔除，
        所以非激活面板用「移出视口但仍参与渲染」的方式隐藏。
      */}
      <TabPanel $active={activeTab === 'desc'} aria-hidden={activeTab !== 'desc'}>
        <div className="section-head">
          <h2>插件描述</h2>
          <p>{detail.description || detail.summary || '暂无说明。'}</p>
          {detail.capability && <p>适用场景：{detail.capability}</p>}
          <div className="section-head-actions">
            <Button
              theme="light"
              type="primary"
              icon={<IconPlus aria-hidden="true" />}
              loading={creating}
              tabIndex={activeTab === 'desc' ? undefined : -1}
              onClick={onAddToCanvas}
            >
              添加到我的工作流
            </Button>
          </div>
        </div>
      </TabPanel>

      <TabPanel $active={toolsTabActive} aria-hidden={!toolsTabActive}>
        <div className="section-head">
          <h2>工具参数</h2>
          <p>查看每个参数的示例值与说明，复制请求体 / 返回体 JSON。</p>
        </div>
        {/* 只有一个工具时也保留 chip 行：它是「当前工具」的可见标识，与参考图一致 */}
        {tools.length > 0 && (
          <ToolChips>
            {tools.map((tool, index) => (
              <ToolChip
                key={tool.name}
                type="button"
                aria-pressed={index === activeToolIndex}
                tabIndex={toolsTabActive ? undefined : -1}
                onClick={() => onToolSelect(index)}
              >
                {tool.name}
              </ToolChip>
            ))}
          </ToolChips>
        )}
        {activeTool ? (
          <ToolPanel>
            <ParamArea>
              <ParamColumnHeader>参数名</ParamColumnHeader>
              <ParamColumnHeader>参数说明</ParamColumnHeader>
              {(activeTool.params || []).map((param, index) => {
                const isLast = index === (activeTool.params || []).length - 1;
                const example = formatExampleValue(param);
                return (
                  <Fragment key={param.name}>
                    <ParamNameCell $last={isLast}>
                      <code>{param.name}</code>
                      {param.required && <em>*</em>}
                    </ParamNameCell>
                    <ParamDetailCell $last={isLast}>
                      <ExampleValue title={example}>{example}</ExampleValue>
                      <p>
                        {formatParamType(param.type)} · {param.description || '—'}
                      </p>
                    </ParamDetailCell>
                  </Fragment>
                );
              })}
              {!(activeTool.params || []).length && <ParamEmpty>该工具无需参数。</ParamEmpty>}
            </ParamArea>
            <JsonPane>
              <JsonPaneHeader>
                <JsonModeSwitch role="group" aria-label="示例 JSON 类型">
                  <JsonModeButton
                    type="button"
                    aria-pressed={jsonMode === 'body'}
                    tabIndex={toolsTabActive ? undefined : -1}
                    onClick={() => setJsonMode('body')}
                  >
                    请求体
                  </JsonModeButton>
                  <JsonModeButton
                    type="button"
                    aria-pressed={jsonMode === 'output'}
                    tabIndex={toolsTabActive ? undefined : -1}
                    onClick={() => setJsonMode('output')}
                  >
                    返回体
                  </JsonModeButton>
                </JsonModeSwitch>
                <JsonPaneLabel>JSON</JsonPaneLabel>
                <CopyButton
                  type="button"
                  aria-label="复制 JSON"
                  title="复制 JSON"
                  tabIndex={toolsTabActive ? undefined : -1}
                  onClick={() => void handleCopyJson()}
                >
                  <IconCopy aria-hidden="true" />
                </CopyButton>
              </JsonPaneHeader>
              <JsonSample>{activeJson}</JsonSample>
            </JsonPane>
          </ToolPanel>
        ) : (
          <EmptyState>该插件暂未登记工具参数。</EmptyState>
        )}
      </TabPanel>
      </ScrollArea>
    </PageContainer>
  );
};

/** 参数示例值：优先渲染默认值的 JSON 形式，无默认值时按类型给占位 */
const formatExampleValue = (param: PluginToolParam) =>
  JSON.stringify(param.default ?? sampleForType(param.type)) ?? '';

/** 参数类型首字母大写，用于「类型 · 说明」行（与参考图一致） */
const formatParamType = (type?: string) => {
  if (!type) return 'String';
  return type.charAt(0).toUpperCase() + type.slice(1);
};

const sampleForType = (type?: string) => {
  if (type === 'number' || type === 'integer') return 0;
  if (type === 'boolean') return false;
  if (type === 'array') return [];
  if (type === 'object') return {};
  return '';
};

const PageContainer = styled.div`
  display: flex;
  height: 100%;
  min-height: 0;
  flex-direction: column;
  padding: 26px 32px 0;
  background: var(--ff-page);

  @media (max-width: 720px) {
    height: auto;
    padding: 16px 14px 0;
  }
`;

/** 滚动区：只让详情面板/卡片网格滚动，头部与工具条保持可见 */
const ScrollArea = styled.div<{ $topGap?: number }>`
  padding: ${(props) => `${props.$topGap ?? 0}px 0 40px`};

  @media (max-width: 720px) {
    padding-bottom: 32px;
  }
`;

const CategoryRow = styled.div`
  display: flex;
  flex-wrap: wrap;
  /* 分类现在位于工具条左侧，chips 换行时每行也靠左 */
  justify-content: flex-start;
  gap: 8px;
`;

const CategoryChip = styled.button<{ $active: boolean }>`
  padding: 5px 12px;
  border: 1px solid var(--ff-border);
  border-radius: 999px;
  background: ${(props) => (props.$active ? 'var(--ff-primary-soft)' : '#ffffff')};
  color: ${(props) => (props.$active ? 'var(--ff-primary)' : 'var(--ff-text-secondary)')};
  border-color: ${(props) => (props.$active ? 'var(--ff-primary-border)' : 'var(--ff-border)')};
  cursor: pointer;
  font-size: 13px;
  transition: background-color 120ms ease;

  &:hover {
    background: ${(props) => (props.$active ? 'var(--ff-primary-soft)' : 'var(--ff-surface-muted)')};
  }
`;

const PluginGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 14px;
`;

const PluginCard = styled.button`
  display: grid;
  gap: 10px;
  padding: 16px;
  border: 1px solid var(--ff-border);
  border-radius: var(--ff-radius-lg);
  background: var(--ff-surface);
  box-shadow: var(--ff-shadow-sm);
  cursor: pointer;
  text-align: left;
  transition: border-color 140ms ease, box-shadow 140ms ease;

  &:hover {
    border-color: var(--ff-border-hover);
    box-shadow: 0 6px 18px rgba(15, 23, 42, 0.07);
  }
`;

const CardTop = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;

  strong {
    display: block;
    color: var(--ff-text);
    font-size: 15px;
    font-weight: 600;
    line-height: 20px;
  }

  small {
    color: var(--ff-subtle);
    font-size: 12px;
  }
`;

const PluginIcon = styled.span`
  display: grid;
  width: 38px;
  height: 38px;
  flex: 0 0 38px;
  place-items: center;
  overflow: hidden;
  border-radius: 9px;
  background: var(--ff-surface-muted);

  img {
    border-radius: 8px;
    object-fit: cover;
  }
`;

const LetterMark = styled.span<{ $labelSize?: number }>`
  display: grid;
  place-items: center;
  border-radius: 8px;
  background: var(--ff-primary-soft);
  color: var(--ff-primary);
  font-size: ${(props) => `${props.$labelSize ?? 15}px`};
  font-weight: 600;
`;

const CardSummary = styled.p`
  margin: 0;
  min-height: 38px;
  color: var(--ff-text-secondary);
  font-size: 13px;
  line-height: 20px;
`;

const TagRow = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
`;

const CardStats = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--ff-border);
  color: var(--ff-subtle);
  font-size: 12px;

  b {
    color: var(--ff-text);
    font-weight: 600;
  }
`;

const LoadingCenter = styled.div`
  display: grid;
  min-height: 320px;
  place-items: center;
`;

const EmptyState = styled.div`
  padding: 60px 16px;
  border: 1px dashed var(--ff-border);
  border-radius: var(--ff-radius-lg);
  color: var(--ff-subtle);
  font-size: 13px;
  text-align: center;
`;

const ErrorState = styled.div`
  display: grid;
  min-height: 260px;
  place-items: center;
  gap: 12px;
`;

const StatStrip = styled.div`
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  border-bottom: 1px solid var(--ff-border);
  padding-bottom: 20px;
  /* 与下方页签行保持与其它页面一致的间距 */
  margin-bottom: 14px;

  @media (max-width: 960px) {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 18px 0;
  }
`;

const StatCell = styled.div`
  display: grid;
  justify-items: center;
  gap: 4px;
  padding: 4px 10px;
  border-right: 1px solid var(--ff-border);
  text-align: center;

  &:last-child {
    border-right: 0;
  }

  b {
    color: var(--ff-text);
    font-size: 22px;
    font-weight: 600;
    line-height: 30px;
  }

  span {
    color: var(--ff-muted);
    font-size: 12px;
  }
`;

const TabBar = styled.div`
  display: flex;
  align-items: center;
  gap: 26px;
  border-bottom: 1px solid var(--ff-border);
`;

const TabButton = styled.button`
  position: relative;
  padding: 2px 2px 12px;
  border: 0;
  background: transparent;
  color: var(--ff-subtle);
  cursor: pointer;
  font-size: 15px;
  line-height: 22px;
  transition: color 120ms ease;

  &:hover {
    color: var(--ff-text);
  }

  &[aria-selected='true'] {
    color: var(--ff-primary);
    font-weight: 600;

    &::after {
      position: absolute;
      right: 0;
      bottom: -1px;
      left: 0;
      height: 2px;
      border-radius: 2px 2px 0 0;
      background: var(--ff-primary);
      content: '';
    }
  }
`;

/**
 * 非激活面板不能只靠 display:none / visibility:hidden 隐藏：
 * 那会把面板文案从 body.innerText 里剔除，冒烟测试读不到「参数名」等详情文案。
 * 移出视口仍然参与渲染，innerText 可见，但用户看不到、也点不到。
 */
const TabPanel = styled.div<{ $active: boolean }>`
  ${(props) =>
    props.$active
      ? ''
      : `
    position: absolute;
    left: -9999px;
    top: 0;
    width: 1px;
    height: 1px;
    overflow: hidden;
    pointer-events: none;
  `}
`;

const ToolChips = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
`;

const ToolChip = styled.button`
  padding: 5px 12px;
  border: 1px solid var(--ff-border);
  border-radius: 8px;
  background: #ffffff;
  color: var(--ff-text-secondary);
  cursor: pointer;
  font-size: 13px;
  line-height: 18px;
  transition: border-color 120ms ease, background-color 120ms ease, color 120ms ease;

  &:hover {
    border-color: var(--ff-border-hover);
    background: var(--ff-surface-muted);
  }

  &[aria-pressed='true'] {
    border-color: var(--ff-primary);
    background: var(--ff-primary-soft);
    color: var(--ff-primary);
  }
`;

const ToolPanel = styled.div`
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(240px, 34%);
  overflow: hidden;
  border: 1px solid var(--ff-border);
  border-radius: var(--ff-radius-lg);
  background: var(--ff-surface);

  @media (max-width: 860px) {
    grid-template-columns: minmax(0, 1fr);
  }
`;

const ParamArea = styled.div`
  display: grid;
  align-content: start;
  grid-template-columns: minmax(140px, 24%) minmax(0, 1fr);
`;

const ParamColumnHeader = styled.div`
  padding: 12px 20px;
  border-bottom: 1px solid var(--ff-border);
  color: var(--ff-subtle);
  font-size: 12px;
  font-weight: 600;
  line-height: 18px;
`;

const ParamNameCell = styled.div<{ $last: boolean }>`
  padding: 16px 20px;
  border-bottom: ${(props) => (props.$last ? '0' : '1px solid var(--ff-border)')};
  color: var(--ff-text-secondary);
  font-size: 13px;
  line-height: 20px;
  overflow-wrap: anywhere;

  code {
    color: var(--ff-text);
    font-family: 'JetBrains Mono', Consolas, monospace;
  }

  em {
    margin-left: 3px;
    color: var(--ff-danger);
    font-style: normal;
  }
`;

const ParamDetailCell = styled.div<{ $last: boolean }>`
  display: grid;
  gap: 8px;
  align-content: start;
  padding: 16px 20px;
  border-bottom: ${(props) => (props.$last ? '0' : '1px solid var(--ff-border)')};

  p {
    margin: 0;
    color: var(--ff-muted);
    font-size: 13px;
    line-height: 20px;
  }
`;

const ExampleValue = styled.span`
  display: inline-block;
  max-width: 100%;
  justify-self: start;
  padding: 4px 10px;
  overflow: hidden;
  border: 1px solid var(--ff-border);
  border-radius: 6px;
  background: var(--ff-surface-muted);
  color: var(--ff-text-secondary);
  font-family: 'JetBrains Mono', Consolas, monospace;
  font-size: 12px;
  line-height: 18px;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const ParamEmpty = styled.div`
  grid-column: 1 / -1;
  padding: 24px 20px;
  color: var(--ff-subtle);
  font-size: 13px;
  text-align: center;
`;

const JsonPane = styled.div`
  display: flex;
  min-width: 0;
  flex-direction: column;
  border-left: 1px solid var(--ff-border);

  @media (max-width: 860px) {
    border-top: 1px solid var(--ff-border);
    border-left: 0;
  }
`;

const JsonPaneHeader = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--ff-border);
`;

const JsonModeSwitch = styled.div`
  display: flex;
  align-items: center;
  gap: 12px;
`;

const JsonModeButton = styled.button`
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--ff-subtle);
  cursor: pointer;
  font-size: 12px;
  line-height: 18px;
  transition: color 120ms ease;

  &:hover {
    color: var(--ff-text);
  }

  &[aria-pressed='true'] {
    color: var(--ff-text);
    font-weight: 600;
  }
`;

const JsonPaneLabel = styled.span`
  margin-left: auto;
  color: var(--ff-subtle);
  font-family: 'JetBrains Mono', Consolas, monospace;
  font-size: 11px;
  letter-spacing: 0.04em;
`;

const CopyButton = styled.button`
  display: grid;
  width: 26px;
  height: 26px;
  place-items: center;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--ff-muted);
  cursor: pointer;
  transition: background-color 120ms ease, color 120ms ease;

  &:hover {
    background: var(--ff-surface-muted);
    border-color: var(--ff-border);
    color: var(--ff-text);
  }
`;

const JsonSample = styled.pre`
  flex: 1;
  margin: 0;
  padding: 14px 16px;
  overflow: auto;
  background: var(--ff-surface-muted);
  color: var(--ff-text-secondary);
  font-family: 'JetBrains Mono', Consolas, monospace;
  font-size: 12px;
  line-height: 18px;
  white-space: pre-wrap;
`;
