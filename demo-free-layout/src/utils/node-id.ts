import { customAlphabet } from 'nanoid';

// Dify 0.15.x only accepts [A-Za-z0-9_] for node IDs that appear in
// variable selectors. Keep every canvas-generated executable-node ID inside
// that contract so {{#node_id.output#}} is always interpolated after publish.
const nextDifySafeSuffix = customAlphabet(
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_',
  8,
);

export const createWorkflowNodeId = (prefix: string): string => `${prefix}_${nextDifySafeSuffix()}`;
