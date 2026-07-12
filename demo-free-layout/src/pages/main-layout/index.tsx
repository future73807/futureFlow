/**
 * futureFlow 主布局
 * 深色侧边栏: Logo + 导航 + 用户信息卡片 + 退出按钮
 */

import { useState, useCallback, useEffect } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { Avatar, Typography, Button } from '@douyinfe/semi-ui';
import {
  IconApps,
  IconUser,
  IconExit,
  IconSetting,
} from '@douyinfe/semi-icons';
import styled from 'styled-components';
import {
  isLoggedIn,
  removeToken,
  fetchProfile,
} from '../../utils/auth';

const NAV_ITEMS = [
  { key: '/', label: '工作流列表', icon: <IconApps />, adminOnly: false },
  { key: '/profile', label: '个人中心', icon: <IconUser />, adminOnly: false },
  { key: '/admin', label: '管理员后台', icon: <IconSetting />, adminOnly: true },
];

export const MainLayout = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [user, setUser] = useState<any>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!isLoggedIn()) {
      navigate('/login', { replace: true });
      return;
    }
    fetchProfile().then((u) => {
      if (u) {
        setUser(u);
        setTick((t) => t + 1);
      } else {
        navigate('/login', { replace: true });
      }
    });
  }, [navigate]);

  const handleLogout = useCallback(() => {
    removeToken();
    navigate('/login', { replace: true });
  }, [navigate]);

  const currentPath = location.pathname === '/' ? '/' : location.pathname;

  return (
    <LayoutWrapper>
      <Sidebar>
        {/* Logo 区域 */}
        <SidebarHeader>
          <LogoMark>
            <svg width="32" height="32" viewBox="0 0 48 48" fill="none">
              <rect width="48" height="48" rx="10" fill="#4834d4" />
              <path
                d="M14 18 L24 14 L34 18 L34 30 L24 34 L14 30 Z"
                stroke="white"
                strokeWidth="2.5"
                fill="none"
                strokeLinejoin="round"
              />
              <circle cx="24" cy="24" r="3" fill="white" />
            </svg>
          </LogoMark>
          <Typography.Title heading={5} style={{ color: '#fff', margin: 0 }}>
            futureFlow
          </Typography.Title>
        </SidebarHeader>

        {/* 导航菜单 */}
        <NavMenu>
          {NAV_ITEMS.filter((item) => !item.adminOnly || user?.role === 'admin').map((item) => (
            <NavItem
              key={item.key}
              $active={currentPath === item.key}
              onClick={() => navigate(item.key)}
            >
              <span className="nav-icon">{item.icon}</span>
              <span className="nav-label">{item.label}</span>
            </NavItem>
          ))}
        </NavMenu>

        {/* 底部用户信息 + 退出 */}
        <SidebarFooter>
          <UserCard>
            <Avatar
              size="medium"
              style={{ background: 'linear-gradient(135deg, #4834d4, #6c5ce7)', flexShrink: 0 }}
            >
              {user?.username?.[0]?.toUpperCase() || 'U'}
            </Avatar>
            <UserInfo>
              <Typography.Text strong style={{ color: '#fff', fontSize: 14 }}>
                {user?.username || '...'}
              </Typography.Text>
              <Typography.Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 12 }}>
                {user?.vipLevel?.toUpperCase() || 'FREE'} · ¥{user?.balance?.toFixed(2) || '0.00'}
              </Typography.Text>
            </UserInfo>
          </UserCard>
          <Button
            block
            size="default"
            theme="borderless"
            icon={<IconExit />}
            onClick={handleLogout}
            style={{
              color: 'rgba(255,255,255,0.5)',
              justifyContent: 'flex-start',
              padding: '8px 12px',
            }}
          >
            退出登录
          </Button>
        </SidebarFooter>
      </Sidebar>

      <ContentArea>
        <Outlet />
      </ContentArea>
    </LayoutWrapper>
  );
};

const LayoutWrapper = styled.div`
  display: flex;
  height: 100vh;
  overflow: hidden;
`;

const Sidebar = styled.div`
  width: 240px;
  background: #1a1d29;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  border-right: 1px solid rgba(255, 255, 255, 0.06);
`;

const SidebarHeader = styled.div`
  padding: 20px 20px;
  display: flex;
  align-items: center;
  gap: 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
`;

const LogoMark = styled.div`
  display: flex;
  align-items: center;
`;

const NavMenu = styled.nav`
  flex: 1;
  padding: 16px 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
`;

const NavItem = styled.div<{ $active: boolean }>`
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 11px 16px;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.15s ease;
  color: ${(props) => (props.$active ? '#fff' : 'rgba(255,255,255,0.55)')};
  background: ${(props) => (props.$active ? 'rgba(72, 52, 212, 0.2)' : 'transparent')};
  font-size: 14px;
  font-weight: ${(props) => (props.$active ? 600 : 400)};

  .nav-icon {
    display: flex;
    align-items: center;
    font-size: 18px;
  }

  &:hover {
    background: rgba(255, 255, 255, 0.06);
    color: #fff;
  }

  ${(props) =>
    props.$active &&
    `
    &::before {
      content: '';
      position: absolute;
      left: 0;
      width: 3px;
      height: 20px;
      background: #4834d4;
      border-radius: 0 3px 3px 0;
    }
  `}
`;

const SidebarFooter = styled.div`
  padding: 16px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  display: flex;
  flex-direction: column;
  gap: 12px;
`;

const UserCard = styled.div`
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.04);
`;

const UserInfo = styled.div`
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow: hidden;
`;

const ContentArea = styled.div`
  flex: 1;
  overflow: hidden;
  background: #f5f6f8;
  display: flex;
  flex-direction: column;
  min-height: 0;
`;
