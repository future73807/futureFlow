/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

type SaveHook = () => Promise<void>;

let activeSaveHook: SaveHook | null = null;

/**
 * 画布页注册“立即保存草稿”的钩子，供云端试运行等组件在执行前调用，
 * 消除「1.5 秒自动保存未落盘就执行旧草稿」的竞态。
 */
export function registerSaveHook(hook: SaveHook | null): void {
  activeSaveHook = hook;
}

/** 调用当前注册的保存钩子；未注册时静默跳过。 */
export async function callSaveHook(): Promise<void> {
  if (!activeSaveHook) return;
  await activeSaveHook();
}
