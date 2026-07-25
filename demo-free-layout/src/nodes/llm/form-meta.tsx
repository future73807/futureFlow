import { FormMeta, FormRenderProps } from '@flowgram.ai/free-layout-editor';
import { createInferInputsPlugin, DisplayOutputs } from '@flowgram.ai/form-materials';
import { Divider } from '@douyinfe/semi-ui';
import { FormContent, FormHeader, FormInputs } from '../../form-components';
import { FlowNodeJSON } from '../../typings';
import { defaultFormMeta } from '../default-form-meta';

/**
 * LLM used to rely on the generic fallback registry.  Giving it an explicit
 * form contract keeps the node panel mounted when it is created from either
 * the toolbar or a connection port, and ensures input references are inferred.
 */
const LLMForm = ({ form }: FormRenderProps<FlowNodeJSON>) => (
  <>
    <FormHeader />
    <FormContent>
      <FormInputs />
      <Divider />
      <DisplayOutputs displayFromScope />
    </FormContent>
  </>
);

export const formMeta: FormMeta<FlowNodeJSON> = {
  render: (props) => <LLMForm {...props} />,
  effect: defaultFormMeta.effect,
  validate: defaultFormMeta.validate,
  plugins: [createInferInputsPlugin({ sourceKey: 'inputsValues', targetKey: 'inputs' })],
};
