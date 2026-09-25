# @futureflow/ff-embed-host-sdk

ff-embed/v1 **宿主端 SDK**：把 futureFlow 嵌进任意宿主应用（iframe + 握手 + 身份注入 + 事件），一个调用完成协议细节。

协议与安全模型见 flow 仓 `docs/ff-embed-v1.md` 与《flow插件集成规划》§3/§6。

## 安装

```bash
pnpm add @futureflow/ff-embed-host-sdk
```

## 最小接入

```ts
import { mountFlowEmbed } from "@futureflow/ff-embed-host-sdk";

const embed = mountFlowEmbed({
  container: document.getElementById("flow-root")!,
  frontendUrl: "http://127.0.0.1:8090",            // flow 前端地址（origin）
  getIdentity: async () => {
    // 用你自己的会话换取宿主侧令牌（flow 网关回调你的 /api/flow/host/identity 验签）
    return { hostToken: await yourSessionToken() };
  },
  onNavigate: (path) => yourRouter.push(path),      // 可选：flow 请求宿主侧导航
  onRunEvent: (event) => console.log(event),        // 可选：运行事件（带 seq）
  onError: (reason) => console.warn(reason),        // 可选：flow 上报的错误
});

// 卸载
embed.destroy();
```

## 服务端配套（宿主后端）

- `POST /api/flow/host/identity`：验证宿主会话令牌，返回 `{subject, displayName?, email?}`（参考实现见 KenFutWork 主仓 `apps/server/src/http/flow-host.ts`）。
- 可选三缝：凭证下发 / 计费三段事务 / 事件透出（见协议文档 §4.2–4.4）。

## 开发

```bash
pnpm test   # 离线冒烟（jsdom 模拟 iframe 握手 / 安全边界 / 生命周期）
pnpm build  # 双格式：dist/esm (import) + dist/cjs (require)
```
