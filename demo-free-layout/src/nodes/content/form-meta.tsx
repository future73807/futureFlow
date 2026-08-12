import { useState } from 'react';
import { Field, FormMeta, FormRenderProps, ValidateTrigger } from '@flowgram.ai/free-layout-editor';
import { IFlowValue, validateFlowValue } from '@flowgram.ai/form-materials';
import { Button, Divider, InputNumber, Select, Tag, Typography } from '@douyinfe/semi-ui';

import {
  Feedback,
  FormContent,
  FormHeader,
  FormInputs,
  FormItem,
  LocalizedOutputs,
  PromptEditorBoundary,
} from '../../form-components';
import { useIsSidebar, useNodeRenderContext } from '../../hooks';
import { FlowNodeJSON } from '../../typings';
import { defaultFormMeta } from '../default-form-meta';
import { WorkflowNodeType } from '../constants';
import { isMediaCredentialId } from '../../services/media-credentials';
import { MediaCredentialSelector } from './media-credential-selector';
import './styles.css';

type MediaMode = 'passthrough' | 'generate';
type MediaProvider = 'openai' | 'google' | 'doubao' | 'minimax';
type MediaOperation = 'generate' | 'create' | 'query';

interface MediaConfig {
  mode?: MediaMode;
  provider?: MediaProvider;
  operation?: MediaOperation;
  credentialId?: string;
  model?: string;
  size?: string;
  aspectRatio?: string;
  resolution?: string;
  durationSeconds?: number;
}

const PROVIDERS: Array<{ label: string; value: MediaProvider }> = [
  { label: 'OpenAI', value: 'openai' },
  { label: 'Google', value: 'google' },
  { label: '豆包（火山引擎）', value: 'doubao' },
  { label: 'MiniMax', value: 'minimax' },
];

const PROVIDER_LABELS: Record<MediaProvider, string> = {
  openai: 'OpenAI',
  google: 'Google',
  doubao: '豆包',
  minimax: 'MiniMax',
};

const MODEL_HINTS: Record<MediaProvider, Record<'image' | 'video', string[]>> = {
  openai: {
    image: ['gpt-image-1.5', 'gpt-image-1'],
    video: ['sora-2', 'sora-2-pro'],
  },
  google: {
    image: ['imagen-4.0-generate-001', 'gemini-2.5-flash-image'],
    video: ['veo-3.1-generate-preview', 'veo-3.0-generate-001'],
  },
  doubao: {
    image: ['doubao-seedream-4-0-250828', 'doubao-seedream-3-0-t2i-250415'],
    video: ['doubao-seedance-1-0-pro-250528', 'doubao-seedance-1-0-lite-t2v-250428'],
  },
  minimax: {
    image: ['image-01'],
    video: ['MiniMax-H3'],
  },
};

const contentOf = (value?: IFlowValue): string => {
  if (!value || !('content' in value)) return '';
  if (Array.isArray(value.content)) return `引用：${value.content.join('.')}`;
  return String(value.content ?? '');
};

const mediaModeOf = (values: any): MediaMode => values?.media?.mode || 'passthrough';
const isMediaNodeType = (type: unknown): boolean => (
  type === WorkflowNodeType.Image || type === WorkflowNodeType.Video
);
const mediaOperationOf = (values: any, type: WorkflowNodeType): MediaOperation => (
  type === WorkflowNodeType.Image ? 'generate' : values?.media?.operation || 'create'
);

const validateConditionalFlowValue = (
  value: IFlowValue | undefined,
  context: any,
  required: boolean,
  requiredMessage: string,
) => validateFlowValue(value, {
  node: context.node,
  required,
  errorMessages: {
    required: requiredMessage,
    unknownVariable: '引用的变量不存在或不在当前节点上游',
  },
});

const ContentPreview = () => {
  const { node } = useNodeRenderContext();
  const type = node.flowNodeType as WorkflowNodeType;
  const [approvedPreviewUrl, setApprovedPreviewUrl] = useState('');

  return (
    <Field<MediaConfig | undefined> name="media">
      {({ field: mediaField }) => (
        <Field<Record<string, IFlowValue | undefined> | undefined> name="inputsValues">
          {({ field }) => {
            const values = field.value || {};
            if (type === WorkflowNodeType.Text) {
              const text = contentOf(values.text);
              return (
                <div className="content-node-preview content-node-text-preview">
                  {text || '配置文本内容后将在这里显示摘要'}
                </div>
              );
            }

            const media = mediaField.value || {};
            const mode = media.mode || 'passthrough';
            const operation = mediaOperationOf({ media }, type);
            if (mode === 'generate') {
              const provider = media.provider || 'openai';
              const summary = operation === 'query'
                ? contentOf(values.taskId) || '填写媒体任务 ID 后查询生成结果'
                : contentOf(values.prompt) || '填写提示词后由媒体网关生成';
              return (
                <div className="content-node-preview content-node-ai-preview">
                  <div className="content-node-ai-heading">
                    <Tag color="violet" size="small">AI 原生生成</Tag>
                    <strong>{PROVIDER_LABELS[provider]}</strong>
                    <span>{operation === 'query' ? '查询任务' : type === WorkflowNodeType.Image ? '生成图片' : '创建任务'}</span>
                  </div>
                  <div className="content-node-ai-model">{media.model || '尚未选择模型'}</div>
                  <small>{summary}</small>
                </div>
              );
            }

            const url = contentOf(values.url);
            const caption = contentOf(values.caption || values.title);
            const canPreview = /^(https?:|data:|blob:)/i.test(url);
            const previewEnabled = canPreview && approvedPreviewUrl === url;

            const previewPlaceholder = (
              <span>
                {canPreview ? (
                  <Button size="small" theme="borderless" onClick={() => setApprovedPreviewUrl(url)}>
                    加载预览
                  </Button>
                ) : '填写资源地址后可加载预览'}
              </span>
            );

            if (type === WorkflowNodeType.Image) {
              return (
                <div className="content-node-preview content-node-media-preview">
                  {previewEnabled ? <img src={url} alt={caption || '图片预览'} /> : previewPlaceholder}
                  {caption && <small>{caption}</small>}
                </div>
              );
            }

            return (
              <div className="content-node-preview content-node-media-preview">
                {previewEnabled ? (
                  <video src={url} poster={contentOf(values.poster)} muted preload="metadata" />
                ) : (
                  previewPlaceholder
                )}
                {caption && <small>{caption}</small>}
              </div>
            );
          }}
        </Field>
      )}
    </Field>
  );
};

interface TemplateInputProps {
  name: string;
  label: string;
  placeholder: string;
  helperText?: string;
  required?: boolean;
  readonly: boolean;
  minRows?: number;
  maxRows?: number;
}

const TemplateInput = ({
  name,
  label,
  placeholder,
  helperText,
  required,
  readonly,
  minRows,
  maxRows,
}: TemplateInputProps) => (
  <Field<IFlowValue | undefined>
    name={`inputsValues.${name}`}
    defaultValue={{ type: 'template', content: '' }}
  >
    {({ field, fieldState }) => (
      <FormItem name={label} required={required} vertical>
        <PromptEditorBoundary
          value={field.value}
          onChange={field.onChange}
          readonly={readonly}
          hasError={Boolean(fieldState?.errors?.length)}
          placeholder={placeholder}
          helperText={helperText}
          minRows={minRows}
          maxRows={maxRows}
        />
        <Feedback errors={fieldState?.errors} warnings={fieldState?.warnings} />
      </FormItem>
    )}
  </Field>
);

const GenerationParameters = ({
  type,
  provider,
  readonly,
}: {
  type: WorkflowNodeType;
  provider: MediaProvider;
  readonly: boolean;
}) => {
  if (type === WorkflowNodeType.Image) {
    return (
      <div className="content-node-parameter-grid">
        <Field<string> name="media.size" defaultValue="1024x1024">
          {({ field, fieldState }) => (
            <FormItem name="画布尺寸" vertical>
              <Select
                value={field.value}
                onChange={(value) => field.onChange(value as string)}
                disabled={readonly}
                size="small"
                style={{ width: '100%' }}
                optionList={['auto', '1024x1024', '1536x1024', '1024x1536'].map((value) => ({ label: value, value }))}
              />
              <Feedback errors={fieldState?.errors} warnings={fieldState?.warnings} />
            </FormItem>
          )}
        </Field>
        <Field<string> name="media.aspectRatio" defaultValue="1:1">
          {({ field, fieldState }) => (
            <FormItem name="画面比例" vertical>
              <Select
                value={field.value}
                onChange={(value) => field.onChange(value as string)}
                disabled={readonly}
                size="small"
                style={{ width: '100%' }}
                optionList={['1:1', '3:2', '2:3', '16:9', '9:16'].map((value) => ({ label: value, value }))}
              />
              <Feedback errors={fieldState?.errors} warnings={fieldState?.warnings} />
            </FormItem>
          )}
        </Field>
      </div>
    );
  }

  const isMiniMaxH3 = provider === 'minimax';
  const minDuration = isMiniMaxH3 ? 4 : 1;
  const maxDuration = isMiniMaxH3 ? 15 : 30;

  return (
    <div className="content-node-parameter-grid">
      <Field<string> name="media.aspectRatio" defaultValue="16:9">
        {({ field, fieldState }) => (
          <FormItem name="画面比例" vertical>
            <Select
              value={field.value}
              onChange={(value) => field.onChange(value as string)}
              disabled={readonly}
              size="small"
              style={{ width: '100%' }}
              optionList={['16:9', '9:16', '1:1'].map((value) => ({ label: value, value }))}
            />
            <Feedback errors={fieldState?.errors} warnings={fieldState?.warnings} />
          </FormItem>
        )}
      </Field>
      {isMiniMaxH3 && (
        <Field<string> name="media.resolution" defaultValue="768P">
          {({ field, fieldState }) => (
            <FormItem name="清晰度（MiniMax H3）" vertical>
              <Select
                value={field.value}
                onChange={(value) => field.onChange(value as string)}
                disabled={readonly}
                size="small"
                style={{ width: '100%' }}
                optionList={['768P', '2K'].map((value) => ({ label: value, value }))}
              />
              <Feedback errors={fieldState?.errors} warnings={fieldState?.warnings} />
            </FormItem>
          )}
        </Field>
      )}
      <Field<number> name="media.durationSeconds" defaultValue={5}>
        {({ field, fieldState }) => (
          <FormItem name="时长（秒）" vertical>
            <InputNumber
              value={field.value}
              onChange={(value) => field.onChange(Number(value))}
              disabled={readonly}
              validateStatus={fieldState?.errors?.length ? 'error' : undefined}
              min={minDuration}
              max={maxDuration}
              step={1}
              size="small"
              style={{ width: '100%' }}
            />
            {isMiniMaxH3 && (
              <Typography.Text type="tertiary" size="small">
                MiniMax H3 支持 4–15 秒；其他供应商以各自模型限制为准。
              </Typography.Text>
            )}
            <Feedback errors={fieldState?.errors} warnings={fieldState?.warnings} />
          </FormItem>
        )}
      </Field>
    </div>
  );
};

const MediaSidebar = ({ type }: { type: WorkflowNodeType }) => {
  const { readonly } = useNodeRenderContext();
  const mediaKind = type === WorkflowNodeType.Image ? 'image' : 'video';

  return (
    <Field<MediaMode> name="media.mode" defaultValue="passthrough">
      {({ field: modeField, fieldState: modeState }) => {
        const mode = modeField.value || 'passthrough';
        return (
          <div className="content-node-editor">
            <div className="content-node-section">
              <div className="content-node-section-heading">
                <strong>处理方式</strong>
                <span>保留已有资源，或调用已配置的生成服务</span>
              </div>
              <FormItem name="运行模式" required vertical>
                <Select
                  value={mode}
                  onChange={(value) => modeField.onChange(value as MediaMode)}
                  disabled={readonly}
                  size="small"
                  style={{ width: '100%' }}
                  optionList={[
                    { label: '资源透传', value: 'passthrough' },
                    { label: 'AI 原生生成', value: 'generate' },
                  ]}
                />
                <Feedback errors={modeState?.errors} warnings={modeState?.warnings} />
              </FormItem>
            </div>

            {mode === 'passthrough' ? (
              <div className="content-node-section">
                <TemplateInput
                  name="url"
                  label={type === WorkflowNodeType.Image ? '图片地址' : '视频地址'}
                  placeholder="输入已有资源 URL，或插入上游变量"
                  required
                  readonly={readonly}
                  minRows={1}
                  maxRows={4}
                />
                {type === WorkflowNodeType.Video && (
                  <TemplateInput
                    name="poster"
                    label="视频封面"
                    placeholder="可选：输入封面图片 URL"
                    readonly={readonly}
                    minRows={1}
                    maxRows={3}
                  />
                )}
                <TemplateInput
                  name="caption"
                  label="说明文字"
                  placeholder="可选：为资源添加说明"
                  readonly={readonly}
                  minRows={1}
                  maxRows={4}
                />
              </div>
            ) : (
              <Field<MediaOperation>
                name="media.operation"
                defaultValue={type === WorkflowNodeType.Image ? 'generate' : 'create'}
              >
                {({ field: operationField, fieldState: operationState }) => {
                  const operation = type === WorkflowNodeType.Image
                    ? 'generate'
                    : operationField.value || 'create';
                  return (
                    <>
                      <div className="content-node-section">
                        {type === WorkflowNodeType.Video && (
                          <FormItem name="任务动作" required vertical>
                            <Select
                              value={operation}
                              onChange={(value) => operationField.onChange(value as MediaOperation)}
                              disabled={readonly}
                              size="small"
                              style={{ width: '100%' }}
                              optionList={[
                                { label: '创建生成任务', value: 'create' },
                                { label: '查询任务结果', value: 'query' },
                              ]}
                            />
                            <Feedback errors={operationState?.errors} warnings={operationState?.warnings} />
                          </FormItem>
                        )}

                        <Field<string> name="media.model" defaultValue={MODEL_HINTS.openai[mediaKind][0]}>
                          {({ field: modelField, fieldState: modelState }) => (
                            <Field<MediaProvider> name="media.provider" defaultValue="openai">
                              {({ field: providerField, fieldState: providerState }) => {
                                const provider = providerField.value || 'openai';
                                const modelOptions = MODEL_HINTS[provider][mediaKind].map((value) => ({
                                  label: value,
                                  value,
                                }));
                                return (
                                  <>
                                    <FormItem name="生成供应商" required vertical>
                                      <Select
                                        value={provider}
                                        onChange={(value) => {
                                          const nextProvider = value as MediaProvider;
                                          providerField.onChange(nextProvider);
                                          modelField.onChange(MODEL_HINTS[nextProvider][mediaKind][0]);
                                        }}
                                        disabled={readonly}
                                        size="small"
                                        style={{ width: '100%' }}
                                        optionList={PROVIDERS}
                                      />
                                      <Feedback errors={providerState?.errors} warnings={providerState?.warnings} />
                                    </FormItem>
                                    <FormItem name="模型 ID" required vertical>
                                      <Select
                                        value={modelField.value}
                                        onChange={(value) => modelField.onChange(value as string)}
                                        disabled={readonly}
                                        size="small"
                                        style={{ width: '100%' }}
                                        optionList={modelOptions}
                                        filter
                                        allowCreate
                                        placeholder="选择或输入模型 ID"
                                      />
                                      <Typography.Text type="tertiary" size="small">
                                        可选择推荐值，也可输入账户已开通的模型 ID。
                                      </Typography.Text>
                                      <Feedback errors={modelState?.errors} warnings={modelState?.warnings} />
                                    </FormItem>
                                    <Field<string> name="media.credentialId" defaultValue="">
                                      {({ field, fieldState }) => (
                                        <FormItem name="服务凭据" required vertical>
                                          <MediaCredentialSelector
                                            provider={provider}
                                            value={field.value}
                                            onChange={field.onChange}
                                            readonly={readonly}
                                          />
                                          <Typography.Text type="tertiary" size="small">
                                            节点只保存服务端 UUID 引用；访问密钥不会写入画布、版本历史或结果 ZIP。
                                          </Typography.Text>
                                          <Feedback errors={fieldState?.errors} warnings={fieldState?.warnings} />
                                        </FormItem>
                                      )}
                                    </Field>
                                    {operation !== 'query' && (
                                      <GenerationParameters
                                        type={type}
                                        provider={provider}
                                        readonly={readonly}
                                      />
                                    )}
                                  </>
                                );
                              }}
                            </Field>
                          )}
                        </Field>

                        <div className="content-node-provider-note">
                          参数会由媒体网关按供应商协议转换，实际能力以模型和账户权限为准。
                        </div>
                      </div>

                      <div className="content-node-section">
                        {operation === 'query' ? (
                          <TemplateInput
                            name="taskId"
                            label="媒体任务 ID"
                            placeholder="输入创建任务返回的 id（可引用上游 jobId）"
                            helperText="这里使用媒体网关创建任务后返回的 id"
                            required
                            readonly={readonly}
                            minRows={1}
                            maxRows={4}
                          />
                        ) : (
                          <>
                            <TemplateInput
                              name="prompt"
                              label="生成提示词"
                              placeholder={type === WorkflowNodeType.Image
                                ? '描述要生成的图片内容、风格和构图'
                                : '描述要生成的视频内容、镜头和运动'}
                              required
                              readonly={readonly}
                              minRows={3}
                              maxRows={10}
                            />
                            <TemplateInput
                              name="caption"
                              label="结果说明"
                              placeholder="可选：为生成结果添加说明"
                              readonly={readonly}
                              minRows={1}
                              maxRows={4}
                            />
                          </>
                        )}
                      </div>
                    </>
                  );
                }}
              </Field>
            )}
          </div>
        );
      }}
    </Field>
  );
};

const FormRender = (props: FormRenderProps<FlowNodeJSON>) => {
  const isSidebar = useIsSidebar();
  const { node } = useNodeRenderContext();
  const type = node.flowNodeType as WorkflowNodeType;
  const isMedia = type === WorkflowNodeType.Image || type === WorkflowNodeType.Video;

  return (
    <>
      <FormHeader />
      <FormContent>
        <ContentPreview />
        {isSidebar && (
          <>
            <Divider />
            {isMedia ? <MediaSidebar type={type} /> : <FormInputs />}
            <Divider />
            <LocalizedOutputs />
          </>
        )}
      </FormContent>
    </>
  );
};

const MEDIA_PROVIDERS = new Set<MediaProvider>(['openai', 'google', 'doubao', 'minimax']);
const MEDIA_MODES = new Set<MediaMode>(['passthrough', 'generate']);

export const contentFormMeta: FormMeta<FlowNodeJSON> = {
  ...defaultFormMeta,
  render: (props) => <FormRender {...props} />,
  validateTrigger: ValidateTrigger.onChange,
  validate: {
    ...defaultFormMeta.validate,
    'media.mode': ({ value }: { value?: MediaMode }) => (
      MEDIA_MODES.has(value || 'passthrough') ? undefined : '请选择有效的处理方式'
    ),
    'media.provider': ({ value, formValues }: { value?: MediaProvider; formValues: any }) => (
      mediaModeOf(formValues) !== 'generate' || MEDIA_PROVIDERS.has(value as MediaProvider)
        ? undefined
        : '请选择生成供应商'
    ),
    'media.operation': ({ value, formValues, context }: { value?: MediaOperation; formValues: any; context: any }) => {
      if (mediaModeOf(formValues) !== 'generate' || context.node.flowNodeType !== WorkflowNodeType.Video) {
        return undefined;
      }
      return value === 'create' || value === 'query' ? undefined : '请选择创建任务或查询任务';
    },
    'media.credentialId': ({ value, formValues }: { value?: string; formValues: any }) => {
      if (mediaModeOf(formValues) !== 'generate') return undefined;
      const credentialId = String(value || '').trim();
      if (!credentialId) return '请选择服务凭据';
      if (/^(?:sk-|AIza|Bearer\s|eyJ[A-Za-z0-9_-]+\.)/i.test(credentialId)) {
        return '不能填写访问密钥，请从服务凭据下拉列表选择';
      }
      return isMediaCredentialId(credentialId)
        ? undefined
        : '服务凭据格式无效，请从下拉列表重新选择';
    },
    'media.model': ({ value, formValues }: { value?: string; formValues: any }) => (
      mediaModeOf(formValues) !== 'generate' || String(value || '').trim()
        ? undefined
        : '模型 ID 不能为空'
    ),
    'media.aspectRatio': ({ value, formValues, context }: { value?: string; formValues: any; context: any }) => {
      if (mediaModeOf(formValues) !== 'generate') return undefined;
      const aspectRatio = String(value || '').trim();
      if (!aspectRatio) return undefined;
      if (context.node.flowNodeType === WorkflowNodeType.Image && aspectRatio === 'auto') {
        return '图片比例暂不支持 auto，请选择实际画面比例';
      }
      return /^\d{1,2}:\d{1,2}$/.test(aspectRatio)
        ? undefined
        : '画面比例格式应为“宽:高”，例如 16:9';
    },
    'media.durationSeconds': ({ value, formValues, context }: { value?: number; formValues: any; context: any }) => {
      const shouldValidate = mediaModeOf(formValues) === 'generate'
        && context.node.flowNodeType === WorkflowNodeType.Video
        && mediaOperationOf(formValues, WorkflowNodeType.Video) === 'create';
      if (!shouldValidate) return undefined;
      const isMiniMaxH3 = formValues?.media?.provider === 'minimax';
      const min = isMiniMaxH3 ? 4 : 1;
      const max = isMiniMaxH3 ? 15 : 30;
      return Number.isInteger(value) && Number(value) >= min && Number(value) <= max
        ? undefined
        : isMiniMaxH3
          ? 'MiniMax H3 视频时长必须是 4 到 15 秒之间的整数'
          : '视频时长必须是 1 到 30 秒之间的整数';
    },
    'inputsValues.url': ({ value, formValues, context }: { value?: IFlowValue; formValues: any; context: any }) => {
      if (!isMediaNodeType(context.node.flowNodeType) || mediaModeOf(formValues) !== 'passthrough') {
        return undefined;
      }
      return validateConditionalFlowValue(value, context, true, '资源地址不能为空');
    },
    'inputsValues.prompt': ({ value, formValues, context }: { value?: IFlowValue; formValues: any; context: any }) => {
      if (!isMediaNodeType(context.node.flowNodeType) || mediaModeOf(formValues) !== 'generate') {
        return undefined;
      }
      const type = context.node.flowNodeType as WorkflowNodeType;
      if (mediaOperationOf(formValues, type) === 'query') return undefined;
      return validateConditionalFlowValue(value, context, true, '生成提示词不能为空');
    },
    'inputsValues.taskId': ({ value, formValues, context }: { value?: IFlowValue; formValues: any; context: any }) => {
      const shouldRequire = mediaModeOf(formValues) === 'generate'
        && context.node.flowNodeType === WorkflowNodeType.Video
        && mediaOperationOf(formValues, WorkflowNodeType.Video) === 'query';
      if (!shouldRequire) return undefined;
      return validateConditionalFlowValue(value, context, true, '媒体任务 ID 不能为空');
    },
  },
};
