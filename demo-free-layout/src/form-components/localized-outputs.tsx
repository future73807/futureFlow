import { Field } from '@flowgram.ai/free-layout-editor';
import { DisplaySchemaTag, IJsonSchema } from '@flowgram.ai/form-materials';

import { getFieldLabel } from './field-labels';
import './localized-outputs.css';

export const LocalizedOutputs = () => (
  <Field<IJsonSchema<'object'> | undefined> name="outputs">
    {({ field }) => {
      const properties = field.value?.properties || {};
      const entries = Object.entries(properties);
      if (!entries.length) return <div className="localized-output-empty">暂无输出</div>;
      return (
        <div className="localized-output-list">
          <strong>输出结果</strong>
          {entries.map(([key, schema]) => (
            <div key={key}>
              <DisplaySchemaTag value={{ type: schema.type }} />
              <span>{getFieldLabel(key)}</span>
            </div>
          ))}
        </div>
      );
    }}
  </Field>
);
