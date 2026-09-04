# REMOTE-AUDIT — 远端操控功能盘点与处置（Pi X 本地化）

范围：apps/mobile（Flutter UI + 服务）+ packages/bridge（Node）。原则：远端操控/遥控类功能删除或本地化；本地仍有意义的（断线重连、审批流）保留；纯本地化后需要补的 UI 列入"新增"。

## 已处置 ✅

> CI：`.github/workflows/ci.yml`（push/PR 自动：flutter analyze/test + debug APK + bridge tsc）——编译把关交给 CI。

| # | 功能 | 处置 | 说明 |
|---|---|---|---|
| 1 | QR 扫码连接（`qr_scan_screen.dart` + 路由 + 按钮链 + 桌面测试） | **删** | commit 21a7b72，零残留 |
| 2 | Setup guide 远端 4 页（bridge 搭建/扫码连接/Tailscale/launchd 自启） | **删** | 替换为 `GuidePageLocalRuntime`，引导 3 页：About → 本机运行 → Ready |
| 3 | mDNS 服务器发现 | **删** | commit 305b3cc：UI widget/cubit/services/main 注册全清；桥侧 mdns/bonjour 待 Pi Host 里程碑 |
| 4 | 机器/主机管理 UI | **收敛为单本机** | `machine_manager_service/cubit` 只种子/跟踪一台 `127.0.0.1:8765`；删 增/改/删/收藏/发现 交互（S5b） |
| 5 | SSH 隧道/启动/跳板 | **删** | `ssh_bridge_tunnel_service`、`ssh_startup_service`、机器编辑表单 SSH 字段、Settings 更新引导弹层 全清 |
| 6 | 连接 URL 解析/端点探测 | **删** | `connection_url_parser.dart`、`bridge_endpoint_probe.dart` + 测试；本地固定 ws://127.0.0.1 |
| 7 | 远程推送 | **删** | `fcm_service.dart` + pubspec firebase_messaging + 设置项 + `fcm*` l10n 键 |
| 8 | 会话分享链接 | **保留（本地）** | deep link 仅 `ccpocket://session/<id>`（`session_link_parser`）；远程 `connect?url=`/`ws://IP` deep link 已删 |
| 9 | 远端更新横幅/Setup guide 残留 | **删/改造** | macOS/更新横幅移除；Bridge 更新卡收敛为"本机引擎版本信息"（无 SSH 引导）；App 更新走自己的管道 |
| 10 | 断线重连/离线队列 | **保留** | 本地引擎进程重启/后台回收时仍有用 |

## 尚存（非遥控、另行处理）

| # | 功能 | 位置 | 处置 | 备注 |
|---|---|---|---|---|
| 11 | 商业远程服务 | RevenueCat/Supporter、Shorebird OTA | **待定** | 非"远端操控"，M4 前再清 |
| 12 | App 更新管道 | `app_update_service.dart`、`bridge_latest_version_service.dart` | **后续** | 自有版本跟随管道另行设计 |

## 桥侧（packages/bridge，Pi Host 里程碑处理）

mdns/bonjour、qrcode、firebase-auth、push-relay、proxy/socks、sharp(原生依赖)、distribution(远程装 agent)、codex-*/claude-provider → 替换为 pi-provider（进程内嵌 pi AgentSession）。协议层保留：`approve/reject/answer/permission_request`（对接 pi ctx.ui 审批）、`stream_delta`、session/worktree/git。

## Pi X 需新增的 UI（100% pi 兼容清单）

1. Provider/模型选择器（pi 目录，含订阅登录设备码流，WebView 承接 OAuth）
2. thinking 层级切换与独立渲染块
3. 设置页（pi settings schema 驱动；当前远端"连接"区已移除）
4. 会话树/分支浏览（pi JSONL，`/tree` 等价物）
5. 扩展/技能/提示模板/主题管理（包安装 UI：npm/git/本地）
6. 项目信任对话框（pi trust.json 语义）
7. 工具调用审批卡 + 可折叠输出（协议已支持）
8. 用量/成本展示（pi usage 事件）
9. 本地引擎状态/启停卡（`LocalEngineCard` 已加，待接真状态）
10. 终端页（可选：xterm.dart + 本地 PTY）

## 状态更新（2026-09）：S5b 单机收敛完成

- 已删：QR 扫码、Setup guide 远端页、macOS/更新横幅、mDNS、非安卓平台目录、fastlane、SSH 隧道/启动/跳板、FCM、远程连接 deep link、远端更新 SSH 引导弹层。
- 已收敛：机器管理 → 单本机种子（127.0.0.1:8765）；Settings "连接/机器" 区改为本机引擎状态 + Bridge 版本信息。
- 已清理：`fcm*`、`machineEdit*`、`sshPassword`、`scanQrCode`、`server*`、`setupStep*`、`push*` 等约 85 个死 l10n 键（4 语言 arb 一致删除，gen-l10n 重生成）。
- 验证：`dart run build_runner build`、`flutter analyze`（无 error/warning，仅上游 info 基线）、`flutter test`（1664 全绿）、`packages/bridge` `tsc --noEmit` 全过。
- S5b 之后与 M2 引擎接线同步推进（见 docs/STATUS.md）。