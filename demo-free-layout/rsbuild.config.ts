/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { pluginReact } from '@rsbuild/plugin-react';
import { pluginLess } from '@rsbuild/plugin-less';
import { defineConfig } from '@rsbuild/core';

export default defineConfig({
  plugins: [pluginReact(), pluginLess()],
  source: {
    entry: {
      index: './src/app.tsx',
    },
    /**
     * support inversify @injectable() and @inject decorators
     */
    decorators: {
      version: 'legacy',
    },
  },
  html: {
    title: 'demo-free-layout',
  },
  tools: {
    rspack: {
      /**
       * ignore warnings from @coze-editor/editor/language-typescript
       * 和 typescript 包在浏览器环境使用 __filename/__dirname 的提示(被 mock,不影响运行)
       */
      ignoreWarnings: [
        /Critical dependency: the request of a dependency is an expression/,
        /__filename is used and has been mocked/,
        /__dirname is used and has been mocked/,
        /Module parse warning/,
      ],
    },
  },
});
