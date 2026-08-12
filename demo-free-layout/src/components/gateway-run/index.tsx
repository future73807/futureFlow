import { useCallback, useRef, useState } from 'react';
import {
  Button,
  Input,
  InputNumber,
  SideSheet,
  Spin,
  Switch,
  Tag,
  Typography,
} from '@douyinfe/semi-ui';
import { IconClose, IconDownload, IconPlay } from '@douyinfe/semi-icons';
import { useRefresh } from '@flowgram.ai/free-layout-editor';
import { useParams } from 'react-router-dom';
import './gateway-run.css';
import { apiFetch, apiJson } from '../../utils/api';
import { downloadResultArchive } from '../../utils/result-archive';
import { getFieldLabel } from '../../form-components/field-labels';

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
  outputs: Record<string, unknown>;
  status: 'idle' | 'running' | 'succeeded' | 'failed';
  error?: string;
}

interface PublishedInputField {
  name: string;
  type: 'string' | 'number' | 'integer' | 'boolean';
  required: boolean;
  defaultValue?: string | number | boolean;
}

interface PublishedWorkflowSnapshot {
  name?: string;
  publishedVersion?: number | null;
  publishedFlowgramJson?: {
    nodes?: Array<{
      id?: string;
      type?: string;
      data?: {
        inputsValues?: Record<string, { type?: string; content?: unknown }>;
        authorization?: {
          type?: string;
          token?: unknown;
          apiKey?: unknown;
          username?: unknown;
          password?: unknown;
        };
        headersValues?: Record<string, unknown>;
        paramsValues?: Record<string, unknown>;
        outputs?: {
          required?: string[];
          properties?: Record<string, { type?: string; default?: unknown }>;
        };
      };
    }>;
  } | null;
}

const ARCHIVE_SENSITIVE_KEY = /api.?key|authorization|cookie|credential|password|secret|token/i;

const collectStartReferences = (
  value: unknown,
  startNodeId: string,
  target: Set<string>,
) => {
  if (typeof value === 'string') {
    const escapedStart = startNodeId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`\\{\\{#?${escapedStart}\\.([^#{}\\s]+)#?\\}\\}`, 'g');
    for (const match of value.matchAll(pattern)) target.add(match[1]);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const record = value as { type?: string; content?: unknown };
  if (
    record.type === 'ref'
    && Array.isArray(record.content)
    && String(record.content[0]) === startNodeId
    && record.content.length >= 2
  ) {
    target.add(String(record.content[1]));
    return;
  }
  if (typeof record.content === 'string') {
    collectStartReferences(record.content, startNodeId, target);
  }
};

/**
 * ZIP 不能只看输入字段名：`foo` 也可能被用作 Bearer/API Key。
 * 从已发布节点的认证位置反向收集开始节点字段，交给归档层按实际值清洗。
 */
const collectArchiveSensitiveInputKeys = (
  snapshot: PublishedWorkflowSnapshot['publishedFlowgramJson'],
): string[] => {
  const startNodeId = snapshot?.nodes?.find((node) => node.type === 'start')?.id;
  if (!startNodeId) return [];
  const keys = new Set<string>();
  for (const node of snapshot?.nodes || []) {
    if (node.type !== 'http') continue;
    const authorization = node.data?.authorization;
    if (authorization?.type === 'bearer') {
      collectStartReferences(authorization.token, startNodeId, keys);
    } else if (authorization?.type === 'api-key') {
      collectStartReferences(authorization.apiKey, startNodeId, keys);
    } else if (authorization?.type === 'basic') {
      collectStartReferences(authorization.username, startNodeId, keys);
      collectStartReferences(authorization.password, startNodeId, keys);
    }
    for (const [name, value] of Object.entries(node.data?.headersValues || {})) {
      if (ARCHIVE_SENSITIVE_KEY.test(name)) collectStartReferences(value, startNodeId, keys);
    }
    for (const [name, value] of Object.entries(node.data?.paramsValues || {})) {
      if (ARCHIVE_SENSITIVE_KEY.test(name)) collectStartReferences(value, startNodeId, keys);
    }
  }
  return Array.from(keys);
};

const initialState: RunResult = {
  text: '',
  nodes: [],
  totalTokens: 0,
  totalSteps: 0,
  elapsedTime: 0,
  outputs: {},
  status: 'idle',
};

const NODE_TYPE_LABELS: Record<string, string> = {
  start: '开始',
  end: '结束',
  llm: '大语言模型',
  code: '代码执行',
  'http-request': 'API 请求',
  'if-else': '条件分支',
  'template-transform': '内容处理',
  assigner: '变量赋值',
  'variable-aggregator': '变量聚合',
  iteration: '数组批处理',
  loop: '数组批处理',
  'parameter-extractor': '参数提取',
  'question-classifier': '问题分类',
  'knowledge-retrieval': '知识检索',
  'document-extractor': '文档提取',
  'list-operator': '列表处理',
  tool: '工具调用',
  answer: '回答',
};

const NODE_STATUS_LABELS: Record<NodeStatus['status'], string> = {
  running: '执行中',
  succeeded: '执行成功',
  failed: '执行失败',
};

export const GatewayRunButton = ({ disabled }: { disabled?: boolean }) => {
  const { id: workflowId } = useParams<{ id: string }>();
  const refresh = useRefresh();
  const [visible, setVisible] = useState(false);
  const [result, setResult] = useState<RunResult>(initialState);
  const [inputs, setInputs] = useState<Record<string, string | number | boolean>>({});
  const [inputFields, setInputFields] = useState<PublishedInputField[]>([]);
  const [publishedVersion, setPublishedVersion] = useState<number | null>(null);
  const [publishedWorkflowName, setPublishedWorkflowName] = useState('');
  const [sensitiveInputKeys, setSensitiveInputKeys] = useState<string[]>([]);
  const [preparing, setPreparing] = useState(false);
  const [inputError, setInputError] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  const handleOpen = useCallback(async () => {
    setVisible(true);
    setResult(initialState);
    setInputError('');
    setPreparing(true);

    try {
      if (!workflowId) throw new Error('缺少工作流标识');
      const workflow = await apiJson<PublishedWorkflowSnapshot>(`/workflows/${workflowId}`);
      const snapshot = workflow.publishedFlowgramJson;
      if (!snapshot || !workflow.publishedVersion) {
        throw new Error('当前工作流尚未发布，请先保存并发布后再运行');
      }

      const startNode = snapshot.nodes?.find((node) => node.type === 'start');
      if (!startNode) throw new Error('已发布版本缺少开始节点');
      const schema = startNode.data?.outputs;
      const required = new Set(schema?.required || []);
      const nextInputs: Record<string, string | number | boolean> = {};
      const nextFields = Object.entries(schema?.properties || {}).map(([name, property]) => {
        const type = property.type === 'boolean'
          ? 'boolean'
          : property.type === 'integer'
            ? 'integer'
            : property.type === 'number'
              ? 'number'
              : 'string';
        const savedValue = startNode.data?.inputsValues?.[name]?.content;
        const defaultValue = savedValue ?? property.default;
        if (['string', 'number', 'boolean'].includes(typeof defaultValue)) {
          nextInputs[name] = defaultValue as string | number | boolean;
        }
        return {
          name,
          type,
          required: required.has(name),
          defaultValue: nextInputs[name],
        } satisfies PublishedInputField;
      });

      setPublishedVersion(workflow.publishedVersion);
      setPublishedWorkflowName(workflow.name?.trim() || '工作流结果');
      setSensitiveInputKeys(collectArchiveSensitiveInputKeys(snapshot));
      setInputFields(nextFields);
      setInputs(nextInputs);
    } catch (error: any) {
      setPublishedVersion(null);
      setPublishedWorkflowName('');
      setSensitiveInputKeys([]);
      setInputFields([]);
      setInputs({});
      setInputError(error?.message || '读取已发布版本失败');
    } finally {
      setPreparing(false);
    }
  }, [workflowId]);

  const handleRun = useCallback(async () => {
    const missingField = inputFields.find((field) => {
      if (!field.required) return false;
      const value = inputs[field.name];
      return value === undefined || value === null || (typeof value === 'string' && !value.trim());
    });
    if (missingField) {
      setInputError(`请填写必填项：${getFieldLabel(missingField.name)}`);
      return;
    }

    setInputError('');
    setResult({ ...initialState, status: 'running' });

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      if (!workflowId) throw new Error('缺少工作流标识');
      const response = await apiFetch(`/workflows/${workflowId}/execute`, {
        method: 'POST',
        body: JSON.stringify({ inputs, publishedVersion }),
        signal: controller.signal,
      });

      if (!response.body) throw new Error('网关未返回可读取的执行结果');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const nodeMap = new Map<string, NodeStatus>();
      let buffer = '';
      let textBuffer = '';
      let receivedTerminalEvent = false;

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
            if (receivedTerminalEvent) {
              throw new Error('执行流在终态之后仍返回事件，结果不可信');
            }
            if (event.event === 'workflow_started') {
              setResult((previous) => ({ ...previous, status: 'running' }));
            }

            if (event.event === 'node_started') {
              const iterationId = event.data?.iteration_id;
              if (iterationId && !nodeMap.has(iterationId)) {
                nodeMap.set(iterationId, {
                  nodeId: iterationId,
                  title: '数组批处理',
                  type: 'iteration',
                  status: 'running',
                });
              }
              nodeMap.set(event.data?.node_id, {
                nodeId: event.data?.node_id,
                title: event.data?.title,
                type: event.data?.node_type,
                status: 'running',
              });
              setResult((previous) => ({ ...previous, nodes: Array.from(nodeMap.values()) }));
            }

            if (event.event === 'node_finished') {
              const iterationId = event.data?.iteration_id;
              nodeMap.set(event.data?.node_id, {
                nodeId: event.data?.node_id,
                title: event.data?.title,
                type: event.data?.node_type,
                status: event.data?.status === 'succeeded' ? 'succeeded' : 'failed',
                output: event.data?.outputs?.text || JSON.stringify(event.data?.outputs || {}),
                tokens: event.data?.execution_metadata?.total_tokens,
              });
              if (iterationId && event.data?.status !== 'succeeded') {
                const iteration = nodeMap.get(iterationId);
                if (iteration) nodeMap.set(iterationId, { ...iteration, status: 'failed' });
              }
              setResult((previous) => ({ ...previous, nodes: Array.from(nodeMap.values()) }));
            }

            if (event.event === 'text_chunk') {
              textBuffer += event.data?.text || '';
              setResult((previous) => ({ ...previous, text: textBuffer }));
            }

            if (event.event === 'workflow_finished') {
              receivedTerminalEvent = true;
              const outputs = event.data?.outputs || {};
              const failedNode = Array.from(nodeMap.values())
                .find((node) => node.status === 'failed');
              const workflowSucceeded = event.data?.status === 'succeeded' && !failedNode;
              nodeMap.forEach((node, nodeId) => {
                if (node.type === 'iteration' && node.status === 'running') {
                  nodeMap.set(nodeId, {
                    ...node,
                    status: workflowSucceeded ? 'succeeded' : 'failed',
                  });
                }
              });
              const completedText = textBuffer
                || (typeof outputs.text === 'string' ? outputs.text : '')
                || (typeof outputs.result === 'string' ? outputs.result : '');
              if (completedText) textBuffer = completedText;
              setResult((previous) => ({
                ...previous,
                nodes: Array.from(nodeMap.values()),
                text: completedText || previous.text,
                status: workflowSucceeded ? 'succeeded' : 'failed',
                totalTokens: event.data?.total_tokens || 0,
                totalSteps: event.data?.total_steps || 0,
                elapsedTime: event.data?.elapsed_time || 0,
                outputs,
                error: event.data?.error
                  || (failedNode ? `节点“${failedNode.title || failedNode.nodeId}”执行失败` : undefined),
              }));
            }

            if (event.event === 'error') {
              receivedTerminalEvent = true;
              setResult((previous) => ({
                ...previous,
                status: 'failed',
                error: event.data?.message || '未知错误',
              }));
            }

            refresh();
          } catch (parseError) {
            controller.abort();
            if (parseError instanceof SyntaxError) {
              throw new Error('运行结果格式异常，请稍后重试');
            }
            throw parseError;
          }
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) {
        throw new Error('执行连接提前结束，最后一条结果不完整');
      }
      if (!receivedTerminalEvent) {
        throw new Error('执行连接提前结束，未收到工作流完成状态');
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
  }, [inputFields, inputs, publishedVersion, refresh, workflowId]);

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const updateInput = useCallback((name: string, value: string | number | boolean) => {
    setInputs((previous) => ({ ...previous, [name]: value }));
  }, []);

  const renderPublishedInput = (field: PublishedInputField) => {
    const value = inputs[field.name];
    if (field.type === 'boolean') {
      return (
        <Switch
          aria-label={getFieldLabel(field.name)}
          checked={Boolean(value)}
          checkedText="是"
          uncheckedText="否"
          onChange={(checked) => updateInput(field.name, checked)}
        />
      );
    }
    if (field.type === 'number' || field.type === 'integer') {
      return (
        <InputNumber
          aria-label={getFieldLabel(field.name)}
          precision={field.type === 'integer' ? 0 : undefined}
          value={typeof value === 'number' ? value : undefined}
          placeholder={field.type === 'integer' ? '请输入整数' : '请输入数字'}
          onChange={(nextValue) => {
            if (typeof nextValue === 'number') updateInput(field.name, nextValue);
          }}
        />
      );
    }
    return (
      <Input
        aria-label={getFieldLabel(field.name)}
        value={typeof value === 'string' ? value : ''}
        placeholder="请输入文本"
        onChange={(nextValue) => updateInput(field.name, nextValue)}
      />
    );
  };

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
        aria-label="运行已发布版本"
        className="gateway-run-action"
        icon={<IconPlay aria-hidden="true" size="small" />}
        disabled={disabled || result.status === 'running'}
        onClick={() => void handleOpen()}
      >
        运行已发布版本
      </Button>

      <SideSheet
        className="gateway-run-sheet"
        title="已发布版本运行结果"
        visible={visible}
        onCancel={() => setVisible(false)}
        width={500}
        footer={null}
      >
        <div className="gateway-result">
          {result.status === 'idle' && (
            <section className="gateway-section gateway-input-section">
              <div>
                <h3>运行输入</h3>
                <p>
                  {publishedVersion
                    ? `正在运行已发布的 v${publishedVersion}，输入不会修改画布。`
                    : '读取已发布版本的开始节点参数。'}
                </p>
              </div>
              {preparing ? (
                <div className="gateway-preparing"><Spin /> 正在读取已发布版本</div>
              ) : (
                inputFields.map((field) => (
                  <label className="gateway-input-field" key={field.name}>
                    <span>
                      {getFieldLabel(field.name)}
                      {field.required && <em>*</em>}
                    </span>
                    {renderPublishedInput(field)}
                  </label>
                ))
              )}
              {!preparing && publishedVersion && inputFields.length === 0 && (
                <div className="gateway-empty-input">开始节点没有输入参数，可直接运行。</div>
              )}
              {inputError && (
                <div className="gateway-error">
                  <Typography.Text type="danger">{inputError}</Typography.Text>
                </div>
              )}
              <Button
                aria-label="开始运行已发布版本"
                block
                theme="solid"
                type="primary"
                icon={<IconPlay aria-hidden="true" />}
                loading={preparing}
                disabled={!publishedVersion || preparing}
                onClick={() => void handleRun()}
              >
                开始运行
              </Button>
            </section>
          )}

          {result.status !== 'idle' && (
            <div className="gateway-result-status">
              <Tag color={statusColor} size="large">
                {result.status === 'running' && <Spin size="small" />}
                {statusText}
              </Tag>
              {result.status === 'running' && (
                <Button
                  aria-label="停止运行"
                  size="small"
                  type="danger"
                  icon={<IconClose aria-hidden="true" />}
                  onClick={handleStop}
                >
                  停止
                </Button>
              )}
            </div>
          )}

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
                    <span
                      className={'gateway-node-state ' + node.status}
                      aria-label={NODE_STATUS_LABELS[node.status]}
                    />
                    <div>
                      <strong>{node.title || '未命名节点'}</strong>
                      <span>{NODE_TYPE_LABELS[node.type] || '其他节点'}</span>
                    </div>
                    {node.tokens ? <small>{node.tokens} 令牌</small> : null}
                  </div>
                ))}
              </div>
            </section>
          )}

          {result.text && (
            <section className="gateway-section">
              <h3>文本输出</h3>
              <pre className="gateway-output">{result.text}</pre>
            </section>
          )}

          {Object.keys(result.outputs).length > 0 && (
            <section className="gateway-section">
              <h3>工作流输出</h3>
              <pre className="gateway-output">{JSON.stringify(result.outputs, null, 2)}</pre>
            </section>
          )}

          {result.status === 'succeeded' && (
            <section className="gateway-section">
              <h3>执行统计</h3>
              <div className="gateway-stats">
                <div><span>令牌用量</span><strong>{result.totalTokens}</strong></div>
                <div><span>执行步数</span><strong>{result.totalSteps}</strong></div>
                <div><span>耗时</span><strong>{result.elapsedTime.toFixed(2)} 秒</strong></div>
              </div>
            </section>
          )}

          {result.status !== 'running' && result.status !== 'idle' && (
            <Button
              aria-label="打包下载已发布版本运行结果"
              block
              theme="light"
              type="primary"
              icon={<IconDownload aria-hidden="true" />}
              onClick={() => void downloadResultArchive({
                workflowName: publishedWorkflowName
                  || (workflowId ? `工作流-${workflowId.slice(0, 8)}` : '工作流结果'),
                status: statusText,
                inputs,
                sensitiveInputKeys,
                text: result.text,
                outputs: result.outputs,
                nodes: result.nodes,
                statistics: {
                  totalTokens: result.totalTokens,
                  totalSteps: result.totalSteps,
                  elapsedTime: result.elapsedTime,
                },
                error: result.error,
              })}
            >
              打包下载 ZIP
            </Button>
          )}

          {result.status !== 'running' && result.status !== 'idle' && (
            <Button
              block
              theme="borderless"
              onClick={() => {
                setResult(initialState);
                setInputError('');
              }}
            >
              修改输入并再次运行
            </Button>
          )}
        </div>
      </SideSheet>
    </>
  );
};
