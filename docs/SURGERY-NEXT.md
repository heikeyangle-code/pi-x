# SURGERY-NEXT — 下一批删除/改造执行单（CI 绿后按序执行）

> 2026-09 更新：S1/S3 完成；S5a 单本机种子、S5b 机器 UI 收敛完成（见 STATUS "S5b 单机收敛完成"）；
> SSH(S2)/FCM(S4) 已随 S5 单本机收敛一并删除（S4 推送中继随 pi-only 已移除）；
> 整体状态见 docs/STATUS.md；M2 引擎接线推进见 ENGINE-INTEGRATION / PI-ONLY-STATUS。
> 本执行单剩余项均已勾销，新手术清单见 STATUS "下一步主线"。

> 前置：等 `.github/workflows/ci.yml` 首跑绿（或按报错修完当前盲改残留）。
> 原则：一批一提交；每批 grep 零残留；禁止引入 Aether/GPL 代码。

## S1. macOS 原生 App 横幅 — ✅ 已完成（b7d2467）

- 删 `lib/features/session_list/widgets/macos_native_app_banner.dart`
- `home_content.dart`：移除 import 与横幅构建块（含 `_macosBannerDismissed` 状态与 `ValueKey('macos_native_app_banner*')` 渲染点，约 lines 230–430 区）
- `session_list_screen.dart:265`：移除 `'macos_native_app_banner.dismissed'` 偏好键逻辑
- `test/home_content_skeleton_test.dart`：删除引用该横幅的 2 个测试段
- 验收：`grep -rn "macos_native_app_banner\|MacOSNativeAppBanner" lib test` 为空；analyze 绿

## S2. SSH 隧道/启动 — ⏳ 并入 S5（与机器模型深度耦合，随单本机收敛一起删）

- 服务：删 `services/ssh_bridge_tunnel_service.dart`、`services/ssh_startup_service.dart`
- `main.dart`：移除 ssh service 构造/注入（lines ~133–142 区，含 wsUrlResolver/httpBaseUrlResolver 接线）——注意 bridge_service 的 resolver 参数需同步移除
- `machine_manager_cubit.dart`/`machine_edit_sheet.dart`：移除 ssh 字段/流程（edit sheet 里的 SSH 表单区）
- 测试：删 `test/ssh_*_smoke_test.dart`、`ssh_startup_service_test.dart`、`ssh_jump_smoke_test.dart`、`ssh_private_key_smoke_test.dart`；`machine_edit_sheet_test`/`machine_manager_cubit_test` 相应段
- 验收：grep `ssh_`（除 pubspec 无关项）为空

## S3. 更新横幅（UI 层）— ✅ 已完成；服务层 dormant（S3b，M2 再清）
> 已删：两个 banner widget、home_content/session_list/appbar/settings 全部 UI 引用；`app_update_service`/`bridge_latest_version_service` 与 cubit 的 refreshLatestBridgeVersion 保留为 dormant，随 M2 引擎管道替换。

- 删 `widgets/app_update_banner.dart`、`widgets/bridge_update_banner.dart`、`services/app_update_service.dart`、`services/bridge_latest_version_service.dart`
- `home_content.dart`：移除两横幅构建与 `_updateBannerDismissed` 状态
- `session_list_screen.dart`：移除 `AppUpdateService.instance.*` 调用（~399–408、1888 区）与刷新逻辑（~526、800 区 `refreshLatestBridgeVersionIfStale`）
- `session_list_app_bar.dart`/`settings_screen.dart`/`machine_manager_cubit.dart` 中相关引用同步清
- 验收：grep 四符号为空；后续"引擎更新提示"由 Pi X 更新管道重新实现

## S4. FCM 推送 — ⏳ 并入 S5/M2（push 状态挂在 machine 粒度上，与机器模型一起重构；本地通知保留）

- `main.dart`：删 firebase_messaging import、`_firebaseMessagingBackgroundHandler`、FcmService 初始化和注册
- `settings_cubit.dart`：删推送开关相关状态/逻辑（保留本地通知偏好）
- 删 `services/fcm_service.dart`；pubspec 移除 `firebase_messaging`/`firebase_core`（若仅此用途）
- AndroidManifest：删 firebase 相关 meta-data（若有）
- 测试：删 `fcm_service_test.dart`、`settings_cubit_push_test.dart` 及引用 Fcm 的测试段
- 验收：grep `firebase_messaging|FcmService|fcm_` 为空

## S5. 机器管理收敛 → 单本机（M2 引擎里程碑主刀）

- `machine_manager_service.dart`：首启自动种子"本机 127.0.0.1:8765"（host=127.0.0.1, ssl off）
- 隐藏 UI：machine_card/list 的 增/改/删/收藏/启动远程 操作收敛为只连/只停本机；`machine_edit_sheet` 入口删除（保留内部逻辑改造成"本机设置"）
- `settings_screen.dart` 连接区：改为本地引擎状态 + 端口/自启 设置
- `connection_url_parser`/`bridge_endpoint_probe`：随单本机收敛删除
- 验收：无"添加主机"路径；会话启动只依赖本机
