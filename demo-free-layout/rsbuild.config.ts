/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { pluginReact } from '@rsbuild/plugin-react';
import { pluginLess } from '@rsbuild/plugin-less';
import { defineConfig } from '@rsbuild/core';

export default defineConfig({
  server: {
    // Keeps the default product address stable while allowing a second local
    // stack to run beside an existing developer session during verification.
    port: Number(process.env.FRONTEND_PORT || 3000),
  },
  plugins: [pluginReact(), pluginLess()],
  source: {
    define: {
      __GATEWAY_URL__: JSON.stringify(
        process.env.PUBLIC_GATEWAY_URL || 'http://localhost:3001',
      ),
    },
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
    title: 'futureFlow',
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
