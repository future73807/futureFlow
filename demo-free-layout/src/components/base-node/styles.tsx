/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import styled from 'styled-components';
import { IconInfoCircle } from '@douyinfe/semi-icons';

export const NodeWrapperStyle = styled.div`
  align-items: flex-start;
  background-color: #fff;
  border: 1px solid #e4e7ec;
  border-radius: 10px;
  box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04), 0 1px 3px rgba(16, 24, 40, 0.03);
  display: flex;
  flex-direction: column;
  justify-content: center;
  position: relative;
  width: 360px;
  height: auto;
  min-height: 44px;
  transition: border-color 140ms ease, box-shadow 140ms ease;

  &.selected {
    border: 1px solid var(--ff-primary);
    box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.09), 0 4px 12px rgba(16, 24, 40, 0.06);
  }

  &:hover {
    border-color: #cfd6e0;
    box-shadow: 0 6px 16px rgba(16, 24, 40, 0.07);
  }
`;

export const ErrorIcon = () => (
  <IconInfoCircle
    style={{
      position: 'absolute',
      color: '#d92d20',
      left: -6,
      top: -6,
      zIndex: 1,
      background: 'white',
      borderRadius: 8,
    }}
  />
);