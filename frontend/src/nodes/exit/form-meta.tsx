/**
 * 退出节点的表单。
 *
 * 「退出范围」决定语义与可放置的位置：
 *   - 退出整个工作流：放在主画布上（不能放进循环体），退出时可以返回一组输出；
 *   - 跳出当前循环：必须放进循环体，执行到时结束当前循环。
 * 位置与范围不匹配时在这里给出校验提示（运行/发布前网关也会再校验一次）。
 */

import { Field, FormMeta, FormRenderProps, ValidateTrigger } from '@flowgram.ai/free-layout-editor';
import { DisplayInputsValues, IFlowValue, InputsValues } from '@flowgram.ai/form-materials';
import { Select, Typography } from '@douyinfe/semi-ui';

import { FlowNodeJSON } from '../../typings';
import { FormHeader, FormContent, FormItem } from '../../form-components';
import { defaultFormMeta } from '../default-form-meta';
import { useIsSidebar } from '../../hooks';
import { promoteTemplateValues } from '../../utils/flow-value';

export const EXIT_SCOPE_WORKFLOW = 'workflow';
export const EXIT_SCOPE_LOOP = 'loop';

/** 节点是否位于循环体内（循环体里的节点挂在 loop 节点下） */
export const isInsideLoopBody = (node: any): boolean => node?.parent?.flowNodeType === 'loop';

const ScopeHint = () => (
  <Field<string> name="scope" defaultValue={EXIT_SCOPE_WORKFLOW}>
    {({ field }) => (
      <Typography.Text
        type="tertiary"
        size="small"
        style={{ display: 'block', marginBottom: 12 }}
      >
        {field.value === EXIT_SCOPE_LOOP
          ? '放在循环体内：执行到这里会立即结束当前循环，剩余轮次不再执行（发布到云端不支持，请用本地试运行）。'
          : '放在循环体外：执行到这里本次运行结束，后续节点不再执行；下面配置的值会作为本次运行的输出。'}
      </Typography.Text>
    )}
  </Field>
);

const WorkflowOutputs = () => (
  <Field<string> name="scope" defaultValue={EXIT_SCOPE_WORKFLOW}>
    {({ field }) => (
      <>
        {field.value === EXIT_SCOPE_LOOP ? null : (
          <FormItem name="退出时返回" type="object" vertical>
            <Field<Record<string, IFlowValue | undefined> | undefined> name="inputsValues">
              {({ field: inputsField }) => (
                <InputsValues
                  value={inputsField.value}
                  onChange={(value) => inputsField.onChange(promoteTemplateValues(value))}
                />
              )}
            </Field>
          </FormItem>
        )}
      </>
    )}
  </Field>
);

const SidebarForm = () => (
  <>
    <FormItem name="退出范围" required>
      <Field<string> name="scope" defaultValue={EXIT_SCOPE_WORKFLOW}>
        {({ field }) => (
          <Select
            style={{ width: '100%' }}
            value={field.value || EXIT_SCOPE_WORKFLOW}
            onChange={(value) => field.onChange(String(value))}
            optionList={[
              { value: EXIT_SCOPE_WORKFLOW, label: '退出整个工作流' },
              { value: EXIT_SCOPE_LOOP, label: '跳出当前循环' },
            ]}
          />
        )}
      </Field>
    </FormItem>
    <ScopeHint />
    <WorkflowOutputs />
  </>
);

export const renderForm = ({ form }: FormRenderProps<FlowNodeJSON>) => {
  const isSidebar = useIsSidebar();
  if (isSidebar) {
    return (
      <>
        <FormHeader />
        <FormContent>
          <SidebarForm />
        </FormContent>
      </>
    );
  }
  return (
    <>
      <FormHeader />
      <FormContent>
        <Field<Record<string, IFlowValue | undefined> | undefined> name="inputsValues">
          {({ field: { value } }) => <DisplayInputsValues value={value} />}
        </Field>
      </FormContent>
    </>
  );
};

export const formMeta: FormMeta = {
  ...defaultFormMeta,
  render: renderForm,
  validateTrigger: ValidateTrigger.onChange,
  validate: {
    ...defaultFormMeta.validate,
    title: ({ value }: { value?: string }) => (value?.trim() ? undefined : '标题不能为空'),
    scope: ({ value, context }: { value?: string; context: { node: any } }) => {
      const inLoop = isInsideLoopBody(context?.node);
      if (value === EXIT_SCOPE_LOOP && !inLoop) {
        return '退出范围是「跳出当前循环」，请把节点拖进循环体';
      }
      if (value !== EXIT_SCOPE_LOOP && inLoop) {
        return '循环体内只能使用「跳出当前循环」，或把节点移出循环体';
      }
      return undefined;
    },
  },
};
