/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { Tooltip, IconButton } from '@douyinfe/semi-ui';

import { UIIconMinimap } from './styles';

export const MinimapSwitch = (props: {
  minimapVisible: boolean;
  setMinimapVisible: (visible: boolean) => void;
}) => {
  const { minimapVisible, setMinimapVisible } = props;

  return (
    <Tooltip content="鸟瞰图">
      <IconButton
        type="tertiary"
        theme="borderless"
        icon={<UIIconMinimap visible={minimapVisible} />}
        onClick={() => setMinimapVisible(!minimapVisible)}
      />
    </Tooltip>
  );
};
