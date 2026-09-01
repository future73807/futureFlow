/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import styled from 'styled-components';

import { IconMinimap } from '../../assets/icon-minimap';

export const ToolContainer = styled.div`
  position: absolute;
  bottom: 18px;
  left: 18px;
  right: 18px;
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
  background-color: var(--ff-surface);
  border: 1px solid var(--ff-border);
  border-radius: var(--ff-radius-lg);
  box-shadow: var(--ff-shadow-sm);
  column-gap: 4px;
  min-height: 44px;
  padding: 4px 10px;

  > :last-child {
    margin-right: 2px;
  }
  pointer-events: auto;

  .canvas-tool-group {
    display: flex;
    align-items: center;
    gap: 3px;
  }

  .gedit-flow-panel-layer-wrap-floating:has(.gedit-flow-panel-right-area .gedit-flow-panel-wrap) & {
    width: 100%;
    justify-content: flex-start;
    overflow-x: auto;
    padding: 4px 8px;

    .canvas-tool-group-view,
    .canvas-tool-group-edit,
    > .semi-divider:first-of-type {
      display: none !important;
    }
  }

  @media (max-width: 720px) {
    width: 100%;
    justify-content: flex-start;
    overflow-x: auto;
    padding: 4px 8px;

    .canvas-tool-group-view,
    .canvas-tool-group-edit,
    > .semi-divider {
      display: none !important;
    }

    .canvas-tool-group-primary {
      width: 100%;
      justify-content: center;
    }
  }
`;

export const SelectZoom = styled.span`
  padding: 4px;
  border-radius: var(--ff-radius);
  border: 1px solid var(--ff-border);
  font-size: 12px;
  width: 50px;
  cursor: pointer;
  color: var(--ff-muted);
  transition: border-color 0.15s ease, color 0.15s ease;

  &:hover {
    border-color: var(--ff-primary);
    color: var(--ff-primary);
  }
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
