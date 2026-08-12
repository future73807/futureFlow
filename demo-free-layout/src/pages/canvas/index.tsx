import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button, Input, Spin, Toast, Tooltip } from '@douyinfe/semi-ui';
import { IconArrowLeft, IconSave } from '@douyinfe/semi-icons';
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
import { GetGlobalVariableSchema } from '../../plugins/variable-panel-plugin';
import { ApiError, apiJson } from '../../utils/api';
import { normalizeCanvasLocale } from '../../utils/normalize-canvas-data';
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
        const workflow = await apiJson<{ name: string; flowgramJson?: any }>('/workflows/' + id);
        setWorkflowName(workflow.name);
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
  }, []);

  const handleEditorReady = useCallback((context: FreeLayoutPluginContext) => {
    editorRef.current = context;
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
        <Spin size="large" tip="加载画布" />
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
          <span className="canvas-brand-mark" aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 48 48" fill="none">
              <rect width="48" height="48" rx="12" fill="currentColor" />
              <path d="M14 18 24 14 34 18v12L24 34 14 30V18Z" stroke="white" strokeWidth="2.5" strokeLinejoin="round" />
              <circle cx="24" cy="24" r="3" fill="white" />
            </svg>
          </span>
          <div className="canvas-name-group">
            <span>futureFlow · 可视化工作流</span>
            <Input
              className="canvas-name-input"
              value={workflowName}
              onChange={(value) => {
                setWorkflowName(value);
                markDirty();
              }}
            />
          </div>
        </div>
        <div className="canvas-save-actions">
          <span className="canvas-autosave-badge">自动保存</span>
          <span className={'canvas-save-status ' + saveStatus}>{saveStatusText}</span>
          <Button
            theme="solid"
            type="primary"
            aria-label="保存工作流"
            icon={<IconSave aria-hidden="true" />}
            loading={saving}
            onClick={() => void saveWorkflow(true)}
          >
            保存
          </Button>
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
