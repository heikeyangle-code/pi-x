# Pi X — AGENTS.md

Pi X：纯本地安卓 AI 编码 Agent。UI/协议层源自 CC Pocket（MIT），引擎为 pi（MIT）。
**只做安卓。** 本仓库是独立产品仓库（非 GitHub fork）；CC Pocket 上游通过 `upstream` remote 合并/挑拣更新（见 `UPSTREAM.md`）。

## 关键决策（不要推翻）

- 引擎：pi（`@earendil-works/pi-coding-agent`），进程内嵌 AgentSession（Pi Host 桥），版本跟随管道热换（engines/<ver>），不走 git merge。
- UI：CC Pocket 本地化改造——已删/收敛完成：QR 扫码、Setup guide 远端页、fastlane 商店资产、mDNS 发现、机器管理 UI → 单本机(127.0.0.1)、SSH 隧道/启动、远端更新横幅、FCM 推送、远程连接 deep link → 仅会话分享（见 `docs/REMOTE-AUDIT.md`）。
- 许可红线：只引入 MIT/Apache-2.0；禁止 Aether(GPL) / Operit(LGPL) / GetStream(非 OSI) 代码。
- 审批流：pi 扩展的 ctx.ui（confirm/select/input）由 Pi Host 注入的 ExtensionUIContext 映射为 CC Pocket 协议 approve/reject 消息。
- 只做安卓：构建/CI/文档均按 Android 目标；ios/macos/linux/windows/web 源码保留备用但不在工作范围。

## 目录

- `apps/mobile` — Flutter 客户端（Android 目标）
- `packages/bridge` — Node Bridge（本地化后 = Pi Host）
- `docs/` — 审计/计划（REMOTE-AUDIT.md、PROJECT-PLAN.md）
- `UPSTREAM.md` — 上游基线跟踪

## 验证（在装有 Flutter 的机器上）

```bash
cd apps/mobile && dart run build_runner build && dart analyze && flutter test
cd packages/bridge && npx tsc --noEmit -p tsconfig.json
```
