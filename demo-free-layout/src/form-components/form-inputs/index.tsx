/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { Field } from '@flowgram.ai/free-layout-editor';
import { DynamicValueInput } from '@flowgram.ai/form-materials';

import { FormItem } from '../form-item';
import { Feedback } from '../feedback';
import { JsonSchema } from '../../typings';
import { useNodeRenderContext } from '../../hooks';

interface PromptEditorBoundaryProps {
  value: any;
  onChange: (value: any) => void;
  readonly: boolean;
  hasError: boolean;
  schema: JsonSchema;
}

/**
 * The upstream rich prompt editor uses a CodeMirror marker layer. Removing an
 * LLM node while that layer is measuring can emit an uncaught "Invalid
 * position -1" error, even though the canvas remains visible. The dynamic
 * value input supports the same constant/template values and variable syntax
 * without retaining an editor instance after the node has been removed.
 */
function PromptEditorBoundary(props: PromptEditorBoundaryProps) {
  return (
    <DynamicValueInput
      value={props.value}
      onChange={props.onChange}
      readonly={props.readonly}
      hasError={props.hasError}
      schema={props.schema}
    />
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
                  name={key}
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
