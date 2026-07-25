/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import styled from 'styled-components';

import { IconMinimap } from '../../assets/icon-minimap';

export const ToolContainer = styled.div`
  position: absolute;
  bottom: 20px;
  left: 20px;
  right: 20px;
  display: flex;
  justify-content: center;
  min-width: 360px;
  pointer-events: none;
  gap: 10px;

  z-index: 20;

  @media (max-width: 720px) {
    right: 8px;
    bottom: 8px;
    left: 8px;
    min-width: 0;
    justify-content: stretch;
  }
`;

export const ToolSection = styled.div`
  display: flex;
  align-items: center;
  background-color: #fff;
  border: 1px solid #dfe5ef;
  border-radius: 12px;
  box-shadow: 0 6px 20px rgba(16, 24, 40, 0.10);
  column-gap: 3px;
  min-height: 44px;
  padding: 4px 12px 4px 8px;
  pointer-events: auto;

  @media (max-width: 720px) {
    width: 100%;
    justify-content: space-between;
    padding: 4px 6px;

    > :nth-child(-n + 14),
    > :nth-child(10),
    > :nth-child(11),
    > :nth-child(16) {
      display: none !important;
    }
  }
`;

export const SelectZoom = styled.span`
  padding: 4px;
  border-radius: 8px;
  border: 1px solid rgba(68, 83, 130, 0.25);
  font-size: 12px;
  width: 50px;
  cursor: pointer;
`;

export const MinimapContainer = styled.div`
  position: absolute;
  bottom: 60px;
  left: 16px;
  width: 198px;
`;

export const UIIconMinimap = styled(IconMinimap)<{ visible: boolean }>`
  color: ${(props) => (props.visible ? undefined : '#060709cc')};
`;
