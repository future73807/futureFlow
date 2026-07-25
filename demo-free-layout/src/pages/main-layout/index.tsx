import { useCallback, useEffect, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Avatar, Button, Toast, Typography } from '@douyinfe/semi-ui';
import {
  IconApps,
  IconExit,
  IconKey,
  IconList,
  IconPlus,
  IconSetting,
  IconUser,
} from '@douyinfe/semi-icons';
import './main-layout.css';
import { fetchProfile, isLoggedIn, removeToken } from '../../utils/auth';

const NAV_ITEMS = [
  { key: '/', label: '工作流', icon: <IconApps />, adminOnly: false },
  { key: '/profile', label: '个人中心', icon: <IconUser />, adminOnly: false },
  { key: '/admin', label: '平台管理', icon: <IconSetting />, adminOnly: true },
];

export const MainLayout = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [user, setUser] = useState<any>(null);

  useEffect(() => {
    if (!isLoggedIn()) {
      navigate('/login', { replace: true });
      return;
    }

    fetchProfile()
      .then((profile) => {
        if (profile) {
          setUser(profile);
        } else {
          navigate('/login', { replace: true });
        }
      })
      .catch(() => Toast.error('无法读取账户信息，请确认网关服务已启动'));
  }, [location.pathname, navigate]);

  const handleLogout = useCallback(() => {
    removeToken();
    navigate('/login', { replace: true });
  }, [navigate]);

  const openWorkflowAction = (action: 'create' | 'templates') => {
    navigate('/?action=' + action);
  };

  return (
    <div className="app-layout">
      <aside className="app-sidebar">
        <button className="app-brand" type="button" onClick={() => navigate('/')}>
          <span className="app-brand-mark" aria-hidden="true">
            <svg width="24" height="24" viewBox="0 0 48 48" fill="none">
              <rect width="48" height="48" rx="12" fill="currentColor" />
              <path d="M14 18 24 14 34 18v12L24 34 14 30V18Z" stroke="white" strokeWidth="2.5" strokeLinejoin="round" />
              <circle cx="24" cy="24" r="3" fill="white" />
            </svg>
          </span>
          <strong>futureFlow</strong>
        </button>

        <div className="sidebar-actions">
          <Button
            className="sidebar-create"
            type="primary"
            theme="solid"
            icon={<IconPlus />}
            onClick={() => openWorkflowAction('create')}
          >
            创建画布
          </Button>
          <Button
            className="sidebar-command"
            type="tertiary"
            theme="borderless"
            icon={<IconList />}
            onClick={() => openWorkflowAction('templates')}
          >
            模板库
          </Button>
          <Button
            className="sidebar-command"
            type="tertiary"
            theme="borderless"
            icon={<IconKey />}
            onClick={() => navigate('/profile?action=create-key')}
          >
            创建 Key
          </Button>
        </div>

        <div className="sidebar-label">工作区</div>
        <nav className="sidebar-nav" aria-label="主导航">
          {NAV_ITEMS
            .filter((item) => !item.adminOnly || user?.role === 'admin')
            .map((item) => {
              const active = item.key === '/'
                ? location.pathname === '/'
                : location.pathname.startsWith(item.key);
              return (
                <button
                  key={item.key}
                  className={'sidebar-nav-item' + (active ? ' is-active' : '')}
                  type="button"
                  onClick={() => navigate(item.key)}
                >
                  <span aria-hidden="true">{item.icon}</span>
                  {item.label}
                </button>
              );
            })}
        </nav>

        <div className="sidebar-footer">
          <button className="sidebar-account" type="button" onClick={() => navigate('/profile')}>
            <Avatar size="small">
              {user?.username?.[0]?.toUpperCase() || 'U'}
            </Avatar>
            <span>
              <Typography.Text strong>{user?.username || '加载中'}</Typography.Text>
              <Typography.Text type="tertiary">
                {user?.vipLevel?.toUpperCase() || 'FREE'} · ¥{Number(user?.balance || 0).toFixed(2)}
              </Typography.Text>
            </span>
          </button>
          <Button
            className="sidebar-logout"
            type="tertiary"
            theme="borderless"
            icon={<IconExit />}
            onClick={handleLogout}
          >
            退出登录
          </Button>
        </div>
      </aside>

      <main className="app-content">
        <Outlet />
      </main>
    </div>
  );
};
