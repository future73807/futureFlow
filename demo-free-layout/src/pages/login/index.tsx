/**
 * futureFlow 登录/注册页面
 * 简洁商务风：纯白背景 + 居中卡片
 */

import { useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Form, Button, Typography, Toast } from '@douyinfe/semi-ui';
import { IconUser, IconLock, IconMail } from '@douyinfe/semi-icons';
import styled from 'styled-components';
import { login, register, isLoggedIn } from '../../utils/auth';

export const LoginRegisterPage = () => {
  const navigate = useNavigate();
  const [isLogin, setIsLogin] = useState(true);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (isLoggedIn()) {
      navigate('/', { replace: true });
    }
  }, [navigate]);

  const handleLogin = useCallback(
    async (values: any) => {
      setLoading(true);
      try {
        await login(values.account, values.password);
        Toast.success('登录成功');
        navigate('/', { replace: true });
      } catch (err: any) {
        Toast.error(err.message || '登录失败');
      } finally {
        setLoading(false);
      }
    },
    [navigate],
  );

  const handleRegister = useCallback(
    async (values: any) => {
      setLoading(true);
      try {
        await register(values.username, values.email, values.password);
        Toast.success('注册成功');
        navigate('/', { replace: true });
      } catch (err: any) {
        Toast.error(err.message || '注册失败');
      } finally {
        setLoading(false);
      }
    },
    [navigate],
  );

  return (
    <PageWrapper>
      <LoginCard>
        {/* 顶部 Logo */}
        <LogoRow>
          <svg width="40" height="40" viewBox="0 0 48 48" fill="none">
            <rect width="48" height="48" rx="10" fill="#4834d4" />
            <path d="M14 18 L24 14 L34 18 L34 30 L24 34 L14 30 Z" stroke="white" strokeWidth="2.5" fill="none" strokeLinejoin="round" />
            <circle cx="24" cy="24" r="3" fill="white" />
          </svg>
          <Typography.Title heading={4} style={{ margin: 0, fontWeight: 600 }}>
            futureFlow
          </Typography.Title>
        </LogoRow>

        <Typography.Title heading={5} style={{ marginTop: 8, marginBottom: 4, fontWeight: 500 }}>
          {isLogin ? '登录' : '注册'}
        </Typography.Title>
        <Typography.Text type="tertiary" size="small" style={{ marginBottom: 28, display: 'block' }}>
          {isLogin ? '登录你的账号以继续' : '创建一个新账号'}
        </Typography.Text>

        {isLogin ? (
          <Form onSubmit={handleLogin} key="login-form">
            <Form.Input
              field="account"
              label="用户名"
              prefix={<IconUser />}
              placeholder="demo"
              size="large"
              rules={[{ required: true, message: '请输入用户名' }]}
            />
            <Form.Input
              field="password"
              label="密码"
              mode="password"
              prefix={<IconLock />}
              placeholder="输入密码"
              size="large"
              rules={[{ required: true, message: '请输入密码' }]}
            />
            <Button
              type="primary"
              theme="solid"
              htmlType="submit"
              loading={loading}
              size="large"
              block
              style={{ marginTop: 12, height: 42 }}
            >
              登录
            </Button>
          </Form>
        ) : (
          <Form onSubmit={handleRegister} key="register-form">
            <Form.Input
              field="username"
              label="用户名"
              prefix={<IconUser />}
              placeholder="3-32 个字符"
              size="large"
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
              size="large"
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
              size="large"
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
              size="large"
              block
              style={{ marginTop: 12, height: 42 }}
            >
              注册
            </Button>
          </Form>
        )}

        {/* 切换登录/注册 */}
        <SwitchRow>
          <Typography.Text type="tertiary" size="small">
            {isLogin ? '没有账号？' : '已有账号？'}
          </Typography.Text>
          <SwitchButton onClick={() => setIsLogin(!isLogin)}>
            {isLogin ? '去注册' : '去登录'}
          </SwitchButton>
        </SwitchRow>

        {/* 演示账号提示 */}
        {isLogin && (
          <DemoBox>
            <Typography.Text type="tertiary" size="small">
              演示账号：demo / demo123456
            </Typography.Text>
          </DemoBox>
        )}
      </LoginCard>
    </PageWrapper>
  );
};

const PageWrapper = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100vh;
  padding: 24px;
  background: #f7f8fb;
`;

const LoginCard = styled.div`
  width: min(100%, 420px);
  padding: 36px;
  background: #fff;
  border-radius: 14px;
  border: 1px solid #e5e9f1;
  box-shadow: 0 16px 36px rgba(16, 24, 40, .08);
`;

const LogoRow = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 4px;
`;

const SwitchRow = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  margin-top: 20px;
`;

const SwitchButton = styled.span`
  color: #4054bf;
  font-size: 13px;
  cursor: pointer;

  &:hover {
    text-decoration: underline;
  }
`;

const DemoBox = styled.div`
  margin-top: 16px;
  padding: 8px 12px;
  background: #f7f9fd;
  border-radius: 8px;
  text-align: center;
  border: 1px solid #e5e9f1;
`;
