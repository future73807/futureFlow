import { useCallback, useRef, useState } from 'react';
import { Button, SideSheet, Spin, Tag, Toast, Typography } from '@douyinfe/semi-ui';
import { IconClose, IconPlay } from '@douyinfe/semi-icons';
import { useClientContext, useRefresh } from '@flowgram.ai/free-layout-editor';
import './gateway-run.css';
import { apiFetch } from '../../utils/api';

interface NodeStatus {
  nodeId: string;
  title: string;
  type: string;
  status: 'running' | 'succeeded' | 'failed';
  output?: string;
  tokens?: number;
}

interface RunResult {
  text: string;
  nodes: NodeStatus[];
  totalTokens: number;
  totalSteps: number;
  elapsedTime: number;
  status: 'idle' | 'running' | 'succeeded' | 'failed';
  error?: string;
}

const initialState: RunResult = {
  text: '',
  nodes: [],
  totalTokens: 0,
  totalSteps: 0,
  elapsedTime: 0,
  status: 'idle',
};

export const GatewayRunButton = ({ disabled }: { disabled?: boolean }) => {
  const context = useClientContext();
  const refresh = useRefresh();
  const [visible, setVisible] = useState(false);
  const [result, setResult] = useState<RunResult>(initialState);
  const abortRef = useRef<AbortController | null>(null);

  const handleRun = useCallback(async () => {
    const flowgramJson = context.document.toJSON();
    setResult({ ...initialState, status: 'running' });
    setVisible(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await apiFetch('/workflows/run', {
        method: 'POST',
        body: JSON.stringify({ flowgram: flowgramJson }),
        signal: controller.signal,
      });

      if (!response.body) throw new Error('网关未返回可读取的执行结果');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const nodeMap = new Map<string, NodeStatus>();
      let buffer = '';
      let textBuffer = '';

      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;

        buffer += decoder.decode(chunk.value, { stream: true });
        const messages = buffer.split(/\r?\n\r?\n/);
        buffer = messages.pop() || '';

        for (const message of messages) {
          const jsonText = message
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n')
            .trim();

          if (!jsonText) continue;

          try {
            const event = JSON.parse(jsonText);
            if (event.event === 'workflow_started') {
              setResult((previous) => ({ ...previous, status: 'running' }));
            }

            if (event.event === 'node_started') {
              nodeMap.set(event.data?.node_id, {
                nodeId: event.data?.node_id,
                title: event.data?.title,
                type: event.data?.node_type,
                status: 'running',
              });
              setResult((previous) => ({ ...previous, nodes: Array.from(nodeMap.values()) }));
            }

            if (event.event === 'node_finished') {
              nodeMap.set(event.data?.node_id, {
                nodeId: event.data?.node_id,
                title: event.data?.title,
                type: event.data?.node_type,
                status: event.data?.status === 'succeeded' ? 'succeeded' : 'failed',
                output: event.data?.outputs?.text || JSON.stringify(event.data?.outputs || {}),
                tokens: event.data?.execution_metadata?.total_tokens,
              });
              setResult((previous) => ({ ...previous, nodes: Array.from(nodeMap.values()) }));
            }

            if (event.event === 'text_chunk') {
              textBuffer += event.data?.text || '';
              setResult((previous) => ({ ...previous, text: textBuffer }));
            }

            if (event.event === 'workflow_finished') {
              setResult((previous) => ({
                ...previous,
                status: event.data?.status === 'succeeded' ? 'succeeded' : 'failed',
                totalTokens: event.data?.total_tokens || 0,
                totalSteps: event.data?.total_steps || 0,
                elapsedTime: event.data?.elapsed_time || 0,
                error: event.data?.error,
              }));
            }

            if (event.event === 'error') {
              setResult((previous) => ({
                ...previous,
                status: 'failed',
                error: event.data?.message || '未知错误',
              }));
            }

            if (event.event === 'engine_degraded') {
              Toast.info({ content: 'Dify 未配置，已切换到直接 LLM 模式', duration: 4 });
            }

            refresh();
          } catch {
            // Ignore incomplete SSE messages and continue reading the stream.
          }
        }
      }
    } catch (error: any) {
      if (error.name === 'AbortError') {
        setResult((previous) => ({ ...previous, status: 'failed', error: '已取消' }));
      } else {
        setResult((previous) => ({
          ...previous,
          status: 'failed',
          error: error.message || '请求失败',
        }));
      }
    } finally {
      abortRef.current = null;
    }
  }, [context, refresh]);

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const statusColor = result.status === 'succeeded'
    ? 'green'
    : result.status === 'failed'
      ? 'red'
      : result.status === 'running'
        ? 'blue'
        : 'grey';

  const statusText = result.status === 'running'
    ? '执行中'
    : result.status === 'succeeded'
      ? '执行成功'
      : result.status === 'failed'
        ? '执行失败'
        : '等待执行';

  return (
    <>
      <Button
        className="gateway-run-action"
        icon={<IconPlay size="small" />}
        disabled={disabled || result.status === 'running'}
        onClick={handleRun}
      >
        通过网关执行
      </Button>

      <SideSheet
        className="gateway-run-sheet"
        title="网关执行结果"
        visible={visible}
        onCancel={() => setVisible(false)}
        width={500}
        footer={null}
      >
        <div className="gateway-result">
          <div className="gateway-result-status">
            <Tag color={statusColor} size="large">
              {result.status === 'running' && <Spin size="small" />}
              {statusText}
            </Tag>
            {result.status === 'running' && (
              <Button size="small" type="danger" icon={<IconClose />} onClick={handleStop}>
                停止
              </Button>
            )}
          </div>

          {result.error && (
            <div className="gateway-error">
              <Typography.Text type="danger">{result.error}</Typography.Text>
            </div>
          )}

          {result.nodes.length > 0 && (
            <section className="gateway-section">
              <h3>节点执行</h3>
              <div className="gateway-node-list">
                {result.nodes.map((node) => (
                  <div className="gateway-node-row" key={node.nodeId}>
                    <span className={'gateway-node-state ' + node.status} aria-label={node.status} />
                    <div>
                      <strong>{node.title}</strong>
                      <span>{node.type}</span>
                    </div>
                    {node.tokens ? <small>{node.tokens} tokens</small> : null}
                  </div>
                ))}
              </div>
            </section>
          )}

          {result.text && (
            <section className="gateway-section">
              <h3>LLM 输出</h3>
              <pre className="gateway-output">{result.text}</pre>
            </section>
          )}

          {result.status === 'succeeded' && (
            <section className="gateway-section">
              <h3>执行统计</h3>
              <div className="gateway-stats">
                <div><span>Token 用量</span><strong>{result.totalTokens}</strong></div>
                <div><span>执行步数</span><strong>{result.totalSteps}</strong></div>
                <div><span>耗时</span><strong>{result.elapsedTime.toFixed(2)}s</strong></div>
              </div>
            </section>
          )}
        </div>
      </SideSheet>
    </>
  );
};
