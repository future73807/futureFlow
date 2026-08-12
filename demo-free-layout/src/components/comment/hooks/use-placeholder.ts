/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { useState, useEffect } from 'react';

import { CommentEditorModel } from '../model';
import { CommentEditorEvent } from '../constant';

export const usePlaceholder = (params: { model: CommentEditorModel }): string | undefined => {
  const { model } = params;

  const [placeholder, setPlaceholder] = useState<string | undefined>('输入注释…');

  // 监听 change 事件
  useEffect(() => {
    const changeDisposer = model.on((params) => {
      if (params.type !== CommentEditorEvent.Change && params.type !== CommentEditorEvent.Init) {
        return;
      }
      if (params.value) {
        setPlaceholder(undefined);
      } else {
        setPlaceholder('输入注释…');
      }
    });
    return () => {
      changeDisposer.dispose();
    };
  }, [model]);

  return placeholder;
};
