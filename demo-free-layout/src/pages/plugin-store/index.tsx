/**
 * 插件商店
 * 列表：浏览平台内置工具插件
 * 详情：单个插件的工具、参数与真实运行统计（对齐参考图的插件详情布局）
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button, Input, Spin, Tag, Toast, Typography } from '@douyinfe/semi-ui';
import { IconArrowLeft, IconSearch } from '@douyinfe/semi-icons';
import styled from 'styled-components';

import { apiJson } from '../../utils/api';
import { nodeRegistries } from '../../nodes';

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
  stats?: PluginStats;
}

interface PluginDetail extends PluginSummary {
  description?: string;
  capability?: string;
  tools?: PluginTool[];
}

/** nodeType → 画布节点图标，直接复用节点注册表，避免两处维护同一份图标映射 */
const nodeIconMap = new Map<string, string>(
  nodeRegistries
    .filter((registry) => typeof registry.info?.icon === 'string')
    .map((registry) => [String(registry.type), registry.info!.icon as string]),
);

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
  const handleAddToCanvas = useCallback(async () => {
    if (!detail) return;
    setCreating(true);
    try {
      const registry = nodeRegistries.find((item) => String(item.type) === detail.nodeType);
      // 所有节点注册表的 onAdd() 都不读上下文参数，商店页没有画布上下文，传空即可。
      const added = (registry?.onAdd?.(undefined as any) || {}) as any;
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
          <Spin size="large" tip="加载插件商店" />
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
            <Spin size="large" tip="加载插件详情" />
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
        creating={creating}
      />
    );
  }

  return (
    <PageContainer>
      <PageHeader>
        <HeaderTitle>
          <h3>插件商店</h3>
          <p>平台内置工具插件，查看参数与运行统计，一键创建含该工具的画布。</p>
        </HeaderTitle>
      </PageHeader>

      <Toolbar>
        <Input
          className="plugin-search"
          prefix={<IconSearch />}
          placeholder="搜索插件名称、说明或标签"
          value={keyword}
          onChange={setKeyword}
          showClear
        />
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
      </Toolbar>

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
    </PageContainer>
  );
};

const PluginMark = ({ item, size }: { item: PluginSummary; size: number }) => {
  const source = nodeIconMap.get(item.nodeType);
  if (source) {
    return <img src={source} width={size} height={size} alt="" />;
  }
  return <LetterMark style={{ width: size, height: size }}>{(item.name || '?').slice(0, 1)}</LetterMark>;
};

const DetailView = ({
  detail,
  activeToolIndex,
  onToolSelect,
  onBack,
  onAddToCanvas,
  creating,
}: {
  detail: PluginDetail;
  activeToolIndex: number;
  onToolSelect: (index: number) => void;
  onBack: () => void;
  onAddToCanvas: () => void;
  creating: boolean;
}) => {
  const tools = detail.tools || [];
  const activeTool = tools[activeToolIndex] || tools[0];
  const stats = detail.stats || {};

  return (
    <PageContainer>
      <DetailBar>
        <Button
          theme="borderless"
          className="plugin-back"
          icon={<IconArrowLeft aria-hidden="true" />}
          aria-label="返回插件列表"
          onClick={onBack}
        />
        <div className="plugin-detail-actions">
          <Button
            theme="solid"
            type="primary"
            loading={creating}
            onClick={onAddToCanvas}
          >
            添加到我的工作流
          </Button>
        </div>
      </DetailBar>

      <DetailHeader>
        <DetailIcon>
          <PluginMark item={detail} size={54} />
        </DetailIcon>
        <DetailHeading>
          <h1>{detail.name}</h1>
          <p>
            futureFlow 官方
            <span className="dot" />
            内置工具
            <span className="dot" />
            {detail.category || '通用'}
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
        </DetailHeading>
      </DetailHeader>

      <StatStrip>
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

      <Section>
        <SectionTitle>插件说明</SectionTitle>
        <DescriptionBlock>
          <p>{detail.description || detail.summary || '暂无说明。'}</p>
          {detail.capability && <p className="capability">适用场景：{detail.capability}</p>}
        </DescriptionBlock>
      </Section>

      <Section>
        <SectionTitle>插件工具</SectionTitle>
        {tools.length > 1 && (
          <ToolChips>
            {tools.map((tool, index) => (
              <CategoryChip
                key={tool.name}
                type="button"
                $active={index === activeToolIndex}
                onClick={() => onToolSelect(index)}
              >
                {tool.name}
              </CategoryChip>
            ))}
          </ToolChips>
        )}
        {activeTool ? (
          <ToolPanel>
            <ToolIntro>
              <strong>{activeTool.name}</strong>
              <span>{activeTool.description || '暂无说明'}</span>
            </ToolIntro>
            <ParamTable>
              <thead>
                <tr>
                  <th style={{ width: '26%' }}>参数名</th>
                  <th style={{ width: '38%' }}>参数说明</th>
                  <th>示例</th>
                </tr>
              </thead>
              <tbody>
                {(activeTool.params || []).map((param) => (
                  <tr key={param.name}>
                    <td>
                      <code>{param.name}</code>
                      {param.required && <em>*</em>}
                      <span className="param-type">{param.type}</span>
                    </td>
                    <td>{param.description || '—'}</td>
                    <td>
                      <JsonSample>{JSON.stringify(param.default ?? sampleForType(param.type), null, 2)}</JsonSample>
                    </td>
                  </tr>
                ))}
                {!(activeTool.params || []).length && (
                  <tr>
                    <td colSpan={3} className="empty-row">
                      该工具无需参数。
                    </td>
                  </tr>
                )}
              </tbody>
            </ParamTable>
            <SampleBlock>
              <div>
                <span>请求体</span>
                <JsonSample>{buildSampleBody(activeTool)}</JsonSample>
              </div>
              <div>
                <span>返回体</span>
                <JsonSample>{buildSampleOutputs(activeTool)}</JsonSample>
              </div>
            </SampleBlock>
          </ToolPanel>
        ) : (
          <EmptyState>该插件暂未登记工具参数。</EmptyState>
        )}
      </Section>
    </PageContainer>
  );
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
  min-height: 0;
  flex: 1;
  flex-direction: column;
  gap: 18px;
  padding: 26px 32px 40px;
  overflow: auto;
  background: var(--ff-page);

  @media (max-width: 720px) {
    padding: 16px 14px 32px;
  }
`;

const PageHeader = styled.header`
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
`;

const HeaderTitle = styled.div`
  h3 {
    margin: 0;
    color: var(--ff-text);
    font-size: 24px;
    line-height: 32px;
  }

  p {
    margin: 6px 0 0;
    color: var(--ff-muted);
    font-size: 14px;
  }
`;

const Toolbar = styled.div`
  display: grid;
  gap: 12px;

  .plugin-search {
    max-width: 360px;
  }
`;

const CategoryRow = styled.div`
  display: flex;
  flex-wrap: wrap;
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

const LetterMark = styled.span`
  display: grid;
  place-items: center;
  border-radius: 8px;
  background: var(--ff-primary-soft);
  color: var(--ff-primary);
  font-size: 15px;
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

const DetailBar = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;

  .plugin-back {
    width: 32px;
    height: 32px;
    padding: 0;
    color: var(--ff-text-secondary);
  }

  .plugin-detail-actions {
    display: flex;
    gap: 8px;
  }
`;

const DetailHeader = styled.header`
  display: flex;
  align-items: flex-start;
  gap: 18px;
  padding-bottom: 22px;
  border-bottom: 1px solid var(--ff-border);
`;

const DetailIcon = styled.div`
  display: grid;
  width: 66px;
  height: 66px;
  flex: 0 0 66px;
  place-items: center;
  overflow: hidden;
  border: 1px solid var(--ff-border);
  border-radius: 14px;
  background: #ffffff;

  img {
    border-radius: 12px;
    object-fit: cover;
  }
`;

const DetailHeading = styled.div`
  display: grid;
  gap: 8px;

  h1 {
    margin: 0;
    color: var(--ff-text);
    font-size: 28px;
    line-height: 36px;
  }

  p {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0;
    color: var(--ff-muted);
    font-size: 13px;
  }

  .dot {
    width: 3px;
    height: 3px;
    border-radius: 50%;
    background: var(--ff-border-hover);
  }
`;

const StatStrip = styled.div`
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  border-bottom: 1px solid var(--ff-border);
  padding-bottom: 20px;

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

const Section = styled.section`
  display: grid;
  gap: 12px;
`;

const SectionTitle = styled.h4`
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0;
  color: var(--ff-text);
  font-size: 16px;

  &::after {
    height: 2px;
    flex: 1;
    background: var(--ff-border);
    content: '';
  }
`;

const DescriptionBlock = styled.div`
  display: grid;
  gap: 10px;
  padding: 18px 20px;
  border: 1px solid var(--ff-border);
  border-radius: var(--ff-radius-lg);
  background: var(--ff-surface);

  p {
    margin: 0;
    color: var(--ff-text-secondary);
    font-size: 14px;
    line-height: 24px;
  }

  .capability {
    color: var(--ff-muted);
    font-size: 13px;
  }
`;

const ToolChips = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
`;

const ToolPanel = styled.div`
  display: grid;
  border: 1px solid var(--ff-border);
  border-radius: var(--ff-radius-lg);
  overflow: hidden;
  background: var(--ff-surface);
`;

const ToolIntro = styled.div`
  display: grid;
  gap: 4px;
  padding: 16px 20px;
  border-bottom: 1px solid var(--ff-border);

  strong {
    color: var(--ff-text);
    font-size: 14px;
  }

  span {
    color: var(--ff-muted);
    font-size: 13px;
  }
`;

const ParamTable = styled.table`
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;

  th {
    padding: 10px 20px;
    background: var(--ff-surface-muted);
    color: var(--ff-muted);
    font-size: 12px;
    font-weight: 600;
    text-align: left;
  }

  td {
    padding: 14px 20px;
    border-top: 1px solid var(--ff-border);
    color: var(--ff-text-secondary);
    vertical-align: top;
    line-height: 20px;
  }

  code {
    color: var(--ff-text);
    font-family: 'JetBrains Mono', Consolas, monospace;
  }

  em {
    margin-left: 3px;
    color: var(--ff-danger);
    font-style: normal;
  }

  .param-type {
    display: block;
    margin-top: 4px;
    color: var(--ff-subtle);
    font-size: 11px;
  }

  .empty-row {
    color: var(--ff-subtle);
    text-align: center;
  }
`;

const JsonSample = styled.pre`
  margin: 0;
  padding: 8px 10px;
  overflow: auto;
  border: 1px solid var(--ff-border);
  border-radius: 6px;
  background: var(--ff-surface-muted);
  color: var(--ff-text-secondary);
  font-family: 'JetBrains Mono', Consolas, monospace;
  font-size: 12px;
  line-height: 18px;
  white-space: pre-wrap;
`;

const SampleBlock = styled.div`
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  padding: 16px 20px;
  border-top: 1px solid var(--ff-border);

  > div {
    display: grid;
    gap: 6px;
  }

  span {
    color: var(--ff-muted);
    font-size: 12px;
    font-weight: 600;
  }

  @media (max-width: 720px) {
    grid-template-columns: minmax(0, 1fr);
  }
`;
