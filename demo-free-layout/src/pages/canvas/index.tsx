/**
 * 画布编辑器页面
 * 从后端加载工作流数据，嵌入 FlowGram 编辑器，支持保存
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Button, Input, Toast, Spin } from '@douyinfe/semi-ui';
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
import styled from 'styled-components';

import '@flowgram.ai/free-layout-editor/index.css';
import '../../styles/index.css';
import { nodeRegistries } from '../../nodes';
import { useEditorProps } from '../../hooks';
import { GetGlobalVariableSchema } from '../../plugins/variable-panel-plugin';
import { ApiError, apiJson } from '../../utils/api';

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
        const wf = await apiJson<{ name: string; flowgramJson?: any }>(`/workflows/${id}`);
        setWorkflowName(wf.name);
        setFlowgramData(wf.flowgramJson || { nodes: [], edges: [] });
      } catch (error: any) {
        if (error instanceof ApiError && error.status === 401) return;
        Toast.error(error.message || '加载工作流失败');
        navigate('/', { replace: true });
      } finally {
        setLoading(false);
      }
    };
    loadWorkflow();
  }, [id, navigate]);

  const markDirty = useCallback(() => {
    revisionRef.current += 1;
    setChangeRevision(revisionRef.current);
    setSaveStatus('unsaved');
  }, []);

  const handleEditorReady = useCallback((ctx: FreeLayoutPluginContext) => {
    editorRef.current = ctx;
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
      const ctx = editorRef.current;
      const flowgramJson = {
        ...ctx.document.toJSON(),
        globalVariable: ctx.get<GetGlobalVariableSchema>(GetGlobalVariableSchema)(),
      };
      await apiJson(`/workflows/${id}`, {
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
    } catch (e: any) {
      setSaveStatus('error');
      if (e instanceof ApiError && e.status === 401) {
        saveQueuedRef.current = false;
        return;
      }
      if (showToast) Toast.error(`保存失败: ${e?.message || '网络错误'}`);
    } finally {
      setSaving(false);
      saveInFlightRef.current = false;

      const shouldSaveAgain = saveQueuedRef.current;
      saveQueuedRef.current = false;
      if (shouldSaveAgain && !unmountedRef.current) {
        window.setTimeout(() => void saveRunnerRef.current(false), 0);
      }
    }
  }, [id, workflowName, navigate]);

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
    if (
      (revisionRef.current !== savedRevisionRef.current || saveInFlightRef.current) &&
      !window.confirm('当前更改尚未保存完成，确定要离开吗？')
    ) {
      return;
    }
    navigate('/');
  }, [navigate]);

  const saveStatusText = (() => {
    if (saveStatus === 'saving') return '正在自动保存…';
    if (saveStatus === 'unsaved') return '有未保存更改';
    if (saveStatus === 'error') return '自动保存失败，请手动重试';
    if (!lastSavedAt) return '已保存';
    return `已保存 ${lastSavedAt.toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
    })}`;
  })();

  if (loading) {
    return (
      <LoadingCenter>
        <Spin size="large" tip="加载画布..." />
      </LoadingCenter>
    );
  }

  return (
    <CanvasContainer>
      <CanvasTopBar>
        <LeftGroup>
          <Button
            icon={<IconArrowLeft />}
            onClick={handleBack}
            theme="borderless"
            aria-label="返回工作流"
          />
          <CanvasTitleGroup>
            <CanvasEyebrow>工作流画布</CanvasEyebrow>
            <CanvasName
            value={workflowName}
            onChange={(value) => {
              setWorkflowName(value);
              markDirty();
            }}
            />
          </CanvasTitleGroup>
        </LeftGroup>
        <SaveActions>
          <SaveStatusText $status={saveStatus}>{saveStatusText}</SaveStatusText>
          <Button
            theme="solid"
            type="primary"
            icon={<IconSave />}
            loading={saving}
            onClick={() => void saveWorkflow(true)}
          >
            保存
          </Button>
        </SaveActions>
      </CanvasTopBar>

      <EditorWrapper>
        <SemiLocaleProvider locale={zh_CN}>
          <CanvasEditor
            key={id}
            initialData={flowgramData}
            onReady={handleEditorReady}
            onContentChange={markDirty}
          />
        </SemiLocaleProvider>
      </EditorWrapper>
    </CanvasContainer>
  );
};

/**
 * 内部编辑器组件
 * useClientContext 必须在 FreeLayoutEditorProvider 内部的子组件中调用，
 * 否则 ctx 永远是 undefined，导致保存功能失效
 */
const CanvasEditor = ({
  initialData,
  onReady,
  onContentChange,
}: {
  initialData: any;
  onReady: (ctx: FreeLayoutPluginContext) => void;
  onContentChange: () => void;
}) => {
  const editorProps = useEditorProps(initialData, nodeRegistries);

  return (
    <FreeLayoutEditorProvider {...editorProps}>
      <CanvasInner onReady={onReady} onContentChange={onContentChange} />
    </FreeLayoutEditorProvider>
  );
};

/**
 * 在 Provider 内部调用 useClientContext，确保能拿到 ctx
 */
const CanvasInner = ({
  onReady,
  onContentChange,
}: {
  onReady: (ctx: FreeLayoutPluginContext) => void;
  onContentChange: () => void;
}) => {
  const ctx = useClientContext();
  useEffect(() => {
    if (!ctx) return;

    onReady(ctx);
    const disposable = ctx.document.onContentChange(() => onContentChange());
    return () => disposable.dispose();
  }, [ctx, onReady, onContentChange]);

  return (
    <div className="demo-container">
      <DockedPanelLayer>
        <EditorRenderer className="demo-editor" />
      </DockedPanelLayer>
    </div>
  );
};

const CanvasContainer = styled.div`
  display: flex;
  flex-direction: column;
  height: 100vh;
  width: 100vw;
  overflow: hidden;
`;

const CanvasTopBar = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  min-height: 64px;
  padding: 10px 20px;
  background: #fff;
  border-bottom: 1px solid #e5e9f1;
  box-shadow: 0 1px 2px rgba(16, 24, 40, .02);
  flex-shrink: 0;

  @media (max-width: 720px) {
    min-height: 56px;
    padding: 8px 10px;
    gap: 8px;
  }
`;

const LeftGroup = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  flex: 1;
`;

const CanvasTitleGroup = styled.div`
  display: grid;
  gap: 1px;
  min-width: 0;
  flex: 1;
`;

const CanvasEyebrow = styled.div`
  color: #98a2b3;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: .05em;

  @media (max-width: 720px) { display: none; }
`;

const CanvasName = styled(Input)`
  width: 300px;
  .semi-input { color: #182230; font-size: 15px; font-weight: 600; }
  &.semi-input-wrapper { border-color: transparent !important; background: transparent; padding: 0; }
  &.semi-input-wrapper:hover, &.semi-input-wrapper-focus { border-color: #d8deea !important; background: #fff; padding: 0 8px; }

  @media (max-width: 720px) {
    width: 100%;
    min-width: 0;
  }
`;

const SaveActions = styled.div`
  display: flex;
  align-items: center;
  gap: 14px;
  flex: 0 0 auto;
`;

const SaveStatusText = styled.span<{ $status: SaveStatus }>`
  min-width: 162px;
  color: ${(props) => {
    if (props.$status === 'error') return '#d92d20';
    if (props.$status === 'unsaved') return '#b54708';
    return '#667085';
  }};
  font-size: 12px;
  text-align: right;

  @media (max-width: 720px) { display: none; }
`;

const EditorWrapper = styled.div`
  flex: 1;
  overflow: hidden;
  position: relative;
  min-height: 0;
  display: flex;
  flex-direction: column;
`;

const LoadingCenter = styled.div`
  display: flex;
  justify-content: center;
  align-items: center;
  height: 100%;
  gap: 12px;

  /* 让 Spin 的 tip 文本不换行，与 spinner 同行显示 */
  :global(.semi-spin-content) {
    white-space: nowrap;
  }
`;
