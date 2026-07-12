/**
 * futureFlow 应用入口
 * 路由：/login → 登录页 | / → 主布局(工作流列表) | /canvas/:id → 画布编辑器
 */

import { createRoot } from 'react-dom/client';
import { unstableSetCreateRoot } from '@flowgram.ai/form-materials';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';

import { LoginRegisterPage } from './pages/login';
import { MainLayout } from './pages/main-layout';
import { WorkflowListPage } from './pages/workflow-list';
import { ProfilePage } from './pages/profile';
import { CanvasPage } from './pages/canvas';
import { isLoggedIn } from './utils/auth';

/**
 * React 18/19 polyfill for form-materials
 */
unstableSetCreateRoot(createRoot);

function PrivateRoute({ children }: { children: React.ReactNode }) {
  if (!isLoggedIn()) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}

const app = createRoot(document.getElementById('root')!);

app.render(
  <BrowserRouter>
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
        <Route path="profile" element={<ProfilePage />} />
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
