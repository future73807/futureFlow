/**
 * futureFlow 登录/注册对话框
 */

import { useState, useCallback } from 'react';
import { Modal, Form, Button, Tabs, Toast } from '@douyinfe/semi-ui';
import { IconUser, IconLock, IconMail } from '@douyinfe/semi-icons';
import { login, register, isLoggedIn, getUser } from '../../utils/auth';

interface LoginDialogProps {
  visible: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export const LoginDialog = ({
  visible,
  onClose,
  onSuccess,
}: LoginDialogProps) => {
  const [activeTab, setActiveTab] = useState<'login' | 'register'>('login');
  const [loading, setLoading] = useState(false);

  const handleLogin = useCallback(
    async (values: any) => {
      setLoading(true);
      try {
        await login(values.account, values.password);
        Toast.success('登录成功');
        onSuccess();
        onClose();
      } catch (err: any) {
        Toast.error(err.message || '登录失败');
      } finally {
        setLoading(false);
      }
    },
    [onClose, onSuccess],
  );

  const handleRegister = useCallback(
    async (values: any) => {
      setLoading(true);
      try {
        await register(values.username, values.email, values.password);
        Toast.success('注册成功，已自动登录');
        onSuccess();
        onClose();
      } catch (err: any) {
        Toast.error(err.message || '注册失败');
      } finally {
        setLoading(false);
      }
    },
    [onClose, onSuccess],
  );

  return (
    <Modal
      title="futureFlow 账号"
      visible={visible}
      onCancel={onClose}
      footer={null}
      width={420}
    >
      <Tabs
        activeKey={activeTab}
        onChange={(key) => setActiveTab(key as 'login' | 'register')}
      >
        <Tabs.TabPane tab="登录" itemKey="login">
          <Form onSubmit={handleLogin} key="login-form">
            <Form.Input
              field="account"
              label="用户名 / 邮箱"
              prefix={<IconUser />}
              placeholder="输入用户名或邮箱"
              rules={[{ required: true, message: '请输入账号' }]}
            />
            <Form.Input
              field="password"
              label="密码"
              mode="password"
              prefix={<IconLock />}
              placeholder="输入密码"
              rules={[{ required: true, message: '请输入密码' }]}
            />
            <Button
              type="primary"
              theme="solid"
              htmlType="submit"
              loading={loading}
              block
              style={{ marginTop: 8 }}
            >
              登录
            </Button>
          </Form>
        </Tabs.TabPane>

        <Tabs.TabPane tab="注册" itemKey="register">
          <Form onSubmit={handleRegister} key="register-form">
            <Form.Input
              field="username"
              label="用户名"
              prefix={<IconUser />}
              placeholder="3-32 个字符"
              rules={[
                { required: true, message: '请输入用户名' },
                { min: 3, message: '至少 3 个字符' },
              ]}
            />
            <Form.Input
              field="email"
              label="邮箱"
              prefix={<IconMail />}
              placeholder="your@email.com"
              rules={[
                { required: true, message: '请输入邮箱' },
                { type: 'email', message: '邮箱格式不正确' },
              ]}
            />
            <Form.Input
              field="password"
              label="密码"
              mode="password"
              prefix={<IconLock />}
              placeholder="至少 8 位"
              rules={[
                { required: true, message: '请输入密码' },
                { min: 8, message: '至少 8 位' },
              ]}
            />
            <Button
              type="primary"
              theme="solid"
              htmlType="submit"
              loading={loading}
              block
              style={{ marginTop: 8 }}
            >
              注册并登录
            </Button>
          </Form>
        </Tabs.TabPane>
      </Tabs>
    </Modal>
  );
};

/**
 * 用户信息条（显示在工具栏）
 */
export const UserBadge = ({
  onLogout,
  onLoginClick,
}: {
  onLogout: () => void;
  onLoginClick: () => void;
}) => {
  const user = getUser();

  if (!isLoggedIn() || !user) {
    return (
      <Button
        size="small"
        theme="solid"
        type="primary"
        onClick={onLoginClick}
        style={{ marginLeft: 8 }}
      >
        登录
      </Button>
    );
  }

  return (
    <Button
      size="small"
      theme="borderless"
      onClick={onLogout}
      style={{ marginLeft: 8 }}
      title={`余额: ¥${user.balance?.toFixed(2) || 0} | 点击退出`}
    >
      {user.username} · {user.vipLevel} · ¥{user.balance?.toFixed(2) || 0}
    </Button>
  );
};
