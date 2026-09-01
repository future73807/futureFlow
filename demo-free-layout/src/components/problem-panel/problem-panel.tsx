/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { useService, WorkflowSelectService } from '@flowgram.ai/free-layout-editor';
import { IconButton, Spin, Typography, Avatar, Tooltip } from '@douyinfe/semi-ui';
import { IconUploadError, IconClose } from '@douyinfe/semi-icons';
import styled from 'styled-components';

import { useProblemPanel, useNodeFormPanel } from '../../plugins/panel-manager-plugin/hooks';
import { useWatchValidate } from './use-watch-validate';

const PanelContainer = styled.div`
  width: 100%;
  height: 100%;
  border-radius: var(--ff-radius-lg);
  background: var(--ff-surface);
  border: 1px solid var(--ff-border);
  box-shadow: var(--ff-shadow-lg);
  display: flex;
  flex-direction: column;
  overflow: hidden;
`;

const PanelHeader = styled.div`
  display: flex;
  height: 50px;
  flex-shrink: 0;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  border-bottom: 1px solid var(--ff-border);
  background: var(--ff-surface-muted);
`;

const ProblemList = styled.div`
  padding: 12px;
  display: flex;
  flex-direction: column;
  rowGap: 8px;
  overflow: auto;
`;

const ProblemItem = styled.div`
  display: flex;
  align-items: center;
  border: 1px solid var(--ff-border);
  border-radius: var(--ff-radius);
  padding: 8px;
  cursor: pointer;
  background: var(--ff-surface);
  transition: border-color 0.15s ease, background 0.15s ease;

  &:hover {
    border-color: var(--ff-primary);
    background: var(--ff-primary-soft);
  }
`;

export const ProblemPanel = () => {
  const { results, loading } = useWatchValidate();

  const selectService = useService(WorkflowSelectService);

  const { close: closePanel } = useProblemPanel();
  const { open: openNodeFormPanel } = useNodeFormPanel();

  return (
    <PanelContainer>
      <PanelHeader>
        <div style={{ display: 'flex', alignItems: 'center', columnGap: '4px', height: '100%' }}>
          <Typography.Text strong>问题检查</Typography.Text>
          {loading && <Spin size="small" style={{ lineHeight: '0' }} />}
        </div>
        <IconButton
          aria-label="关闭问题检查"
          type="tertiary"
          theme="borderless"
          icon={<IconClose aria-hidden="true" />}
          onClick={() => closePanel()}
        />
      </PanelHeader>
      <ProblemList>
        {results.map((i) => (
          <ProblemItem
            key={i.node.id}
            onClick={() => {
              selectService.selectNodeAndScrollToView(i.node);
              openNodeFormPanel({ nodeId: i.node.id });
            }}
          >
            <Avatar
              style={{ flexShrink: '0' }}
              src={i.node.getNodeRegistry().info.icon}
              size="24px"
              shape="square"
            />
            <div style={{ marginLeft: '8px', minWidth: 0 }}>
              <Typography.Text ellipsis={{ showTooltip: true }}>
                {i.node.form?.values.title}
              </Typography.Text>
              <br />
              <Typography.Text type="danger">
                {i.feedbacks.map((i) => i.feedbackText).join(', ')}
              </Typography.Text>
            </div>
          </ProblemItem>
        ))}
      </ProblemList>
    </PanelContainer>
  );
};

export const ProblemButton = () => {
  const { open } = useProblemPanel();
  return (
    <Tooltip content="问题检查">
      <IconButton
        aria-label="打开问题检查"
        type="tertiary"
        theme="borderless"
        icon={<IconUploadError aria-hidden="true" />}
        onClick={() => open()}
      />
    </Tooltip>
  );
};
