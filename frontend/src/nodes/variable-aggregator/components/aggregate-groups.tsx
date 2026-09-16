/**
 * 变量聚合节点的「分组」编辑区。
 *
 * 顶部是聚合策略（目前只有「返回每个分组中第一个非空的值」），下面按分组列出变量：
 * 每个分组一行行变量选择器，行首显示该变量的类型缩写；分组可改名、可增删。
 * 输出列表由分组结构推导，改动后会同步写回节点 outputs，供下游引用。
 */

import { Button, Input, Select, Tag } from '@douyinfe/semi-ui';
import { IconDelete, IconPlus } from '@douyinfe/semi-icons';
import { Field, FlowNodeJSON, FormRenderProps, PrivateScopeProvider } from '@flowgram.ai/free-layout-editor';
import { VariableSelector } from '@flowgram.ai/form-materials';

import { FormItem } from '../../../form-components';
import { useNodeRenderContext } from '../../../hooks';
import { AggregateGroup, AggregateValue, normalizeAggregateType, validateAggregateGroups } from '../aggregate';

const STRATEGY_OPTIONS = [
  { value: 'first-non-empty', label: '返回每个分组中第一个非空的值' },
];

const TYPE_SHORT: Record<string, string> = {
  string: 'str',
  number: 'num',
  boolean: 'bool',
  object: 'obj',
  array: 'arr',
};

/** 从变量的 JSON Schema 推出分组输出类型：同一分组内类型必须一致 */
const inferGroupType = (form: FormRenderProps<FlowNodeJSON>['form'], group: AggregateGroup): string => {
  const types = new Set<string>();
  const scope = (form as any)?.context?.node ? undefined : undefined;
  void scope;
  for (const value of group.values || []) {
    const content = (value?.content as string[] | undefined) || [];
    if (content.length < 2) continue;
    const variable = (form as any)?.context?.node
      ?.getNodeScope?.()
      ?.available?.getByKeyPath?.(content);
    const schemaType = variable?.type?.type || variable?.meta?.schema?.type;
    types.add(normalizeAggregateType(schemaType || 'string'));
  }
  if (types.size === 0) return 'string';
  return [...types][0];
};

export function AggregateGroups({ form }: { form: FormRenderProps<FlowNodeJSON>['form'] }) {
  const { readonly } = useNodeRenderContext();

  const syncOutputs = (groups: AggregateGroup[]) => {
    const properties: Record<string, any> = {};
    groups.forEach((group) => {
      const key = String(group?.key || '').trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return;
      properties[key] = { type: inferGroupType(form, group), title: key };
    });
    form.setValueIn('outputs', { type: 'object', properties });
  };

  return (
    <>
      <Field<'first-non-empty'> name="strategy" defaultValue="first-non-empty">
        {({ field }) => (
          <FormItem name="聚合策略" required>
            <Select
              style={{ width: '100%' }}
              value={field.value || 'first-non-empty'}
              optionList={STRATEGY_OPTIONS}
              disabled={readonly}
              onChange={(value) => field.onChange(String(value) as 'first-non-empty')}
            />
          </FormItem>
        )}
      </Field>

      <Field<AggregateGroup[]> name="groups" defaultValue={[{ key: 'result', values: [] }]}>
        {({ field, fieldState }) => {
          const groups: AggregateGroup[] = Array.isArray(field.value) ? field.value : [];
          const commit = (next: AggregateGroup[]) => {
            field.onChange(next);
            syncOutputs(next);
          };

          return (
            <FormItem name="分组" type="object" vertical>
              {groups.map((group, groupIndex) => {
                const groupType = inferGroupType(form, group);
                return (
                  <div
                    key={`group-${groupIndex}`}
                    style={{
                      marginBottom: 10,
                      padding: '8px 10px',
                      border: '1px solid var(--semi-color-border)',
                      borderRadius: 8,
                    }}
                  >
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
                      <Input
                        size="small"
                        value={group.key}
                        disabled={readonly}
                        placeholder="输出名"
                        style={{ width: 120, flex: '0 0 120px' }}
                        onChange={(next) => {
                          const trimmed = String(next).trim();
                          const updated = groups.map((item, index) => (
                            index === groupIndex ? { ...item, key: trimmed } : item
                          ));
                          commit(updated);
                        }}
                      />
                      <Tag size="small" color="blue">{TYPE_SHORT[groupType] || 'str'}</Tag>
                      <span style={{ flex: 1 }} />
                      <Button
                        size="small"
                        theme="borderless"
                        type="danger"
                        disabled={readonly || groups.length <= 1}
                        icon={<IconDelete />}
                        aria-label={`删除分组 ${group.key}`}
                        onClick={() => commit(groups.filter((_item, index) => index !== groupIndex))}
                      />
                    </div>
                    {(group.values || []).map((value: AggregateValue | undefined, valueIndex: number) => {
                      const content = (value?.content as string[] | undefined) || [];
                      const variable = (form as any)?.context?.node
                        ?.getNodeScope?.()
                        ?.available?.getByKeyPath?.(content);
                      const type = normalizeAggregateType(
                        variable?.type?.type || variable?.meta?.schema?.type || 'string',
                      );
                      return (
                        <div
                          key={`value-${groupIndex}-${valueIndex}`}
                          style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}
                        >
                          <Tag size="small" style={{ flex: '0 0 42px', textAlign: 'center' }}>
                            {TYPE_SHORT[type] || 'str'}.
                          </Tag>
                          <PrivateScopeProvider>
                            <VariableSelector
                              style={{ flex: 1, minWidth: 0 }}
                              value={content}
                              readonly={readonly}
                              config={{ placeholder: '选择要聚合的变量' }}
                              onChange={(next) => {
                                const updated = groups.map((item, index) => {
                                  if (index !== groupIndex) return item;
                                  const values = [...(item.values || [])];
                                  values[valueIndex] = { type: 'ref', content: next || [] };
                                  return { ...item, values };
                                });
                                commit(updated);
                              }}
                            />
                          </PrivateScopeProvider>
                          <Button
                            size="small"
                            theme="borderless"
                            type="danger"
                            disabled={readonly || (group.values || []).length <= 1}
                            icon={<IconDelete />}
                            aria-label="删除变量"
                            onClick={() => {
                              const updated = groups.map((item, index) => (
                                index === groupIndex
                                  ? { ...item, values: (item.values || []).filter((_v: unknown, i: number) => i !== valueIndex) }
                                  : item
                              ));
                              commit(updated);
                            }}
                          />
                        </div>
                      );
                    })}
                    <Button
                      size="small"
                      theme="light"
                      disabled={readonly}
                      icon={<IconPlus />}
                      onClick={() => {
                        const updated = groups.map((item, index) => (
                          index === groupIndex
                            ? { ...item, values: [...(item.values || []), { type: 'ref', content: [] }] }
                            : item
                        ));
                        commit(updated);
                      }}
                    >
                      新增变量
                    </Button>
                  </div>
                );
              })}
              <Button
                size="small"
                theme="light"
                type="primary"
                disabled={readonly}
                icon={<IconPlus />}
                onClick={() => {
                  let suffix = groups.length + 1;
                  let key = `result_${suffix}`;
                  const used = new Set(groups.map((group) => group.key));
                  while (used.has(key)) {
                    suffix += 1;
                    key = `result_${suffix}`;
                  }
                  commit([...groups, { key, values: [{ type: 'ref', content: [] }] }]);
                }}
              >
                新增分组
              </Button>
              {fieldState?.errors?.length ? (
                <div style={{ marginTop: 6, color: 'var(--semi-color-danger)', fontSize: 12 }}>
                  {String(fieldState.errors[0])}
                </div>
              ) : null}
            </FormItem>
          );
        }}
      </Field>
    </>
  );
}

export { validateAggregateGroups };
