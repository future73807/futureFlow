/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { useLayoutEffect } from 'react';

import { Field } from '@flowgram.ai/free-layout-editor';
import { Switch } from '@douyinfe/semi-ui';
import styled from 'styled-components';

import { useNodeRenderContext } from '../../hooks';
import { FormItem } from '../form-item';

/** 发布时映射为 Dify 的 fail-branch 输出柄；节点表单与转换器共用这个端口 ID。 */
export const FAIL_BRANCH_PORT_ID = 'onError';

const FailPort = styled.div`
  position: absolute;
  right: -12px;
  bottom: -6px;
`;

const SwitchRow = styled.div`
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
`;

const PortHint = styled.span`
  font-size: 11px;
  color: var(--ff-danger, #c5382d);
`;

interface FailBranchToggleProps {
  node: ReturnType<typeof useNodeRenderContext>['node'];
  readonly: boolean;
  enabled: boolean;
  onChange: (value: boolean) => void;
}

function FailBranchToggle({ node, readonly, enabled, onChange }: FailBranchToggleProps) {
  useLayoutEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      node.ports?.updateDynamicPorts();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [enabled, node]);

  return (
    <FormItem
      name="失败时"
      type="boolean"
      vertical
      description="开启后节点执行失败会走“失败时”出口，成功仍走主出口"
    >
      <SwitchRow>
        {enabled && <PortHint>失败时 →</PortHint>}
        <Switch
          checked={enabled}
          disabled={readonly}
          onChange={(value) => onChange(value === true)}
          aria-label="失败分支开关"
        />
      </SwitchRow>
      {enabled && (
        <FailPort
          data-port-id={FAIL_BRANCH_PORT_ID}
          data-port-type="output"
          data-port-location="right"
        />
      )}
    </FormItem>
  );
}

/**
 * LLM / API 请求 / 代码执行节点的失败分支开关。
 * 开关数据保存在节点 data.failBranchEnabled；画布连线端口由 DOM
 * data-port-* 属性动态生成（与条件分支同一机制）。
 */
export function FailBranchControl() {
  const { node, readonly } = useNodeRenderContext();

  return (
    <Field<boolean> name="failBranchEnabled">
      {({ field }) => (
        <FailBranchToggle
          node={node}
          readonly={readonly}
          enabled={field.value === true}
          onChange={(value) => field.onChange(value)}
        />
      )}
    </Field>
  );
}
