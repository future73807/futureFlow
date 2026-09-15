import { Field } from '@flowgram.ai/free-layout-editor';
import { IconInfoCircle } from '@douyinfe/semi-icons';
import { IFlowValue } from '@flowgram.ai/form-materials';

import { useNodeRenderContext } from '../../hooks';
import { JsonSchema } from '../../typings';
import { getFieldLabel } from '../field-labels';

const MAX_CHIPS = 3;

const SummaryLabel = ({ children }: { children: string }) => (
  <span className="ff-node-summary-label">
    {children}
    <IconInfoCircle aria-hidden="true" />
  </span>
);

const SummaryRow = ({
  label,
  chips,
  variant = 'variable',
}: {
  label: string;
  chips: string[];
  variant?: 'variable' | 'plain';
}) => {
  if (chips.length === 0) return null;
  return (
    <div className="ff-node-summary-row">
      <SummaryLabel>{label}</SummaryLabel>
      <span className="ff-node-summary-values">
        {chips.slice(0, MAX_CHIPS).map((chip) => (
          <b
            className={
              variant === 'variable'
                ? 'ff-node-summary-chip variable'
                : 'ff-node-summary-chip'
            }
            key={chip}
            title={chip}
          >
            {chip}
          </b>
        ))}
        {chips.length > MAX_CHIPS && (
          <span className="ff-node-summary-more">{`+${chips.length - MAX_CHIPS}`}</span>
        )}
      </span>
    </div>
  );
};

const flowValueText = (value?: IFlowValue): string => {
  if (!value) return '';
  if (value.type === 'ref' && Array.isArray(value.content)) {
    return value.content.join('.');
  }
  if (typeof value.content === 'string' || typeof value.content === 'number') {
    return String(value.content);
  }
  return '';
};

const schemaChips = (schema?: JsonSchema): string[] =>
  Object.keys(schema?.properties || {}).map((key) => getFieldLabel(key));

/**
 * 折叠态节点摘要：对齐简洁画布风格的紧凑信息行（输入 / 输出 / 模型）。
 */
export function NodeSummary() {
  const { node } = useNodeRenderContext();
  const isLLM = node.flowNodeType === 'llm';

  return (
    <div className="ff-node-summary">
      <Field<JsonSchema> name="inputs">
        {({ field }) => <SummaryRow label="输入" chips={schemaChips(field.value)} />}
      </Field>
      <Field<JsonSchema> name="outputs">
        {({ field }) => <SummaryRow label="输出" chips={schemaChips(field.value)} />}
      </Field>
      {isLLM && (
        <Field<IFlowValue> name="inputsValues.modelName">
          {({ field }) => {
            const model = flowValueText(field.value);
            return <SummaryRow label="模型" chips={model ? [model] : []} variant="plain" />;
          }}
        </Field>
      )}
    </div>
  );
}
