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
import styled from 'styled-components';
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
        if (profile) setUser(profile);
        else navigate('/login', { replace: true });
      })
      .catch(() => Toast.error('无法读取账户信息，请确认网关服务已启动'));
  }, [navigate, location.pathname]);

  const handleLogout = useCallback(() => {
    removeToken();
    navigate('/login', { replace: true });
  }, [navigate]);

  const openWorkflowAction = (action: 'create' | 'templates') => {
    navigate(`/?action=${action}`);
  };

  return (
    <LayoutWrapper>
      <Sidebar>
        <Brand onClick={() => navigate('/')}>
          <BrandMark aria-hidden="true">
            <svg width="28" height="28" viewBox="0 0 48 48" fill="none">
              <rect width="48" height="48" rx="12" fill="currentColor" />
              <path d="M14 18 24 14 34 18v12L24 34 14 30V18Z" stroke="white" strokeWidth="2.5" strokeLinejoin="round" />
              <circle cx="24" cy="24" r="3" fill="white" />
            </svg>
          </BrandMark>
          <strong>futureFlow</strong>
        </Brand>

        <PrimaryAction type="primary" theme="solid" icon={<IconPlus />} onClick={() => openWorkflowAction('create')}>
          创建画布
        </PrimaryAction>
        <QuickActions aria-label="快捷操作">
          <QuickAction type="tertiary" theme="borderless" icon={<IconList />} onClick={() => openWorkflowAction('templates')}>
            模板库
          </QuickAction>
          <QuickAction type="tertiary" theme="borderless" icon={<IconKey />} onClick={() => navigate('/profile?action=create-key')}>
            创建 Key
          </QuickAction>
        </QuickActions>

        <NavLabel>工作区</NavLabel>
        <NavMenu>
          {NAV_ITEMS.filter((item) => !item.adminOnly || user?.role === 'admin').map((item) => (
            <NavItem
              key={item.key}
              $active={item.key === '/' ? location.pathname === '/' : location.pathname.startsWith(item.key)}
              onClick={() => navigate(item.key)}
            >
              <span>{item.icon}</span>
              {item.label}
            </NavItem>
          ))}
        </NavMenu>

        <SidebarFooter>
          <AccountButton onClick={() => navigate('/profile')}>
            <Avatar size="small">{user?.username?.[0]?.toUpperCase() || 'U'}</Avatar>
            <AccountCopy>
              <Typography.Text strong>{user?.username || '加载中'}</Typography.Text>
              <Typography.Text type="tertiary">{user?.vipLevel?.toUpperCase() || 'FREE'} · ¥{Number(user?.balance || 0).toFixed(2)}</Typography.Text>
            </AccountCopy>
          </AccountButton>
          <QuickAction type="tertiary" theme="borderless" icon={<IconExit />} onClick={handleLogout}>
            退出登录
          </QuickAction>
        </SidebarFooter>
      </Sidebar>
      <ContentArea><Outlet /></ContentArea>
    </LayoutWrapper>
  );
};

const LayoutWrapper = styled.div`
  display: flex;
  height: 100vh;
  min-width: 0;
  overflow: hidden;
  background: var(--ff-page);
`;

const Sidebar = styled.aside`
  width: 248px;
  padding: 18px 12px 14px;
  box-sizing: border-box;
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  background: var(--ff-sidebar);
  color: #d8dde8;
  border-right: 1px solid rgba(255, 255, 255, 0.06);
`;

const Brand = styled.button`
  appearance: none;
  border: 0;
  width: 100%;
  padding: 6px 8px 22px;
  display: flex;
  align-items: center;
  gap: 10px;
  color: #fff;
  background: transparent;
  cursor: pointer;
  font-size: 18px;
  letter-spacing: -0.35px;
  text-align: left;
`;

const BrandMark = styled.span`
  color: var(--ff-accent);
  line-height: 0;
`;

const PrimaryAction = styled(Button)`
  width: 100%;
  height: 42px;
  border-radius: 9px !important;
  justify-content: center;
  font-weight: 600;
`;

const QuickActions = styled.div`
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px;
  padding: 8px 0 18px;
`;

const QuickAction = styled(Button)`
  width: 100%;
  min-height: 34px;
  justify-content: flex-start !important;
  border-radius: 8px !important;
  color: #aeb8c9 !important;
  font-size: 13px;

  &:hover {
    background: rgba(255, 255, 255, 0.07) !important;
    color: #fff !important;
  }
`;

const NavLabel = styled.div`
  padding: 0 10px 7px;
  color: #667085;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
`;

const NavMenu = styled.nav`
  display: grid;
  gap: 3px;
`;

const NavItem = styled.button<{ $active: boolean }>`
  width: 100%;
  height: 42px;
  padding: 0 10px;
  display: flex;
  align-items: center;
  gap: 11px;
  border: 0;
  border-radius: 8px;
  color: ${(props) => (props.$active ? '#fff' : '#aeb8c9')};
  background: ${(props) => (props.$active ? 'rgba(99, 102, 241, 0.20)' : 'transparent')};
  box-shadow: ${(props) => (props.$active ? 'inset 2px 0 0 var(--ff-accent)' : 'none')};
  cursor: pointer;
  font-size: 14px;
  font-weight: ${(props) => (props.$active ? 600 : 500)};
  text-align: left;
  outline: none;

  span { display: inline-flex; font-size: 17px; }
  &:hover { background: ${(props) => (props.$active ? 'rgba(99, 102, 241, 0.24)' : 'rgba(255, 255, 255, 0.06)')}; color: #fff; }
  &:focus-visible { outline: 2px solid #aeb8f5; outline-offset: 2px; }
`;

const SidebarFooter = styled.div`
  margin-top: auto;
  padding-top: 12px;
  display: grid;
  gap: 5px;
  border-top: 1px solid rgba(255, 255, 255, 0.07);
`;

const AccountButton = styled.button`
  width: 100%;
  padding: 9px 8px;
  display: flex;
  align-items: center;
  gap: 9px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: #f8fafc;
  text-align: left;
  cursor: pointer;

  &:hover { background: rgba(255, 255, 255, 0.06); }
  .semi-avatar { background: #475569; color: #fff; }
`;

const AccountCopy = styled.div`
  min-width: 0;
  display: grid;
  gap: 2px;
  .semi-typography { color: inherit; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .semi-typography-secondary { color: #8e9aad; font-size: 12px; }
`;

const ContentArea = styled.main`
  min-width: 0;
  min-height: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--ff-page);
`;
