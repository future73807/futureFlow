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
  performance: {
    // 按体验拆包：框架/依赖/公共代码分离，改善缓存命中并避免单包过大。
    chunkSplit: {
      strategy: 'split-by-experience',
    },
    // 备注（2026-09 深度拆分调研结论）：剩余两个大包均为厂商固有单模块——
    // async/3.93MB 是 @flowgram.ai/coze-editor 内嵌的 TypeScript 语言服务
    // （单一巨型模块，webpack 无法按模块再拆）；js/28.x 2.9MB 含 runtime-js
    // 自带的 React 16.13 沙箱副本（与 React 18 刻意隔离，不可去重）。
    // 两者都是异步/画布路径，不落在登录与列表页的关键链路上。
  },
  tools: {
    // 深度拆分 FlowGram 编辑器引擎大包：code 节点/试运行编辑器的
    // CodeMirror 全家桶 + moment + coze-editor 是 5.8MB 单包的主体，
    // 独立成包后编辑页与列表页可以并行缓存，命中一次长期复用。
    rspack: (config, { appendPlugins }) => {
      appendPlugins([
        {
          name: 'futureflow-flowgram-split',
          apply(compiler: any) {
            compiler.options.optimization.splitChunks = {
              ...compiler.options.optimization.splitChunks,
              cacheGroups: {
                ...compiler.options.optimization.splitChunks?.cacheGroups,
                flowgramEditor: {
                  test: /[\\\\/]node_modules[\\\\/](@flowgram\.ai[\\\\/](coze-editor|editor|json-schema|utils|free-layout-core)|@codemirror[\\\\/]|moment[\\\\/])/,
                  name: 'lib-flowgram-editor',
                  priority: 20,
                  reuseExistingChunk: true,
                  enforce: true,
                },
              },
            };
          },
        },
      ]);
    },
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
