import { FormMeta } from '@flowgram.ai/free-layout-editor';
import { createInferInputsPlugin } from '@flowgram.ai/form-materials';
import { FlowNodeJSON } from '../../typings';
import { defaultFormMeta } from '../default-form-meta';

/*
 * The LLM editor uses the full base form contract.  This keeps every lifecycle
 * hook present when the node is created from either the picker or a connector.
 */
export const formMeta: FormMeta<FlowNodeJSON> = {
  ...defaultFormMeta,
  plugins: [
    createInferInputsPlugin({
      sourceKey: 'inputsValues',
      targetKey: 'inputs',
    }),
  ],
};
