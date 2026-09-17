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
import {
  BatchOutputs,
  BatchVariableSelector,
  createBatchOutputsFormPlugin,
  IFlowRefValue,
  provideBatchInputEffect,
} from '@flowgram.ai/form-materials';
import { InputNumber, Select } from '@douyinfe/semi-ui';

import { LoopMiddleValues } from './components/middle-values';
import { LoopCanvasLayer } from './components/loop-body-layer';
import { defaultFormMeta } from '../default-form-meta';
import { useIsSidebar, useNodeRenderContext } from '../../hooks';
import { Feedback, FormContent, FormHeader, FormItem } from '../../form-components';

interface LoopNodeJSON extends FlowNodeJSON {
  data: {
    /** array：数组循环；count：指定次数；infinite：无限循环（受最大轮数保护） */
    loopType?: 'array' | 'count' | 'infinite';
    loopFor: IFlowRefValue;
    loopCount?: number;
    loopMaxRounds?: number;
    loopMiddleValues?: Record<string, IFlowRefValue | undefined>;
    loopOutputs: Record<string, IFlowRefValue | undefined>;
  };
}

/** 循环类型选项：与画布/云端归一化保持一致 */
const LOOP_TYPE_OPTIONS = [
  { value: 'array', label: '使用数组循环' },
  { value: 'count', label: '指定循环次数' },
  { value: 'infinite', label: '无限循环' },
];

const MAX_ROUNDS = 20;

/** 侧栏分节标题：循环设置 / 中间变量 / 输出 */
const FormSection = ({ title }: { title: string }) => (
  <div className="ff-loop-form-section">{title}</div>
);

export const LoopFormRender = ({ form }: FormRenderProps<LoopNodeJSON>) => {
  const isSidebar = useIsSidebar();
  const { readonly } = useNodeRenderContext();

  const loopType = (
    <Field<'array' | 'count' | 'infinite'> name="loopType" defaultValue="array">
      {({ field, fieldState }) => (
        <>
          <FormItem name="循环类型" required>
            <Select
              style={{ width: '100%' }}
              value={field.value || 'array'}
              optionList={LOOP_TYPE_OPTIONS}
              disabled={readonly}
              onChange={(value) => field.onChange(String(value) as 'array' | 'count' | 'infinite')}
            />
            <Feedback errors={fieldState?.errors} />
          </FormItem>
          {field.value === 'count'
            ? loopCount
            : field.value === 'infinite'
            ? loopMaxRounds
            : loopFor}
        </>
      )}
    </Field>
  );

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

  const loopCount = (
    <Field<number> name="loopCount" defaultValue={3}>
      {({ field, fieldState }) => (
        <FormItem name="循环次数" required>
          <InputNumber
            style={{ width: '100%' }}
            min={1}
            max={MAX_ROUNDS}
            value={field.value ?? 3}
            disabled={readonly}
            onChange={(value) => field.onChange(Number(value) || 1)}
          />
          <Feedback errors={fieldState?.errors} />
        </FormItem>
      )}
    </Field>
  );

  const loopMaxRounds = (
    <Field<number> name="loopMaxRounds" defaultValue={MAX_ROUNDS}>
      {({ field, fieldState }) => (
        <FormItem name="最大轮数" required>
          <InputNumber
            style={{ width: '100%' }}
            min={1}
            max={MAX_ROUNDS}
            value={field.value ?? MAX_ROUNDS}
            disabled={readonly}
            onChange={(value) => field.onChange(Number(value) || 1)}
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
          <FormSection title="循环设置" />
          {loopType}
          <FormSection title="中间变量" />
          <LoopMiddleValues />
          <FormSection title="输出" />
          {loopOutputs}
        </FormContent>
      </>
    );
  }
  return (
    <>
      <FormContent>
        {/* 画布图层：卡片（世界锚定）+ 循环体框 + 竖线 + 端口标记 */}
        <LoopCanvasLayer />
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
    loopType: ({ value }: { value?: string }) =>
      ['array', 'count', 'infinite'].includes(String(value || 'array'))
        ? undefined
        : '循环类型不合法',
    loopFor: ({
      value,
      formValues,
    }: {
      value?: IFlowRefValue;
      formValues: LoopNodeJSON['data'];
    }) => {
      if (String(formValues?.loopType || 'array') !== 'array') return undefined;
      return value?.type === 'ref' && Array.isArray(value.content) && value.content.length >= 2
        ? undefined
        : '请选择一个字符串或数字数组';
    },
    loopCount: ({ value, formValues }: { value?: number; formValues: LoopNodeJSON['data'] }) => {
      if (String(formValues?.loopType || 'array') !== 'count') return undefined;
      const rounds = Number(value);
      return Number.isInteger(rounds) && rounds >= 1 && rounds <= MAX_ROUNDS
        ? undefined
        : `循环次数必须是 1 到 ${MAX_ROUNDS} 之间的整数`;
    },
    loopMaxRounds: ({
      value,
      formValues,
    }: {
      value?: number;
      formValues: LoopNodeJSON['data'];
    }) => {
      if (String(formValues?.loopType || 'array') !== 'infinite') return undefined;
      const rounds = Number(value);
      return Number.isInteger(rounds) && rounds >= 1 && rounds <= MAX_ROUNDS
        ? undefined
        : `最大轮数必须是 1 到 ${MAX_ROUNDS} 之间的整数`;
    },
    loopMiddleValues: ({ value }: { value?: Record<string, IFlowRefValue | undefined> }) => {
      for (const [name, mapping] of Object.entries(value || {})) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
          return '中间变量名需以字母或下划线开头，仅包含字母、数字和下划线';
        }
        if (
          mapping &&
          (mapping.type !== 'ref' || !Array.isArray(mapping.content) || mapping.content.length < 2)
        ) {
          return `中间变量 ${name} 需要引用一个循环外的变量`;
        }
      }
      return undefined;
    },
    loopOutputs: ({ value }: { value?: Record<string, IFlowRefValue | undefined> }) => {
      const entries = Object.entries(value || {});
      if (entries.length !== 1) return '循环节点必须且只能设置一个输出';
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
