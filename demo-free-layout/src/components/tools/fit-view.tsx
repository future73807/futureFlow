/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { usePlaygroundTools } from '@flowgram.ai/free-layout-editor';
import { IconButton, Tooltip } from '@douyinfe/semi-ui';
import { IconExpand } from '@douyinfe/semi-icons';

export const FitView = () => {
  const tools = usePlaygroundTools();
  return (
    <Tooltip content="适应视图">
      <IconButton
        aria-label="适应视图"
        icon={<IconExpand aria-hidden="true" />}
        type="tertiary"
        theme="borderless"
        onClick={() => tools.fitView()}
      />
    </Tooltip>
  );
};
