/**
 * Copyright (c) 2025 Bytedance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 */

import { FormMeta, FormRenderProps, ValidateTrigger } from '@flowgram.ai/free-layout-editor';
import { createInferInputsPlugin, validateFlowValue } from '@flowgram.ai/form-materials';
import { Divider } from '@douyinfe/semi-ui';

import { FormHeader, FormContent, LocalizedOutputs } from '../../form-components';
import { HTTPNodeJSON } from './types';
import { Timeout } from './components/timeout';
import { Params } from './components/params';
import { Headers } from './components/headers';
import { Body } from './components/body';
import { Api } from './components/api';
import { Authorization } from './components/authorization';
import { defaultFormMeta } from '../default-form-meta';

const HTTP_HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD']);
const AUTH_TYPES = new Set(['none', 'bearer', 'api-key', 'basic']);

const flowValueRawText = (value: any): string => {
  if (!value) return '';
  if (Array.isArray(value.content)) return value.content.join('.');
  return String(value.content ?? '');
};

const flowValueText = (value: any): string => flowValueRawText(value).trim();

const hasFlowValue = (value: any): boolean => flowValueText(value).length > 0;
const hasVariableReference = (value: any): boolean => (
  value?.type === 'ref' || Array.isArray(value?.content) || /\{\{[^}]+\}\}/.test(flowValueText(value))
);

const authType = (formValues: any): string => String(formValues?.authorization?.type || 'none');

const validateReferencedValue = (
  value: any,
  context: any,
  required: boolean,
  requiredMessage: string,
) => validateFlowValue(value, {
  node: context.node,
  required,
  errorMessages: {
    required: requiredMessage,
    unknownVariable: '引用的变量不存在或不在当前节点上游',
  },
});

const requireAuthValue = (expectedType: string, message: string) => (
  { value, formValues, context }: { value: any; formValues: any; context: any },
) => {
  if (authType(formValues) !== expectedType) return undefined;
  if (!hasFlowValue(value)) return message;
  return validateReferencedValue(value, context, true, message);
};

export const FormRender = ({ form }: FormRenderProps<HTTPNodeJSON>) => (
  <>
    <FormHeader />
    <FormContent>
      <Api />
      <Divider />
      <Authorization />
      <Divider />
      <Headers />
      <Divider />
      <Params />
      <Divider />
      <Body />
      <Divider />
      <Timeout />
      <Divider />
      <LocalizedOutputs />
    </FormContent>
  </>
);

export const formMeta: FormMeta = {
  render: (props) => <FormRender {...props} />,
  validateTrigger: ValidateTrigger.onChange,
  validate: {
    title: ({ value }: { value: string }) => (value?.trim() ? undefined : '标题不能为空'),
    'api.method': ({ value }: { value: string }) => (
      HTTP_METHODS.has(String(value || '').toUpperCase()) ? undefined : '请选择支持的请求方法'
    ),
    'api.url': ({ value, context }: { value: any; context: any }) => {
      const referenceError = validateReferencedValue(value, context, true, '请求地址不能为空');
      if (referenceError) return referenceError;
      const rawUrl = flowValueRawText(value);
      const url = flowValueText(value);
      if (rawUrl !== url) return '请求地址首尾不能包含空格';
      if (!hasVariableReference(value) && !/^https?:\/\//i.test(url)) {
        return '请求地址必须以 http:// 或 https:// 开头';
      }
      return undefined;
    },
    'authorization.type': ({ value }: { value: string }) => (
      AUTH_TYPES.has(String(value || '')) ? undefined : '请选择支持的认证方式'
    ),
    'authorization.token': requireAuthValue('bearer', 'Bearer 令牌不能为空'),
    'authorization.headerName': ({ value, formValues }: { value: any; formValues: any }) => {
      if (authType(formValues) !== 'api-key') return undefined;
      if (!hasFlowValue(value)) return 'API 密钥请求头名称不能为空';
      if (value?.type !== 'constant') return 'API 密钥请求头名称只能填写固定文本';
      return HTTP_HEADER_NAME_PATTERN.test(flowValueText(value))
        ? undefined
        : 'API 密钥请求头名称格式无效';
    },
    'authorization.apiKey': requireAuthValue('api-key', 'API 密钥不能为空'),
    'authorization.username': ({ value, formValues }: { value: any; formValues: any }) => {
      if (authType(formValues) !== 'basic') return undefined;
      if (!hasFlowValue(value)) return 'Basic 认证用户名不能为空';
      return value?.type === 'constant' ? undefined : 'Basic 认证用户名只能填写固定文本';
    },
    'authorization.password': ({ value, formValues }: { value: any; formValues: any }) => {
      if (authType(formValues) !== 'basic') return undefined;
      if (!hasFlowValue(value)) return 'Basic 认证密码不能为空';
      return value?.type === 'constant' ? undefined : 'Basic 认证密码只能填写固定文本';
    },
    headersValues: ({ value }: { value: Record<string, unknown> | undefined }) => {
      const invalidName = Object.keys(value || {}).find((name) => !HTTP_HEADER_NAME_PATTERN.test(name));
      return invalidName !== undefined
        ? `请求头名称“${invalidName || '空名称'}”格式无效`
        : undefined;
    },
    paramsValues: ({ value }: { value: Record<string, unknown> | undefined }) => {
      const invalidName = Object.keys(value || {}).find((name) => !name || /\s/u.test(name));
      return invalidName !== undefined
        ? `查询参数名称“${invalidName || '空名称'}”不能为空或包含空白字符`
        : undefined;
    },
    'body.json': ({ value, formValues, context }: { value: any; formValues: any; context: any }) => {
      const method = String(formValues?.api?.method || 'GET').toUpperCase();
      const bodyType = String(formValues?.body?.bodyType || 'none');
      if (method === 'GET' || method === 'HEAD' || bodyType === 'none') return undefined;
      const requiredMessage = bodyType === 'JSON' ? 'JSON 请求体不能为空' : '纯文本请求体不能为空';
      if (!hasFlowValue(value)) return requiredMessage;
      const referenceError = validateReferencedValue(value, context, true, requiredMessage);
      if (referenceError) return referenceError;
      if (bodyType === 'JSON' && value?.type !== 'ref') {
        try {
          const jsonWithPlaceholders = flowValueRawText(value).replace(/\{\{[^{}]+\}\}/g, '0');
          JSON.parse(jsonWithPlaceholders);
        } catch {
          return 'JSON 请求体格式无效';
        }
      }
      return undefined;
    },
    'timeout.timeout': ({ value }: { value: number }) => (
      Number.isInteger(value) && value >= 1 && value <= 120000
        ? undefined
        : '超时时间必须是 1 到 120000 毫秒之间的整数'
    ),
    'timeout.retryTimes': ({ value }: { value: number }) => (
      Number.isInteger(value) && value >= 0 && value <= 10
        ? undefined
        : '重试次数必须是 0 到 10 之间的整数'
    ),
  },
  effect: defaultFormMeta.effect,
  plugins: [
    createInferInputsPlugin({ sourceKey: 'headersValues', targetKey: 'headers' }),
    createInferInputsPlugin({ sourceKey: 'paramsValues', targetKey: 'params' }),
  ],
};
