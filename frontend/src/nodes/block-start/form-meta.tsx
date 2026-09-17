/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { FormRenderProps, FormMeta } from '@flowgram.ai/free-layout-editor';

import { FlowNodeJSON } from '../../typings';

/**
 * 循环体框边缘的连接圆点：参考图里循环体没有输入/输出节点，只有框线
 * 上的圆点。节点本身不渲染任何内容（占位 20×20），可见的圆点是节点
 * 的端口（port 位于节点中心 = 框线上的钉位点），由 flowgram 渲染，
 * hover 时只放大、不显示加号（循环体边缘不能加节点，样式见 canvas.css）。
 */
export const renderForm = ({ form }: FormRenderProps<FlowNodeJSON>) => {
  void form;
  return <></>;
};

export const formMeta: FormMeta<FlowNodeJSON> = {
  render: renderForm,
};
