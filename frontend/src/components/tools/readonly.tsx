/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { useCallback } from 'react';

import { usePlayground } from '@flowgram.ai/free-layout-editor';
import { IconButton, Tooltip } from '@douyinfe/semi-ui';
import { IconUnlock, IconLock } from '@douyinfe/semi-icons';

export const Readonly = () => {
  const playground = usePlayground();
  const toggleReadonly = useCallback(() => {
    playground.config.readonly = !playground.config.readonly;
  }, [playground]);
  return playground.config.readonly ? (
    <Tooltip content="切换为可编辑">
      <IconButton
        aria-label="切换为可编辑"
        theme="borderless"
        type="tertiary"
        icon={<IconLock aria-hidden="true" size="default" />}
        onClick={toggleReadonly}
      />
    </Tooltip>
  ) : (
    <Tooltip content="切换为只读">
      <IconButton
        aria-label="切换为只读"
        theme="borderless"
        type="tertiary"
        icon={<IconUnlock aria-hidden="true" size="default" />}
        onClick={toggleReadonly}
      />
    </Tooltip>
  );
};
