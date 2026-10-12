import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useSyncExternalStore } from 'react';

import {
  getFfEmbedStatus,
  setFfEmbedNavigateHandler,
  subscribeFfEmbed,
} from './client';

/** 订阅内嵌状态（宿主握手 / 降级都会触发重渲染）。 */
export function useFfEmbedStatus() {
  return useSyncExternalStore(subscribeFfEmbed, getFfEmbedStatus);
}

/** 宿主 chrome（flow 自己的侧栏 / 品牌等）是否可见：独立与降级可见，其余隐藏。 */
export function useFfEmbedChromeVisible(): boolean {
  return useSyncExternalStore(subscribeFfEmbed, () => {
    const state = getFfEmbedStatus().state;
    return state === 'standalone' || state === 'degraded';
  });
}

/**
 * 降级横幅：版本不匹配 / 宿主 origin 不在白名单 / 身份交换失败时在界面明示。
 *
 * 为什么必须有它：内嵌形态降级成独立模式如果只写日志，用户看到的是「登录页怎么又出来了」
 * 这种无从下手的现象；把原因摆在页面上，连同「已按独立模式运行」一起说清楚。
 */
/**
 * 宿主 → flow 的站内导航桥：宿主侧栏（内嵌形态下 flow 自己的侧栏隐藏）点
 * 「工作流 / 任务中心」时发 `ff-embed/navigate`，这里用 react-router 执行跳转。
 * 必须挂在 BrowserRouter 内。
 */
export function FfEmbedNavigateBridge() {
  const navigate = useNavigate();
  useEffect(() => {
    setFfEmbedNavigateHandler(navigate);
    return () => {
      setFfEmbedNavigateHandler(() => {});
    };
  }, [navigate]);
  return null;
}

/**
 * 内嵌会话桥：宿主身份交换成功（状态进入 embedded）后，若此刻还停在登录页，
 * 立即送回工作区。
 *
 * 为什么需要它：首帧渲染往往**快于**交换往返，`LoginRegisterPage` 的登录态检查
 * 只在挂载时跑一次；交换把 token 写进本地存储时页面已经渲染在 /login 上，
 * 没有这一跳就会停在登录页——身份其实已经换好了，只是没人把这件事告诉路由。
 * 必须挂在 BrowserRouter 内。
 */
export function FfEmbedSessionBridge() {
  const status = useFfEmbedStatus();
  const navigate = useNavigate();
  const location = useLocation();
  useEffect(() => {
    if (status.state === 'embedded' && location.pathname === '/login') {
      navigate('/', { replace: true });
    }
  }, [status.state, location.pathname, navigate]);
  return null;
}

export function FfEmbedNotice() {
  const status = useFfEmbedStatus();
  if (status.state !== 'degraded') return null;
  return (
    <div className="ff-embed-notice" role="status">
      <strong>已按独立模式运行</strong>
      <span>{status.reason}</span>
    </div>
  );
}
