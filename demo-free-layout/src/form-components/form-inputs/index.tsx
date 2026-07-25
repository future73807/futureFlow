/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { Component } from 'react';
import { Field } from '@flowgram.ai/free-layout-editor';
import { DynamicValueInput, PromptEditorWithVariables } from '@flowgram.ai/form-materials';

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
 * The rich prompt editor is loaded lazily by the upstream material package.
 * If a transient chunk request fails, preserve the workflow canvas and fall
 * back to the standard dynamic input instead of letting React unmount it.
 */
class PromptEditorBoundary extends Component<PromptEditorBoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <DynamicValueInput
          value={this.props.value}
          onChange={this.props.onChange}
          readonly={this.props.readonly}
          hasError={this.props.hasError}
          schema={this.props.schema}
        />
      );
    }
    return (
      <PromptEditorWithVariables
        value={this.props.value}
        onChange={this.props.onChange}
        readonly={this.props.readonly}
        hasError={this.props.hasError}
      />
    );
  }
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
