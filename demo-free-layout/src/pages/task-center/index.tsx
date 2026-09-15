/**
 * 任务中心
 * 批量任务：把一批输入逐行投入同一张工作流执行，逐行记录结果
 * 异步任务：由 Webhook / 定时计划 / 平台 API 触发的运行记录
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button,
  Input,
  Modal,
  Progress,
  Select,
  SideSheet,
  Spin,
  Tag,
  TextArea,
  Toast,
  Typography,
} from '@douyinfe/semi-ui';
import { IconClock, IconPlus, IconRefresh } from '@douyinfe/semi-icons';
import styled from 'styled-components';

import { apiJson } from '../../utils/api';

type TaskStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';

interface BatchTaskSummary {
  id: string;
  name: string;
  workflowId: string | null;
  workflowName: string;
  mode: 'published' | 'draft';
  status: TaskStatus;
  totalCount: number;
  succeededCount: number;
  failedCount: number;
  error?: string | null;
  createdAt: string;
  finishedAt?: string | null;
}

interface BatchTaskRowResult {
  index: number;
  status: string;
  error?: string;
  outputText?: string;
  tokens?: number;
}

interface BatchTaskDetail extends BatchTaskSummary {
  inputs?: Array<Record<string, unknown>>;
  results?: BatchTaskRowResult[];
}

interface AsyncRun {
  id: string;
  workflowId: string | null;
  workflowName: string | null;
  source: string;
  status: string;
  tokens: number;
  cost: number;
  createdAt: string;
  finishedAt?: string | null;
}

interface WorkflowOption {
  id: string;
  name: string;
  publishedVersion: number | null;
  status: string;
}

const PAGE_SIZE = 20;

const STATUS_META: Record<string, { text: string; color: 'blue' | 'green' | 'red' | 'grey' | 'orange' }> = {
  pending: { text: '等待执行', color: 'grey' },
  running: { text: '执行中', color: 'blue' },
  succeeded: { text: '执行成功', color: 'green' },
  failed: { text: '执行失败', color: 'red' },
  cancelled: { text: '已取消', color: 'orange' },
};

const SOURCE_LABELS: Record<string, string> = {
  webhook: 'Webhook 触发',
  schedule: '定时计划',
  api: '平台 API',
  batch: '批量任务',
  'draft-run': '草稿试运行',
  'manual-canvas': '画布试运行',
  manual: '画布试运行',
};

const formatTime = (value?: string | null) => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
};

/** 极简 CSV 解析：支持引号包裹的字段，第一行作为输入字段名 */
const parseCsv = (text: string): Array<Record<string, string>> => {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) return [];

  const splitLine = (line: string) => {
    const cells: string[] = [];
    let current = '';
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      if (quoted) {
        if (char === '"' && line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else if (char === '"') {
          quoted = false;
        } else {
          current += char;
        }
      } else if (char === '"') {
        quoted = true;
      } else if (char === ',') {
        cells.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    cells.push(current.trim());
    return cells;
  };

  const headers = splitLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = splitLine(line);
    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      if (header) row[header] = cells[index] ?? '';
    });
    return row;
  });
};

const parseRows = (text: string): { rows: Array<Record<string, unknown>>; error?: string } => {
  const trimmed = text.trim();
  if (!trimmed) return { rows: [], error: '请填写批量输入数据' };

  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (!Array.isArray(parsed)) return { rows: [], error: 'JSON 数据必须是数组' };
      const invalid = parsed.find(
        (row) => !row || typeof row !== 'object' || Array.isArray(row),
      );
      if (invalid !== undefined) return { rows: [], error: 'JSON 数组的每一项都必须是对象' };
      return { rows: parsed as Array<Record<string, unknown>> };
    } catch {
      return { rows: [], error: 'JSON 解析失败，请检查格式' };
    }
  }

  const rows = parseCsv(trimmed);
  if (rows.length === 0) return { rows: [], error: 'CSV 至少需要表头和一行数据' };
  return { rows };
};

export const TaskCenterPage = () => {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<'batch' | 'async'>('batch');
  const [batchTasks, setBatchTasks] = useState<BatchTaskSummary[]>([]);
  const [asyncRuns, setAsyncRuns] = useState<AsyncRun[]>([]);
  const [loading, setLoading] = useState(true);
  // 手动刷新与轮询走 refreshing：只让按钮转圈，列表保持在屏幕上，避免整页被 Spin 替换
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState('全部');
  const [creatorFilter, setCreatorFilter] = useState('全部创建者');
  const [guideVisible, setGuideVisible] = useState(false);
  const [sourceFilter, setSourceFilter] = useState('全部');
  const [createVisible, setCreateVisible] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<BatchTaskDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const pollingRef = useRef<number | null>(null);

  const loadBatchTasks = useCallback(async () => {
    const params = new URLSearchParams({ page: '1', pageSize: String(PAGE_SIZE) });
    if (statusFilter !== '全部') params.set('status', statusFilter);
    const response = await apiJson<{ items: BatchTaskSummary[] }>(`/tasks/batch?${params.toString()}`);
    setBatchTasks(response?.items || []);
  }, [statusFilter]);

  const loadAsyncRuns = useCallback(async () => {
    const params = new URLSearchParams({ page: '1', pageSize: String(PAGE_SIZE) });
    if (sourceFilter !== '全部') params.set('source', sourceFilter);
    const response = await apiJson<{ items: AsyncRun[] }>(`/tasks/async?${params.toString()}`);
    setAsyncRuns(response?.items || []);
  }, [sourceFilter]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      setError(null);
      if (activeTab === 'batch') await loadBatchTasks();
      else await loadAsyncRuns();
    } catch (err: any) {
      setError(err?.message || '加载任务失败');
    } finally {
      setRefreshing(false);
      // 首屏 Spin 只在第一次请求结束后收起，之后刷新不再整块替换列表
      setLoading(false);
    }
  }, [activeTab, loadAsyncRuns, loadBatchTasks]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 有任务在跑时轮询，跑完自动停；页面隐藏时也不轮询，避免后台空转。
  useEffect(() => {
    const hasRunning =
      activeTab === 'batch'
        ? batchTasks.some((task) => task.status === 'running' || task.status === 'pending')
        : asyncRuns.some((run) => run.status === 'running' || run.status === 'pending');

    if (pollingRef.current) {
      window.clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
    if (!hasRunning) return;

    pollingRef.current = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 2500);
    return () => {
      if (pollingRef.current) window.clearInterval(pollingRef.current);
    };
  }, [activeTab, asyncRuns, batchTasks, refresh]);

  const loadDetail = useCallback(async (id: string) => {
    try {
      setDetail(await apiJson<BatchTaskDetail>(`/tasks/batch/${id}`));
    } catch (err: any) {
      Toast.error(err?.message || '加载任务详情失败');
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!detailId) {
      setDetail(null);
      return;
    }
    setDetailLoading(true);
    void loadDetail(detailId);
  }, [detailId, loadDetail]);

  useEffect(() => {
    if (!detailId || !detail) return;
    if (detail.status !== 'running' && detail.status !== 'pending') return;
    const timer = window.setInterval(() => void loadDetail(detailId), 1500);
    return () => window.clearInterval(timer);
  }, [detail, detailId, loadDetail]);

  const handleCancel = useCallback(
    async (id: string) => {
      try {
        await apiJson(`/tasks/batch/${id}/cancel`, { method: 'POST' });
        Toast.success('已请求取消');
        await refresh();
        if (detailId === id) await loadDetail(id);
      } catch (err: any) {
        Toast.error(err?.message || '取消失败');
      }
    },
    [detailId, loadDetail, refresh],
  );

  const statusOptions = useMemo(
    () => ['全部', 'running', 'succeeded', 'failed', 'cancelled'].map((value) => ({
      value,
      label: value === '全部' ? '所有状态' : STATUS_META[value]?.text || value,
    })),
    [],
  );

  const sourceOptions = useMemo(
    () =>
      ['全部', 'webhook', 'schedule', 'api'].map((value) => ({
        value,
        label: value === '全部' ? '所有来源' : SOURCE_LABELS[value] || value,
      })),
    [],
  );

  return (
    <PageContainer>
      <header className="page-head">
        <h1>任务中心</h1>
        <p className="page-sub">把一批输入逐行投入工作流执行，并跟踪 Webhook / 定时触发的异步运行。</p>
        <div className="page-actions">
          <Button
            theme="solid"
            type="primary"
            icon={<IconPlus aria-hidden="true" />}
            onClick={() => setCreateVisible(true)}
          >
            创建任务
          </Button>
        </div>
      </header>

      <TabRow>
        <TabButton type="button" $active={activeTab === 'batch'} onClick={() => setActiveTab('batch')}>
          批量任务
        </TabButton>
        <TabButton type="button" $active={activeTab === 'async'} onClick={() => setActiveTab('async')}>
          异步任务
        </TabButton>
      </TabRow>

      {/* 区块头已删除：列表本身可读，不再占用一行标题；操作与筛选统一放工具条 */}
      <div className="list-toolbar">
        <div className="toolbar-actions">
          <Button
            icon={<IconRefresh aria-hidden="true" />}
            onClick={() => void refresh()}
            loading={refreshing}
          >
            刷新
          </Button>
        </div>
        <div className="toolbar-filters">
          {activeTab === 'batch' ? (
            <>
              {/* 平台是单账号工作区，「创建者」维度只有本账号一种取值；控件形态与参考图保持一致 */}
              <Select
                value={creatorFilter}
                onChange={(value) => setCreatorFilter(String(value))}
                optionList={[
                  { value: '全部创建者', label: '全部创建者' },
                  { value: '我创建的', label: '我创建的' },
                ]}
                style={{ width: 150 }}
              />
              <Select
                value={statusFilter}
                onChange={(value) => setStatusFilter(String(value))}
                optionList={statusOptions}
                style={{ width: 150 }}
              />
            </>
          ) : (
            <Select
              value={sourceFilter}
              onChange={(value) => setSourceFilter(String(value))}
              optionList={sourceOptions}
              style={{ width: 160 }}
            />
          )}
        </div>
      </div>

      {error && (
        <ErrorBanner>
          <Typography.Text type="danger">{error}</Typography.Text>
          <Button size="small" onClick={() => void refresh()}>
            重试
          </Button>
        </ErrorBanner>
      )}

      {loading && !error ? (
        <LoadingCenter>
          <Spin size="large" tip="加载任务" />
        </LoadingCenter>
      ) : activeTab === 'batch' ? (
        batchTasks.length === 0 ? (
          <BatchEmptyState
            onCreate={() => setCreateVisible(true)}
            onGuide={() => setGuideVisible(true)}
          />
        ) : (
          <TaskList>
            {batchTasks.map((task) => (
              <TaskCard key={task.id} type="button" onClick={() => setDetailId(task.id)}>
                <TaskCardMain>
                  <TaskNameRow>
                    <strong>{task.name}</strong>
                    <Tag size="small" color={STATUS_META[task.status]?.color || 'grey'}>
                      {STATUS_META[task.status]?.text || task.status}
                    </Tag>
                    <Tag size="small" type="ghost">
                      {task.mode === 'draft' ? '草稿' : '已发布'}
                    </Tag>
                  </TaskNameRow>
                  <TaskMeta>
                    <span>工作流：{task.workflowName || '已删除的工作流'}</span>
                    <span>创建于 {formatTime(task.createdAt)}</span>
                    {task.finishedAt && <span>完成于 {formatTime(task.finishedAt)}</span>}
                  </TaskMeta>
                  <Progress
                    percent={
                      task.totalCount > 0
                        ? Math.round(((task.succeededCount + task.failedCount) / task.totalCount) * 100)
                        : 0
                    }
                    showInfo={false}
                    stroke={
                      task.failedCount > 0 && task.status !== 'running' ? 'var(--ff-danger)' : undefined
                    }
                  />
                </TaskCardMain>
                <TaskCardSide>
                  <TaskCounts>
                    <b>
                      {task.succeededCount}/{task.totalCount}
                    </b>
                    <span>成功 / 总数</span>
                  </TaskCounts>
                  {task.failedCount > 0 && <TaskFailCount>失败 {task.failedCount}</TaskFailCount>}
                  {(task.status === 'running' || task.status === 'pending') && (
                    <Button
                      size="small"
                      type="danger"
                      theme="borderless"
                      onClick={(event) => {
                        event.stopPropagation();
                        void handleCancel(task.id);
                      }}
                    >
                      取消
                    </Button>
                  )}
                </TaskCardSide>
              </TaskCard>
            ))}
          </TaskList>
        )
      ) : asyncRuns.length === 0 ? (
        <SimpleEmptyState>
          <IconClock size="large" />
          <strong>暂无异步任务</strong>
          <p>在工作流里配置 Webhook 或定时触发计划后，每次触发都会在这里留下运行记录。</p>
          <Button theme="borderless" type="primary" onClick={() => navigate('/')}>
            去配置触发方式
          </Button>
        </SimpleEmptyState>
      ) : (
        <TaskList>
          {asyncRuns.map((run) => (
            <TaskCard key={run.id} type="button" onClick={() => run.workflowId && navigate(`/canvas/${run.workflowId}`)}>
              <TaskCardMain>
                <TaskNameRow>
                  <strong>{run.workflowName || '画布试运行'}</strong>
                  <Tag size="small" color={STATUS_META[run.status]?.color || 'grey'}>
                    {STATUS_META[run.status]?.text || run.status}
                  </Tag>
                  <Tag size="small" type="ghost">
                    {SOURCE_LABELS[run.source] || run.source}
                  </Tag>
                </TaskNameRow>
                <TaskMeta>
                  <span>开始于 {formatTime(run.createdAt)}</span>
                  {run.finishedAt && <span>完成于 {formatTime(run.finishedAt)}</span>}
                  <span>令牌 {run.tokens || 0}</span>
                  <span>费用 ¥{Number(run.cost || 0).toFixed(4)}</span>
                </TaskMeta>
              </TaskCardMain>
            </TaskCard>
          ))}
        </TaskList>
      )}

      <CreateTaskModal
        visible={createVisible}
        onCancel={() => setCreateVisible(false)}
        onCreated={(taskId) => {
          setCreateVisible(false);
          setActiveTab('batch');
          void refresh();
          setDetailId(taskId);
        }}
      />

      <Modal
        title="批量任务怎么用"
        visible={guideVisible}
        onCancel={() => setGuideVisible(false)}
        footer={
          <Button theme="solid" type="primary" onClick={() => setGuideVisible(false)}>
            我知道了
          </Button>
        }
        width={520}
      >
        <GuideList>
          <li>
            <b>1. 选择任务对象</b>
            <span>先把工作流编排好；批量任务支持「已发布版本」与「当前草稿」两种执行模式。</span>
          </li>
          <li>
            <b>2. 填写任务数据</b>
            <span>用 CSV（首行为字段名）或 JSON 数组提供每行输入，字段名要和开始节点的输入参数一致。</span>
          </li>
          <li>
            <b>3. 批量任务执行</b>
            <span>任务创建后逐行串行执行，每行结束即写入进度，列表里可以直接看到成功率。</span>
          </li>
          <li>
            <b>4. 查看任务结果</b>
            <span>点开任务详情可以查看每行输出、令牌用量和失败原因，运行中的任务可以取消。</span>
          </li>
        </GuideList>
      </Modal>

      <SideSheet
        title="任务详情"
        visible={!!detailId}
        width={560}
        footer={null}
        onCancel={() => setDetailId(null)}
      >
        {detailLoading || !detail ? (
          <LoadingCenter>
            <Spin size="large" tip="加载任务详情" />
          </LoadingCenter>
        ) : (
          <DetailBody>
            <DetailHead>
              <strong>{detail.name}</strong>
              <Tag size="small" color={STATUS_META[detail.status]?.color || 'grey'}>
                {STATUS_META[detail.status]?.text || detail.status}
              </Tag>
            </DetailHead>
            <DetailMeta>
              <span>工作流：{detail.workflowName || '已删除的工作流'}</span>
              <span>执行模式：{detail.mode === 'draft' ? '当前草稿' : '已发布版本'}</span>
              <span>
                进度：{detail.succeededCount + detail.failedCount}/{detail.totalCount}（失败{' '}
                {detail.failedCount}）
              </span>
              <span>创建于 {formatTime(detail.createdAt)}</span>
            </DetailMeta>
            {detail.error && (
              <ErrorBanner>
                <Typography.Text type="danger">{detail.error}</Typography.Text>
              </ErrorBanner>
            )}
            <DetailRows>
              {(detail.results || []).map((row) => (
                <DetailRow key={row.index}>
                  <DetailRowHead>
                    <b>第 {row.index + 1} 行</b>
                    <Tag size="small" color={STATUS_META[row.status]?.color || 'grey'}>
                      {STATUS_META[row.status]?.text || row.status}
                    </Tag>
                    {row.tokens ? <span className="tokens">{row.tokens} 令牌</span> : null}
                  </DetailRowHead>
                  {row.error && <p className="row-error">{row.error}</p>}
                  {row.outputText && <pre className="row-output">{row.outputText}</pre>}
                </DetailRow>
              ))}
              {!(detail.results || []).length && (
                <SimpleEmptyState>
                  <strong>还没有执行结果</strong>
                  <p>任务开始后这里会逐行显示输出。</p>
                </SimpleEmptyState>
              )}
            </DetailRows>
          </DetailBody>
        )}
      </SideSheet>
    </PageContainer>
  );
};

const BatchEmptyState = ({ onCreate, onGuide }: { onCreate: () => void; onGuide: () => void }) => (
  <EmptyWrap>
    <EmptyTitle>futureFlow 批量任务，让我们开始吧！</EmptyTitle>
    <EmptySubtitle>批量任务可以让你配置一批工作流输入，逐行驱动同一张工作流执行。</EmptySubtitle>
    <StepRow>
      <Step>
        <StepArt>
          <StepArtPick />
        </StepArt>
        <strong>选择任务对象</strong>
        <p>选择一张工作流作为批量任务的执行对象。</p>
      </Step>
      <StepArrow>→</StepArrow>
      <Step>
        <StepArt>
          <StepArtData />
        </StepArt>
        <strong>填写任务数据</strong>
        <p>用 CSV 或 JSON 数组提供每行的输入参数。</p>
      </Step>
      <StepArrow>→</StepArrow>
      <Step>
        <StepArt>
          <StepArtRun />
        </StepArt>
        <strong>批量任务执行</strong>
        <p>逐行读取输入并驱动工作流执行。</p>
      </Step>
      <StepArrow>→</StepArrow>
      <Step>
        <StepArt>
          <StepArtResult />
        </StepArt>
        <strong>查看任务结果</strong>
        <p>执行完成后在任务详情里查看每行输出。</p>
      </Step>
    </StepRow>
    <Button theme="solid" type="primary" icon={<IconPlus aria-hidden="true" />} onClick={onCreate}>
      创建批量任务
    </Button>
    <GuideLink type="button" onClick={onGuide}>
      新手必看
    </GuideLink>
  </EmptyWrap>
);

/** 四步引导插图：扁平线稿 + 单一强调色，避免为帮助区引入位图资源 */
const StepArtPick = () => (
  <svg width="128" height="76" viewBox="0 0 128 76" fill="none" aria-hidden="true">
    <rect x="10" y="14" width="58" height="14" rx="4" fill="#ecfdf3" />
    <rect x="10" y="34" width="46" height="8" rx="4" fill="#f1f3f7" />
    <rect x="10" y="48" width="52" height="8" rx="4" fill="#f1f3f7" />
    <rect x="80" y="22" width="38" height="30" rx="6" fill="#eef4ff" stroke="#c7d7fb" />
    <path d="M92 37l6 6 12-13" stroke="#2563eb" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const StepArtData = () => (
  <svg width="128" height="76" viewBox="0 0 128 76" fill="none" aria-hidden="true">
    <rect x="24" y="8" width="58" height="60" rx="6" fill="#ffffff" stroke="#dbe0e8" />
    <rect x="34" y="18" width="20" height="7" rx="3.5" fill="#ecfdf3" />
    <rect x="34" y="32" width="38" height="6" rx="3" fill="#f1f3f7" />
    <rect x="34" y="44" width="38" height="6" rx="3" fill="#f1f3f7" />
    <circle cx="96" cy="46" r="16" fill="#ecfdf3" />
    <path d="M96 38v16M88 46h16" stroke="#16803c" strokeWidth="2.6" strokeLinecap="round" />
  </svg>
);

const StepArtRun = () => (
  <svg width="128" height="76" viewBox="0 0 128 76" fill="none" aria-hidden="true">
    <circle cx="30" cy="38" r="9" fill="#eef4ff" stroke="#c7d7fb" strokeWidth="2" />
    <circle cx="64" cy="20" r="7" fill="#ecfdf3" stroke="#bfe6cd" strokeWidth="2" />
    <circle cx="64" cy="56" r="7" fill="#ecfdf3" stroke="#bfe6cd" strokeWidth="2" />
    <circle cx="100" cy="38" r="9" fill="#fff6e8" stroke="#f4d8ac" strokeWidth="2" />
    <path d="M38 34l18-11M38 42l18 11M71 22l21 12M71 54l21-12" stroke="#c9cdd4" strokeWidth="2" strokeLinecap="round" />
    <path d="M97 34l3 4 6-8" stroke="#b54708" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const StepArtResult = () => (
  <svg width="128" height="76" viewBox="0 0 128 76" fill="none" aria-hidden="true">
    <rect x="16" y="10" width="96" height="56" rx="6" fill="#ffffff" stroke="#dbe0e8" />
    <rect x="26" y="20" width="34" height="8" rx="4" fill="#eef4ff" />
    <rect x="66" y="20" width="36" height="8" rx="4" fill="#ecfdf3" />
    <rect x="26" y="34" width="34" height="8" rx="4" fill="#f1f3f7" />
    <rect x="66" y="34" width="36" height="8" rx="4" fill="#f1f3f7" />
    <rect x="26" y="48" width="76" height="8" rx="4" fill="#f1f3f7" />
  </svg>
);

const CreateTaskModal = ({
  visible,
  onCancel,
  onCreated,
}: {
  visible: boolean;
  onCancel: () => void;
  onCreated: (taskId: string) => void;
}) => {
  const [workflows, setWorkflows] = useState<WorkflowOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [workflowId, setWorkflowId] = useState('');
  const [mode, setMode] = useState<'published' | 'draft'>('published');
  const [name, setName] = useState('');
  const [dataText, setDataText] = useState('');
  const [formError, setFormError] = useState('');

  useEffect(() => {
    if (!visible) return;
    setLoading(true);
    setFormError('');
    apiJson<WorkflowOption[]>('/workflows')
      .then((list) => {
        setWorkflows(list || []);
        const firstPublished = (list || []).find((item) => item.publishedVersion);
        const first = firstPublished || (list || [])[0];
        if (first) {
          setWorkflowId(first.id);
          setMode(first.publishedVersion ? 'published' : 'draft');
          setName(`批量任务-${first.name}`);
        }
      })
      .catch((err: any) => setFormError(err?.message || '加载工作流失败'))
      .finally(() => setLoading(false));
  }, [visible]);

  const parsed = useMemo(() => parseRows(dataText), [dataText]);
  const selected = workflows.find((item) => item.id === workflowId);
  const previewFields = useMemo(() => {
    const first = parsed.rows[0];
    return first ? Object.keys(first).slice(0, 8) : [];
  }, [parsed.rows]);

  const handleSubmit = useCallback(async () => {
    if (!workflowId) {
      setFormError('请选择要执行的工作流');
      return;
    }
    if (!parsed.rows.length) {
      setFormError(parsed.error || '请填写批量输入数据');
      return;
    }
    if (parsed.rows.length > 200) {
      setFormError('单次批量任务最多 200 行输入');
      return;
    }
    setSubmitting(true);
    setFormError('');
    try {
      const task = await apiJson<BatchTaskSummary>('/tasks/batch', {
        method: 'POST',
        body: JSON.stringify({
          workflowId,
          name: name.trim() || '批量任务',
          mode,
          inputs: parsed.rows,
        }),
      });
      Toast.success(`已创建批量任务，共 ${parsed.rows.length} 行`);
      setDataText('');
      onCreated(task.id);
    } catch (err: any) {
      setFormError(err?.message || '创建任务失败');
    } finally {
      setSubmitting(false);
    }
  }, [mode, name, onCreated, parsed, workflowId]);

  return (
    <Modal
      title="创建批量任务"
      visible={visible}
      onCancel={onCancel}
      onOk={() => void handleSubmit()}
      okText="开始执行"
      cancelText="取消"
      confirmLoading={submitting}
      width={620}
      maskClosable={false}
    >
      {loading ? (
        <LoadingCenter>
          <Spin tip="加载工作流" />
        </LoadingCenter>
      ) : (
        <ModalBody>
          <Field>
            <label>执行工作流</label>
            <Select
              value={workflowId}
              onChange={(value) => {
                const nextId = String(value);
                setWorkflowId(nextId);
                const target = workflows.find((item) => item.id === nextId);
                if (target) {
                  setMode(target.publishedVersion ? 'published' : 'draft');
                  setName(`批量任务-${target.name}`);
                }
              }}
              style={{ width: '100%' }}
              optionList={workflows.map((item) => ({
                value: item.id,
                label: item.publishedVersion ? `${item.name}（已发布 v${item.publishedVersion}）` : `${item.name}（未发布）`,
              }))}
              placeholder="选择工作流"
            />
          </Field>

          <Field>
            <label>执行模式</label>
            <Select
              value={mode}
              onChange={(value) => setMode(String(value) as 'published' | 'draft')}
              style={{ width: '100%' }}
              optionList={[
                {
                  value: 'published',
                  label: '已发布版本',
                  disabled: !selected?.publishedVersion,
                },
                { value: 'draft', label: '当前草稿（导入沙箱执行）' },
              ]}
            />
            {!selected?.publishedVersion && (
              <small>该工作流尚未发布，只能以草稿模式执行。</small>
            )}
          </Field>

          <Field>
            <label>任务名称</label>
            <Input value={name} onChange={setName} placeholder="便于识别的任务名称" />
          </Field>

          <Field>
            <label>任务数据</label>
            <TextArea
              value={dataText}
              onChange={setDataText}
              autosize={{ minRows: 6, maxRows: 12 }}
              placeholder={'CSV（首行为字段名）：\nquery\n你好\n介绍一下你自己\n\n或 JSON 数组：\n[{"query":"你好"}]'}
            />
            <small>
              {parsed.rows.length > 0
                ? `已解析 ${parsed.rows.length} 行${previewFields.length ? `，字段：${previewFields.join(' / ')}` : ''}`
                : parsed.error || 'CSV 首行为字段名，字段需与开始节点的输入参数一致'}
            </small>
          </Field>

          {formError && <Typography.Text type="danger">{formError}</Typography.Text>}
        </ModalBody>
      )}
    </Modal>
  );
};

const PageContainer = styled.div`
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  gap: 16px;
  padding: 26px 32px 40px;
  overflow: auto;
  background: var(--ff-page);

  @media (max-width: 720px) {
    padding: 16px 14px 32px;
  }
`;

const TabRow = styled.div`
  display: flex;
  gap: 22px;
  border-bottom: 1px solid var(--ff-border);
`;

const TabButton = styled.button<{ $active: boolean }>`
  position: relative;
  padding: 0 2px 12px;
  border: 0;
  background: transparent;
  color: ${(props) => (props.$active ? 'var(--ff-primary)' : 'var(--ff-text-secondary)')};
  cursor: pointer;
  font-size: 15px;
  font-weight: ${(props) => (props.$active ? 600 : 400)};

  &::after {
    position: absolute;
    right: 0;
    bottom: -1px;
    left: 0;
    height: 2px;
    background: ${(props) => (props.$active ? 'var(--ff-primary)' : 'transparent')};
    content: '';
  }
`;

const ErrorBanner = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  border: 1px solid var(--ff-danger-border);
  border-radius: var(--ff-radius);
  background: var(--ff-danger-soft);
`;

const LoadingCenter = styled.div`
  display: grid;
  min-height: 240px;
  place-items: center;
`;

const TaskList = styled.div`
  display: grid;
  gap: 10px;
`;

const TaskCard = styled.button`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 16px 18px;
  border: 1px solid var(--ff-border);
  border-radius: var(--ff-radius-lg);
  background: var(--ff-surface);
  box-shadow: var(--ff-shadow-sm);
  cursor: pointer;
  text-align: left;
  transition: border-color 140ms ease;

  &:hover {
    border-color: var(--ff-border-hover);
  }
`;

const TaskCardMain = styled.div`
  display: grid;
  min-width: 0;
  flex: 1;
  gap: 8px;
`;

const TaskNameRow = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;

  strong {
    overflow: hidden;
    color: var(--ff-text);
    font-size: 15px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
`;

const TaskMeta = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  color: var(--ff-muted);
  font-size: 12px;
`;

const TaskCardSide = styled.div`
  display: grid;
  flex: 0 0 auto;
  justify-items: end;
  gap: 6px;
`;

const TaskCounts = styled.div`
  display: grid;
  justify-items: end;

  b {
    color: var(--ff-text);
    font-size: 18px;
    font-weight: 600;
  }

  span {
    color: var(--ff-subtle);
    font-size: 11px;
  }
`;

const TaskFailCount = styled.span`
  color: var(--ff-danger);
  font-size: 12px;
`;

const EmptyWrap = styled.div`
  display: grid;
  justify-items: center;
  gap: 10px;
  padding: 46px 20px 54px;
  border: 1px solid var(--ff-border);
  border-radius: var(--ff-radius-lg);
  background: var(--ff-surface);
`;

const GuideLink = styled.button`
  margin-top: 12px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--ff-primary);
  cursor: pointer;
  font-size: 13px;

  &:hover {
    color: var(--ff-primary-hover);
    text-decoration: underline;
  }
`;

const EmptyTitle = styled.h2`
  margin: 0;
  color: var(--ff-text);
  font-size: 22px;
`;

const EmptySubtitle = styled.p`
  margin: 0 0 22px;
  color: var(--ff-muted);
  font-size: 14px;
`;

const StepRow = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: center;
  gap: 10px;
  margin-bottom: 26px;
`;

const Step = styled.div`
  display: grid;
  width: 190px;
  justify-items: center;
  gap: 6px;
  text-align: center;

  strong {
    color: var(--ff-text);
    font-size: 14px;
  }

  p {
    margin: 0;
    color: var(--ff-muted);
    font-size: 12px;
    line-height: 18px;
  }
`;

const StepArt = styled.div`
  display: grid;
  place-items: center;
`;

const GuideList = styled.ul`
  display: grid;
  gap: 14px;
  margin: 0;
  padding: 0;
  list-style: none;

  li {
    display: grid;
    gap: 4px;
  }

  b {
    color: var(--ff-text);
    font-size: 14px;
  }

  span {
    color: var(--ff-muted);
    font-size: 13px;
    line-height: 20px;
  }
`;

const StepArrow = styled.span`
  margin-top: 22px;
  color: var(--ff-border-hover);
  font-size: 16px;
`;

const SimpleEmptyState = styled.div`
  display: grid;
  justify-items: center;
  gap: 8px;
  padding: 48px 20px;
  color: var(--ff-subtle);
  text-align: center;

  strong {
    color: var(--ff-text);
    font-size: 15px;
  }

  p {
    max-width: 420px;
    margin: 0;
    font-size: 13px;
    line-height: 20px;
  }
`;

const DetailBody = styled.div`
  display: grid;
  gap: 14px;
`;

const DetailHead = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;

  strong {
    color: var(--ff-text);
    font-size: 17px;
  }
`;

const DetailMeta = styled.div`
  display: grid;
  gap: 4px;
  color: var(--ff-muted);
  font-size: 13px;
`;

const DetailRows = styled.div`
  display: grid;
  gap: 10px;
`;

const DetailRow = styled.div`
  display: grid;
  gap: 8px;
  padding: 12px 14px;
  border: 1px solid var(--ff-border);
  border-radius: var(--ff-radius);
  background: var(--ff-surface);

  .row-error {
    margin: 0;
    color: var(--ff-danger);
    font-size: 12px;
  }

  .row-output {
    max-height: 220px;
    margin: 0;
    padding: 10px;
    overflow: auto;
    border-radius: 6px;
    background: var(--ff-surface-muted);
    color: var(--ff-text-secondary);
    font-family: 'JetBrains Mono', Consolas, monospace;
    font-size: 12px;
    line-height: 18px;
    white-space: pre-wrap;
  }
`;

const DetailRowHead = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;

  b {
    color: var(--ff-text);
    font-size: 13px;
  }

  .tokens {
    margin-left: auto;
    color: var(--ff-subtle);
    font-size: 12px;
  }
`;

const ModalBody = styled.div`
  display: grid;
  gap: 16px;
`;

const Field = styled.div`
  display: grid;
  gap: 6px;

  label {
    color: var(--ff-text);
    font-size: 13px;
    font-weight: 600;
  }

  small {
    color: var(--ff-subtle);
    font-size: 12px;
  }
`;
