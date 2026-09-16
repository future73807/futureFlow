/**
 * 变量类型选择器（替换组件库默认实现）。
 *
 * 组件库默认用 Semi Cascader 展示类型：二级列窄、条目被裁切，且必须点击才能展开子类型。
 * 这里换成我们自己的面板：
 *   - 一层列表完整展示所有类型（不再出现「显示不全」）；
 *   - 数组把鼠标移上去就展开二级菜单（数组元素类型）；
 *   - 每行统一使用同一套 TypeGlyph 线性图标（含「文件」）。
 */

import { useRef, useState } from 'react';

import { IconButton, Popover } from '@douyinfe/semi-ui';
import { useTypeManager } from '@flowgram.ai/form-materials';

import { TypeGlyph } from './type-glyph';

interface TypeSelectorProps {
  value?: { type?: string; items?: any };
  onChange?: (schema: { type: string; items?: any } | undefined) => void;
  readonly?: boolean;
  disabled?: boolean;
  style?: React.CSSProperties;
}

/** schema → 选择路径，例如 {type:'array',items:{type:'string'}} → ['array','string'] */
const toPath = (schema?: { type?: string; items?: any }): string[] => {
  if (schema?.type === 'array' && schema.items) return [schema.type, ...toPath(schema.items)];
  return schema?.type ? [schema.type] : [];
};

/** 选择路径 → schema */
const fromPath = (path: string[]): { type: string; items?: any } | undefined => {
  const [type, ...rest] = path;
  if (!type) return undefined;
  if (type === 'array') {
    const items = fromPath(rest);
    return items ? { type: 'array', items } : { type: 'array' };
  }
  return { type };
};

export const LocalizedTypeSelector = ({
  value,
  onChange,
  readonly,
  disabled,
  style,
}: TypeSelectorProps) => {
  const typeManager = useTypeManager();
  const [visible, setVisible] = useState(false);
  const [openSubmenu, setOpenSubmenu] = useState<string | null>(null);
  const closeTimer = useRef<number | undefined>(undefined);

  const typeLabel = (type: string) =>
    typeManager.getTypeBySchema({ type } as any)?.label || type;

  const topTypes = typeManager.getTypeRegistriesWithParentType().map((item: any) => item.type);
  const arrayItemTypes = typeManager
    .getTypeRegistriesWithParentType('array')
    .map((item: any) => item.type)
    .filter((type: string) => type !== 'array');

  const select = (path: string[]) => {
    onChange?.(fromPath(path));
    setVisible(false);
    setOpenSubmenu(null);
  };

  const rowStyle = (active: boolean): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 10px',
    minWidth: 150,
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 13,
    color: 'var(--semi-color-text-0)',
    background: active ? 'var(--semi-color-fill-0)' : 'transparent',
  });

  const keepSubmenu = () => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
  };
  const scheduleCloseSubmenu = () => {
    keepSubmenu();
    closeTimer.current = window.setTimeout(() => setOpenSubmenu(null), 120);
  };

  const menu = (
    <div style={{ position: 'relative', padding: 4 }} onMouseLeave={scheduleCloseSubmenu}>
      {topTypes.map((type: string) => {
        const hasChildren = type === 'array';
        const active = openSubmenu === type || (value?.type === type && !hasChildren);
        return (
          <div
            key={type}
            role="menuitem"
            style={rowStyle(active)}
            onMouseEnter={() => {
              keepSubmenu();
              setOpenSubmenu(hasChildren ? type : null);
            }}
            onClick={() => (hasChildren ? setOpenSubmenu(type) : select([type]))}
          >
            <TypeGlyph type={type} />
            <span style={{ flex: 1 }}>{typeLabel(type)}</span>
            {hasChildren && <span style={{ color: 'var(--semi-color-text-2)' }}>›</span>}
          </div>
        );
      })}
      {openSubmenu === 'array' && (
        <div
          style={{
            position: 'absolute',
            top: 4,
            left: '100%',
            marginLeft: 4,
            padding: 4,
            borderRadius: 8,
            border: '1px solid var(--semi-color-border)',
            background: 'var(--semi-color-bg-3)',
            boxShadow: 'var(--semi-shadow-elevated)',
            zIndex: 10,
          }}
          onMouseEnter={keepSubmenu}
        >
          {arrayItemTypes.map((itemType: string) => (
            <div
              key={itemType}
              role="menuitem"
              style={rowStyle(false)}
              onClick={() => select(['array', itemType])}
            >
              <TypeGlyph type={itemType} />
              <span style={{ flex: 1 }}>{typeLabel(itemType)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  const current = toPath(value)[0];
  return (
    <Popover
      trigger="custom"
      visible={visible}
      onClickOutSide={() => {
        setVisible(false);
        setOpenSubmenu(null);
      }}
      content={menu}
      position="bottomLeft"
    >
      <IconButton
        size="small"
        style={style}
        disabled={readonly || disabled}
        aria-label="变量类型"
        icon={<TypeGlyph type={current} />}
        onClick={() => setVisible((open) => !open)}
      />
    </Popover>
  );
};
