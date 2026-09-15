/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { definePluginCreator, PluginContext } from '@flowgram.ai/free-layout-editor';

import { RuntimePluginOptions } from './type';
import { WORKFLOW_RUNTIME_SERVICE, WorkflowRuntimeService } from './runtime-service';
import {
  WorkflowRuntimeBrowserClient,
  WorkflowRuntimeClient,
  WorkflowRuntimeServerClient,
} from './client';

export const createRuntimePlugin = definePluginCreator<RuntimePluginOptions, PluginContext>({
  onBind({ bind, rebind }, options) {
    bind(WorkflowRuntimeClient).toSelf().inSingletonScope();
    bind(WorkflowRuntimeServerClient).toSelf().inSingletonScope();
    bind(WorkflowRuntimeBrowserClient).toSelf().inSingletonScope();
    if (options.mode === 'server') {
      rebind(WorkflowRuntimeClient).to(WorkflowRuntimeServerClient);
    } else {
      rebind(WorkflowRuntimeClient).to(WorkflowRuntimeBrowserClient);
    }
    bind(WORKFLOW_RUNTIME_SERVICE).to(WorkflowRuntimeService).inSingletonScope();
  },
  onInit(ctx, options) {
    if (options.mode === 'server') {
      const serverClient = ctx.get<WorkflowRuntimeServerClient>(WorkflowRuntimeClient);
      serverClient.init(options.serverConfig);
    }
  },
});
