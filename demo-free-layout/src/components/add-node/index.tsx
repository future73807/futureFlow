/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { Button } from '@douyinfe/semi-ui';
import { IconPlus } from '@douyinfe/semi-icons';

import { useAddNode } from './use-add-node';

export const AddNode = (props: { disabled: boolean }) => {
  const addNode = useAddNode();
  return (
    <Button
      data-testid="demo.free-layout.add-node"
      className="canvas-add-node-action"
      aria-label="添加节点"
      icon={<IconPlus aria-hidden="true" />}
      type="primary"
      theme="light"
      disabled={props.disabled}
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        addNode(rect);
      }}
    >
      添加节点
    </Button>
  );
};
