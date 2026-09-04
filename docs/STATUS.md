# STATUS — 项目状态与已知问题（2026-09 更新）

## 已验证（真实执行）

- pi 0.84.4 引擎包本机安装/启动成功；`--mode rpc` 官方 JSONL 协议真实往返 OK
  （get_commands / get_state）。协议帧与 `packages/bridge/src/pi-host/pi-rpc.ts` 逐条核对一致。
- EngineProcess（子进程+JSONL+审批桥）模块级验证通过。
- EnginePool（每项目一进程+空闲回收+回调）验证通过（含请求往返）。
- 引擎分发策略定稿：基线打进 APK + 新版本后台热更（npm/pi.dev 双源 + sha256 + 冒烟）。
- UI 手术：QR 扫码、Setup guide 远端页、mDNS、macOS/更新横幅、非安卓平台目录、fastlane
  已删；单本机种子已加；Pi X 品牌 + CI（android analyze/test/apk、bridge tsc、engine-smoke）。

## 已知问题（open）

1. **Gateway 上下文 spawn 秒退（安卓沙箱）**：引擎经 `PiGateway → EnginePool` spawn 时收到
   SIGTERM（裸 EngineProcess/EnginePool 不受影响，同参数）。疑似 bun-ELF 在该模拟环境的
   spawn 竞态。缓解：boot-guard（300ms 存活检查 + ≤3 次重启）已入代码。
   **裁决等待 `engine-smoke` CI 任务**（ubuntu + 真实 pi）——若 CI 也复现则是真 bug，否则为沙箱怪癖。
2. **index.ts 全链路拉 sharp**：`PI_HOST=1` 走 `packages/bridge/src/index.ts` 时顶层 import
   链（image/media store）会加载 sharp（libvips 原生，安卓无预编译）→ 安卓端应使用
   **专用入口 `packages/bridge/src/pi-host-entry.ts`**（只依赖 pi-host/server，无 sharp）。
3. **Flutter analyze 基线**：上游自带大量 lint info → CI 用 `flutter analyze --no-fatal-infos`；
   我们的删除手术引入的 warning 已清零（按 CI 反馈迭代修完）。

## CI 任务

| 任务 | 作用 |
|---|---|
| android | build_runner → analyze(--no-fatal-infos) → test → debug APK |
| bridge | npm ci → tsc --noEmit |
| engine-smoke | ubuntu 装真实 pi → EngineProcess get_state 往返 |

## 下一步主线

1. 看 engine-smoke / android CI 结果，红则修
2. App ⇄ PiHost 的 wire client（Flutter 消费 envelope）→ 真机/模拟器端到端
3. M1 页面：Provider/模型管理（models.json 表单）、命令面板（get_commands）、扩展管理
4. 引擎包运行时（APK 内置基线 + 热更）落地 ENGINE-BUNDLE 配方

## Termux 快速跑通（开发路径，不等自带运行时）
`scripts/termux-setup.sh`：手机装 Termux → node22 + pi 引擎 → `pi-host-entry.js` 监听
127.0.0.1:8765 → App 连本机种子。UI/审批/会话树全链路当天可验证；
自带运行时（自编译 Node22 等）作为第二步，见 DECISIONS #12。
