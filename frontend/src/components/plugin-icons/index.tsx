/**
 * 插件 / 节点图标的唯一来源。
 *
 * 插件商店与画布节点（节点面板、节点标题、问题检查）都从这里取图形、取色和渲染函数：
 * 图形只在这里定义一次，改一处两边同时生效，不会再出现商店与画布图标各一套的情况。
 *
 * key 同时是插件商店的插件 id 与画布节点类型；内容类节点多一层 `content-` 前缀，
 * 由 `pluginIconKey` 统一归一化。
 */

export type PluginIconShape =
  | { kind: 'path'; d: string }
  | { kind: 'circle'; cx: number; cy: number; r: number }
  | { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number }
  | { kind: 'rect'; x: number; y: number; width: number; height: number; rx?: number };

/** 24x24 线性图形；描边用当前色，因此跟着取色板变色。 */
export const PLUGIN_ICON_SHAPES: Record<string, PluginIconShape[]> = {
  // 大语言模型：AI 星芒（四角内凹），单个大图形更醒目
  llm: [{ kind: 'path', d: 'M12 2.8c.7 4.6 4.6 8.5 9.2 9.2-4.6.7-8.5 4.6-9.2 9.2-.7-4.6-4.6-8.5-9.2-9.2 4.6-.7 8.5-4.6 9.2-9.2z' }],
  // 文本处理：三行文字
  'content-text': [{ kind: 'path', d: 'M5 7h14M5 12h10.5M5 17h7' }],
  // 图片处理：相框 + 太阳 + 山
  'content-image': [
    { kind: 'rect', x: 3.5, y: 5, width: 17, height: 14, rx: 2.6 },
    { kind: 'circle', cx: 9, cy: 10, r: 1.5 },
    { kind: 'path', d: 'M4.2 17.2l4.6-4.6 3.6 3.6 2.4-2.2 5 4.4' },
  ],
  // 视频处理：播放键
  'content-video': [
    { kind: 'rect', x: 3.5, y: 5.5, width: 17, height: 13, rx: 2.6 },
    { kind: 'path', d: 'M10.6 9.6l5.2 2.4-5.2 2.4z' },
  ],
  // API 请求：地球
  http: [
    { kind: 'circle', cx: 12, cy: 12, r: 8.4 },
    { kind: 'path', d: 'M3.6 12h16.8' },
    { kind: 'path', d: 'M12 3.6c2.6 2.5 2.6 14.4 0 16.8-2.6-2.4-2.6-14.3 0-16.8z' },
  ],
  // 代码执行：尖括号
  code: [{ kind: 'path', d: 'M9.2 8l-4 4 4 4M14.8 8l4 4-4 4' }],
  // 知识检索：书本
  knowledge: [
    { kind: 'path', d: 'M5.5 4.5h9a2.5 2.5 0 012.5 2.5v12H8a2.5 2.5 0 01-2.5-2.5z' },
    { kind: 'path', d: 'M8.6 4.5v14.5' },
  ],
  // 子工作流：两个节点 + 连线
  subworkflow: [
    { kind: 'rect', x: 3.5, y: 4.2, width: 7, height: 5.6, rx: 1.6 },
    { kind: 'rect', x: 13.5, y: 14.2, width: 7, height: 5.6, rx: 1.6 },
    { kind: 'path', d: 'M10.5 7h4.2a2.4 2.4 0 012.4 2.4v4.8' },
  ],
  // MCP 工具：插头
  mcp: [
    { kind: 'path', d: 'M9.6 4.6v4.2M14.4 4.6v4.2' },
    { kind: 'path', d: 'M7.4 8.8h9.2v4a4.6 4.6 0 01-9.2 0z' },
    { kind: 'path', d: 'M12 17.4V20.5' },
  ],
  // Python 执行：终端窗口
  python: [
    { kind: 'rect', x: 3.6, y: 4.6, width: 16.8, height: 14.8, rx: 2.4 },
    { kind: 'path', d: 'M7.4 9.6l2.4 2.4-2.4 2.4M12.4 14.4h4.2' },
  ],
  // 条件分支：分叉
  condition: [
    { kind: 'path', d: 'M12 4.2v3.6M12 7.8L7.2 12.2v4.4M12 7.8l4.8 4.4v4.4' },
    { kind: 'circle', cx: 7.2, cy: 18.4, r: 1.5 },
    { kind: 'circle', cx: 12, cy: 18.4, r: 1.5 },
    { kind: 'circle', cx: 16.8, cy: 18.4, r: 1.5 },
  ],
  // 多条件分支：三分叉
  'multi-condition': [
    { kind: 'path', d: 'M12 4.2v3.4M12 7.6H6.4v7.2M12 7.6v7.2M12 7.6h5.6v7.2' },
    { kind: 'circle', cx: 6.4, cy: 16.6, r: 1.4 },
    { kind: 'circle', cx: 12, cy: 16.6, r: 1.4 },
    { kind: 'circle', cx: 17.6, cy: 16.6, r: 1.4 },
  ],
  // 循环：循环箭头
  loop: [
    { kind: 'path', d: 'M4.6 12a7.4 7.4 0 0112.6-5.2' },
    { kind: 'path', d: 'M19.4 12a7.4 7.4 0 01-12.6 5.2' },
    { kind: 'path', d: 'M17.6 3.4v3.8h-3.8M6.4 20.6v-3.8h3.8' },
  ],
  // 变量聚合：多路汇入一个点
  'variable-aggregator': [
    { kind: 'path', d: 'M4.2 6.4h4.4a3 3 0 013 3v1.2' },
    { kind: 'path', d: 'M4.2 12h7.4' },
    { kind: 'path', d: 'M4.2 17.6h4.4a3 3 0 003-3v-1.2' },
    { kind: 'circle', cx: 13.4, cy: 12, r: 2.2 },
    { kind: 'path', d: 'M15.6 12h4.2' },
  ],
  // 变量赋值：花括号里的叉（变量符号）
  variable: [
    { kind: 'path', d: 'M8.4 5.6H7a1.6 1.6 0 00-1.6 1.6v9.6A1.6 1.6 0 007 18.4h1.4M15.6 5.6H17a1.6 1.6 0 011.6 1.6v9.6a1.6 1.6 0 01-1.6 1.6h-1.4' },
    { kind: 'path', d: 'M10.2 9.6l3.6 4.8M13.8 9.6l-3.6 4.8' },
  ],
  // 开始 / 块开始：圆圈 + 播放
  start: [
    { kind: 'circle', cx: 12, cy: 12, r: 8.4 },
    { kind: 'path', d: 'M10.2 8.4l5.6 3.6-5.6 3.6z' },
  ],
  // 结束 / 块结束：圆圈 + 停止方块
  end: [
    { kind: 'circle', cx: 12, cy: 12, r: 8.4 },
    { kind: 'rect', x: 9.6, y: 9.6, width: 4.8, height: 4.8, rx: 1 },
  ],
  // 注释：对话气泡
  comment: [{ kind: 'path', d: 'M4.8 6.6h14.4v9.2h-7.4l-4.2 3.4v-3.4H4.8z' }],
  // 退出节点：方框 + 向右跳出的箭头（提前结束本次运行 / 跳出循环）
  exit: [
    { kind: 'path', d: 'M13.6 4.6H6.4a1.8 1.8 0 00-1.8 1.8v11.2a1.8 1.8 0 001.8 1.8h7.2' },
    { kind: 'path', d: 'M13.8 12h6.4M17.4 9.2l2.8 2.8-2.8 2.8' },
  ],
};

/** 未知图标兜底：方块 + 十字，保持与其他图标同样的线性观感 */
export const PLUGIN_FALLBACK_SHAPES: PluginIconShape[] = [
  { kind: 'rect', x: 4, y: 4, width: 16, height: 16, rx: 3 },
  { kind: 'path', d: 'M9 12h6M12 9v6' },
];

/**
 * 插件图标的取色板：字形用较深的颜色，背景用同色系接近白色的浅色。
 * 颜色按插件 id 做稳定哈希，保证同一插件每次渲染颜色一致。
 */
export const PLUGIN_TINTS: Array<{ fg: string; bg: string }> = [
  { fg: '#1E3A8A', bg: '#EDF1FB' },
  { fg: '#B45309', bg: '#FDF4E7' },
  { fg: '#0F766E', bg: '#E8F7F4' },
  { fg: '#6D28D9', bg: '#F3EEFE' },
  { fg: '#BE123C', bg: '#FCEEF1' },
  { fg: '#15803D', bg: '#EBF9F0' },
  { fg: '#0369A1', bg: '#E9F4FB' },
  { fg: '#9A3412', bg: '#FBEFE8' },
];

export const pluginTint = (seed: string): { fg: string; bg: string } => {
  // 大语言模型用最深的一档蓝（用户指定：这个颜色深一点）
  if (seed === 'llm') return { fg: '#1E3A8A', bg: '#EDF1FB' };
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  return PLUGIN_TINTS[hash % PLUGIN_TINTS.length];
};

/**
 * 画布节点类型 → 图标 key。
 * 节点类型与插件 id 基本同名，只有内容类节点带 `content-` 前缀。
 */
const ICON_KEY_BY_NODE_TYPE: Record<string, string> = {
  text: 'content-text',
  image: 'content-image',
  video: 'content-video',
  'block-start': 'start',
  'block-end': 'end',
};

export const pluginIconKey = (nodeTypeOrId: string): string =>
  ICON_KEY_BY_NODE_TYPE[nodeTypeOrId] ?? nodeTypeOrId;

export const pluginIconShapes = (nodeTypeOrId: string): PluginIconShape[] =>
  PLUGIN_ICON_SHAPES[pluginIconKey(nodeTypeOrId)] ?? PLUGIN_FALLBACK_SHAPES;

/** 24x24 坐标系里的图形渲染成 SVG 片段（字符串，供 data URI 使用）。 */
const shapeToString = (shape: PluginIconShape): string => {
  switch (shape.kind) {
    case 'path':
      return `<path d="${shape.d}"/>`;
    case 'circle':
      return `<circle cx="${shape.cx}" cy="${shape.cy}" r="${shape.r}"/>`;
    case 'ellipse':
      return `<ellipse cx="${shape.cx}" cy="${shape.cy}" rx="${shape.rx}" ry="${shape.ry}"/>`;
    case 'rect':
      return `<rect x="${shape.x}" y="${shape.y}" width="${shape.width}" height="${shape.height}"${shape.rx ? ` rx="${shape.rx}"` : ''}/>`;
    default:
      return '';
  }
};

/**
 * 节点注册表使用的图标地址（data URI）：
 * 与插件商店同款图形 + 同款同色系底色，画布与商店视觉完全一致。
 */
export const pluginIconUrl = (nodeTypeOrId: string, size = 48): string => {
  const tint = pluginTint(pluginIconKey(nodeTypeOrId));
  const glyph = Math.round(size * 0.66);
  const offset = (size - glyph) / 2;
  const shapes = pluginIconShapes(nodeTypeOrId).map(shapeToString).join('');
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`
    + `<rect width="${size}" height="${size}" rx="${Math.round(size * 0.22)}" fill="${tint.bg}"/>`
    + `<g transform="translate(${offset} ${offset}) scale(${glyph / 24})" fill="none" stroke="${tint.fg}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">`
    + shapes
    + '</g></svg>';
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
};

/** React 渲染版本：插件商店列表、详情页共用。 */
export const PluginIconGlyph = ({
  id,
  size = 24,
  strokeWidth = 1.9,
}: {
  id: string;
  size?: number;
  strokeWidth?: number;
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {pluginIconShapes(id).map((shape, index) => {
      const key = `${shape.kind}-${index}`;
      switch (shape.kind) {
        case 'path':
          return <path key={key} d={shape.d} />;
        case 'circle':
          return <circle key={key} cx={shape.cx} cy={shape.cy} r={shape.r} />;
        case 'ellipse':
          return <ellipse key={key} cx={shape.cx} cy={shape.cy} rx={shape.rx} ry={shape.ry} />;
        case 'rect':
          return (
            <rect
              key={key}
              x={shape.x}
              y={shape.y}
              width={shape.width}
              height={shape.height}
              rx={shape.rx}
            />
          );
        default:
          return null;
      }
    })}
  </svg>
);
