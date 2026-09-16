/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { Button, Collapsible, Tabs, Tooltip } from '@douyinfe/semi-ui';
import { IconLayers, IconMinus } from '@douyinfe/semi-icons';

import { FullVariableList } from './full-variable-list';

import styles from './index.module.less';

/** 变量面板默认贴在画布区域左上角，与顶栏、画布留出同样的 25px 间距 */
const PANEL_OFFSET = 25;
/** 高于 Semi 弹层（1000 起）与画布顶栏，保证变量列表始终悬浮在最上面 */
const PANEL_Z_INDEX = 3000;
/** 拖动时留出一点边距，避免面板被完全拖出视口 */
const VIEWPORT_MARGIN = 8;
/** 收起状态的圆形按钮尺寸 */
const BUTTON_SIZE = 50;
/** 展开面板在测量不到时的兜底尺寸（500 宽 + 标题栏与内边距） */
const PANEL_FALLBACK_SIZE: PanelSize = { width: 500, height: 570 };

interface PanelPosition {
  left: number;
  top: number;
}

const measureAnchor = (): PanelPosition | null => {
  const wrap = document.querySelector('.canvas-editor-wrap');
  if (!wrap) return null;
  const rect = wrap.getBoundingClientRect();
  return {
    left: rect.left + PANEL_OFFSET,
    top: rect.top + PANEL_OFFSET,
  };
};

interface PanelSize {
  width: number;
  height: number;
}

/**
 * 把位置限制在视口内。
 * 之前用「外层包裹元素」的尺寸算边界，收起时那个元素是 0×0，导致左侧约 60px
 * 的区域永远拖不过去；这里改成按当前真正可见的尺寸（收起=圆形按钮，展开=整块
 * 面板）来算，左侧从 8px 起都可以放。
 */
const clampToViewport = (position: PanelPosition, size: PanelSize): PanelPosition => {
  const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - size.width - VIEWPORT_MARGIN);
  const maxTop = Math.max(VIEWPORT_MARGIN, window.innerHeight - size.height - VIEWPORT_MARGIN);
  return {
    left: Math.min(Math.max(position.left, VIEWPORT_MARGIN), maxLeft),
    top: Math.min(Math.max(position.top, VIEWPORT_MARGIN), maxTop),
  };
};

export function VariablePanel() {
  const [isOpen, setOpen] = useState<boolean>(false);
  const [position, setPosition] = useState<PanelPosition | null>(() => measureAnchor());
  /** 用户拖动过之后就不再跟随画布尺寸重新贴边 */
  const movedByUserRef = useRef(false);
  const dragStateRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originLeft: number;
    originTop: number;
    moved: boolean;
  } | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  /** 拖动过的这一次点击不再当作「展开/收起」 */
  const suppressClickRef = useRef(false);

  /** 当前可见尺寸：展开时量真实面板，收起时就是那颗圆形按钮 */
  const visibleSize = useCallback((): PanelSize => {
    if (!isOpen) return { width: BUTTON_SIZE, height: BUTTON_SIZE };
    const rect = wrapperRef.current?.getBoundingClientRect();
    return {
      width: Math.round(rect?.width || PANEL_FALLBACK_SIZE.width),
      height: Math.round(rect?.height || PANEL_FALLBACK_SIZE.height),
    };
  }, [isOpen]);

  useEffect(() => {
    const update = () => {
      if (movedByUserRef.current) return;
      setPosition(measureAnchor());
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  // 展开后尺寸变大：把位置收敛回视口内，防止面板被右/下边界裁掉
  useEffect(() => {
    if (!isOpen) return;
    const timer = window.setTimeout(() => {
      setPosition((current) => (current ? clampToViewport(current, visibleSize()) : current));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [isOpen, visibleSize]);

  const endDrag = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const drag = dragStateRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragStateRef.current = null;
    // 拖动结束后浏览器还会补一个 click：这里保留标记，由 onClick 自行跳过
    if (drag.moved) {
      suppressClickRef.current = true;
      window.setTimeout(() => { suppressClickRef.current = false; }, 0);
    }
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }, []);

  const onDragMove = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const drag = dragStateRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (Math.abs(event.clientX - drag.startX) > 3 || Math.abs(event.clientY - drag.startY) > 3) {
      drag.moved = true;
    }
    const next = clampToViewport(
      {
        left: drag.originLeft + (event.clientX - drag.startX),
        top: drag.originTop + (event.clientY - drag.startY),
      },
      visibleSize(),
    );
    movedByUserRef.current = true;
    setPosition(next);
  }, [visibleSize]);

  const startDrag = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || !position) return;
    dragStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originLeft: position.left,
      originTop: position.top,
      moved: false,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }, [position]);

  if (!position) {
    return null;
  }

  return createPortal(
    <div
      className={styles['panel-anchor']}
      style={{ left: position.left, top: position.top, zIndex: PANEL_Z_INDEX }}
    >
      <div
        ref={wrapperRef}
        className={styles['panel-wrapper']}
        onPointerMove={onDragMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <Tooltip content={isOpen ? '收起变量面板（可拖动）' : '打开变量面板（可拖动）'}>
          <Button
            className={`${styles['variable-panel-button']} ${isOpen ? styles.close : ''}`}
            theme={isOpen ? 'borderless' : 'light'}
            aria-label={isOpen ? '收起变量面板' : '打开变量面板'}
            onClick={() => {
              if (suppressClickRef.current) {
                suppressClickRef.current = false;
                return;
              }
              setOpen((_open) => !_open);
            }}
            onPointerDown={startDrag}
          >
            {isOpen
              ? <IconMinus aria-hidden="true" />
              : <IconLayers aria-hidden="true" size="large" />}
          </Button>
        </Tooltip>
        <Collapsible isOpen={isOpen}>
          <div className={styles['panel-container']}>
            {/* Tabs 的标题栏同时充当拖动把手 */}
            <div className={styles['panel-drag-handle']} onPointerDown={startDrag} title="拖动面板">
              <Tabs activeKey="variables">
                <Tabs.TabPane itemKey="variables" tab="变量列表">
                  <FullVariableList />
                </Tabs.TabPane>
              </Tabs>
            </div>
          </div>
        </Collapsible>
      </div>
    </div>,
    document.body,
  );
}
