import { useCallback, useEffect, useState } from 'react';

import logoUrl from '../../assets/logo.svg';
import { useNavigate } from 'react-router-dom';
import { Button, Form, Toast } from '@douyinfe/semi-ui';
import { IconLock, IconMail, IconUser } from '@douyinfe/semi-icons';
import './login.css';
import { isLoggedIn, login, register } from '../../utils/auth';

/** 全角字符检测：中文输入法把 @ - _ . 等打成全角时，密码看着没错但认证必然失败 */
const FULL_WIDTH_PATTERN = /[\uFF01-\uFF5E\u3000]/;
const hasFullWidth = (value: string) => FULL_WIDTH_PATTERN.test(value);

export const LoginRegisterPage = () => {
  const navigate = useNavigate();
  const [isLogin, setIsLogin] = useState(true);
  // 记录全角输入并在表单内常驻提示：全角字符导致的失败绝不能用「账号或密码错误」糊过去
  const [fullWidthField, setFullWidthField] = useState<'' | 'account' | 'password'>('');
  // 密码首尾空格是另一类高频误输（复制粘贴带进来），同样提前提示而不是让用户猜
  const [passwordHasSpace, setPasswordHasSpace] = useState(false);
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
    const fullWidth = hasFullWidth(password) ? 'password' : hasFullWidth(account) ? 'account' : '';
    setFullWidthField(fullWidth);
    setPasswordHasSpace(password !== password.trim());
    try {
      await login(account, password);
      Toast.success('登录成功');
      navigate('/', { replace: true });
    } catch (error: any) {
      // 中文输入法把 @ 打成全角 ＠ 时认证必然失败，此时「账号或密码错误」是误导：
      // 用户会以为记错密码，真正要改的是输入法，所以这种情况只给全角提示。
      if (fullWidth) {
        Toast.error(
          fullWidth === 'password'
            ? '密码里有全角字符（如 ＠），请切换英文输入法后重输'
            : '用户名里有全角字符，请切换英文输入法后重输',
        );
      } else if (password !== password.trim()) {
        Toast.error('密码首尾带空格，请删掉后再登录');
      } else {
        Toast.error(error.message || '登录失败');
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
              onChange={(value: string) =>
                setFullWidthField((previous) =>
                  hasFullWidth(String(value)) ? 'account' : previous === 'account' ? '' : previous,
                )
              }
            />
            <Form.Input
              field="password"
              label="密码"
              mode="password"
              prefix={<IconLock />}
              placeholder="输入密码"
              size="large"
              rules={[{ required: true, message: '请输入密码' }]}
              onChange={(value: string) => {
                const text = String(value);
                setFullWidthField((previous) =>
                  hasFullWidth(text) ? 'password' : previous === 'password' ? '' : previous,
                );
                setPasswordHasSpace(text !== text.trim());
              }}
            />
            {fullWidthField && (
              <p className="auth-input-warning" role="alert">
                检测到全角字符：中文输入法会把 <code>@</code> 打成 <code>＠</code>，请切换英文输入法后重输
                {fullWidthField === 'password' ? '密码' : '用户名'}。
              </p>
            )}
            {!fullWidthField && passwordHasSpace && (
              <p className="auth-input-warning" role="alert">
                密码首尾带空格（常见于复制粘贴），请删掉后再登录。
              </p>
            )}
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
