/**
 * 循环卡片正文：输入 / 中间变量 / 输出 三行摘要（详细配置在右侧面板）。
 * 结构对齐参考图：每行 = 灰色标签 + 类型图标 + 值。
 */

import { Field } from '@flowgram.ai/free-layout-editor';
import { IFlowRefValue } from '@flowgram.ai/form-materials';

import { TypeGlyph } from '../../../form-components/type-glyph';

const MAX_ROUNDS = 20;

/** 引用值的显示名：['start','items'] → items */
const refLabel = (ref?: IFlowRefValue): string => {
  if (ref?.type !== 'ref' || !Array.isArray(ref.content) || ref.content.length === 0) {
    return '';
  }
  return String(ref.content[ref.content.length - 1]);
};

export const LoopCardRows = () => (
  <div className="ff-loop-card-rows">
    <Field<'array' | 'count' | 'infinite'> name="loopType" defaultValue="array">
      {({ field: typeField }) => (
        <>
          {typeField.value !== 'array' ? (
            <Field<number>
              name={typeField.value === 'infinite' ? 'loopMaxRounds' : 'loopCount'}
              defaultValue={typeField.value === 'infinite' ? MAX_ROUNDS : 3}
            >
              {({ field }) => (
                <div className="ff-loop-row">
                  <span className="ff-loop-row-label">
                    {typeField.value === 'infinite' ? '最大轮数' : '循环次数'}
                  </span>
                  <TypeGlyph type="integer" size={13} />
                  <span className="ff-loop-row-value">
                    {field.value ?? (typeField.value === 'infinite' ? MAX_ROUNDS : 3)}
                  </span>
                </div>
              )}
            </Field>
          ) : (
            <Field<IFlowRefValue> name="loopFor">
              {({ field }) => (
                <div className="ff-loop-row">
                  <span className="ff-loop-row-label">输入</span>
                  <TypeGlyph type="array" size={13} />
                  <span className={`ff-loop-row-value${refLabel(field.value) ? '' : ' empty'}`}>
                    {refLabel(field.value) || '选择循环数组'}
                  </span>
                </div>
              )}
            </Field>
          )}
        </>
      )}
    </Field>
    <Field<Record<string, IFlowRefValue | undefined>> name="loopMiddleValues" defaultValue={{}}>
      {({ field }) => {
        const names = Object.keys(field.value || {});
        return (
          <div className="ff-loop-row">
            <span className="ff-loop-row-label">中间变量</span>
            <span className={`ff-loop-row-value${names.length ? '' : ' empty'}`}>
              {names.length ? names.join('、') : '未配置中间变量'}
            </span>
          </div>
        );
      }}
    </Field>
    <Field<Record<string, IFlowRefValue | undefined> | undefined> name="loopOutputs">
      {({ field }) => {
        const names = Object.keys(field.value || {});
        return (
          <div className="ff-loop-row">
            <span className="ff-loop-row-label">输出</span>
            <TypeGlyph type="array" size={13} />
            <span className={`ff-loop-row-value${names.length ? '' : ' empty'}`}>
              {names.length ? names.join('、') : 'output'}
            </span>
          </div>
        );
      }}
    </Field>
  </div>
);
