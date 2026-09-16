/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { FormRenderProps, FormMeta } from '@flowgram.ai/free-layout-editor';

import { FlowNodeJSON } from '../../typings';

/**
 * 循环体内的连接点：参考图里循环体没有输入/输出节点，
 * 只有左右两个用来连线的圆点，所以这里只画一个圆点，不渲染卡片和图标。
 */
export const renderForm = ({ form }: FormRenderProps<FlowNodeJSON>) => {
  void form;
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'grid',
        placeItems: 'center',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 12,
          height: 12,
          borderRadius: '50%',
          background: 'var(--ff-primary, #2563eb)',
          boxShadow: '0 0 0 3px rgba(37, 99, 235, 0.12)',
        }}
      />
    </div>
  );
};

export const formMeta: FormMeta<FlowNodeJSON> = {
  render: renderForm,
};
