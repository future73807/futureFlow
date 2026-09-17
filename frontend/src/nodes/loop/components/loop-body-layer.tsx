/**
 * 循环节点在画布上的「可视图层」。
 *
 * 结构（对齐参考图）：
 *  - 白色循环卡片：钉在**世界坐标锚点**上（见 constants.ts 的锚点说明），
 *    拖动体内节点时卡片不动；
 *  - 竖向连线：卡片底部中心 → 循环体框顶部中心的弹性线
 *    （默认状态为竖直线，内容横向偏移时允许倾斜）；
 *  - 循环体：独立画布框 = 体内节点包围盒外扩边距，**自动适配内容
 *    （可增可减）**；拖拽过程中冻结不追手，松手后自动重新贴合；
 *  - 框左右两侧中部各一个连接圆点（block-start / block-end 钉位，
 *    圆点同时把容器 bounds 的左右边界撑到框线上，见 constants.ts）。
 *
 * 交互：卡片与循环体框本体接收指针事件（外层 flowgram 节点 DOM 不响应）。
 * 三路拖拽分流（对齐视频的解耦行为）：
 *  - 拖卡片 = 只移动卡片：卡片 onMouseDown 里 preventDefault 掐断原生
 *    HTML5 拖拽（容器完全不动），自己用 PlaygroundDrag 平移锚点；
 *  - 拖循环体框空白 = 移动循环体（容器 + 体内节点），卡片原地不动；
 *  - 拖体内节点 = 只移动该节点（flowgram 原生行为）。
 */

import { useEffect, useLayoutEffect, useRef } from 'react';

import {
  PlaygroundConfigEntity,
  PlaygroundDrag,
  useService,
  WorkflowDragService,
  WorkflowNodeEntity,
} from '@flowgram.ai/free-layout-editor';
import { useNodeSize } from '@flowgram.ai/free-container-plugin';

import {
  getLoopCardAnchor,
  LoopFrameRect,
  LOOP_BODY_MARGIN,
  LOOP_CARD_HEIGHT,
  LOOP_CARD_WIDTH,
  setLoopCardAnchor,
  setLoopFrameRect,
  getLoopFrameRect,
} from '../constants';
import { WorkflowNodeType } from '../../constants';
import { useNodeRenderContext } from '../../../hooks';
import { FormHeader } from '../../../form-components';
import { LoopCardRows } from './card-rows';

const isLoopDot = (node: WorkflowNodeEntity) =>
  node.flowNodeType === WorkflowNodeType.BlockStart ||
  node.flowNodeType === WorkflowNodeType.BlockEnd;

/** 两个框矩形是否一致（浮点容差，避免无意义的重写） */
const isRectEqual = (a: LoopFrameRect, b: LoopFrameRect) =>
  Math.abs(a.left - b.left) < 0.5 &&
  Math.abs(a.top - b.top) < 0.5 &&
  Math.abs(a.right - b.right) < 0.5 &&
  Math.abs(a.bottom - b.bottom) < 0.5;

/** 设置节点局部坐标；位置没变时不触发变更，避免监听回路 */
const pinNode = (node: WorkflowNodeEntity | undefined, x: number, y: number) => {
  if (!node) return;
  const current = node.transform.position;
  if (Math.abs(current.x - x) < 0.5 && Math.abs(current.y - y) < 0.5) return;
  node.transform.position = { x, y };
};

/**
 * 把圆点（0×0 尺寸，position 即左上角=中心）钉到世界坐标 (x, y)：
 * 先按目标钉一次，再读实际 bounds 修正一遍，两遍即可精确收敛。
 */
const pinDot = (node: WorkflowNodeEntity | undefined, x: number, y: number) => {
  if (!node) return;
  pinNode(node, x, y);
  const bounds = node.transform.bounds;
  const dx = x - bounds.left;
  const dy = y - bounds.top;
  if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
    const { x: px, y: py } = node.transform.position;
    node.transform.position = { x: px + dx, y: py + dy };
  }
};

/**
 * 循环节点画布渲染层：卡片（世界锚定）+ 弹性连线 + 循环体框。
 * 命令式逻辑有三件事：初始化/更新卡片锚点、把内容约束在卡片下方、
 * 把连接圆点钉到框线左右边缘中部。
 */
export const LoopCanvasLayer = () => {
  const { node, expanded } = useNodeRenderContext();
  const nodeSize = useNodeSize();
  const width = expanded ? nodeSize?.width ?? LOOP_CARD_WIDTH : LOOP_CARD_WIDTH;
  const height = expanded ? nodeSize?.height ?? LOOP_CARD_HEIGHT : LOOP_CARD_HEIGHT;

  const cardRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const connectorRef = useRef<SVGSVGElement>(null);
  const connectorPathRef = useRef<SVGPathElement>(null);
  const connectorFromDotRef = useRef<SVGCircleElement>(null);
  const connectorToDotRef = useRef<SVGCircleElement>(null);

  const playgroundConfig = useService(PlaygroundConfigEntity);
  const dragService = useService<WorkflowDragService>(WorkflowDragService);
  // relayout 的稳定引用：卡片拖拽回调里调用最新一轮的重排逻辑
  const relayoutRef = useRef<() => void>(() => {});

  // 端口标记挂载后让 flowgram 重新扫描 DOM，把输入/输出端口绑定到卡片边缘
  useLayoutEffect(() => {
    node.ports?.updateDynamicPorts();
  }, [node]);

  // 图层 DOM 尺寸同步到外层 activity DOM：hover / 框选 / 命中测试
  // 才能拿到与 bounds 一致的矩形（外层默认不会自动量出这个尺寸）
  useLayoutEffect(() => {
    const el = node.renderData.node;
    if (!el) return;
    el.style.width = `${width}px`;
    el.style.height = `${height}px`;
  }, [node, width, height]);

  useEffect(() => {
    let disposed = false;
    let reentering = false;
    let pending = false;
    let frameId = 0;
    let settleTimer = 0;
    let disposer: { dispose(): void }[] = [];
    // 整体拖动（框内空白按下）的起始状态：框跟随容器位移
    let dragStartPos: { x: number; y: number } | undefined;
    let dragStartFrame: LoopFrameRect | undefined;
    // 拖拽进行中冻结「自动适配」：框不追手，松手后再贴合内容
    let frameFrozen = false;

    /** 卡片：按世界锚点换算为图层内偏移（图层原点 = bounds 左上角）；
     *  连线 = 卡片底部中心圆点 → 循环体框顶部中心圆点的 S 形曲线
     *  （两端竖直切线，与视频一致；无框时收成一个点） */
    const applyCard = (frame?: { left: number; top: number; right: number }) => {
      const anchor = getLoopCardAnchor(node);
      if (!anchor) return;
      const bounds = node.transform.bounds;
      const card = cardRef.current;
      if (card) {
        card.style.left = `${anchor.x - bounds.left}px`;
        card.style.top = `${anchor.y - bounds.top}px`;
      }
      const path = connectorPathRef.current;
      const fromDot = connectorFromDotRef.current;
      const toDot = connectorToDotRef.current;
      if (!path) return;
      const fromX = anchor.x + LOOP_CARD_WIDTH / 2 - bounds.left;
      const fromY = anchor.y + LOOP_CARD_HEIGHT - bounds.top;
      const toX = frame ? (frame.left + frame.right) / 2 - bounds.left : fromX;
      const toY = frame ? frame.top - bounds.top : fromY;
      path.setAttribute(
        'd',
        `M ${fromX} ${fromY} C ${fromX} ${(fromY + toY) / 2}, ${toX} ${
          (fromY + toY) / 2
        }, ${toX} ${toY}`
      );
      if (fromDot) {
        fromDot.setAttribute('cx', String(fromX));
        fromDot.setAttribute('cy', String(fromY));
      }
      if (toDot) {
        toDot.setAttribute('cx', String(toX));
        toDot.setAttribute('cy', String(toY));
      }
    };

    /** 循环体框 div：按框数据（世界坐标）显式定位（图层原点 = bounds 左上角） */
    const applyFrame = (frame?: { left: number; top: number; right: number; bottom: number }) => {
      const el = frameRef.current;
      if (!el) return;
      if (!frame) return;
      const bounds = node.transform.bounds;
      el.style.left = `${frame.left - bounds.left}px`;
      el.style.top = `${frame.top - bounds.top}px`;
      el.style.width = `${frame.right - frame.left}px`;
      el.style.height = `${frame.bottom - frame.top}px`;
    };

    const relayout = () => {
      if (disposed) return;
      if (reentering) {
        // 钉位触发的容器重排：不丢弃，下一帧补算
        if (!pending) {
          pending = true;
          frameId = requestAnimationFrame(() => {
            pending = false;
            relayout();
          });
        }
        return;
      }
      reentering = true;
      try {
        // ── 卡片锚点：首次以「bounds 顶部居中」初始化 ──
        if (!getLoopCardAnchor(node)) {
          const bounds = node.transform.bounds;
          setLoopCardAnchor(node, {
            x: bounds.left + (bounds.width - LOOP_CARD_WIDTH) / 2,
            y: bounds.top,
          });
        }

        if (!expanded) {
          // 收缩：框数据保留（展开后恢复原框），只重算卡片
          applyCard(getLoopFrameRect(node));
          return;
        }

        const content = node.blocks.filter((block) => !isLoopDot(block));
        const frame = getLoopFrameRect(node);

        if (content.length === 0) {
          // 没有内容节点：框保持原样（空白框仍可整体拖动/选中）
          if (frame) {
            const frameMidY = (frame.top + frame.bottom) / 2;
            const dots = node.blocks.filter(isLoopDot);
            pinDot(
              dots.find((dot) => dot.flowNodeType === WorkflowNodeType.BlockStart),
              frame.left,
              frameMidY
            );
            pinDot(
              dots.find((dot) => dot.flowNodeType === WorkflowNodeType.BlockEnd),
              frame.right,
              frameMidY
            );
          }
          applyFrame(frame);
          applyCard(frame);
          return;
        }

        // ── 子节点尺寸校正（框贴可见卡片的根因）──
        // 渲染层的尺寸观测未生效时，部分节点的 transform bounds 还是
        // 注册表 meta.size 的虚大值（如代码节点 360×390 vs 实际
        // 300×101），按数据框算包围盒会把循环体撑得远比内容大。
        // 这里按 DOM 实测尺寸校正（世界坐标换算以图层 DOM 为参照，
        // 缩放比实测，免疫视口平移与 fitview 动画）。
        const layerEl = node.renderData.node;
        const layerRect = layerEl ? layerEl.getBoundingClientRect() : null;
        const boundsNow = node.transform.bounds;
        const zoom = layerRect && boundsNow.width > 1 ? layerRect.width / boundsNow.width : 1;
        if (layerRect) {
          for (const block of content) {
            const el = block.renderData.node;
            if (!el) continue;
            const rect = el.getBoundingClientRect();
            if (rect.width < 2 || rect.height < 2) continue;
            const size = { width: rect.width / zoom, height: rect.height / zoom };
            const current = block.transform.bounds;
            if (
              Math.abs(current.width - size.width) > 1 ||
              Math.abs(current.height - size.height) > 1
            ) {
              block.transform.size = size;
            }
          }
        }

        // ── 内容包围盒（世界坐标，校正后的 transform bounds）──
        let left = Infinity;
        let top = Infinity;
        let right = -Infinity;
        let bottom = -Infinity;
        for (const block of content) {
          const rect = block.transform.bounds;
          left = Math.min(left, rect.left);
          top = Math.min(top, rect.top);
          right = Math.max(right, rect.right);
          bottom = Math.max(bottom, rect.bottom);
        }

        // ── 循环体框：自动适配内容（可增可减）──
        // 框 = 内容包围盒 + 边距。节点在框内拖动时框冻结不追手，
        // 松手后自动重新贴合（也覆盖增删节点、内容移动等情况）；
        // 框与卡片是两个独立部件，允许重叠，连线曲线自适应。
        const next: LoopFrameRect = {
          left: left - LOOP_BODY_MARGIN.left,
          top: top - LOOP_BODY_MARGIN.top,
          right: right + LOOP_BODY_MARGIN.right,
          bottom: bottom + LOOP_BODY_MARGIN.bottom,
        };
        if (!frameFrozen && (!frame || !isRectEqual(next, frame))) {
          setLoopFrameRect(node, next);
        }
        const applied = frameFrozen && frame ? frame : next;

        // 圆点钉在框线左右边缘中部（两遍钉位，见 pinDot）
        const frameMidY = (applied.top + applied.bottom) / 2;
        const dots = node.blocks.filter(isLoopDot);
        pinDot(
          dots.find((dot) => dot.flowNodeType === WorkflowNodeType.BlockStart),
          applied.left,
          frameMidY
        );
        pinDot(
          dots.find((dot) => dot.flowNodeType === WorkflowNodeType.BlockEnd),
          applied.right,
          frameMidY
        );

        applyFrame(applied);
        applyCard(applied);
      } finally {
        reentering = false;
      }
    };

    const subscribe = () => {
      disposer = [
        node.onEntityChange(relayout),
        node.transform.onDataChange(relayout),
        ...node.blocks.map((block) => block.transform.onDataChange(relayout)),
      ];
    };
    relayout();
    relayoutRef.current = relayout;
    subscribe();

    // 挂载后的补算节拍：等布局/缩放就位后重跑几轮，让子节点尺寸校正
    // 与自动适配拿到真实 DOM 尺寸（免疫 fitview 动画期间的中间值）
    [2, 4, 8, 16, 32].forEach(() => {
      requestAnimationFrame(() => relayout());
    });
    settleTimer = window.setTimeout(() => relayout(), 600);

    // 整体拖动（框内空白按下 → flowgram 拖容器）：框跟随容器位移平移。
    // 卡片拖动走 handleCardMouseDown 自管路径，不会进入这里。
    // 任何拖拽进行中冻结「自动适配」（框不追手），松手后自动重新贴合。
    disposer.push(
      dragService.onNodesDrag((e) => {
        const includesLoop = e.nodes?.includes(node);
        if (e.type === 'onDragStart') {
          frameFrozen = true;
          if (includesLoop) {
            dragStartPos = { ...node.transform.position };
            dragStartFrame = getLoopFrameRect(node) ? { ...getLoopFrameRect(node)! } : undefined;
          }
          return;
        }
        if (e.type === 'onDragging' || e.type === 'onDragEnd') {
          if (includesLoop && dragStartPos && dragStartFrame) {
            const pos = node.transform.position;
            const dx = pos.x - dragStartPos.x;
            const dy = pos.y - dragStartPos.y;
            if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
              setLoopFrameRect(node, {
                left: dragStartFrame.left + dx,
                top: dragStartFrame.top + dy,
                right: dragStartFrame.right + dx,
                bottom: dragStartFrame.bottom + dy,
              });
              node.transform.fireChange();
            }
          }
          if (e.type === 'onDragEnd') {
            dragStartPos = undefined;
            dragStartFrame = undefined;
            frameFrozen = false;
            // 松手后下一帧自动重新贴合（增删/移动内容都可能改变包围盒）
            requestAnimationFrame(() => relayout());
          }
        }
      })
    );

    return () => {
      disposed = true;
      if (frameId) cancelAnimationFrame(frameId);
      if (settleTimer) window.clearTimeout(settleTimer);
      setLoopFrameRect(node, undefined);
      disposer.forEach((d) => d.dispose());
    };
  }, [node, expanded, dragService]);

  /** 拖卡片 = 只移动卡片。
   *
   * 用「捕获阶段」拦截：卡片内部的 FormHeader 标题栏有自己的
   * onMouseDown={startDrag}（会启动 flowgram 容器拖拽，把循环体 +
   * 体内节点整块拖走），必须在它之前 stopPropagation 掐断，否则
   * 两路拖拽叠加，整个循环连同画布一起动。
   *
   * 之后 preventDefault 掐断原生 HTML5 拖拽，自己用 PlaygroundDrag
   * 平移卡片锚点（循环体原地不动，连线曲线拉伸）。
   * 标题输入框/按钮等交互元素上按下时不接管，保持默认行为；
   * 同时临时关闭包装层的 draggable，保证这些点也带不动容器。 */
  const handleCardMouseDown = (e: React.MouseEvent) => {
    const wrapper = node.renderData.node?.firstElementChild as HTMLElement | null;
    const target = e.target as HTMLElement;
    const interactive = !!target.closest('input, textarea, button, [contenteditable="true"]');
    if (wrapper) {
      wrapper.setAttribute('draggable', interactive ? 'true' : 'false');
      const restore = () => {
        wrapper.setAttribute('draggable', 'true');
        window.removeEventListener('mouseup', restore, true);
        window.removeEventListener('dragend', restore, true);
      };
      window.addEventListener('mouseup', restore, true);
      window.addEventListener('dragend', restore, true);
    }
    if (interactive) return;
    if (e.button !== 0 || playgroundConfig.readonly) return;
    e.stopPropagation();
    e.preventDefault();
    const startAnchor = getLoopCardAnchor(node);
    if (!startAnchor) return;
    const anchorStart = { ...startAnchor };
    // 屏幕位移 → 世界位移用画布缩放比换算
    const scale = playgroundConfig.finalScale || 1;
    const dragger = new PlaygroundDrag({
      onDrag: (dragEvent) => {
        setLoopCardAnchor(node, {
          x: anchorStart.x + (dragEvent.endPos.x - dragEvent.startPos.x) / scale,
          y: anchorStart.y + (dragEvent.endPos.y - dragEvent.startPos.y) / scale,
        });
        relayoutRef.current();
      },
    });
    dragger.start(e.clientX, e.clientY, playgroundConfig);
  };

  return (
    <div className="ff-loop-layer" style={{ width, height }}>
      {/* 白色循环卡片：位置由世界锚点决定（LoopCanvasLayer 命令式写入 left/top）。
          捕获阶段接管 mousedown，先于标题栏的容器拖拽 */}
      <div ref={cardRef} className="ff-loop-card" onMouseDownCapture={handleCardMouseDown}>
        <FormHeader />
        <LoopCardRows />
        {/* 端口标记：flowgram 把端口圆点 portal 进来，跟随卡片移动 */}
        <span
          className="ff-loop-port-marker"
          data-port-id=""
          data-port-type="input"
          data-port-location="left"
        />
        <span
          className="ff-loop-port-marker ff-loop-port-marker-right"
          data-port-id=""
          data-port-type="output"
          data-port-location="right"
        />
      </div>

      {/* 卡片底部中心圆点 → 循环体框顶部中心圆点的 S 形曲线（仅展开时渲染） */}
      {expanded && (
        <svg ref={connectorRef} className="ff-loop-connector" aria-hidden="true">
          <path ref={connectorPathRef} d="M 0 0" />
          <circle ref={connectorFromDotRef} className="ff-loop-connector-dot" r="4" />
          <circle ref={connectorToDotRef} className="ff-loop-connector-dot" r="4" />
        </svg>
      )}

      {/* 循环体：独立虚线画布框（仅展开时渲染）。位置尺寸由 LoopCanvasLayer
          按框数据显式写入；框内空白拖动 = flowgram 原生拖容器（循环体整体） */}
      {expanded && (
        <div ref={frameRef} className="ff-loop-body" data-node-id={`${node.id}_body`}>
          <span className="ff-loop-body-tag">
            <span className="ff-loop-body-tag-icon" aria-hidden="true">
              <svg
                viewBox="0 0 16 16"
                width="12"
                height="12"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M3.6 8a4.4 4.4 0 017.5-3.1" />
                <path d="M12.4 8a4.4 4.4 0 01-7.5 3.1" />
                <path d="M11.3 2.6v2.6H8.7M4.7 13.4v-2.6h2.6" />
              </svg>
            </span>
            循环体
            <span className="ff-loop-body-tag-info" aria-hidden="true">
              <svg
                viewBox="0 0 16 16"
                width="12"
                height="12"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
              >
                <circle cx="8" cy="8" r="6.2" />
                <path d="M8 7.2v4M8 4.9h.01" strokeLinecap="round" />
              </svg>
            </span>
          </span>
        </div>
      )}
    </div>
  );
};
