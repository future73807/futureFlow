import { useSyncExternalStore } from 'react';

import { getFfEmbedStatus, shouldHideBrand, subscribeFfEmbed } from './client';

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
