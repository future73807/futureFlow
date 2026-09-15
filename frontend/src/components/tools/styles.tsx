/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import styled from 'styled-components';

import { IconMinimap } from '../../assets/icon-minimap';

export const ToolContainer = styled.div`
  position: absolute;
  bottom: 16px;
  left: 16px;
  right: 16px;
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
  border: 1px solid var(--ff-border);
  border-radius: 10px;
  box-shadow: 0 4px 16px rgba(15, 23, 42, 0.06);
  column-gap: 2px;
  min-height: 40px;
  padding: 4px 8px;

  > :last-child {
    margin-right: 2px;
  }
  pointer-events: auto;

  .canvas-tool-group {
    display: flex;
    align-items: center;
    gap: 1px;
  }

  /* 工具条内的图标按钮统一为紧凑的中性灰按钮 */
  .semi-button {
    min-height: 28px;
    height: 28px;
    padding: 0 4px;
    border: none !important;
    background: transparent !important;
    color: var(--ff-text-secondary) !important;
  }

  .semi-button:hover:not(:disabled) {
    background: var(--ff-surface-muted) !important;
    color: var(--ff-text) !important;
  }

  .semi-button:disabled {
    color: #c9cdd4 !important;
  }

  .semi-divider {
    background: var(--ff-border) !important;
  }

  /* 节点配置/版本等右侧面板展开时画布变窄：工具栏收成内容宽度并居中，不再是整条通栏白条 */
  .gedit-flow-panel-layer-wrap-floating:has(.gedit-flow-panel-right-area .gedit-flow-panel-wrap) & {
    width: max-content;
    max-width: 100%;
    overflow-x: auto;
    scrollbar-width: none;

    &::-webkit-scrollbar {
      display: none;
    }

    /* 空间不够时图标组可以滚走，但「添加节点 / 试运行」必须钉在可见区域 */
    .canvas-tool-group-primary {
      position: sticky;
      right: 0;
      padding-left: 6px;
      background: #ffffff;
      box-shadow: -8px 0 8px -6px rgba(15, 23, 42, 0.12);
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
  display: inline-flex;
  min-width: 46px;
  align-items: center;
  justify-content: center;
  padding: 3px 6px;
  border: none;
  border-radius: 6px;
  color: var(--ff-text-secondary);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;

  &:hover {
    background: var(--ff-surface-muted);
    color: var(--ff-text);
  }
`;

export const MinimapContainer = styled.div`
  position: absolute;
  bottom: 60px;
  left: 16px;
  width: 198px;
  padding: 3px;
  overflow: hidden;
  border: 1px solid var(--ff-border);
  border-radius: 10px;
  background: #ffffff;
  box-shadow: 0 4px 16px rgba(15, 23, 42, 0.06);
`;

export const UIIconMinimap = styled(IconMinimap)<{ visible: boolean }>`
  color: ${(props) => (props.visible ? undefined : '#060709cc')};
`;
