/**
 * futureFlow 应用入口
 * 路由：/login → 登录页 | / → 主布局(工作流列表/插件商店/任务中心) | /canvas/:id → 画布编辑器
 */

import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { unstableSetCreateRoot } from '@flowgram.ai/form-materials';
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Toast } from '@douyinfe/semi-ui';

import { LoginRegisterPage } from './pages/login';
import { MainLayout } from './pages/main-layout';
import { WorkflowListPage } from './pages/workflow-list';
import { PluginStorePage } from './pages/plugin-store';
import { TaskCenterPage } from './pages/task-center';
import { ProfilePage } from './pages/profile';
import { AdminPage } from './pages/admin';
import { CanvasPage } from './pages/canvas';
import { isLoggedIn, getUser } from './utils/auth';
import { AUTH_EXPIRED_EVENT } from './utils/api';
import { applyTheme, resolveInitialTheme } from './utils/theme';
import { initFfEmbed } from './embed/client';
import { FfEmbedNotice } from './embed/react';

/**
 * React 18/19 polyfill for form-materials
 */
unstableSetCreateRoot(createRoot);

// 在首个组件渲染前套用主题，避免浅色闪烁。
applyTheme(resolveInitialTheme());

// 宿主适配（ff-embed）：被宿主 iframe 嵌进来时握手换会话、随宿主视觉；
// 不在宿主里 / 网关为独立模式时它什么也不做（内部已判）。
void initFfEmbed();

function PrivateRoute({ children }: { children: React.ReactNode }) {
  if (!isLoggedIn()) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}

/** 管理员路由:需要 role === 'admin' */
function AdminRoute({ children }: { children: React.ReactNode }) {
  const user = getUser();
  if (!isLoggedIn() || user?.role !== 'admin') {
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
}

function AuthExpiredWatcher() {
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    const handleAuthExpired = () => {
      if (location.pathname !== '/login') {
        Toast.warning('登录已过期，请重新登录');
      }
      navigate('/login', { replace: true });
    };
    window.addEventListener(AUTH_EXPIRED_EVENT, handleAuthExpired);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, handleAuthExpired);
  }, [location.pathname, navigate]);

  return null;
}

const app = createRoot(document.getElementById('root')!);

app.render(
  <BrowserRouter>
    <AuthExpiredWatcher />
    <FfEmbedNotice />
    <Routes>
      <Route path="/login" element={<LoginRegisterPage />} />
      <Route
        path="/"
        element={
          <PrivateRoute>
            <MainLayout />
          </PrivateRoute>
        }
      >
        <Route index element={<WorkflowListPage />} />
        <Route path="plugins" element={<PluginStorePage />} />
        <Route path="plugins/:pluginId" element={<PluginStorePage />} />
        <Route path="tasks" element={<TaskCenterPage />} />
        <Route path="profile" element={<ProfilePage />} />
        <Route
          path="admin"
          element={
            <AdminRoute>
              <AdminPage />
            </AdminRoute>
          }
        />
      </Route>
      <Route
        path="/canvas/:id"
        element={
          <PrivateRoute>
            <CanvasPage />
          </PrivateRoute>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  </BrowserRouter>,
);
