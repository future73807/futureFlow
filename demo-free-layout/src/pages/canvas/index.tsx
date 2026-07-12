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
} from '@flowgram.ai/free-layout-editor';
import { LocaleProvider as SemiLocaleProvider } from '@douyinfe/semi-ui';
import zh_CN from '@douyinfe/semi-ui/lib/es/locale/source/zh_CN';
import styled from 'styled-components';

import '@flowgram.ai/free-layout-editor/index.css';
import '../../styles/index.css';
import { nodeRegistries } from '../../nodes';
import { useEditorProps } from '../../hooks';
import { getToken } from '../../utils/auth';

const GATEWAY_URL = 'http://localhost:3001';

export const CanvasPage = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [workflowName, setWorkflowName] = useState('');
  const [flowgramData, setFlowgramData] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const editorRef = useRef<any>(null);

  useEffect(() => {
    const loadWorkflow = async () => {
      const token = getToken();
      if (!token || !id) {
        navigate('/', { replace: true });
        return;
      }
      try {
        const res = await fetch(`${GATEWAY_URL}/workflows/${id}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          Toast.error('加载工作流失败');
          navigate('/', { replace: true });
          return;
        }
        const wf = await res.json();
        setWorkflowName(wf.name);
        setFlowgramData(wf.flowgramJson || { nodes: [], edges: [] });
      } catch {
        Toast.error('加载失败');
        navigate('/', { replace: true });
      } finally {
        setLoading(false);
      }
    };
    loadWorkflow();
  }, [id, navigate]);

  const handleSave = useCallback(async () => {
    if (!id || !editorRef.current) return;
    setSaving(true);
    try {
      const flowgramJson = editorRef.current.document.toJSON();
      const token = getToken();
      const res = await fetch(`${GATEWAY_URL}/workflows/${id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          name: workflowName,
          flowgram: JSON.stringify(flowgramJson),
        }),
      });
      if (res.ok) {
        Toast.success('已保存');
      } else {
        Toast.error('保存失败');
      }
    } catch {
      Toast.error('保存失败');
    } finally {
      setSaving(false);
    }
  }, [id, workflowName]);

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
            onClick={() => navigate('/')}
            theme="borderless"
          />
          <Input
            value={workflowName}
            onChange={setWorkflowName}
            style={{ width: 240 }}
            onBlur={handleSave}
          />
        </LeftGroup>
        <Button
          theme="solid"
          type="primary"
          icon={<IconSave />}
          loading={saving}
          onClick={handleSave}
        >
          保存
        </Button>
      </CanvasTopBar>

      <EditorWrapper>
        <SemiLocaleProvider locale={zh_CN}>
          <CanvasEditor
            key={id}
            initialData={flowgramData}
            onReady={(ctx) => {
              editorRef.current = ctx;
            }}
          />
        </SemiLocaleProvider>
      </EditorWrapper>
    </CanvasContainer>
  );
};

/**
 * 内部编辑器组件，接收 onReady 回调暴露 context
 */
const CanvasEditor = ({
  initialData,
  onReady,
}: {
  initialData: any;
  onReady: (ctx: any) => void;
}) => {
  const editorProps = useEditorProps(initialData, nodeRegistries);
  const ctx = useClientContext();

  useEffect(() => {
    if (ctx) {
      onReady(ctx);
    }
  }, [ctx, onReady]);

  return (
    <FreeLayoutEditorProvider {...editorProps}>
      <div className="demo-container">
        <DockedPanelLayer>
          <EditorRenderer className="demo-editor" />
        </DockedPanelLayer>
      </div>
    </FreeLayoutEditorProvider>
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
  padding: 8px 16px;
  background: #fff;
  border-bottom: 1px solid #e8e8e8;
  flex-shrink: 0;
`;

const LeftGroup = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
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
`;
