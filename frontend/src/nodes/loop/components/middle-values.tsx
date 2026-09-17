/**
 * 循环节点的「中间变量」编辑区。
 *
 * 中间变量 = 循环体要读取的循环外变量：这里按「变量名 → 变量引用」成对配置，
 * 试运行与发布时会注入循环体代码节点的入参，循环体里用 params.<变量名> 读取。
 */

import { Field, PrivateScopeProvider } from '@flowgram.ai/free-layout-editor';
import { IFlowRefValue, VariableSelector } from '@flowgram.ai/form-materials';
import { Button, Input } from '@douyinfe/semi-ui';
import { IconDelete, IconPlus } from '@douyinfe/semi-icons';

import { useNodeRenderContext } from '../../../hooks';
import { FormItem } from '../../../form-components';

type MiddleValues = Record<string, IFlowRefValue | undefined>;

export function LoopMiddleValues() {
  const { readonly } = useNodeRenderContext();

  return (
    <Field<MiddleValues> name="loopMiddleValues" defaultValue={{}}>
      {({ field }) => {
        const entries = Object.entries(field.value || {});
        const rename = (from: string, to: string) => {
          if (from === to) return;
          const next: MiddleValues = {};
          for (const [name, value] of entries) {
            next[name === from ? to : name] = value;
          }
          field.onChange(next);
        };
        const update = (name: string, value: IFlowRefValue | undefined) => {
          field.onChange({ ...(field.value || {}), [name]: value });
        };
        const remove = (name: string) => {
          const next: MiddleValues = { ...(field.value || {}) };
          delete next[name];
          field.onChange(next);
        };

        return (
          <FormItem name="中间变量" type="object" vertical>
            {entries.map(([name, value], position) => (
              <div
                key={`${name}-${position}`}
                style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8 }}
              >
                <Input
                  size="small"
                  value={name}
                  disabled={readonly}
                  placeholder="变量名"
                  style={{ width: 110, flex: '0 0 110px' }}
                  onChange={(next) => rename(name, String(next).trim())}
                />
                <PrivateScopeProvider>
                  <VariableSelector
                    style={{ flex: 1, minWidth: 0 }}
                    value={value?.content || []}
                    readonly={readonly}
                    config={{ placeholder: '选择循环外的变量' }}
                    onChange={(next) => update(name, { type: 'ref', content: next || [] })}
                  />
                </PrivateScopeProvider>
                <Button
                  size="small"
                  theme="borderless"
                  type="danger"
                  disabled={readonly}
                  icon={<IconDelete />}
                  aria-label={`删除中间变量 ${name}`}
                  onClick={() => remove(name)}
                />
              </div>
            ))}
            <Button
              size="small"
              theme="light"
              disabled={readonly}
              icon={<IconPlus />}
              onClick={() => {
                let candidate = `mid_${entries.length + 1}`;
                let suffix = entries.length + 1;
                while (candidate in (field.value || {})) {
                  suffix += 1;
                  candidate = `mid_${suffix}`;
                }
                field.onChange({ ...(field.value || {}), [candidate]: undefined });
              }}
            >
              新增中间变量
            </Button>
          </FormItem>
        );
      }}
    </Field>
  );
}
