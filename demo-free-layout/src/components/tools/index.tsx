/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { useState, useEffect } from 'react';

import { useRefresh } from '@flowgram.ai/free-layout-editor';
import { useClientContext } from '@flowgram.ai/free-layout-editor';
import { Tooltip, IconButton, Divider } from '@douyinfe/semi-ui';
import { IconUndo, IconRedo } from '@douyinfe/semi-icons';

import { TestRunButton } from '../testrun/testrun-button';
import { GatewayRunButton } from '../gateway-run';
import { AddNode } from '../add-node';
import { ZoomSelect } from './zoom-select';
import { SwitchLine } from './switch-line';
import { ToolContainer, ToolSection } from './styles';
import { Readonly } from './readonly';
import { MinimapSwitch } from './minimap-switch';
import { Minimap } from './minimap';
import { Interactive } from './interactive';
import { FitView } from './fit-view';
import { Comment } from './comment';
import { AutoLayout } from './auto-layout';
import { ProblemButton } from '../problem-panel';
import { DownloadTool } from './download';

export const DemoTools = () => {
  const { history, playground } = useClientContext();
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [minimapVisible, setMinimapVisible] = useState(true);
  useEffect(() => {
    const disposable = history.undoRedoService.onChange(() => {
      setCanUndo(history.canUndo());
      setCanRedo(history.canRedo());
    });
    return () => disposable.dispose();
  }, [history]);
  const refresh = useRefresh();

  useEffect(() => {
    const disposable = playground.config.onReadonlyOrDisabledChange(() => refresh());
    return () => disposable.dispose();
  }, [playground]);

  return (
    <ToolContainer className="demo-free-layout-tools">
      <ToolSection>
        <div className="canvas-tool-group canvas-tool-group-view">
          <Interactive />
          <SwitchLine />
          <ZoomSelect />
          <FitView />
          <MinimapSwitch minimapVisible={minimapVisible} setMinimapVisible={setMinimapVisible} />
          <Minimap visible={minimapVisible} />
        </div>
        <Divider layout="vertical" style={{ height: '16px' }} margin={3} />
        <div className="canvas-tool-group canvas-tool-group-edit">
          <AutoLayout />
          <Readonly />
          <Comment />
          <Tooltip content="撤销">
            <IconButton
              aria-label="撤销"
              type="tertiary"
              theme="borderless"
              icon={<IconUndo aria-hidden="true" />}
              disabled={!canUndo || playground.config.readonly}
              onClick={() => history.undo()}
            />
          </Tooltip>
          <Tooltip content="重做">
            <IconButton
              aria-label="重做"
              type="tertiary"
              theme="borderless"
              icon={<IconRedo aria-hidden="true" />}
              disabled={!canRedo || playground.config.readonly}
              onClick={() => history.redo()}
            />
          </Tooltip>
          <ProblemButton />
          <DownloadTool />
        </div>
        <Divider layout="vertical" style={{ height: '16px' }} margin={3} />
        <div className="canvas-tool-group canvas-tool-group-primary">
          <AddNode disabled={playground.config.readonly} />
          <TestRunButton disabled={playground.config.readonly} />
          <GatewayRunButton disabled={playground.config.readonly} />
        </div>
      </ToolSection>
    </ToolContainer>
  );
};
