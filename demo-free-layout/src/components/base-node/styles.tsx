/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import styled from 'styled-components';
import { IconInfoCircle } from '@douyinfe/semi-icons';

export const NodeWrapperStyle = styled.div`
  align-items: flex-start;
  background-color: #fff;
  border: 1px solid #e5e6eb;
  border-radius: 10px;
  box-shadow: 0 2px 8px rgba(15, 23, 42, 0.04);
  display: flex;
  flex-direction: column;
  justify-content: center;
  position: relative;
  width: 300px;
  height: auto;
  min-height: 42px;
  transition: border-color 140ms ease, box-shadow 140ms ease;

  &.selected {
    border: 1px solid var(--ff-primary);
    box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1), 0 6px 16px rgba(15, 23, 42, 0.06);
  }

  &:hover {
    border-color: #c9cdd4;
    box-shadow: 0 6px 18px rgba(15, 23, 42, 0.07);
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
