/**
 * 变量类型图标：一套统一的线性图标（16×16、描边 1.4、圆角端点），
 * 字符串 / 整数 / 数字 / 布尔值 / 时间 / 对象 / 数组 / 映射 / 文件 / 枚举 / 未知
 * 全部用同一套画法，避免不同类型图标风格与大小不一致。
 */

export type TypeGlyphName =
  | 'string'
  | 'integer'
  | 'number'
  | 'boolean'
  | 'date-time'
  | 'object'
  | 'array'
  | 'map'
  | 'file'
  | 'enum'
  | 'unknown';

const PATHS: Record<TypeGlyphName, JSX.Element> = {
  // 字符串：字母 A
  string: <path d="M4 12.5l4-9 4 9M5.6 9.6h4.8" />,
  // 整数：数字 1
  integer: <path d="M6.4 5.6l2-1.1v8M5 12.5h5" />,
  // 数字：#（与整数区分）
  number: <path d="M6.4 3.8l-1 8.4M10.6 3.8l-1 8.4M4.2 6.6h8M3.8 9.4h8" />,
  // 布尔值：开关
  boolean: (
    <>
      <rect x="2.6" y="5.4" width="10.8" height="5.2" rx="2.6" />
      <circle cx="10.6" cy="8" r="1.5" />
    </>
  ),
  // 时间：时钟
  'date-time': (
    <>
      <circle cx="8" cy="8" r="5.4" />
      <path d="M8 4.9V8l2.2 1.6" />
    </>
  ),
  // 对象：花括号
  object: <path d="M6.6 3.4H5.4a1.2 1.2 0 00-1.2 1.2v6.8a1.2 1.2 0 001.2 1.2h1.2M9.4 3.4h1.2a1.2 1.2 0 011.2 1.2v6.8a1.2 1.2 0 01-1.2 1.2H9.4" />,
  // 数组：方括号
  array: <path d="M6.2 3.4H5v9.2h1.2M9.8 3.4H11v9.2H9.8" />,
  // 映射：网格
  map: (
    <>
      <rect x="3.2" y="3.2" width="9.6" height="9.6" rx="1.4" />
      <path d="M3.2 8h9.6M8 3.2v9.6" />
    </>
  ),
  // 文件：带折角的文档
  file: (
    <>
      <path d="M4.2 2.9h4.6l3 3v7.2H4.2z" />
      <path d="M8.8 2.9v3h3" />
    </>
  ),
  // 枚举：列表
  enum: <path d="M6 5.2h6.2M6 8h6.2M6 10.8h6.2M3.6 5.2h.01M3.6 8h.01M3.6 10.8h.01" />,
  // 未知：问号
  unknown: (
    <>
      <circle cx="8" cy="8" r="5.4" />
      <path d="M6.4 6.4a1.7 1.7 0 113 1.2c-.6.5-1.4.8-1.4 1.6M8 11.4h.01" />
    </>
  ),
};

export const TypeGlyph = ({
  type,
  size = 14,
}: {
  type?: string;
  size?: number;
}) => {
  const name = (type && type in PATHS ? type : 'unknown') as TypeGlyphName;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flex: `0 0 ${size}px` }}
    >
      {PATHS[name]}
    </svg>
  );
};
