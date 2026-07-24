/**
 * futureFlow 网关执行组件
 * 将画布工作流 JSON 提交到自研网关,以 SSE 流式接收执行结果
 */

import { useState, useCallback, useRef } from 'react';
import {
  useClientContext,
  useRefresh,
} from '@flowgram.ai/free-layout-editor';
import { Button, SideSheet, Tag, Typography, Spin, Toast } from '@douyinfe/semi-ui';
import { IconPlay, IconClose } from '@douyinfe/semi-icons';
import styled from 'styled-components';
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
  const ctx = useClientContext();
  const refresh = useRefresh();
  const [visible, setVisible] = useState(false);
  const [result, setResult] = useState<RunResult>(initialState);
  const abortRef = useRef<AbortController | null>(null);

  const handleRun = useCallback(async () => {
    // 0. 检查登录态
    // 1. 获取画布 JSON
    const flowgramJson = ctx.document.toJSON();

    // 2. 重置状态
    setResult({ ...initialState, status: 'running' });
    setVisible(true);

    // 3. 发起请求
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await apiFetch('/workflows/run', {
        method: 'POST',
        body: JSON.stringify({ flowgram: flowgramJson }),
        signal: controller.signal,
      });

      // 4. 解析 SSE 流
      if (!response.body) throw new Error('网关未返回可读取的执行结果');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let textBuffer = '';
      const nodeMap = new Map<string, NodeStatus>();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const messages = buffer.split('\n\n');
        buffer = messages.pop() || '';

        for (const message of messages) {
          const line = message.trim();
          if (!line.startsWith('data:')) continue;

          const jsonStr = line.slice(5).trim();
          if (!jsonStr) continue;

          try {
            const event = JSON.parse(jsonStr);

            switch (event.event) {
              case 'workflow_started':
                setResult((prev) => ({
                  ...prev,
                  status: 'running',
                }));
                break;

              case 'node_started':
                nodeMap.set(event.data?.node_id, {
                  nodeId: event.data?.node_id,
                  title: event.data?.title,
                  type: event.data?.node_type,
                  status: 'running',
                });
                setResult((prev) => ({
                  ...prev,
                  nodes: Array.from(nodeMap.values()),
                }));
                break;

              case 'node_finished':
                nodeMap.set(event.data?.node_id, {
                  nodeId: event.data?.node_id,
                  title: event.data?.title,
                  type: event.data?.node_type,
                  status: event.data?.status === 'succeeded' ? 'succeeded' : 'failed',
                  output:
                    event.data?.outputs?.text ||
                    JSON.stringify(event.data?.outputs || {}),
                  tokens: event.data?.execution_metadata?.total_tokens,
                });
                setResult((prev) => ({
                  ...prev,
                  nodes: Array.from(nodeMap.values()),
                }));
                break;

              case 'text_chunk':
                textBuffer += event.data?.text || '';
                setResult((prev) => ({
                  ...prev,
                  text: textBuffer,
                }));
                break;

              case 'workflow_finished':
                setResult((prev) => ({
                  ...prev,
                  status: event.data?.status === 'succeeded' ? 'succeeded' : 'failed',
                  totalTokens: event.data?.total_tokens || 0,
                  totalSteps: event.data?.total_steps || 0,
                  elapsedTime: event.data?.elapsed_time || 0,
                  error: event.data?.error,
                }));
                break;

              case 'error':
                setResult((prev) => ({
                  ...prev,
                  status: 'failed',
                  error: event.data?.message || '未知错误',
                }));
                break;

              case 'engine_degraded':
                // Dify 未配置，系统自动降级到直接 LLM 模式
                Toast.info({
                  content: 'Dify 未配置，已降级到直接 LLM 模式',
                  duration: 4,
                });
                break;
            }
            refresh();
          } catch {
            // JSON 解析失败,跳过
          }
        }
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        setResult((prev) => ({ ...prev, status: 'failed', error: '已取消' }));
      } else {
        setResult((prev) => ({
          ...prev,
          status: 'failed',
          error: err.message || '请求失败',
        }));
      }
    }
  }, [ctx, refresh]);

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const statusColor = {
    idle: 'grey',
    running: 'blue',
    succeeded: 'green',
    failed: 'red',
  }[result.status] as any;

  return (
    <>
      <Button
        theme="solid"
        type="primary"
        icon={<IconPlay />}
        disabled={disabled || result.status === 'running'}
        onClick={handleRun}
        style={{ marginLeft: 8 }}
      >
        通过网关执行
      </Button>

      <SideSheet
        title="网关执行结果"
        visible={visible}
        onCancel={() => setVisible(false)}
        width={500}
        footer={null}
      >
        <ResultPanel>
          {/* 状态栏 */}
          <StatusBar>
            <Tag color={statusColor} size="large">
              {result.status === 'running' && <Spin size="small" />}
              {result.status === 'idle' ? '等待执行' :
               result.status === 'running' ? '执行中...' :
               result.status === 'succeeded' ? '执行成功' : '执行失败'}
            </Tag>
            {result.status === 'running' && (
              <Button
                size="small"
                type="danger"
                icon={<IconClose />}
                onClick={handleStop}
              >
                停止
              </Button>
            )}
          </StatusBar>

          {/* 错误信息 */}
          {result.error && (
            <ErrorBox>
              <Typography.Text type="danger">
                {result.error}
              </Typography.Text>
            </ErrorBox>
          )}

          {/* 节点执行状态 */}
          {result.nodes.length > 0 && (
            <Section>
              <Typography.Title heading={5}>节点执行</Typography.Title>
              {result.nodes.map((node) => (
                <NodeRow key={node.nodeId}>
                  <Tag
                    size="small"
                    color={
                      node.status === 'succeeded' ? 'green' :
                      node.status === 'failed' ? 'red' : 'blue'
                    }
                  >
                    {node.status === 'running' ? '⏳' :
                     node.status === 'succeeded' ? '✅' : '❌'}
                  </Tag>
                  <span className="node-title">{node.title}</span>
                  <span className="node-type">({node.type})</span>
                  {node.tokens && (
                    <span className="node-tokens">{node.tokens} tokens</span>
                  )}
                </NodeRow>
              ))}
            </Section>
          )}

          {/* 流式文本输出 */}
          {result.text && (
            <Section>
              <Typography.Title heading={5}>LLM 输出</Typography.Title>
              <TextOutput>{result.text}</TextOutput>
            </Section>
          )}

          {/* 执行统计 */}
          {result.status === 'succeeded' && (
            <Section>
              <Typography.Title heading={5}>执行统计</Typography.Title>
              <Stats>
                <span>Token 用量: <strong>{result.totalTokens}</strong></span>
                <span>执行步数: <strong>{result.totalSteps}</strong></span>
                <span>耗时: <strong>{result.elapsedTime.toFixed(2)}s</strong></span>
              </Stats>
            </Section>
          )}
        </ResultPanel>
      </SideSheet>
    </>
  );
};

const ResultPanel = styled.div`
  display: flex;
  flex-direction: column;
  gap: 16px;
`;

const StatusBar = styled.div`
  display: flex;
  align-items: center;
  gap: 12px;
`;

const ErrorBox = styled.div`
  padding: 12px;
  background: #fff2f0;
  border: 1px solid #ffccc7;
  border-radius: 6px;
`;

const Section = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;
`;

const NodeRow = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;

  .node-title {
    font-weight: 500;
  }
  .node-type {
    color: #999;
    font-size: 12px;
  }
  .node-tokens {
    margin-left: auto;
    color: #666;
    font-size: 12px;
  }
`;

const TextOutput = styled.div`
  padding: 12px;
  background: #f5f5f5;
  border-radius: 6px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 300px;
  overflow-y: auto;
  font-size: 14px;
  line-height: 1.6;
`;

const Stats = styled.div`
  display: flex;
  gap: 24px;
  padding: 12px;
  background: #f5f5f5;
  border-radius: 6px;
`;
