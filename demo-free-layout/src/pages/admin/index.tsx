/**
 * futureFlow 管理员后台
 * 仪表盘 + 用户管理 + API Key + 工作流 + 运行记录 + 余额流水
 */

import { useState, useEffect, useCallback } from 'react';
import {
  Typography,
  Table,
  Tag,
  Button,
  Tabs,
  TabPane,
  Card,
  Spin,
  Toast,
  Modal,
  Form,
  Popconfirm,
  Empty,
  Select,
} from '@douyinfe/semi-ui';
import {
  IconDelete,
  IconUser,
  IconKey,
  IconBranch,
  IconActivity,
  IconList,
} from '@douyinfe/semi-icons';
import styled from 'styled-components';
import {
  getStats,
  listUsers,
  adjustBalance,
  updateVipLevel,
  updateUserStatus,
  deleteUser,
  listApiKeys,
  revokeApiKey,
  listWorkflows,
  listRuns,
  listBalanceLogs,
} from './api';
import { getUser } from '../../utils/auth';

type Stats = any;
type UserRow = any;
type ApiKeyRow = any;
type WorkflowRow = any;
type RunRow = any;
type BalanceLogRow = any;

/** 操作下拉选择器（提前定义，避免 TDZ 问题） */
const ActionSelect = (props: any) => (
  <Select {...props} size="small" style={{ width: 100, ...props.style }} />
);

export const AdminPage = () => {
  const me = getUser();
  const [tab, setTab] = useState('dashboard');
  const [loading, setLoading] = useState(false);

  // 各列表数据
  const [stats, setStats] = useState<Stats | null>(null);
  const [users, setUsers] = useState<{ items: UserRow[]; total: number }>({ items: [], total: 0 });
  const [apiKeys, setApiKeys] = useState<{ items: ApiKeyRow[]; total: number }>({ items: [], total: 0 });
  const [workflows, setWorkflows] = useState<{ items: WorkflowRow[]; total: number }>({ items: [], total: 0 });
  const [runs, setRuns] = useState<{ items: RunRow[]; total: number }>({ items: [], total: 0 });
  const [logs, setLogs] = useState<{ items: BalanceLogRow[]; total: number }>({ items: [], total: 0 });

  // 分页
  const [page, setPage] = useState(1);
  const pageSize = 20;

  const loadStats = useCallback(async () => {
    try {
      const s = await getStats();
      setStats(s);
    } catch (e: any) {
      Toast.error(e.message || '加载统计失败');
    }
  }, []);

  const loadTab = useCallback(
    async (key: string, p = 1) => {
      setLoading(true);
      try {
        if (key === 'dashboard') {
          await loadStats();
        } else if (key === 'users') {
          const data = await listUsers(p, pageSize);
          setUsers(data);
        } else if (key === 'apikeys') {
          const data = await listApiKeys(p, pageSize);
          setApiKeys(data);
        } else if (key === 'workflows') {
          const data = await listWorkflows(p, pageSize);
          setWorkflows(data);
        } else if (key === 'runs') {
          const data = await listRuns(p, pageSize);
          setRuns(data);
        } else if (key === 'logs') {
          const data = await listBalanceLogs(p, 50);
          setLogs(data);
        }
      } catch (e: any) {
        Toast.error(e.message || '加载数据失败');
      } finally {
        setLoading(false);
      }
    },
    [loadStats],
  );

  useEffect(() => {
    loadTab(tab, 1);
  }, [loadTab, tab]);

  const handlePageChange = (p: number) => {
    setPage(p);
    loadTab(tab, p);
  };

  const refresh = () => loadTab(tab, page);

  return (
    <PageContainer>
      <Typography.Title heading={3} style={{ marginBottom: 4, fontWeight: 600 }}>
        管理员后台
      </Typography.Title>
      <Typography.Text type="tertiary" style={{ marginBottom: 20, display: 'block' }}>
        欢迎，{me?.username}。你可以在这里管理系统用户、API Key、工作流和余额流水。
      </Typography.Text>

      <Tabs
        type="line"
        activeKey={tab}
        onChange={(k) => {
          setTab(k);
          setPage(1);
        }}
      >
        <TabPane tab={<TabIcon icon={<IconActivity />} text="仪表盘" />} itemKey="dashboard">
          <DashboardView stats={stats} loading={loading} />
        </TabPane>

        <TabPane tab={<TabIcon icon={<IconUser />} text="用户管理" />} itemKey="users">
          <UsersView
            data={users}
            loading={loading}
            page={page}
            pageSize={pageSize}
            onPageChange={handlePageChange}
            refresh={refresh}
          />
        </TabPane>

        <TabPane tab={<TabIcon icon={<IconKey />} text="API Key" />} itemKey="apikeys">
          <ApiKeysView
            data={apiKeys}
            loading={loading}
            page={page}
            pageSize={pageSize}
            onPageChange={handlePageChange}
            refresh={refresh}
          />
        </TabPane>

        <TabPane tab={<TabIcon icon={<IconBranch />} text="工作流" />} itemKey="workflows">
          <WorkflowsView
            data={workflows}
            loading={loading}
            page={page}
            pageSize={pageSize}
            onPageChange={handlePageChange}
          />
        </TabPane>

        <TabPane tab={<TabIcon icon={<IconActivity />} text="运行记录" />} itemKey="runs">
          <RunsView
            data={runs}
            loading={loading}
            page={page}
            pageSize={pageSize}
            onPageChange={handlePageChange}
          />
        </TabPane>

        <TabPane tab={<TabIcon icon={<IconList />} text="余额流水" />} itemKey="logs">
          <LogsView
            data={logs}
            loading={loading}
            page={page}
            pageSize={50}
            onPageChange={handlePageChange}
          />
        </TabPane>
      </Tabs>
    </PageContainer>
  );
};

/* ============ 仪表盘 ============ */

const DashboardView = ({ stats, loading }: { stats: Stats | null; loading: boolean }) => {
  if (loading && !stats) {
    return (
      <Center>
        <Spin size="large" />
      </Center>
    );
  }
  if (!stats) return <Empty description="暂无数据" />;

  return (
    <div>
      <StatsGrid>
        <StatCard>
          <StatLabel>注册用户</StatLabel>
          <StatValue>{stats.userCount}</StatValue>
        </StatCard>
        <StatCard>
          <StatLabel>有效 API Key</StatLabel>
          <StatValue>{stats.apiKeyCount}</StatValue>
        </StatCard>
        <StatCard>
          <StatLabel>工作流</StatLabel>
          <StatValue>{stats.workflowCount}</StatValue>
        </StatCard>
        <StatCard>
          <StatLabel>运行总次数</StatLabel>
          <StatValue>{stats.runCount}</StatValue>
        </StatCard>
        <StatCard>
          <StatLabel>Token 消耗</StatLabel>
          <StatValue $accent>{stats.totalTokens.toLocaleString()}</StatValue>
        </StatCard>
        <StatCard>
          <StatLabel>总费用（元）</StatLabel>
          <StatValue $accent>¥ {stats.totalCost.toFixed(4)}</StatValue>
        </StatCard>
      </StatsGrid>

      <Card title="最近 7 天运行趋势" style={{ marginTop: 16, borderRadius: 12 }}>
        {stats.recentRuns && stats.recentRuns.length > 0 ? (
          <TrendChart data={stats.recentRuns} />
        ) : (
          <Empty description="最近 7 天暂无运行记录" />
        )}
      </Card>
    </div>
  );
};

const TrendChart = ({ data }: { data: { date: string; count: number; tokens: number }[] }) => {
  const maxCount = Math.max(...data.map((d) => d.count), 1);
  return (
    <ChartWrap>
      {data.map((d) => (
        <Bar key={d.date}>
          <BarFill style={{ height: `${(d.count / maxCount) * 100}%` }} />
          <BarLabel>{d.date.slice(5)}</BarLabel>
          <BarCount>{d.count}</BarCount>
        </Bar>
      ))}
    </ChartWrap>
  );
};

/* ============ 用户管理 ============ */

const UsersView = ({
  data,
  loading,
  page,
  pageSize,
  onPageChange,
  refresh,
}: {
  data: { items: UserRow[]; total: number };
  loading: boolean;
  page: number;
  pageSize: number;
  onPageChange: (p: number) => void;
  refresh: () => void;
}) => {
  const [balanceModal, setBalanceModal] = useState<{ user: UserRow; visible: boolean }>({
    user: null,
    visible: false,
  });

  const handleAdjustBalance = async (values: any) => {
    try {
      await adjustBalance(balanceModal.user.id, values.delta, values.remark || '');
      Toast.success('余额已调整');
      setBalanceModal({ user: null, visible: false });
      refresh();
    } catch (e: any) {
      Toast.error(e.message || '调整失败');
    }
  };

  const handleVipChange = async (id: string, vip: string) => {
    try {
      await updateVipLevel(id, vip);
      Toast.success('VIP 等级已更新');
      refresh();
    } catch (e: any) {
      Toast.error(e.message || '更新失败');
    }
  };

  const handleStatusChange = async (id: string, status: string) => {
    try {
      await updateUserStatus(id, status);
      Toast.success('状态已更新');
      refresh();
    } catch (e: any) {
      Toast.error(e.message || '更新失败');
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteUser(id);
      Toast.success('用户已删除');
      refresh();
    } catch (e: any) {
      Toast.error(e.message || '删除失败');
    }
  };

  const columns = [
    {
      title: '用户名',
      dataIndex: 'username',
      width: 120,
      render: (t: string, r: UserRow) => (
        <span>
          {t} {r.role === 'admin' && <Tag size="small" color="orange">管理员</Tag>}
        </span>
      ),
    },
    { title: '邮箱', dataIndex: 'email', width: 180 },
    {
      title: 'VIP',
      dataIndex: 'vipLevel',
      width: 100,
      render: (vip: string, r: UserRow) => (
        <Tag
          size="small"
          color={vip === 'enterprise' ? 'purple' : vip === 'pro' ? 'blue' : 'grey'}
        >
          {vip?.toUpperCase()}
        </Tag>
      ),
    },
    {
      title: '余额',
      dataIndex: 'balance',
      width: 100,
      render: (b: number) => `¥${b?.toFixed(2)}`,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 80,
      render: (s: string) => (
        <Tag size="small" color={s === 'active' ? 'green' : 'red'}>
          {s === 'active' ? '正常' : s === 'banned' ? '封禁' : '暂停'}
        </Tag>
      ),
    },
    {
      title: '注册时间',
      dataIndex: 'createdAt',
      width: 160,
      render: (t: string) => (t ? new Date(t).toLocaleString('zh-CN') : '-'),
    },
    {
      title: '操作',
      width: 280,
      render: (_: any, r: UserRow) => (
        <ActionGroup>
          <Button
            size="small"
            onClick={() => setBalanceModal({ user: r, visible: true })}
          >
            调整余额
          </Button>
          <ActionSelect
            value={r.vipLevel}
            onChange={(v: any) => handleVipChange(r.id, v as string)}
            optionList={[
              { value: 'free', label: 'Free' },
              { value: 'pro', label: 'Pro' },
              { value: 'enterprise', label: 'Enterprise' },
            ]}
          />
          <ActionSelect
            value={r.status}
            onChange={(v: any) => handleStatusChange(r.id, v as string)}
            optionList={[
              { value: 'active', label: '正常' },
              { value: 'suspended', label: '暂停' },
              { value: 'banned', label: '封禁' },
            ]}
          />
          {r.role !== 'admin' && (
            <Popconfirm title="确认删除此用户？" onConfirm={() => handleDelete(r.id)}>
              <Button size="small" type="danger" icon={<IconDelete />}>
                删除
              </Button>
            </Popconfirm>
          )}
        </ActionGroup>
      ),
    },
  ];

  return (
    <div>
      <Table
        dataSource={data.items}
        columns={columns}
        rowKey="id"
        loading={loading}
        pagination={{
          currentPage: page,
          pageSize,
          total: data.total,
          onPageChange,
        }}
        empty={<Empty description="暂无用户" />}
      />
      <Modal
        title={`调整余额 - ${balanceModal.user?.username || ''}`}
        visible={balanceModal.visible}
        onCancel={() => setBalanceModal({ user: null, visible: false })}
        footer={null}
      >
        <Form onSubmit={handleAdjustBalance} initValues={{ delta: 0, remark: '' }}>
          <Form.InputNumber
            field="delta"
            label="变动金额（正数充值，负数扣除）"
            step={1}
            style={{ width: '100%' }}
          />
          <Form.Input
            field="remark"
            label="备注"
            placeholder="如：管理员手动充值"
          />
          <div style={{ textAlign: 'right', marginTop: 16 }}>
            <Button
              theme="solid"
              type="primary"
              htmlType="submit"
              style={{ borderRadius: 6 }}
            >
              确认调整
            </Button>
          </div>
        </Form>
      </Modal>
    </div>
  );
};

/* ============ API Key 管理 ============ */

const ApiKeysView = ({
  data,
  loading,
  page,
  pageSize,
  onPageChange,
  refresh,
}: {
  data: { items: ApiKeyRow[]; total: number };
  loading: boolean;
  page: number;
  pageSize: number;
  onPageChange: (p: number) => void;
  refresh: () => void;
}) => {
  const handleRevoke = async (id: string) => {
    try {
      await revokeApiKey(id);
      Toast.success('API Key 已吊销');
      refresh();
    } catch (e: any) {
      Toast.error(e.message || '操作失败');
    }
  };

  const columns = [
    { title: '名称', dataIndex: 'name', width: 120 },
    {
      title: 'Key 前缀',
      dataIndex: 'keyPrefix',
      width: 120,
      render: (t: string) => <code style={{ color: '#4834d4' }}>{t}...</code>,
    },
    {
      title: '所属用户',
      dataIndex: 'username',
      width: 100,
    },
    {
      title: '状态',
      dataIndex: 'revoked',
      width: 80,
      render: (r: boolean) =>
        r ? (
          <Tag size="small" color="red">已吊销</Tag>
        ) : (
          <Tag size="small" color="green">正常</Tag>
        ),
    },
    {
      title: '最后使用',
      dataIndex: 'lastUsedAt',
      width: 160,
      render: (t: string) => (t ? new Date(t).toLocaleString('zh-CN') : '从未使用'),
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      width: 160,
      render: (t: string) => (t ? new Date(t).toLocaleString('zh-CN') : '-'),
    },
    {
      title: '操作',
      width: 100,
      render: (_: any, r: ApiKeyRow) =>
        !r.revoked && (
          <Popconfirm title="确认吊销此 API Key？" onConfirm={() => handleRevoke(r.id)}>
            <Button size="small" type="danger">
              吊销
            </Button>
          </Popconfirm>
        ),
    },
  ];

  return (
    <Table
      dataSource={data.items}
      columns={columns}
      rowKey="id"
      loading={loading}
      pagination={{
        currentPage: page,
        pageSize,
        total: data.total,
        onPageChange,
      }}
      empty={<Empty description="暂无 API Key" />}
    />
  );
};

/* ============ 工作流 ============ */

const WorkflowsView = ({
  data,
  loading,
  page,
  pageSize,
  onPageChange,
}: {
  data: { items: WorkflowRow[]; total: number };
  loading: boolean;
  page: number;
  pageSize: number;
  onPageChange: (p: number) => void;
}) => {
  const columns = [
    { title: '名称', dataIndex: 'name', width: 160 },
    {
      title: '描述',
      dataIndex: 'description',
      width: 200,
      render: (t: string) => t || '暂无描述',
    },
    { title: '所属用户', dataIndex: 'username', width: 100 },
    {
      title: '版本',
      dataIndex: 'version',
      width: 60,
      render: (v: number) => `v${v}`,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 80,
      render: (s: string) => <Tag size="small">{s}</Tag>,
    },
    {
      title: '更新时间',
      dataIndex: 'updatedAt',
      width: 160,
      render: (t: string) => (t ? new Date(t).toLocaleString('zh-CN') : '-'),
    },
  ];

  return (
    <Table
      dataSource={data.items}
      columns={columns}
      rowKey="id"
      loading={loading}
      pagination={{
        currentPage: page,
        pageSize,
        total: data.total,
        onPageChange,
      }}
      empty={<Empty description="暂无工作流" />}
    />
  );
};

/* ============ 运行记录 ============ */

const RunsView = ({
  data,
  loading,
  page,
  pageSize,
  onPageChange,
}: {
  data: { items: RunRow[]; total: number };
  loading: boolean;
  page: number;
  pageSize: number;
  onPageChange: (p: number) => void;
}) => {
  const columns = [
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (s: string) => {
        const color =
          s === 'succeeded' ? 'green' : s === 'failed' ? 'red' : s === 'running' ? 'blue' : 'grey';
        const label: Record<string, string> = {
          pending: '等待中',
          running: '运行中',
          succeeded: '成功',
          failed: '失败',
        };
        return <Tag size="small" color={color}>{label[s] || s}</Tag>;
      },
    },
    { title: '用户', dataIndex: 'username', width: 100 },
    {
      title: 'Token',
      dataIndex: 'totalTokens',
      width: 100,
      render: (t: number) => (t || 0).toLocaleString(),
    },
    { title: '步数', dataIndex: 'totalSteps', width: 60 },
    {
      title: '费用',
      dataIndex: 'actualCost',
      width: 80,
      render: (c: number) => `¥${(c || 0).toFixed(4)}`,
    },
    {
      title: '耗时',
      dataIndex: 'elapsedTime',
      width: 80,
      render: (t: number) => `${(t || 0).toFixed(2)}s`,
    },
    {
      title: '错误',
      dataIndex: 'errorMessage',
      ellipsis: true,
      render: (t: string) => t || '-',
    },
    {
      title: '时间',
      dataIndex: 'createdAt',
      width: 160,
      render: (t: string) => (t ? new Date(t).toLocaleString('zh-CN') : '-'),
    },
  ];

  return (
    <Table
      dataSource={data.items}
      columns={columns}
      rowKey="id"
      loading={loading}
      pagination={{
        currentPage: page,
        pageSize,
        total: data.total,
        onPageChange,
      }}
      empty={<Empty description="暂无运行记录" />}
    />
  );
};

/* ============ 余额流水 ============ */

const LogsView = ({
  data,
  loading,
  page,
  pageSize,
  onPageChange,
}: {
  data: { items: BalanceLogRow[]; total: number };
  loading: boolean;
  page: number;
  pageSize: number;
  onPageChange: (p: number) => void;
}) => {
  const typeLabel: Record<string, string> = {
    freeze: '冻结',
    deduct: '扣费',
    unfreeze: '解冻',
    refund: '退款',
    recharge: '充值',
  };

  const columns = [
    {
      title: '类型',
      dataIndex: 'type',
      width: 80,
      render: (t: string) => <Tag size="small">{typeLabel[t] || t}</Tag>,
    },
    { title: '用户', dataIndex: 'username', width: 100 },
    {
      title: '金额',
      dataIndex: 'amount',
      width: 100,
      render: (a: number) => (
        <span style={{ color: a >= 0 ? '#00b42a' : '#f53f3f', fontWeight: 600 }}>
          {a >= 0 ? '+' : ''}{a.toFixed(4)}
        </span>
      ),
    },
    {
      title: '变动后余额',
      dataIndex: 'balanceAfter',
      width: 120,
      render: (b: number) => `¥${b.toFixed(4)}`,
    },
    { title: '备注', dataIndex: 'remark', ellipsis: true, render: (t: string) => t || '-' },
    {
      title: '时间',
      dataIndex: 'createdAt',
      width: 160,
      render: (t: string) => (t ? new Date(t).toLocaleString('zh-CN') : '-'),
    },
  ];

  return (
    <Table
      dataSource={data.items}
      columns={columns}
      rowKey="id"
      loading={loading}
      pagination={{
        currentPage: page,
        pageSize,
        total: data.total,
        onPageChange,
      }}
      empty={<Empty description="暂无流水记录" />}
    />
  );
};

/* ============ 公共样式组件 ============ */

const TabIcon = ({ icon, text }: { icon: React.ReactNode; text: string }) => (
  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
    {icon}
    {text}
  </span>
);

const PageContainer = styled.div`
  padding: 34px 38px 48px;
  height: 100%;
  overflow-y: auto;
`;

const Center = styled.div`
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 200px;
`;

const StatsGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;

  @media (max-width: 880px) { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  @media (max-width: 520px) { grid-template-columns: 1fr; }
`;

const StatCard = styled.div`
  background: #fff;
  min-height: 104px;
  border-radius: var(--ff-radius);
  padding: 20px;
  border: 1px solid var(--ff-border);
  box-shadow: var(--ff-shadow-sm);
`;

const StatLabel = styled.div`
  font-size: 13px;
  color: var(--ff-muted);
  margin-bottom: 8px;
`;

const StatValue = styled.div<{ $accent?: boolean }>`
  font-size: 28px;
  font-weight: 700;
  color: ${(p) => (p.$accent ? '#4054bf' : 'var(--ff-text)')};
`;

const ActionGroup = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
`;

const ChartWrap = styled.div`
  display: flex;
  align-items: flex-end;
  gap: 12px;
  height: 200px;
  padding: 20px 0;
  overflow-x: auto;
`;

const Bar = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  min-width: 50px;
  height: 100%;
  justify-content: flex-end;
`;

const BarFill = styled.div`
  width: 28px;
  min-height: 4px;
  background: #7d8aec;
  border-radius: 4px 4px 0 0;
  transition: height 0.3s;
`;

const BarLabel = styled.div`
  font-size: 12px;
  color: #999;
  margin-top: 6px;
`;

const BarCount = styled.div`
  font-size: 13px;
  font-weight: 600;
  color: #1a1d29;
`;
