import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSyncExternalStore } from 'react';

import {
  getFfEmbedStatus,
  setFfEmbedNavigateHandler,
  shouldHideBrand,
  subscribeFfEmbed,
} from './client';

/** 订阅内嵌状态（宿主握手 / 降级都会触发重渲染）。 */
export function useFfEmbedStatus() {
  return useSyncExternalStore(subscribeFfEmbed, getFfEmbedStatus);
}

/** 内嵌形态且宿主没要求保留品牌 → 隐藏 flow 自己的 logo / 名字。 */
export function useFfEmbedBrandHidden(): boolean {
  return useSyncExternalStore(subscribeFfEmbed, shouldHideBrand);
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
