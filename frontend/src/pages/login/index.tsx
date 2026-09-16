import { useCallback, useEffect, useState } from 'react';

import logoUrl from '../../assets/logo.svg';
import { useNavigate } from 'react-router-dom';
import { Button, Form, Toast } from '@douyinfe/semi-ui';
import { IconLock, IconMail, IconUser } from '@douyinfe/semi-icons';
import './login.css';
import { isLoggedIn, login, register } from '../../utils/auth';

/**
 * 输入法误输入检测：密码里混入全角字符或中文时，界面看着没错但认证必然失败。
 * 只提示“账号或密码错误”会把用户引到“我记错密码了”的错误方向，这里按类型给出具体原因。
 */
const FULL_WIDTH_PATTERN = /[\uFF01-\uFF5E\u3000]/;
const CJK_PATTERN = /[\u3400-\u9FFF\uF900-\uFAFF]/;
const NON_ASCII_PATTERN = /[^\u0020-\u007E]/;

type InputIssueKind = 'fullwidth' | 'cjk' | 'non-ascii';

interface InputIssue {
  kind: InputIssueKind;
  /** 第一个可疑字符的位置（从 1 开始），帮助用户快速定位；不回显字符本身 */
  position: number;
}

const classifyInput = (value: string): InputIssue | null => {
  if (!value) return null;
  const classifyChar = (char: string): InputIssueKind | null => {
    if (FULL_WIDTH_PATTERN.test(char)) return 'fullwidth';
    if (CJK_PATTERN.test(char)) return 'cjk';
    if (NON_ASCII_PATTERN.test(char)) return 'non-ascii';
    return null;
  };
  // 先整体判一次，绝大多数输入是纯 ASCII，避免逐字符扫描
  if (!NON_ASCII_PATTERN.test(value)) return null;
  for (let index = 0; index < value.length; index += 1) {
    const kind = classifyChar(value[index]);
    if (kind) return { kind, position: index + 1 };
  }
  return null;
};

const issueHint = (issue: InputIssue): string => {
  const at = `（第 ${issue.position} 个字符）`;
  switch (issue.kind) {
    case 'fullwidth':
      return `${at}是全角字符（中文输入法会把半角符号打成全角），请切换英文输入法后重输`;
    case 'cjk':
      return `${at}是中文字符（输入法处于中文状态时字母会被打成中文），请切换英文输入法后重输`;
    default:
      return `${at}是非半角字符，请切换英文输入法后重输`;
  }
};

export const LoginRegisterPage = () => {
  const navigate = useNavigate();
  const [isLogin, setIsLogin] = useState(true);
  // 记录输入法误输入并在表单内常驻提示，避免用「账号或密码错误」糊过去
  const [inputIssue, setInputIssue] = useState<{ field: 'account' | 'password'; issue: InputIssue } | null>(null);
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
    const passwordIssue = classifyInput(password);
    const accountIssue = classifyInput(account);
    const issue = passwordIssue
      ? { field: 'password' as const, issue: passwordIssue }
      : accountIssue
        ? { field: 'account' as const, issue: accountIssue }
        : null;
    setInputIssue(issue);
    setPasswordHasSpace(password !== password.trim());
    try {
      await login(account, password);
      Toast.success('登录成功');
      navigate('/', { replace: true });
    } catch (error: any) {
      // 输入法误输入导致的失败绝不能用「账号或密码错误」糊过去：用户会以为记错密码，
      // 真正要改的是输入法，所以这种情况只给输入法提示。
      if (issue) {
        Toast.error(`${issue.field === 'password' ? '密码' : '用户名'}${issueHint(issue.issue)}`);
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
                setInputIssue((previous) => {
                  const nextIssue = classifyInput(String(value));
                  if (nextIssue) return { field: 'account', issue: nextIssue };
                  return previous?.field === 'account' ? null : previous;
                })
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
                setInputIssue((previous) => {
                  const nextIssue = classifyInput(text);
                  if (nextIssue) return { field: 'password', issue: nextIssue };
                  return previous?.field === 'password' ? null : previous;
                });
                setPasswordHasSpace(text !== text.trim());
              }}
            />
            {inputIssue && (
              <p className="auth-input-warning" role="alert">
                {inputIssue.field === 'password' ? '密码' : '用户名'}
                {issueHint(inputIssue.issue)}。
              </p>
            )}
            {!inputIssue && passwordHasSpace && (
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
