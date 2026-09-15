/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { useCallback, useState } from 'react';

import { applyTheme, currentTheme, ThemeMode } from '../utils/theme';

export function useThemeMode(): { mode: ThemeMode; toggle: () => void } {
  const [mode, setMode] = useState<ThemeMode>(() => currentTheme());

  const toggle = useCallback(() => {
    const next: ThemeMode = currentTheme() === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    setMode(next);
  }, []);

  return { mode, toggle };
}
