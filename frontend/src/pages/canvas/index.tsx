import { useCallback, useEffect, useRef, useState } from 'react';

import { useNavigate, useParams } from 'react-router-dom';
import { Button, Dropdown, Input, Modal, SideSheet, Spin, Tag, Toast, Tooltip, Typography } from '@douyinfe/semi-ui';
import {
  IconArrowLeft,
  IconBranch,
  IconCopy,
  IconDelete,
  IconDownload,
  IconHistory,
  IconMore,
  IconSave,
  IconSend,
} from '@douyinfe/semi-icons';
import { DockedPanelLayer } from '@flowgram.ai/panel-manager-plugin';
import {
  EditorRenderer,
  FreeLayoutEditorProvider,
  useClientContext,
  type FreeLayoutPluginContext,
} from '@flowgram.ai/free-layout-editor';
import { LocaleProvider as SemiLocaleProvider } from '@douyinfe/semi-ui';
import zh_CN from '@douyinfe/semi-ui/lib/es/locale/source/zh_CN';
import './canvas.css';
import '@flowgram.ai/free-layout-editor/index.css';
import '../../styles/index.css';
import { nodeRegistries } from '../../nodes';
import { useEditorProps } from '../../hooks';
import { GatewayRunButton } from '../../components/gateway-run';
import { CanvasNodeSearch } from './node-search';
import { VersionPanel } from '../../components/version-panel';
import { buildWorkflowExport, downloadJsonFile } from '../../utils/workflow-io';
import { formatVersionLabel } from '../../utils/version';
import { GetGlobalVariableSchema } from '../../plugins/variable-panel-plugin';
import { ApiError, apiJson } from '../../utils/api';
import { normalizeCanvasLocale } from '../../utils/normalize-canvas-data';
import { registerSaveHook } from '../../utils/save-registry';
import { LocalizedSchemaTypeProvider } from '../../form-components/localized-materials';

const AUTOSAVE_DELAY = 1500;

type SaveStatus = 'saved' | 'unsaved' | 'saving' | 'error';

export const CanvasPage = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [workflowName, setWorkflowName] = useState('');
  const [flowgramData, setFlowgramData] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved');
  const [workflowDescription, setWorkflowDescription] = useState('');
  const [publishedVersion, setPublishedVersion] = useState<number | null>(null);
  // 是否存在「已保存但尚未发布」的改动：编辑即置位，发布成功才复位。
  const [publishDirty, setPublishDirty] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [versionsVisible, setVersionsVisible] = useState(false);
  const [runsVisible, setRunsVisible] = useState(false);
  const [runs, setRuns] = useState<any[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [editorReady, setEditorReady] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const [changeRevision, setChangeRevision] = useState(0);
  const editorRef = useRef<FreeLayoutPluginContext | null>(null);
  const revisionRef = useRef(0);
  const savedRevisionRef = useRef(0);
  const saveInFlightRef = useRef(false);
  const saveQueuedRef = useRef(false);
  const unmountedRef = useRef(false);
  const saveRunnerRef = useRef<(showToast?: boolean) => Promise<void>>(async () => undefined);

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
    };
  }, []);

  useEffect(() => {
    const loadWorkflow = async () => {
      if (!id) {
        navigate('/', { replace: true });
        return;
      }
      try {
        const workflow = await apiJson<{
          name: string;
          description?: string;
          publishedVersion?: number | null;
          flowgramJson?: any;
        }>('/workflows/' + id);
        setWorkflowName(workflow.name);
        setWorkflowDescription(workflow.description || '');
        setPublishedVersion(workflow.publishedVersion || null);
        setFlowgramData(normalizeCanvasLocale(workflow.flowgramJson || { nodes: [], edges: [] }));
      } catch (error: any) {
        if (error instanceof ApiError && error.status === 401) return;
        Toast.error(error.message || '加载工作流失败');
        navigate('/', { replace: true });
      } finally {
        setLoading(false);
      }
    };

    void loadWorkflow();
  }, [id, navigate]);

  const markDirty = useCallback(() => {
    revisionRef.current += 1;
    setChangeRevision(revisionRef.current);
    setSaveStatus('unsaved');
    setPublishDirty(true);
  }, []);

  const handleEditorReady = useCallback((context: FreeLayoutPluginContext) => {
    editorRef.current = context;
    setEditorReady(true);
  }, []);

  const saveWorkflow = useCallback(async (showToast = false) => {
    if (!id || !editorRef.current) {
      if (showToast) Toast.warning('编辑器尚未就绪');
      return;
    }

    const trimmedName = workflowName.trim();
    if (!trimmedName) {
      setSaveStatus('error');
      if (showToast) Toast.warning('工作流名称不能为空');
      return;
    }

    if (saveInFlightRef.current) {
      saveQueuedRef.current = true;
      return;
    }

    if (showToast && revisionRef.current === savedRevisionRef.current) {
      Toast.info('当前内容已保存');
      return;
    }

    const revisionToSave = revisionRef.current;
    saveInFlightRef.current = true;
    setSaving(true);
    setSaveStatus('saving');

    try {
      const context = editorRef.current;
      const flowgramJson = {
        ...context.document.toJSON(),
        globalVariable: context.get<GetGlobalVariableSchema>(GetGlobalVariableSchema)(),
      };
      await apiJson('/workflows/' + id, {
        method: 'PUT',
        body: JSON.stringify({
          name: trimmedName,
          flowgram: JSON.stringify(flowgramJson),
        }),
      });

      savedRevisionRef.current = revisionToSave;
      setLastSavedAt(new Date());
      if (revisionRef.current === revisionToSave) {
        setSaveStatus('saved');
      } else {
        setSaveStatus('unsaved');
        saveQueuedRef.current = true;
      }
      if (showToast) Toast.success('已保存');
    } catch (error: any) {
      setSaveStatus('error');
      if (error instanceof ApiError && error.status === 401) {
        saveQueuedRef.current = false;
        return;
      }
      if (showToast) Toast.error('保存失败: ' + (error?.message || '网络错误'));
    } finally {
      setSaving(false);
      saveInFlightRef.current = false;

      const shouldSaveAgain = saveQueuedRef.current;
      saveQueuedRef.current = false;
      if (shouldSaveAgain && !unmountedRef.current) {
        window.setTimeout(() => void saveRunnerRef.current(false), 0);
      }
    }
  }, [id, workflowName]);

  saveRunnerRef.current = saveWorkflow;

  // 云端试运行等组件执行前通过该钩子强制落盘草稿，避免自动保存延迟造成旧草稿竞态。
  useEffect(() => {
    registerSaveHook(async () => {
      if (revisionRef.current !== savedRevisionRef.current || saveInFlightRef.current) {
        await saveRunnerRef.current(false);
      }
    });
    return () => registerSaveHook(null);
  }, []);

  useEffect(() => {
    if (changeRevision === savedRevisionRef.current) return;
    const timer = window.setTimeout(() => {
      void saveWorkflow(false);
    }, AUTOSAVE_DELAY);
    return () => window.clearTimeout(timer);
  }, [changeRevision, saveWorkflow]);

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (revisionRef.current !== savedRevisionRef.current || saveInFlightRef.current) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void saveWorkflow(true);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [saveWorkflow]);

  const handlePublish = useCallback(async () => {
    if (!id) return;
    const trimmedName = workflowName.trim();
    if (!trimmedName) {
      Toast.warning('工作流名称不能为空');
      return;
    }
    setPublishing(true);
    try {
      // 发布读的是服务端快照，必须先把画布上的改动落盘，否则会发布旧版本。
      if (revisionRef.current !== savedRevisionRef.current) {
        await saveRunnerRef.current(false);
      }
      const result = await apiJson<{ workflow: { publishedVersion: number }; message?: string }>(
        `/workflows/${id}/publish`,
        { method: 'POST' },
      );
      setPublishedVersion(result?.workflow?.publishedVersion ?? null);
      setPublishDirty(false);
      Toast.success(result?.message || '已发布');
    } catch (error: any) {
      Toast.error(error?.message || '发布失败');
    } finally {
      setPublishing(false);
    }
  }, [id, workflowName]);

  const openRuns = useCallback(async () => {
    if (!id) return;
    setRunsVisible(true);
    setRunsLoading(true);
    try {
      const response = await apiJson<any>(`/workflows/${id}/runs?page=1&pageSize=20`);
      setRuns(response?.items || []);
    } catch (error: any) {
      Toast.error(error?.message || '加载运行记录失败');
    } finally {
      setRunsLoading(false);
    }
  }, [id]);

  const handleExport = useCallback(() => {
    const context = editorRef.current;
    if (!context) {
      Toast.warning('编辑器尚未就绪');
      return;
    }
    const flowgram = context.document.toJSON();
    downloadJsonFile(
      workflowName.trim() || 'workflow',
      buildWorkflowExport(workflowName.trim(), workflowDescription, flowgram as any),
    );
    Toast.success('已导出工作流文件');
  }, [workflowDescription, workflowName]);

  const handleRestored = useCallback(() => {
    // 回退只改服务端草稿，画布必须重新拉一次，否则用户还在看旧图
    if (!id) return;
    apiJson<{ name: string; description?: string; publishedVersion?: number | null; flowgramJson?: any }>(
      '/workflows/' + id,
    )
      .then((workflow) => {
        setWorkflowName(workflow.name);
        setWorkflowDescription(workflow.description || '');
        setPublishedVersion(workflow.publishedVersion || null);
        setFlowgramData(normalizeCanvasLocale(workflow.flowgramJson || { nodes: [], edges: [] }));
        setPublishDirty(true);
        setChangeRevision((previous) => previous + 1);
      })
      .catch((error: any) => Toast.error(error?.message || '重新加载画布失败'));
  }, [id]);

  const handleDuplicate = useCallback(async () => {
    if (!id) return;
    try {
      const copy = await apiJson<{ id: string }>(`/workflows/${id}/duplicate`, { method: 'POST' });
      Toast.success('已复制工作流');
      navigate(`/canvas/${copy.id}`);
    } catch (error: any) {
      Toast.error(error?.message || '复制失败');
    }
  }, [id, navigate]);

  const handleDelete = useCallback(() => {
    if (!id) return;
    Modal.confirm({
      title: '删除工作流',
      content: '删除后草稿与版本历史都会移除，确定继续吗？',
      okText: '删除',
      cancelText: '取消',
      onOk: async () => {
        try {
          await apiJson(`/workflows/${id}`, { method: 'DELETE' });
          Toast.success('已删除');
          navigate('/');
        } catch (error: any) {
          Toast.error(error?.message || '删除失败');
        }
      },
    });
  }, [id, navigate]);

  const handleBack = useCallback(() => {
    const hasPendingWork = revisionRef.current !== savedRevisionRef.current || saveInFlightRef.current;
    if (hasPendingWork && !window.confirm('当前更改尚未保存完成，确定要离开吗？')) return;
    navigate('/');
  }, [navigate]);

  const saveStatusText = (() => {
    if (saveStatus === 'saving') return '正在自动保存';
    if (saveStatus === 'unsaved') return '有未保存更改';
    if (saveStatus === 'error') return '自动保存失败，请手动重试';
    if (!lastSavedAt) return '已保存';
    return '已保存 ' + lastSavedAt.toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
    });
  })();

  if (loading) {
    return (
      <div className="canvas-loading">
        <div className="loading-inline">
          <Spin size="small" />
          <span>加载画布</span>
        </div>
      </div>
    );
  }

  return (
    <main className="canvas-page">
      <header className="canvas-header">
        <div className="canvas-header-left">
          <Tooltip content="返回工作流列表">
            <Button
              className="canvas-back-button"
              theme="borderless"
              icon={<IconArrowLeft aria-hidden="true" />}
              aria-label="返回工作流列表"
              onClick={handleBack}
            />
          </Tooltip>
          <div className="canvas-title-block">
            <div className="canvas-name-group">
              <Input
                className="canvas-name-input"
                value={workflowName}
                onChange={(value) => {
                  setWorkflowName(value);
                  markDirty();
                }}
              />
            </div>
            <div className="canvas-status-row">
              <span className={'canvas-save-status ' + saveStatus}>{saveStatusText}</span>
              {saveStatus === 'error' && (
                <Tag size="small" color="red">
                  保存失败
                </Tag>
              )}
              {publishDirty ? (
                <span className="canvas-publish-state dirty">有尚未发布的修改</span>
              ) : publishedVersion ? (
                <span className="canvas-publish-state">
                  已发布 v{formatVersionLabel(publishedVersion) ?? publishedVersion}
                </span>
              ) : (
                <span className="canvas-publish-state">尚未发布</span>
              )}
            </div>
          </div>

          <div className="canvas-save-actions">
              <CanvasNodeSearch context={editorReady ? editorRef.current : null} />
              <Tooltip content="版本管理">
              <Button
                className="canvas-icon-action"
                theme="borderless"
                aria-label="版本管理"
                icon={<IconBranch aria-hidden="true" />}
                onClick={() => setVersionsVisible(true)}
              />
              </Tooltip>
              <Tooltip content="运行记录">
              <Button
                className="canvas-icon-action"
                theme="borderless"
                aria-label="运行记录"
                icon={<IconHistory aria-hidden="true" />}
                onClick={() => void openRuns()}
              />
              </Tooltip>
              <Button
              aria-label="保存工作流"
              icon={<IconSave aria-hidden="true" />}
              loading={saving}
              onClick={() => void saveWorkflow(true)}
              >
              保存
              </Button>
              <Button
              theme="solid"
              type="primary"
              aria-label="发布工作流"
              icon={<IconSend aria-hidden="true" />}
              loading={publishing}
              onClick={() => void handlePublish()}
              >
              发布
              </Button>
              <Dropdown
              trigger="click"
              position="bottomRight"
              menu={[
                {
                  node: 'item',
                  name: '导出工作流',
                  icon: <IconDownload />,
                  onClick: handleExport,
                },
                {
                  node: 'item',
                  name: '复制工作流',
                  icon: <IconCopy />,
                  onClick: () => void handleDuplicate(),
                },
                {
                  node: 'item',
                  name: '删除工作流',
                  icon: <IconDelete />,
                  type: 'danger',
                  onClick: handleDelete,
                },
              ]}
              >
              <Button
                className="canvas-icon-action"
                theme="borderless"
                aria-label="更多操作"
                icon={<IconMore aria-hidden="true" />}
              />
              </Dropdown>
        </div>
        </div>
      </header>

      <section className="canvas-editor-wrap">
        <SemiLocaleProvider locale={zh_CN}>
          <CanvasEditor
            key={id}
            initialData={flowgramData}
            onReady={handleEditorReady}
            onContentChange={markDirty}
          />
        </SemiLocaleProvider>
      </section>

      <VersionPanel
        workflowId={id || ''}
        visible={versionsVisible}
        onClose={() => setVersionsVisible(false)}
        onRestored={handleRestored}
      />

      <SideSheet
        title="运行记录"
        visible={runsVisible}
        width={520}
        footer={null}
        onCancel={() => setRunsVisible(false)}
      >
        {/* 工具栏只剩一个「试运行」入口，已发布版本的执行能力收到这里，
            它的语义是「按线上快照跑一次」，和画布草稿试运行不是同一件事 */}
        {publishedVersion ? (
          <div className="canvas-run-actions">
            <span>已发布 v{formatVersionLabel(publishedVersion) ?? publishedVersion}</span>
            <GatewayRunButton disabled={saving} />
          </div>
        ) : (
          <div className="canvas-run-actions muted">
            <span>尚未发布，发布后可在这里运行线上版本</span>
          </div>
        )}
        {runsLoading ? (
          <div className="canvas-loading">
            <div className="loading-inline">
              <Spin size="small" />
              <span>加载运行记录</span>
            </div>
          </div>
        ) : runs.length === 0 ? (
          <div className="canvas-runs-empty">
            <Typography.Text type="tertiary">暂无运行记录</Typography.Text>
          </div>
        ) : (
          <ul className="canvas-run-list">
            {runs.map((run) => (
              <li key={run.id} className="canvas-run-row">
                <div className="canvas-run-head">
                  <Tag
                    size="small"
                    color={
                      run.status === 'succeeded'
                        ? 'green'
                        : run.status === 'failed'
                          ? 'red'
                          : run.status === 'running'
                            ? 'blue'
                            : 'grey'
                    }
                  >
                    {run.status}
                  </Tag>
                  <span className="canvas-run-source">{run.source || 'manual'}</span>
                  <span className="canvas-run-time">
                    {new Date(run.createdAt).toLocaleString('zh-CN', {
                      month: '2-digit',
                      day: '2-digit',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </div>
                <div className="canvas-run-meta">
                  <span>令牌 {run.totalTokens ?? 0}</span>
                  <span>耗时 {Number(run.elapsedTime || 0).toFixed(2)}s</span>
                  <span>费用 ¥{Number(run.actualCost ?? run.estimatedCost ?? 0).toFixed(4)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </SideSheet>
    </main>
  );
};

const CanvasEditor = ({
  initialData,
  onReady,
  onContentChange,
}: {
  initialData: any;
  onReady: (context: FreeLayoutPluginContext) => void;
  onContentChange: () => void;
}) => {
  const editorProps = useEditorProps(initialData, nodeRegistries);

  return (
    <FreeLayoutEditorProvider {...editorProps}>
      <LocalizedSchemaTypeProvider>
        <CanvasInner onReady={onReady} onContentChange={onContentChange} />
      </LocalizedSchemaTypeProvider>
    </FreeLayoutEditorProvider>
  );
};

const CanvasInner = ({
  onReady,
  onContentChange,
}: {
  onReady: (context: FreeLayoutPluginContext) => void;
  onContentChange: () => void;
}) => {
  const context = useClientContext();

  useEffect(() => {
    if (!context) return;
    onReady(context);
    const disposable = context.document.onContentChange(() => onContentChange());
    return () => disposable.dispose();
  }, [context, onContentChange, onReady]);

  return (
    <div className="demo-container">
      <DockedPanelLayer>
        <EditorRenderer className="demo-editor" />
      </DockedPanelLayer>
    </div>
  );
};
