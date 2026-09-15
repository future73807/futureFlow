import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Input, Modal, Select, Spin, Toast, Typography } from '@douyinfe/semi-ui';

import {
  createMediaCredential,
  listMediaCredentials,
  MediaCredentialSummary,
  MediaProvider,
} from '../../services/media-credentials';

const PROVIDER_LABELS: Record<MediaProvider, string> = {
  openai: 'OpenAI',
  google: 'Google',
  doubao: '豆包（火山引擎）',
  minimax: 'MiniMax',
};

const errorMessage = (error: unknown, fallback: string) => (
  error instanceof Error && error.message ? error.message : fallback
);

const shortFingerprint = (fingerprint: string) => (
  fingerprint ? `指纹 ${fingerprint.slice(0, 12)}` : '已加密保存'
);

interface CreateMediaCredentialDialogProps {
  provider: MediaProvider;
  onClose: () => void;
  onCreated: (credential: MediaCredentialSummary) => void;
}

/**
 * API Key 只存在于这个瞬态弹窗状态：不会进入 FlowGram Field，也不会进入画布
 * DSL、工作流历史或 ZIP。弹窗关闭、提交成功或失败后都会立即清空它。
 */
const CreateMediaCredentialDialog = ({
  provider,
  onClose,
  onCreated,
}: CreateMediaCredentialDialogProps) => {
  const [label, setLabel] = useState(`${PROVIDER_LABELS[provider]} 凭据`);
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const clearSecret = useCallback(() => {
    setApiKey('');
  }, []);

  const close = useCallback(() => {
    if (saving) return;
    clearSecret();
    onClose();
  }, [clearSecret, onClose, saving]);

  const submit = useCallback(async () => {
    const trimmedLabel = label.trim();
    if (!trimmedLabel) {
      setError('请输入凭据名称');
      return;
    }
    if (trimmedLabel.length > 80) {
      setError('凭据名称最多 80 个字符');
      return;
    }
    if (apiKey.trim().length < 8) {
      setError('请输入至少 8 个字符的访问密钥');
      return;
    }

    setSaving(true);
    setError('');
    try {
      const credential = await createMediaCredential({
        provider,
        label: trimmedLabel,
        apiKey,
      });
      clearSecret();
      onCreated(credential);
      Toast.success('媒体凭据已加密保存');
      setSaving(false);
      onClose();
    } catch (requestError) {
      // 不回显或保留 Key；失败后要求重新粘贴，避免它长期停留在浏览器内存。
      clearSecret();
      setError(errorMessage(requestError, '保存媒体凭据失败'));
      setSaving(false);
    }
  }, [apiKey, clearSecret, label, onClose, onCreated, provider]);

  return (
    <Modal
      visible
      title={`新增 ${PROVIDER_LABELS[provider]} 服务凭据`}
      onCancel={close}
      closable={!saving}
      maskClosable={!saving}
      footer={(
        <>
          <Button theme="borderless" disabled={saving} onClick={close}>取消</Button>
          <Button type="primary" theme="solid" loading={saving} onClick={() => void submit()}>
            加密保存
          </Button>
        </>
      )}
    >
      <div className="media-credential-dialog">
        <Typography.Text type="tertiary" size="small">
          访问密钥只会提交到当前账户的加密凭据中心，不会写入节点、工作流版本或结果 ZIP。
        </Typography.Text>
        <label className="media-credential-dialog-label" htmlFor="media-credential-label">凭据名称</label>
        <Input
          id="media-credential-label"
          value={label}
          maxLength={80}
          autoComplete="off"
          disabled={saving}
          placeholder="例如：生产环境主账号"
          onChange={(value) => {
            setLabel(value);
            setError('');
          }}
        />
        <label className="media-credential-dialog-label" htmlFor="media-credential-api-key">访问密钥</label>
        <Input
          id="media-credential-api-key"
          type="password"
          value={apiKey}
          autoComplete="new-password"
          disabled={saving}
          placeholder="粘贴服务商 API Key"
          onChange={(value) => {
            setApiKey(value);
            setError('');
          }}
        />
        {error && <Typography.Text type="danger" size="small">{error}</Typography.Text>}
      </div>
    </Modal>
  );
};

interface MediaCredentialSelectorProps {
  provider: MediaProvider;
  value?: string;
  onChange: (value: string) => void;
  readonly: boolean;
}

export const MediaCredentialSelector = ({
  provider,
  value,
  onChange,
  readonly,
}: MediaCredentialSelectorProps) => {
  const [credentials, setCredentials] = useState<MediaCredentialSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [createVisible, setCreateVisible] = useState(false);
  const isMountedRef = useRef(true);
  const requestNumberRef = useRef(0);
  const previousProviderRef = useRef(provider);

  const reload = useCallback(async () => {
    const requestNumber = ++requestNumberRef.current;
    setLoading(true);
    setLoadError('');
    try {
      const rows = await listMediaCredentials();
      if (!isMountedRef.current || requestNumber !== requestNumberRef.current) return;
      setCredentials(rows);
    } catch (requestError) {
      if (!isMountedRef.current || requestNumber !== requestNumberRef.current) return;
      setLoadError(errorMessage(requestError, '无法读取媒体凭据'));
    } finally {
      if (isMountedRef.current && requestNumber === requestNumberRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    void reload();
    return () => {
      isMountedRef.current = false;
      requestNumberRef.current += 1;
    };
  }, [reload]);

  const providerCredentials = useMemo(
    () => credentials.filter((credential) => credential.provider === provider),
    [credentials, provider],
  );
  const selectedCredential = useMemo(
    () => credentials.find((credential) => credential.id === value),
    [credentials, value],
  );

  // 无论列表请求是否暂时失败，切换供应商时都不能继续沿用旧供应商的凭据引用。
  useEffect(() => {
    if (previousProviderRef.current === provider) return;
    previousProviderRef.current = provider;
    if (value) onChange('');
  }, [onChange, provider, value]);

  // 从下拉列表中选择时，供应商和凭据始终是一对；切换供应商后不会复用旧供应商的 Key。
  useEffect(() => {
    if (!value || loading || loadError) return;
    if (!selectedCredential || selectedCredential.provider !== provider) {
      onChange('');
    }
  }, [loadError, loading, onChange, provider, selectedCredential, value]);

  const options = providerCredentials.map((credential) => ({
    value: credential.id,
    label: `${credential.label} · ${shortFingerprint(credential.fingerprint)}`,
  }));

  const handleCreated = useCallback((credential: MediaCredentialSummary) => {
    setCredentials((current) => [
      credential,
      ...current.filter((item) => item.id !== credential.id),
    ]);
    onChange(credential.id);
    setCreateVisible(false);
    void reload();
  }, [onChange, reload]);

  const providerLabel = PROVIDER_LABELS[provider];
  const placeholder = loading
    ? '正在读取已加密保存的凭据…'
    : options.length > 0
      ? `选择 ${providerLabel} 凭据`
      : `暂无 ${providerLabel} 凭据，请先新增`;

  return (
    <div className="media-credential-selector">
      <Select
        value={value || undefined}
        disabled={readonly || loading}
        loading={loading}
        placeholder={placeholder}
        optionList={options}
        style={{ width: '100%' }}
        onChange={(nextValue) => onChange(String(nextValue || ''))}
        emptyContent={loading ? <Spin size="small" /> : '该供应商暂无可用凭据'}
      />
      {!readonly && (
        <div className="media-credential-actions">
          <Button
            theme="borderless"
            size="small"
            disabled={loading}
            onClick={() => void reload()}
          >
            刷新列表
          </Button>
          <Button
            theme="light"
            type="primary"
            size="small"
            onClick={() => setCreateVisible(true)}
          >
            新增凭据
          </Button>
        </div>
      )}
      {loadError && (
        <Typography.Text type="danger" size="small">
          凭据列表加载失败：{loadError}
        </Typography.Text>
      )}
      {!loading && !loadError && options.length === 0 && (
        <Typography.Text type="tertiary" size="small">
          新建后会自动选中；节点只保存 UUID 引用。
        </Typography.Text>
      )}
      {createVisible && (
        <CreateMediaCredentialDialog
          provider={provider}
          onClose={() => setCreateVisible(false)}
          onCreated={handleCreated}
        />
      )}
    </div>
  );
};
