import iconImage from '../../assets/icon-image.svg';
import iconText from '../../assets/icon-text.svg';
import iconVideo from '../../assets/icon-video.svg';
import { FlowNodeRegistry } from '../../typings';
import { createWorkflowNodeId } from '../../utils/node-id';
import { WorkflowNodeType } from '../constants';
import { contentFormMeta } from './form-meta';

let textIndex = 0;
let imageIndex = 0;
let videoIndex = 0;

const baseMeta = {
  size: { width: 360, height: 220 },
};

const mediaInputValues = () => ({
  url: { type: 'template' as const, content: '' },
  poster: { type: 'template' as const, content: '' },
  caption: { type: 'template' as const, content: '' },
  prompt: { type: 'template' as const, content: '' },
  taskId: { type: 'template' as const, content: '' },
});

const mediaInputs = () => ({
  type: 'object' as const,
  required: [],
  properties: {
    url: { type: 'string' as const, title: '资源地址', extra: { formComponent: 'prompt-editor' } },
    poster: { type: 'string' as const, title: '视频封面', extra: { formComponent: 'prompt-editor' } },
    caption: { type: 'string' as const, title: '说明文字', extra: { formComponent: 'prompt-editor' } },
    prompt: { type: 'string' as const, title: '生成提示词', extra: { formComponent: 'prompt-editor' } },
    taskId: { type: 'string' as const, title: '媒体任务编号', extra: { formComponent: 'prompt-editor' } },
  },
});

const mediaOutputs = () => ({
  type: 'object' as const,
  properties: {
    jobId: { type: 'string' as const, title: '媒体任务编号' },
    assetId: { type: 'string' as const, title: '媒体资产编号' },
    url: { type: 'string' as const, title: '资源地址' },
    poster: { type: 'string' as const, title: '视频封面' },
    caption: { type: 'string' as const, title: '说明文字' },
    mediaType: { type: 'string' as const, title: '媒体类型' },
    provider: { type: 'string' as const, title: '生成供应商' },
    model: { type: 'string' as const, title: '生成模型' },
    taskId: { type: 'string' as const, title: '供应商任务编号' },
    status: { type: 'string' as const, title: '生成状态' },
    mimeType: { type: 'string' as const, title: '文件类型' },
    byteSize: { type: 'number' as const, title: '文件大小（字节）' },
    sha256: { type: 'string' as const, title: '文件校验值' },
  },
});

export const TextNodeRegistry: FlowNodeRegistry = {
  type: WorkflowNodeType.Text,
  info: {
    icon: iconText,
    description: '组合、传递或格式化文本，支持引用上游变量。',
  },
  meta: baseMeta,
  formMeta: contentFormMeta,
  onAdd() {
    return {
      id: createWorkflowNodeId('text'),
      type: WorkflowNodeType.Text,
      data: {
        title: `文本处理 ${++textIndex}`,
        inputsValues: {
          text: { type: 'template', content: '在这里输入文本，输入 “{” 可引用上游变量。' },
        },
        inputs: {
          type: 'object',
          required: ['text'],
          properties: {
            text: { type: 'string', title: '文本内容', extra: { formComponent: 'prompt-editor' } },
          },
        },
        outputs: {
          type: 'object',
          properties: { text: { type: 'string', title: '文本内容' } },
        },
      },
    };
  },
};

export const ImageNodeRegistry: FlowNodeRegistry = {
  type: WorkflowNodeType.Image,
  info: {
    icon: iconImage,
    description: '传递已有图片，或通过 OpenAI、Google、豆包、MiniMax 原生生成图片。',
  },
  meta: baseMeta,
  formMeta: contentFormMeta,
  onAdd() {
    return {
      id: createWorkflowNodeId('image'),
      type: WorkflowNodeType.Image,
      data: {
        title: `图片处理 ${++imageIndex}`,
        media: {
          mode: 'passthrough',
          provider: 'openai',
          operation: 'generate',
          credentialId: '',
          model: 'gpt-image-1.5',
          size: '1024x1024',
          aspectRatio: '1:1',
          resolution: 'auto',
          durationSeconds: 5,
        },
        inputsValues: mediaInputValues(),
        inputs: mediaInputs(),
        outputs: mediaOutputs(),
      },
    };
  },
};

export const VideoNodeRegistry: FlowNodeRegistry = {
  type: WorkflowNodeType.Video,
  info: {
    icon: iconVideo,
    description: '传递已有视频，或通过 OpenAI、Google、豆包、MiniMax 创建和查询视频任务。',
  },
  meta: baseMeta,
  formMeta: contentFormMeta,
  onAdd() {
    return {
      id: createWorkflowNodeId('video'),
      type: WorkflowNodeType.Video,
      data: {
        title: `视频处理 ${++videoIndex}`,
        media: {
          mode: 'passthrough',
          provider: 'openai',
          operation: 'create',
          credentialId: '',
          model: 'sora-2',
          size: 'auto',
          aspectRatio: '16:9',
          resolution: '768P',
          durationSeconds: 5,
        },
        inputsValues: mediaInputValues(),
        inputs: mediaInputs(),
        outputs: mediaOutputs(),
      },
    };
  },
};
