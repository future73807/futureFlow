/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { FormRenderProps, FormMeta } from '@flowgram.ai/free-layout-editor';

import { FlowNodeJSON } from '../../typings';

/**
 * 循环体框边缘的连接圆点（右）：与 block-start 对称，节点本身不渲染
 * 任何内容，可见圆点是节点的端口（位于节点中心 = 框线钉位点）。
 */
export const renderForm = ({ form }: FormRenderProps<FlowNodeJSON>) => {
  void form;
  return <></>;
};

export const formMeta: FormMeta<FlowNodeJSON> = {
  render: renderForm,
};
