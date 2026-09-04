# REMOTE-AUDIT — 远端操控功能盘点与处置（Pi X 本地化）

范围：apps/mobile（Flutter UI + 服务）+ packages/bridge（Node）。原则：远端操控/遥控类功能删除或本地化；本地仍有意义的（断线重连、审批流）保留；纯本地化后需要补的 UI 列入"新增"。

## 已处置 ✅

> CI：`.github/workflows/ci.yml`（push/PR 自动：flutter analyze/test + debug APK + bridge tsc）——编译把关交给 CI。

| # | 功能 | 处置 | 说明 |
|---|---|---|---|
| 1 | QR 扫码连接（`qr_scan_screen.dart` + 路由 + 按钮链 + 桌面测试） | **删** | commit 21a7b72，零残留 |
| 2 | Setup guide 远端 4 页（bridge 搭建/扫码连接/Tailscale/launchd 自启） | **删** | 替换为 `GuidePageLocalRuntime`（commit 待记），引导 3 页：About → 本机运行 → Ready |

## 计划处置（按优先级）

| # | 功能 | 位置 | 处置 | 备注 |
|---|---|---|---|---|
| 3 | mDNS 服务器发现 | （同前）| **删 ✅** | commit 305b3cc：UI widget/cubit/services/main 注册全清；桥侧 mdns/bonjour 待 Pi Host 里程碑 |
| 4 | 机器/主机管理 UI | `widgets/machine_{list,card,edit_sheet}.dart`、ConnectForm 机器区、`providers/machine_manager_cubit.dart`、`services/machine_manager_service.dart` | **本地化收敛** | 保留"单一本机(127.0.0.1)"模型：默认自建本地项，删 增/改/收藏/发现 交互 |
| 5 | SSH 隧道/启动 | `services/ssh_bridge_tunnel_service.dart`、`services/ssh_startup_service.dart` 及其 UI 引用 | **删** | 本地无远端主机 |
| 6 | 连接 URL 解析/端点探测 | `services/connection_url_parser.dart`、`services/bridge_endpoint_probe.dart` | **删** | 本地固定 ws://127.0.0.1 |
| 7 | 远端更新横幅 | `widgets/{app_update,bridge_update}_banner.dart`、`home_content.dart` 横幅区、`services/app_update_service.dart`、`bridge_latest_version_service.dart` | **删/改造** | App 更新走我们自己的管道（后续）；横幅先行移除 |
| 8 | 会话分享链接 | `features/session_link/`（勘察中） | **待定** | 若依赖云端 relay → 删；若本地导入/导出 → 保留改造 |
| 9 | 远程推送 | FCM/`services/{fcm,notification}_service.dart`、`functions/`(仓库根，云端) | **删 UI/服务引用** | 本地通知如需另行实现；functions 不随 App 分发 |
| 10 | 商业远程服务 | RevenueCat/Supporter、Shorebird OTA、macOS 原生横幅 | **删/待定** | 非"远端操控"，M4 前清理；macos_native_app_banner 先删 |
| 11 | 断线重连/离线队列 | `reconnect_banner`、`session_reconnect_banner`、`offline_pending_action` | **保留** | 本地引擎进程重启/后台回收时仍有用 |

## 桥侧（packages/bridge，Pi Host 里程碑处理）

mdns/bonjour、qrcode、firebase-auth、push-relay、proxy/socks、sharp(原生依赖)、distribution(远程装 agent)、codex-*/claude-provider → 替换为 pi-provider（进程内嵌 pi AgentSession）。协议层保留：`approve/reject/answer/permission_request`（对接 pi ctx.ui 审批）、`stream_delta`、session/worktree/git。

## Pi X 需新增的 UI（100% pi 兼容清单）

1. Provider/模型选择器（pi 目录，含订阅登录设备码流，WebView 承接 OAuth）
2. thinking 层级切换与独立渲染块
3. 设置页（pi settings schema 驱动；当前远端"连接"区移除）
4. 会话树/分支浏览（pi JSONL，`/tree` 等价物）
5. 扩展/技能/提示模板/主题管理（包安装 UI：npm/git/本地）
6. 项目信任对话框（pi trust.json 语义）
7. 工具调用审批卡 + 可折叠输出（协议已支持）
8. 用量/成本展示（pi usage 事件）
9. 本地引擎状态/启停卡（`LocalEngineCard` 已加，待接真状态）
10. 终端页（可选：xterm.dart + 本地 PTY）

## 状态更新（2026-09）：UI 手术收尾 + 引擎接入进展
- 已删：QR 扫码、Setup guide 远端页、macOS/更新横幅、mDNS、非安卓平台目录、fastlane。
- 已加：单本机种子（127.0.0.1:8765）、Pi X 品牌、CI（android/bridge/engine-smoke）。
- S5 剩余（机器增改删 UI 收敛、SSH/FCM 深删）与 M2 引擎接线同步推进（见 docs/STATUS.md）。

## 本轮核查的 Flutter 死代码落点（待 CI/有 Flutter 工具链的环境执行）
> 交待在沙箱内无法跑 flutter analyze/dart pub get，以下改动必须由 CI（.github/workflows/ci.yml 的 android 任务）或本机 Flutter 编译把关后落地，勿在无工具链环境盲删。

**纯远程残留（删除）**：`services/ssh_bridge_tunnel_service.dart`、`services/ssh_startup_service.dart`、
`services/machine_manager_service.dart`、`providers/machine_manager_cubit.dart`（+#freezed）、
`services/connection_url_parser.dart`、`services/bridge_endpoint_probe.dart`、`services/fcm_service.dart`、
`features/session_link/`（整套，含 session_link_cubit/state/widgets）、`features/session_list/` 中
`workspace_shell_screen.dart`、`widgets/connect_form.dart` 及 `session_list_screen.dart` 里的连接/SSH 分支。
引用方需同步收敛：`main.dart`（ssh/fcm/deep_link 初始化）、`router/app_router.dart`、`features/settings/`
（fcm 设置项）。L10n 清理 `app_{en,zh,ja,ko}.arb` 的 `scanQr/guideConnectionQr/guideConnectionMdns/sshPassword*` 键。

**已确认 0 引用的死文件（可安全删，编译不受影响）**：`lib/services/recording_loader.dart`（自给自足）、
`lib/services/session_runtime_store.dart`（被 `bridge_service.dart:158` `_runtimeStore` 直接引用，**不可删**）。
其余标注存疑的死代码须以 `flutter analyze`/`dart run build_runner` 为准，勿凭 import 猜测。

> 注意：第 4 项"机器管理 UI"建议按 REMOTE-AUDIT 原计划**本地化收敛**而非全删——保留单本机种子的
> `LocalEngineCard` 路径（commit 040beb2 已移除 machine-management 页），仅删增/改/删/收藏交互。
