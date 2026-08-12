/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { useService, WorkflowSelectService } from '@flowgram.ai/free-layout-editor';
import { IconButton, Spin, Typography, Avatar, Tooltip } from '@douyinfe/semi-ui';
import { IconUploadError, IconClose } from '@douyinfe/semi-icons';

import { useProblemPanel, useNodeFormPanel } from '../../plugins/panel-manager-plugin/hooks';
import { useWatchValidate } from './use-watch-validate';

export const ProblemPanel = () => {
  const { results, loading } = useWatchValidate();

  const selectService = useService(WorkflowSelectService);

  const { close: closePanel } = useProblemPanel();
  const { open: openNodeFormPanel } = useNodeFormPanel();

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        borderRadius: '8px',
        background: 'rgb(251, 251, 251)',
        border: '1px solid rgba(82,100,154, 0.13)',
      }}
    >
      <div
        style={{
          display: 'flex',
          height: '50px',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 12px',
        }}
      >
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
      </div>
      <div style={{ padding: '12px', display: 'flex', flexDirection: 'column', rowGap: '4px' }}>
        {results.map((i) => (
          <div
            key={i.node.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              border: '1px solid #999',
              borderRadius: '4px',
              padding: '0 4px',
              cursor: 'pointer',
            }}
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
            <div style={{ marginLeft: '8px' }}>
              <Typography.Text>{i.node.form?.values.title}</Typography.Text>
              <br />
              <Typography.Text type="danger">
                {i.feedbacks.map((i) => i.feedbackText).join(', ')}
              </Typography.Text>
            </div>
          </div>
        ))}
      </div>
    </div>
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
