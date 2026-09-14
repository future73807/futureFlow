import { useCallback, useEffect, useState } from 'react';

import logoUrl from '../../assets/logo-mono.svg';
import { useNavigate } from 'react-router-dom';
import { Button, Form, Toast } from '@douyinfe/semi-ui';
import { IconLock, IconMail, IconUser } from '@douyinfe/semi-icons';
import './login.css';
import { isLoggedIn, login, register } from '../../utils/auth';

export const LoginRegisterPage = () => {
  const navigate = useNavigate();
  const [isLogin, setIsLogin] = useState(true);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (isLoggedIn()) {
      navigate('/', { replace: true });
    }
  }, [navigate]);

  const handleLogin = useCallback(async (values: any) => {
    setLoading(true);
    const account = String(values.account || '').trim();
    const password = String(values.password || '');
    try {
      await login(account, password);
      Toast.success('登录成功');
      navigate('/', { replace: true });
    } catch (error: any) {
      Toast.error(error.message || '登录失败');
      // 常见坑：中文输入法把 @ 等符号打成全角（＠），导致密码看起来没输错却失败
      if (/[\uFF01-\uFF5E\u3000]/.test(password)) {
        Toast.warning('检测到密码中含全角字符，请切换到英文输入法后重新输入');
      }
    } finally {
      setLoading(false);
    }
  }, [navigate]);

  const handleRegister = useCallback(async (values: any) => {
    setLoading(true);
    try {
      await register(values.username, values.email, values.password);
      Toast.success('注册成功');
      navigate('/', { replace: true });
    } catch (error: any) {
      Toast.error(error.message || '注册失败');
    } finally {
      setLoading(false);
    }
  }, [navigate]);

  return (
    <main className="auth-page">
      <section className="auth-surface" aria-labelledby="auth-title">
        <div className="auth-brand">
          <span className="auth-brand-mark" aria-hidden="true">
            <img src={logoUrl} width={34} height={34} alt="" />
          </span>
          <strong>futureFlow</strong>
        </div>

        <header className="auth-heading">
          <h1 id="auth-title">{isLogin ? '登录工作区' : '创建账号'}</h1>
          <p>{isLogin ? '继续管理和运行你的 AI 工作流。' : '用一个账户开始构建新的工作流。'}</p>
        </header>

        {isLogin ? (
          <Form onSubmit={handleLogin} key="login-form">
            <Form.Input
              field="account"
              label="用户名"
              prefix={<IconUser />}
              placeholder="输入用户名"
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
            <Button type="primary" theme="solid" htmlType="submit" loading={loading} size="large" block>
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
              placeholder="name@example.com"
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
            <Button type="primary" theme="solid" htmlType="submit" loading={loading} size="large" block>
              创建账号
            </Button>
          </Form>
        )}

        <div className="auth-switch">
          <span>{isLogin ? '还没有账号？' : '已经有账号？'}</span>
          <button type="button" onClick={() => setIsLogin((current) => !current)}>
            {isLogin ? '去注册' : '去登录'}
          </button>
        </div>
      </section>
    </main>
  );
};
