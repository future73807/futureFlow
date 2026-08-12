/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { DockedPanelLayer } from '@flowgram.ai/panel-manager-plugin';
import { EditorRenderer, FreeLayoutEditorProvider } from '@flowgram.ai/free-layout-editor';
import { LocaleProvider as SemiLocaleProvider } from '@douyinfe/semi-ui';
import zh_CN from '@douyinfe/semi-ui/lib/es/locale/source/zh_CN';

import '@flowgram.ai/free-layout-editor/index.css';
import './styles/index.css';
import { nodeRegistries } from './nodes';
import { initialData } from './initial-data';
import { useEditorProps } from './hooks';
import { LocalizedSchemaTypeProvider } from './form-components/localized-materials';

export const Editor = () => {
  const editorProps = useEditorProps(initialData, nodeRegistries);
  return (
    <SemiLocaleProvider locale={zh_CN}>
      <div className="doc-free-feature-overview">
        <FreeLayoutEditorProvider {...editorProps}>
          <LocalizedSchemaTypeProvider>
            <div className="demo-container">
              <DockedPanelLayer>
                <EditorRenderer className="demo-editor" />
              </DockedPanelLayer>
            </div>
          </LocalizedSchemaTypeProvider>
        </FreeLayoutEditorProvider>
      </div>
    </SemiLocaleProvider>
  );
};
