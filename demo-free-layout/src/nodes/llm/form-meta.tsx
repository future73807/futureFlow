import { FormMeta } from '@flowgram.ai/free-layout-editor';
import { FlowNodeJSON } from '../../typings';
import { defaultFormMeta } from '../default-form-meta';

/*
 * 大语言模型节点的输入结构是固定的。这里不能使用通用输入推断插件，
 * 否则保存时会覆盖 required 与 prompt-editor 元数据，刷新后提示词编辑器
 * 会退化为普通单值输入。
 */
export const formMeta: FormMeta<FlowNodeJSON> = {
  ...defaultFormMeta,
};
