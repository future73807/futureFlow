/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import {
  ASTFactory,
  definePluginCreator,
  GlobalScope,
} from '@flowgram.ai/free-layout-editor';
import { IJsonSchema, JsonSchemaUtils } from '@flowgram.ai/form-materials';

import iconVariable from '../../assets/icon-variable.svg';
import { VariablePanelLayer } from './variable-panel-layer';

const disabledGlobalVariableSchema: IJsonSchema = {
  type: 'object',
  properties: {},
};

export type GetGlobalVariableSchema = () => IJsonSchema;
export const GetGlobalVariableSchema = Symbol('GlobalVariableSchemaGetter');

export const createVariablePanelPlugin = definePluginCreator<{ initialData?: IJsonSchema }>({
  onInit(ctx) {
    ctx.playground.registerLayer(VariablePanelLayer);

    const globalScope = ctx.get(GlobalScope);
    // Dify 0.15.3 cannot publish FlowGram's browser-only global scope.
    // Keep an empty declaration so variable services remain stable, but do
    // not expose editable values that would make a local-only workflow.
    globalScope.setVar(
      ASTFactory.createVariableDeclaration({
        key: 'global',
        meta: {
          title: '全局变量（未启用）',
          icon: iconVariable,
        },
        type: JsonSchemaUtils.schemaToAST(disabledGlobalVariableSchema),
      }),
    );
  },
});
