/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import {
  FormRenderProps,
  FlowNodeJSON,
  Field,
  FormMeta,
  ValidateTrigger,
} from '@flowgram.ai/free-layout-editor';
import { SubCanvasRender } from '@flowgram.ai/free-container-plugin';
import {
  BatchOutputs,
  BatchVariableSelector,
  createBatchOutputsFormPlugin,
  IFlowRefValue,
  provideBatchInputEffect,
} from '@flowgram.ai/form-materials';

import { defaultFormMeta } from '../default-form-meta';
import { useIsSidebar, useNodeRenderContext } from '../../hooks';
import {
  Feedback,
  FormContent,
  FormHeader,
  FormItem,
  LocalizedOutputs,
} from '../../form-components';

interface LoopNodeJSON extends FlowNodeJSON {
  data: {
    loopFor: IFlowRefValue;
    loopOutputs: Record<string, IFlowRefValue | undefined>;
  };
}

const BatchLimits = () => (
  <div style={{
    marginBottom: 12,
    padding: '10px 12px',
    color: 'var(--semi-color-text-1)',
    background: 'var(--semi-color-fill-0)',
    border: '1px solid var(--semi-color-border)',
    borderRadius: 8,
    fontSize: 12,
    lineHeight: 1.7,
  }}>
    首期限制：仅支持字符串或数字数组，按顺序逐项执行；最多 20 项。子画布固定为一个同步 JavaScript 节点，不支持嵌套、API、大语言模型、媒体、变量、继续或中断。
  </div>
);

export const LoopFormRender = ({ form }: FormRenderProps<LoopNodeJSON>) => {
  const isSidebar = useIsSidebar();
  const { readonly } = useNodeRenderContext();
  const formHeight = 115;

  const loopFor = (
    <Field<IFlowRefValue> name={`loopFor`}>
      {({ field, fieldState }) => (
        <FormItem name="循环数组" type="array" required>
          <BatchVariableSelector
            style={{ width: '100%' }}
            value={field.value?.content}
            onChange={(val) => field.onChange({ type: 'ref', content: val })}
            readonly={readonly}
            hasError={Object.keys(fieldState?.errors || {}).length > 0}
          />
          <Feedback errors={fieldState?.errors} />
        </FormItem>
      )}
    </Field>
  );

  const loopOutputs = (
    <Field<Record<string, IFlowRefValue | undefined> | undefined> name={`loopOutputs`}>
      {({ field, fieldState }) => (
        <FormItem name="循环输出" type="object" vertical>
          <BatchOutputs
            style={{ width: '100%' }}
            value={field.value}
            onChange={(val) => field.onChange(val)}
            readonly={readonly}
            hasError={Object.keys(fieldState?.errors || {}).length > 0}
          />
          <Feedback errors={fieldState?.errors} />
        </FormItem>
      )}
    </Field>
  );

  if (isSidebar) {
    return (
      <>
        <FormHeader />
        <FormContent>
          <BatchLimits />
          {loopFor}
          {loopOutputs}
        </FormContent>
      </>
    );
  }
  return (
    <>
      <FormHeader />
      <FormContent>
        <BatchLimits />
        {loopFor}
        <SubCanvasRender offsetY={-formHeight} />
        <LocalizedOutputs />
      </FormContent>
    </>
  );
};

export const formMeta: FormMeta = {
  ...defaultFormMeta,
  render: LoopFormRender,
  validateTrigger: ValidateTrigger.onChange,
  validate: {
    ...defaultFormMeta.validate,
    loopFor: ({ value }: { value?: IFlowRefValue }) => (
      value?.type === 'ref' && Array.isArray(value.content) && value.content.length >= 2
        ? undefined
        : '请选择一个字符串或数字数组'
    ),
    loopOutputs: ({ value }: { value?: Record<string, IFlowRefValue | undefined> }) => {
      const entries = Object.entries(value || {});
      if (entries.length !== 1) return '数组批处理必须且只能设置一个输出';
      const output = entries[0][1];
      return output?.type === 'ref' && Array.isArray(output.content) && output.content.length >= 2
        ? undefined
        : '请选择逐项代码节点的输出';
    },
  },
  effect: {
    loopFor: provideBatchInputEffect,
  },
  plugins: [createBatchOutputsFormPlugin({ outputKey: 'loopOutputs', inferTargetKey: 'outputs' })],
};
