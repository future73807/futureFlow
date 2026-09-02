/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { FormMeta, FormRenderProps } from '@flowgram.ai/free-layout-editor';

import { FlowNodeJSON } from '../../typings';
import { FormHeader, FormContent } from '../../form-components';
import { ServerSelect } from './components/server-select';
import { ToolSelect } from './components/tool-select';
import { ArgumentsInput } from './components/arguments-input';

export const FormRender = ({ form }: FormRenderProps<FlowNodeJSON>) => (
  <>
    <FormHeader />
    <FormContent>
      <ServerSelect />
      <ToolSelect />
      <ArgumentsInput />
    </FormContent>
  </>
);

export const formMeta: FormMeta = {
  render: (props) => <FormRender {...props} />,
  validate: {
    title: ({ value }: { value: string }) => (value?.trim() ? undefined : '标题不能为空'),
    serverId: ({ value }: { value: string }) => (value?.trim() ? undefined : '请选择 MCP 服务器'),
    tool: ({ value }: { value: string }) => (value?.trim() ? undefined : '请选择要调用的工具'),
  },
};
