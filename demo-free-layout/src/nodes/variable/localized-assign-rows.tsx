/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import type { ComponentProps } from 'react';

import { FieldArray } from '@flowgram.ai/free-layout-editor';
import {
  type AssignValueType,
  BlurInput,
  InjectDynamicValueInput,
  InjectVariableSelector,
} from '@flowgram.ai/form-materials';
import { Button, IconButton } from '@douyinfe/semi-ui';
import { IconMinus, IconPlus } from '@douyinfe/semi-icons';

interface LocalizedAssignRowsProps {
  name: string;
  readonly?: boolean;
  defaultValue?: AssignValueType[];
}

type DynamicValue = ComponentProps<typeof InjectDynamicValueInput>['value'];

interface LocalizedAssignRowProps {
  value?: AssignValueType;
  readonly?: boolean;
  onChange: (value?: AssignValueType) => void;
  onDelete: () => void;
}

function LocalizedAssignRow({
  value = { operator: 'assign' },
  readonly,
  onChange,
  onDelete,
}: LocalizedAssignRowProps) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
      <div style={{ width: 150, minWidth: 150, maxWidth: 150 }}>
        {value.operator === 'assign' ? (
          <InjectVariableSelector
            readonly={readonly}
            style={{ width: '100%', height: 26 }}
            value={value.left?.content}
            config={{ placeholder: '选择目标变量', notFoundContent: '暂无可用变量' }}
            onChange={(content) =>
              onChange({
                ...value,
                left: { type: 'ref', content },
              })
            }
          />
        ) : (
          <BlurInput
            disabled={readonly}
            style={{ height: 26 }}
            size="small"
            placeholder="输入变量名"
            value={value.left}
            onChange={(left) => onChange({ ...value, left })}
          />
        )}
      </div>
      <div style={{ flexGrow: 1 }}>
        <InjectDynamicValueInput
          readonly={readonly}
          value={value.right as DynamicValue}
          onChange={(right) => onChange({ ...value, right })}
        />
      </div>
      {!readonly && (
        <IconButton
          aria-label="删除变量操作"
          size="small"
          theme="borderless"
          icon={<IconMinus />}
          onClick={onDelete}
        />
      )}
    </div>
  );
}

export function LocalizedAssignRows({
  name,
  readonly,
  defaultValue,
}: LocalizedAssignRowsProps) {
  return (
    <FieldArray<AssignValueType | undefined> name={name} defaultValue={defaultValue}>
      {({ field }) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {field.map((childField, index) => (
            <LocalizedAssignRow
              key={childField.key}
              readonly={readonly}
              value={childField.value}
              onChange={childField.onChange}
              onDelete={() => field.remove(index)}
            />
          ))}
          {!readonly && (
            <div style={{ display: 'flex', gap: 5 }}>
              <Button
                size="small"
                theme="borderless"
                icon={<IconPlus />}
                onClick={() => field.append({ operator: 'assign' })}
              >
                赋值
              </Button>
              <Button
                size="small"
                theme="borderless"
                icon={<IconPlus />}
                onClick={() => field.append({ operator: 'declare' })}
              >
                声明变量
              </Button>
            </div>
          )}
        </div>
      )}
    </FieldArray>
  );
}
