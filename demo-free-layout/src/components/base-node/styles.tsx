/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import styled from 'styled-components';
import { IconInfoCircle } from '@douyinfe/semi-icons';

export const NodeWrapperStyle = styled.div`
  align-items: flex-start;
  background-color: #fff;
  border: 1px solid #d7dee9;
  border-radius: var(--ff-radius);
  box-shadow: 0 2px 8px rgba(15, 23, 42, 0.06);
  display: flex;
  flex-direction: column;
  justify-content: center;
  position: relative;
  width: 360px;
  height: auto;
  min-height: 44px;
  transition: border-color 140ms ease, box-shadow 140ms ease, transform 140ms ease;

  &::before {
    position: absolute;
    z-index: 2;
    top: 10px;
    bottom: 10px;
    left: 0;
    width: 3px;
    border-radius: 0 3px 3px 0;
    background: #94a3b8;
    content: '';
  }

  &.node-type-llm::before,
  &.node-type-text::before { background: #6366f1; }
  &.node-type-image::before { background: #22a06b; }
  &.node-type-video::before { background: #f97316; }
  &.node-type-http::before { background: #0284c7; }
  &.node-type-code::before { background: #7c3aed; }
  &.node-type-condition::before,
  &.node-type-multi-condition::before { background: #d97706; }
  &.node-type-start::before { background: #16a34a; }
  &.node-type-end::before { background: #dc2626; }

  &.selected {
    border: 1px solid var(--ff-primary);
    box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.12);
  }

  &:hover {
    border-color: #b9c5d6;
    box-shadow: 0 8px 22px rgba(15, 23, 42, 0.09);
    transform: translateY(-1px);
  }
`;

export const ErrorIcon = () => (
  <IconInfoCircle
    style={{
      position: 'absolute',
      color: 'red',
      left: -6,
      top: -6,
      zIndex: 1,
      background: 'white',
      borderRadius: 8,
    }}
  />
);
