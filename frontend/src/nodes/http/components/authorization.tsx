import { useState } from 'react';

import { Field } from '@flowgram.ai/free-layout-editor';
import {
  IFlowConstantValue,
  IFlowTemplateValue,
} from '@flowgram.ai/form-materials';
import { Button, Input, Select, Typography } from '@douyinfe/semi-ui';

import { Feedback, FormItem, PromptEditorBoundary } from '../../../form-components';
import { useNodeRenderContext } from '../../../hooks';

const AUTH_OPTIONS = [
  { label: '无需认证', value: 'none' },
  { label: 'Bearer 令牌', value: 'bearer' },
  { label: 'API 密钥', value: 'api-key' },
  { label: 'Basic 认证', value: 'basic' },
];

const AuthValue = ({ name, placeholder }: { name: string; placeholder: string }) => {
  const { readonly } = useNodeRenderContext();
  return (
    <Field<IFlowTemplateValue>
      name={name}
      defaultValue={{ type: 'template', content: '' }}
    >
      {({ field, fieldState }) => (
        <>
          <PromptEditorBoundary
            readonly={readonly}
            hasError={Boolean(fieldState?.errors?.length)}
            placeholder={placeholder}
            minRows={1}
            maxRows={4}
            value={field.value}
            onChange={field.onChange}
          />
          <Feedback errors={fieldState?.errors} warnings={fieldState?.warnings} />
        </>
      )}
    </Field>
  );
};

const ConstantAuthValue = ({
  name,
  placeholder,
  password = false,
}: {
  name: string;
  placeholder: string;
  password?: boolean;
}) => {
  const { readonly } = useNodeRenderContext();
  const [passwordVisible, setPasswordVisible] = useState(false);
  return (
    <Field<IFlowConstantValue>
      name={name}
      defaultValue={{ type: 'constant', content: '' }}
    >
      {({ field, fieldState }) => (
        <>
          <Input
            type={password ? (passwordVisible ? 'text' : 'password') : undefined}
            suffix={password ? (
              <Button
                theme="borderless"
                type="tertiary"
                size="small"
                aria-label={passwordVisible ? '隐藏密码' : '显示密码'}
                onClick={() => setPasswordVisible((visible) => !visible)}
              >
                {passwordVisible ? '隐藏' : '显示'}
              </Button>
            ) : undefined}
            readonly={readonly}
            validateStatus={fieldState?.errors?.length ? 'error' : undefined}
            placeholder={placeholder}
            value={String(field.value?.content ?? '')}
            onChange={(value) => field.onChange({ type: 'constant', content: value })}
          />
          <Feedback errors={fieldState?.errors} warnings={fieldState?.warnings} />
        </>
      )}
    </Field>
  );
};

export function Authorization() {
  const { readonly } = useNodeRenderContext();
  return (
    <Field<string> name="authorization.type" defaultValue="none">
      {({ field, fieldState }) => (
        <FormItem name="身份认证" vertical type="string">
          <Select
            value={field.value}
            disabled={readonly}
            validateStatus={fieldState?.errors?.length ? 'error' : undefined}
            optionList={AUTH_OPTIONS}
            style={{ width: '100%', marginBottom: field.value === 'none' ? 0 : 10 }}
            onChange={(value) => field.onChange(value as string)}
          />
          <Feedback errors={fieldState?.errors} warnings={fieldState?.warnings} />
          {field.value === 'bearer' && (
            <div style={{ display: 'grid', gap: 6 }}>
              <AuthValue name="authorization.token" placeholder="输入令牌，建议引用开始节点输入" />
              <Typography.Text type="tertiary" size="small">
                生产密钥请通过开始节点输入传入，不要作为常量保存到画布。
              </Typography.Text>
            </div>
          )}
          {field.value === 'api-key' && (
            <div style={{ display: 'grid', gap: 8 }}>
              <ConstantAuthValue
                name="authorization.headerName"
                placeholder="固定请求头名称，例如 X-API-Key"
              />
              <AuthValue name="authorization.apiKey" placeholder="输入密钥，建议引用开始节点输入" />
              <Typography.Text type="tertiary" size="small">
                生产密钥请通过开始节点输入传入，不要作为常量保存到画布。
              </Typography.Text>
            </div>
          )}
          {field.value === 'basic' && (
            <div style={{ display: 'grid', gap: 8 }}>
              <ConstantAuthValue name="authorization.username" placeholder="用户名（仅支持常量）" />
              <ConstantAuthValue name="authorization.password" placeholder="密码（仅支持常量）" password />
              <Typography.Text type="tertiary" size="small">
                Basic 认证暂不支持变量凭据；动态密钥请改用 Bearer 或 API 密钥认证。
              </Typography.Text>
            </div>
          )}
        </FormItem>
      )}
    </Field>
  );
}
