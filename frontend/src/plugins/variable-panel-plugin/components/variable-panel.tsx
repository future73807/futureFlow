/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { useState } from 'react';

import { Button, Collapsible, Tabs, Tooltip } from '@douyinfe/semi-ui';
import { IconLayers, IconMinus } from '@douyinfe/semi-icons';

import { FullVariableList } from './full-variable-list';

import styles from './index.module.less';

export function VariablePanel() {
  const [isOpen, setOpen] = useState<boolean>(false);

  return (
    <div className={styles['panel-wrapper']}>
      <Tooltip content={isOpen ? '收起变量面板' : '打开变量面板'}>
        <Button
          className={`${styles['variable-panel-button']} ${isOpen ? styles.close : ''}`}
          theme={isOpen ? 'borderless' : 'light'}
          aria-label={isOpen ? '收起变量面板' : '打开变量面板'}
          onClick={() => setOpen((_open) => !_open)}
        >
          {isOpen
            ? <IconMinus aria-hidden="true" />
            : <IconLayers aria-hidden="true" size="large" />}
        </Button>
      </Tooltip>
      <Collapsible isOpen={isOpen}>
        <div className={styles['panel-container']}>
          <Tabs activeKey="variables">
            <Tabs.TabPane itemKey="variables" tab="变量列表">
              <FullVariableList />
            </Tabs.TabPane>
          </Tabs>
        </div>
      </Collapsible>
    </div>
  );
}
