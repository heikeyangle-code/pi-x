# STATUS — 项目状态与已知问题（2026-09 更新）

## 已验证（真实执行）

- pi 0.84.4 引擎包本机安装/启动成功；`--mode rpc` 官方 JSONL 协议真实往返 OK
  （get_commands / get_state）。协议帧与 `packages/bridge/src/pi-host/pi-rpc.ts` 逐条核对一致。
- EngineProcess（子进程+JSONL+审批桥）模块级验证通过。
- EnginePool（每项目一进程+空闲回收+回调）验证通过（含请求往返）。
- **真实引擎冒烟再确认**：`pi-ab.mjs`（走真实 `PiGateway.handleControl` 全链路）启动
  仅 1 实例、无 boot-guard 重启；`pi-stab.mjs`（EnginePool 直连，key=绝对路径模拟网关）
  连续 5/5 往返成功，0 失败。唯一 SIGTERM（code 143）来自收尾显式 `stopAll()`，符合预期。
- **PiGateway.handleControl RPC 命令面已铺满 pi docs/rpc.md 全部 33 个 client→engine 命令**
  （prompt/steer/follow_up/abort/queue/session/model/thinking/mode/compact/retry/bash/validate/
  stats/export/fork/clone/entries/tree/name/commands 等），新增单测逐条断言全部 success，
  含 bash 的 request-id 关联与 `stop` 语义。
- **PiHost server(ws 传输层) 端到端测试补齐**（`server.test.ts`，真 WS 客户端驱动 fake 引擎）：
  控制往返 envelope、引擎事件向所有订阅 socket 广播、`ui_response` 回传引擎并保持连接可用、
  `apiKey` 鉴权拒连未授权 socket。此前 ws 传输层无任何测试。
- **EngineProcess 自动创建 cwd**：引擎按工作目录组织会话/资源（docs/sessions.md），若客户端传入
  的 projectId/cwd 目录未预建，`spawn` 会 `ENOENT`。现于 spawn 前 `mkdirSync(cwd, {recursive:true})`，
  新增回归单测（深层不存在的 cwd 也能一次往返跑通）——真机"打开新项目"不再需要预建目录。
- **PiGateway surface-file 算子（settings/models/skills）**：补齐 Provider/模型/设置/技能管理
  UI 所需的后端——`get_settings`/`update_settings`、`get_models`/`upsert_model`/`remove_model`/
  `add_model`、`list_skills`/`list_extensions`/`looks_like_skill`。基于 pi 的 `~/.pi/agent`
  纯文件模型（settings.json/models.json/资源目录），`piHome` 可注入隔离。端到端单测覆盖
  settings 持久化往返、自定义 provider 增删、模型列表同步。
- **扩展 UI 回传全链路修复 + 闭环断言**：pi 扩展通过 `extension_ui_request` 请求交互 UI，客户端
  回 `extension_ui_response` 解锁扩展。此前 `server.ts` 只把 `value` 透传给引擎，**丢掉了
  `confirmed` / `cancelled`**——confirm 的 yes/no 与对话框取消永远到不了扩展。现已透传完整
  结果体（select/input/editor→`{value}`|`{cancelled:true}`，confirm→`{confirmed:bool}`|
  `{cancelled:true}`）；fake 引擎新增 `ui_response_seen` 回显，端到端断言 confirmed/cancelled
  真实到达引擎（先前无法验证）。扩展 UI 全量方法（select/confirm/input/editor/notify/
  setStatus/setWidget/setTitle/set_editor_text）经原样透传 1:1 兼容。
- 引擎分发策略定稿：基线打进 APK + 新版本后台热更（npm/pi.dev 双源 + sha256 + 冒烟）。
- UI 手术：QR 扫码、Setup guide 远端页、mDNS、macOS/更新横幅、非安卓平台目录、fastlane
  已删；单本机种子已加；Pi X 品牌 + CI（android analyze/test/apk、bridge tsc、engine-smoke）。
- **S5b 单机收敛完成**：机器管理收敛为只种子/跟踪本机 `127.0.0.1:8765`（删 增/改/删/收藏/SSH/跳板/探测
  与远程连接 deep link，deep link 仅留会话分享）；Settings 连接区改为本机引擎状态+Bridge 版本信息；
  同步清理约 85 个 `fcm*`/`machineEdit*`/`ssh*`/`server*`/`setup*`/`push*` 死 l10n 键（4 语言 arb）。
  验证：`build_runner` + `flutter analyze`（无 error/warning）+ `flutter test`（1664 全绿）+ bridge `tsc` 全过。

## 已知问题（open）

1. **Gateway 上下文 spawn 秒退（安卓沙箱）→ 已定位真因并修复**：早期裸 EP/EPool 不受影响而
   PiGateway 秒退的现象，根因是 `EnginePool` 用对象展开 `{ maxIdleMs: 10min, ...opts }` 时，
   网关传入的 `maxIdleMs: undefined` 覆盖了默认值，`setTimeout(fn, undefined)` 立即触发，
   在 boot-guard 稳定后马上 SIGTERM 新引擎。修复：改为空值合并
   `opts.maxIdleMs ?? DEFAULT_ENGINE_MAX_IDLE_MS`，并新增回归单测
   （`maxIdleMs: undefined` 引擎保持存活、仍可往返）。本机真引擎 A/B 冒烟已确认修复。
   > 若未来安卓沙箱仍出现 spawn 竞态，boot-guard（300ms 存活检查 + ≤3 次重启）依然兜底。
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
5. Flutter 端补扩展 UI 四个对话框控件（confirm/select/input/editor，接已打通的
   `extension_ui_request/response` 闭环）——扩展 UI 兼容由此在 App 层真正落地

## 已锁定决策（规划层，详见 DECISIONS）
- 终端：**内置 runBash 命令卡片流（必需）**；真终端（xterm.dart + 原生 PTY）**远期可选**
- 文件：本地路径闭环——App Dart 直读工作区目录 + Pi Host 直连 FS(diff/git/受信任写回)；无远端、无远端文件 API
- 工作区数据模型（pi-home+workspace 两级、项目 .pi/AGENTS.md、worktree 并行、每项目一进程）：照用不变

## Termux 快速跑通（开发路径，不等自带运行时）
`scripts/termux-setup.sh`：手机装 Termux → node22 + pi 引擎 → `pi-host-entry.js` 监听
127.0.0.1:8765 → App 连本机种子。UI/审批/会话树全链路当天可验证；
自带运行时（自编译 Node22 等）作为第二步，见 DECISIONS #12。
