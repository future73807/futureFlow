/**
 * 版本管理侧边面板
 *
 * 对齐画布「发布 / 回退」心智：发布会自动落一条版本，手动另存产生 manual 版本，
 * 回退只把历史快照写回草稿，线上已发布版本保持不变。
 * 面板只依赖网关的版本接口，不引用画布内部状态，方便嵌进任意页面。
 */

import { useCallback, useEffect, useState } from 'react';

import styled from 'styled-components';
import {
  Button,
  Empty,
  Input,
  Modal,
  Popconfirm,
  SideSheet,
  Spin,
  Tag,
  TextArea,
  Toast,
  Typography,
} from '@douyinfe/semi-ui';
import { IconEdit, IconHistory, IconPlus } from '@douyinfe/semi-icons';

import { apiJson } from '../../utils/api';

/** 与网关 /workflows/:id/versions 对齐；旧接口缺字段时做只读兜底 */
interface VersionItem {
  id?: string;
  version: number | string;
  /** 服务端渲染好的版本号（如 1.2）；前端永远不自行推算编号 */
  label?: string;
  comment?: string;
  source?: 'publish' | 'manual' | 'restore' | string;
  name?: string;
  description?: string;
  createdAt?: string;
  /** 早期网关只返回 publishedAt，展示时间时兜底读取 */
  publishedAt?: string;
  isPublished?: boolean;
  isLatest?: boolean;
}

export interface VersionPanelProps {
  workflowId: string;
  visible: boolean;
  onClose: () => void;
  /** 回退成功后通知画布重新加载草稿 */
  onRestored: () => void;
}

/** 兼容 { items } 与裸数组两种列表返回，并过滤掉没有版本号的脏数据 */
const normalizeItems = (payload: unknown): VersionItem[] => {
  const raw = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as any)?.items)
    ? (payload as any).items
    : [];
  const items = (raw as any[]).filter(
    (item) => item && item.version !== undefined && item.version !== null
  ) as VersionItem[];
  // 网关已按新→旧排序；这里仅在版本号全为数字时兜底排序，避免字符串版本被误判顺序。
  if (items.every((item) => Number.isFinite(Number(item.version)))) {
    return [...items].sort((a, b) => Number(b.version) - Number(a.version));
  }
  return items;
};

/**
 * 徽标以服务端 label 为准（可能不带 v，统一补上）；
 * 旧网关没有 label 时退回 version 字段，仍不自行推算 1.0→1.1 这类编号。
 */
const formatVersionLabel = (item?: Pick<VersionItem, 'label' | 'version'> | null) => {
  if (!item) return '新版本';
  const label = String(item.label ?? '').trim();
  if (label) return label.startsWith('v') ? label : `v${label}`;
  return item.version !== undefined && item.version !== null ? `v${item.version}` : '新版本';
};

/** POST 返回结构在不同网关版本间不一致（裸对象 / { item } / { version }），逐一兜底 */
const extractVersionItem = (payload: any): VersionItem | null => {
  if (!payload || typeof payload !== 'object') return null;
  const candidate =
    payload.item ??
    (payload.version && typeof payload.version === 'object' ? payload.version : payload);
  if (candidate && typeof candidate === 'object' && candidate.version !== undefined) {
    return candidate as VersionItem;
  }
  return null;
};

const formatTime = (value?: string) => {
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

/** React key / 行状态键：id 缺失时退回 version，保证每行唯一 */
const keyOf = (item: VersionItem) => String(item.id ?? item.version);

const versionPath = (workflowId: string, version: number | string) =>
  `/workflows/${encodeURIComponent(workflowId)}/versions/${encodeURIComponent(String(version))}`;

export const VersionPanel = ({ workflowId, visible, onClose, onRestored }: VersionPanelProps) => {
  const [items, setItems] = useState<VersionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveModalVisible, setSaveModalVisible] = useState(false);
  const [saveComment, setSaveComment] = useState('');
  const [savingVersion, setSavingVersion] = useState(false);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editingComment, setEditingComment] = useState('');
  const [savingComment, setSavingComment] = useState(false);
  const [restoringKey, setRestoringKey] = useState<string | null>(null);

  const loadVersions = useCallback(async (): Promise<VersionItem[]> => {
    if (!workflowId) {
      setItems([]);
      setLoading(false);
      return [];
    }
    setLoading(true);
    setLoadError(null);
    try {
      const response = await apiJson<VersionItem[] | { items?: VersionItem[] }>(
        `/workflows/${encodeURIComponent(workflowId)}/versions`
      );
      const next = normalizeItems(response);
      setItems(next);
      return next;
    } catch (error: any) {
      setLoadError(error?.message || '加载版本列表失败');
      return [];
    } finally {
      setLoading(false);
    }
  }, [workflowId]);

  useEffect(() => {
    if (!visible) return;
    void loadVersions();
  }, [visible, loadVersions]);

  // 面板关闭后清掉临时编辑态，避免下次打开残留上一次的输入内容
  useEffect(() => {
    if (visible) return;
    setEditingKey(null);
    setEditingComment('');
    setSaveModalVisible(false);
    setSaveComment('');
  }, [visible]);

  const openSaveModal = () => {
    setSaveComment('');
    setSaveModalVisible(true);
  };

  const handleSaveVersion = async () => {
    if (!workflowId) return;
    setSavingVersion(true);
    try {
      const response = await apiJson<any>(`/workflows/${encodeURIComponent(workflowId)}/versions`, {
        method: 'POST',
        body: JSON.stringify({ comment: saveComment.trim() || undefined }),
      });
      setSaveModalVisible(false);
      setSaveComment('');
      // 先刷新拿到服务端确认的新版本（含 label），再提示，避免用本地推算的编号
      const next = await loadVersions();
      const created = extractVersionItem(response) || next.find((item) => item.isLatest) || next[0];
      Toast.success(`已保存为 ${formatVersionLabel(created)}`);
    } catch (error: any) {
      // 400（草稿与最新版本一致）等业务错误直接展示服务端文案，不做二次加工
      Toast.error(error?.message || '另存版本失败');
    } finally {
      setSavingVersion(false);
    }
  };

  const startEditComment = (item: VersionItem) => {
    setEditingKey(keyOf(item));
    setEditingComment(String(item.comment || ''));
  };

  const cancelEditComment = () => {
    setEditingKey(null);
    setEditingComment('');
  };

  const handleSaveComment = async (item: VersionItem) => {
    if (!workflowId) return;
    setSavingComment(true);
    try {
      await apiJson(versionPath(workflowId, item.version), {
        method: 'PATCH',
        body: JSON.stringify({ comment: editingComment.trim() }),
      });
      cancelEditComment();
      await loadVersions();
      Toast.success('注释已更新');
    } catch (error: any) {
      Toast.error(error?.message || '更新注释失败');
    } finally {
      setSavingComment(false);
    }
  };

  const handleRestore = async (item: VersionItem) => {
    if (!workflowId) return;
    setRestoringKey(keyOf(item));
    try {
      await apiJson(`${versionPath(workflowId, item.version)}/restore`, { method: 'POST' });
      Toast.success(`已回退到 ${formatVersionLabel(item)}`);
      // 先通知画布重载草稿，再刷新列表，保证行上的「当前草稿」标记与画布一致
      onRestored();
      await loadVersions();
    } catch (error: any) {
      Toast.error(error?.message || '回退失败');
    } finally {
      setRestoringKey(null);
    }
  };

  return (
    <>
      <SideSheet
        className="version-panel-sheet"
        title="版本管理"
        visible={visible}
        width={560}
        footer={null}
        onCancel={onClose}
      >
        <PanelBody>
          <HeaderRow>
            <Button
              theme="solid"
              type="primary"
              icon={<IconPlus aria-hidden="true" />}
              onClick={openSaveModal}
            >
              另存为版本
            </Button>
          </HeaderRow>

          <Hint>
            发布会自动保存一个版本；也可以手动另存为版本，版本号按 1.0 → 1.1 → … → 1.9 → 2.0 递增。
          </Hint>

          {loading ? (
            <Center>
              <Spin tip="加载版本列表" />
            </Center>
          ) : loadError ? (
            <ErrorState>
              <Typography.Text type="danger">{loadError}</Typography.Text>
              <Button size="small" onClick={() => void loadVersions()}>
                重试
              </Button>
            </ErrorState>
          ) : items.length === 0 ? (
            <Center>
              <Empty description="暂无版本，发布或另存后会出现在这里" />
            </Center>
          ) : (
            <VersionList>
              {items.map((item) => {
                const key = keyOf(item);
                const isEditing = editingKey === key;
                return (
                  <VersionRow key={key}>
                    <RowHead>
                      {/* 时间是用户显式要求紧挨版本号展示的信息，不要挪到行尾 */}
                      <VersionBadge>{formatVersionLabel(item)}</VersionBadge>
                      <TimeText>{formatTime(item.createdAt || item.publishedAt)}</TimeText>
                      <TagRow>
                        {item.isPublished && (
                          <Tag size="small" color="green">
                            已发布
                          </Tag>
                        )}
                        {item.isLatest && (
                          <Tag size="small" color="blue">
                            当前草稿
                          </Tag>
                        )}
                      </TagRow>
                    </RowHead>

                    {isEditing ? (
                      <EditRow>
                        <Input
                          size="small"
                          value={editingComment}
                          maxLength={200}
                          placeholder="填写版本注释"
                          onChange={setEditingComment}
                          onEnterPress={() => void handleSaveComment(item)}
                        />
                        <Button
                          size="small"
                          theme="solid"
                          type="primary"
                          loading={savingComment}
                          onClick={() => void handleSaveComment(item)}
                        >
                          保存
                        </Button>
                        <Button size="small" onClick={cancelEditComment}>
                          取消
                        </Button>
                      </EditRow>
                    ) : (
                      <Comment $muted={!item.comment}>{item.comment || '暂无注释'}</Comment>
                    )}

                    <Actions>
                      <Popconfirm
                        title={`回退到 ${formatVersionLabel(item)}？`}
                        content="回退只更新草稿，不会自动发布"
                        okText="回退"
                        cancelText="取消"
                        onConfirm={() => void handleRestore(item)}
                      >
                        <Button
                          size="small"
                          icon={<IconHistory aria-hidden="true" />}
                          loading={restoringKey === key}
                        >
                          回退到此版本
                        </Button>
                      </Popconfirm>
                      {!isEditing && (
                        <Button
                          size="small"
                          icon={<IconEdit aria-hidden="true" />}
                          onClick={() => startEditComment(item)}
                        >
                          编辑注释
                        </Button>
                      )}
                      {/* 只有最新版本行能基于当前草稿再存一版，避免出现两个「另存」入口的语义歧义 */}
                      {item.isLatest && (
                        <Button
                          size="small"
                          theme="light"
                          type="primary"
                          icon={<IconPlus aria-hidden="true" />}
                          onClick={openSaveModal}
                        >
                          另存为新版本
                        </Button>
                      )}
                    </Actions>
                  </VersionRow>
                );
              })}
            </VersionList>
          )}
        </PanelBody>
      </SideSheet>

      <Modal
        title="另存为版本"
        visible={saveModalVisible}
        width={420}
        okText="保存"
        cancelText="取消"
        confirmLoading={savingVersion}
        maskClosable={false}
        onOk={() => void handleSaveVersion()}
        onCancel={() => setSaveModalVisible(false)}
      >
        <ModalCopy>把当前画布草稿保存为一个新版本，之后可以随时回退。</ModalCopy>
        <TextArea
          value={saveComment}
          maxLength={200}
          autosize={{ minRows: 3, maxRows: 6 }}
          placeholder="版本注释（可选），例如：新增知识库检索节点"
          onChange={setSaveComment}
        />
        <CharCount>{saveComment.length}/200</CharCount>
      </Modal>
    </>
  );
};

const PanelBody = styled.div`
  display: grid;
  align-content: start;
  gap: 14px;
  padding-bottom: 24px;
`;

const HeaderRow = styled.div`
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
`;

const Hint = styled.p`
  margin: 0;
  padding: 10px 12px;
  border: 1px solid var(--ff-primary-border);
  border-radius: var(--ff-radius);
  background: var(--ff-primary-soft);
  color: var(--ff-text-secondary);
  font-size: 12px;
  line-height: 18px;
`;

const Center = styled.div`
  display: grid;
  min-height: 220px;
  place-items: center;
`;

const ErrorState = styled.div`
  display: grid;
  gap: 10px;
  justify-items: center;
  padding: 36px 16px;
  border: 1px dashed var(--ff-border);
  border-radius: var(--ff-radius-lg);
  text-align: center;
`;

const VersionList = styled.ul`
  display: grid;
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
`;

const VersionRow = styled.li`
  display: grid;
  gap: 10px;
  padding: 14px 16px;
  border: 1px solid var(--ff-border);
  border-radius: var(--ff-radius-lg);
  background: var(--ff-surface);
  box-shadow: var(--ff-shadow-sm);
`;

const RowHead = styled.div`
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
`;

const VersionBadge = styled.code`
  padding: 3px 8px;
  border: 1px solid var(--ff-border);
  border-radius: 6px;
  background: var(--ff-surface-muted);
  color: var(--ff-text);
  font-family: 'JetBrains Mono', Consolas, monospace;
  font-size: 13px;
  font-weight: 600;
  line-height: 18px;
`;

const TimeText = styled.span`
  color: var(--ff-subtle);
  font-size: 12px;
  line-height: 18px;
`;

const TagRow = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
`;

const Comment = styled.p<{ $muted?: boolean }>`
  margin: 0;
  color: ${(props) => (props.$muted ? 'var(--ff-subtle)' : 'var(--ff-text-secondary)')};
  font-size: 13px;
  line-height: 20px;
  overflow-wrap: anywhere;
`;

const EditRow = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;

  .semi-input-wrapper {
    flex: 1;
  }
`;

const Actions = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
`;

const ModalCopy = styled.p`
  margin: 0 0 10px;
  color: var(--ff-muted);
  font-size: 13px;
  line-height: 20px;
`;

const CharCount = styled.div`
  margin-top: 6px;
  color: var(--ff-subtle);
  font-size: 12px;
  text-align: right;
`;
