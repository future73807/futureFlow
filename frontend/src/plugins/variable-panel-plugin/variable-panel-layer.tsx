/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { injectable, Layer } from '@flowgram.ai/free-layout-editor';

import { VariablePanel } from './components/variable-panel';

/**
 * 变量面板挂载层：面板自身用 Portal 渲染到 body 并固定在画布右上角，
 * 这样它不会被画布图层、顶栏或弹层盖住；这一层只负责挂载。
 */
@injectable()
export class VariablePanelLayer extends Layer {
  render(): JSX.Element {
    return <VariablePanel />;
  }
}
