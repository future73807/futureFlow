/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { useRef } from 'react';

import { Field } from '@flowgram.ai/free-layout-editor';
import { DynamicValueInput, InjectVariableSelector } from '@flowgram.ai/form-materials';
import { Button, TextArea, Typography } from '@douyinfe/semi-ui';

import { FormItem } from '../form-item';
import { Feedback } from '../feedback';
import { JsonSchema } from '../../typings';
import { useNodeRenderContext } from '../../hooks';
import { getFieldLabel } from '../field-labels';

interface PromptEditorBoundaryProps {
  value: any;
  onChange: (value: any) => void;
  readonly: boolean;
  hasError: boolean;
  schema?: JsonSchema;
  placeholder?: string;
  helperText?: string;
  minRows?: number;
  maxRows?: number;
}

const templateText = (value: any): string => {
  if (!value) return '';
  if (value.type === 'ref' && Array.isArray(value.content)) {
    return `{{${value.content.join('.')}}}`;
  }
  return String(value.content ?? '');
};

/**
 * 使用普通文本框实现稳定的模板编辑，避免富文本标记层在删除节点时残留。
 * 文本与变量可以混排，例如“标题：{{start_0.query}}”。
 */
export function PromptEditorBoundary(props: PromptEditorBoundaryProps) {
  const value = templateText(props.value);
  const textAreaRef = useRef<HTMLTextAreaElement>(null);
  const selectionRef = useRef({ start: value.length, end: value.length });

  const rememberSelection = () => {
    const textArea = textAreaRef.current;
    if (!textArea) return;
    selectionRef.current = {
      start: textArea.selectionStart,
      end: textArea.selectionEnd,
    };
  };

  const insertVariable = (path: string[]) => {
    const token = `{{${path.join('.')}}}`;
    const selectionStart = Math.min(selectionRef.current.start, value.length);
    const selectionEnd = Math.min(selectionRef.current.end, value.length);
    const nextValue = `${value.slice(0, selectionStart)}${token}${value.slice(selectionEnd)}`;
    const nextCaret = selectionStart + token.length;

    props.onChange({ type: 'template', content: nextValue });
    window.requestAnimationFrame(() => {
      const nextTextArea = textAreaRef.current;
      if (!nextTextArea) return;
      nextTextArea.focus();
      nextTextArea.setSelectionRange(nextCaret, nextCaret);
      selectionRef.current = { start: nextCaret, end: nextCaret };
    });
  };

  return (
    <div style={{ display: 'grid', gap: 7, width: '100%' }}>
      <TextArea
        ref={textAreaRef}
        autosize={{ minRows: props.minRows ?? 2, maxRows: props.maxRows ?? 8 }}
        readonly={props.readonly}
        value={value}
        validateStatus={props.hasError ? 'error' : undefined}
        placeholder={props.placeholder ?? '输入文本；可在下方插入上游变量'}
        onBlur={rememberSelection}
        onClick={rememberSelection}
        onKeyUp={rememberSelection}
        onSelect={rememberSelection}
        onChange={(content) => props.onChange({ type: 'template', content })}
      />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <Typography.Text type="tertiary" size="small">
          {props.helperText ?? '支持固定文本与变量混排'}
        </Typography.Text>
        <InjectVariableSelector
          includeSchema={props.schema}
          readonly={props.readonly}
          onChange={(path) => {
            if (!path?.length) return;
            insertVariable(path);
          }}
          triggerRender={() => (
            <Button disabled={props.readonly} size="small" theme="borderless">
              插入变量
            </Button>
          )}
        />
      </div>
    </div>
  );
}

export function FormInputs() {
  const { readonly } = useNodeRenderContext();

  return (
    <Field<JsonSchema> name="inputs">
      {({ field: inputsField }) => {
        const required = inputsField.value?.required || [];
        const properties = inputsField.value?.properties;
        if (!properties) {
          return <></>;
        }
        const content = Object.keys(properties).map((key) => {
          const property = properties[key];

          const formComponent = property.extra?.formComponent;

          const vertical = ['prompt-editor'].includes(formComponent || '');

          return (
            <Field key={key} name={`inputsValues.${key}`} defaultValue={property.default}>
              {({ field, fieldState }) => (
                <FormItem
                  name={getFieldLabel(key)}
                  vertical={vertical}
                  type={property.type as string}
                  required={required.includes(key)}
                >
                  {formComponent === 'prompt-editor' && (
                    <PromptEditorBoundary
                      value={field.value}
                      onChange={field.onChange}
                      readonly={readonly}
                      hasError={Object.keys(fieldState?.errors || {}).length > 0}
                      schema={property}
                    />
                  )}
                  {!formComponent && (
                    <DynamicValueInput
                      value={field.value}
                      onChange={field.onChange}
                      readonly={readonly}
                      hasError={Object.keys(fieldState?.errors || {}).length > 0}
                      schema={property}
                    />
                  )}
                  <Feedback errors={fieldState?.errors} warnings={fieldState?.warnings} />
                </FormItem>
              )}
            </Field>
          );
        });
        return <>{content}</>;
      }}
    </Field>
  );
}
