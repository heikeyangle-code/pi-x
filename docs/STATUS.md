# STATUS — 项目状态与已知问题（2026-09 更新）

## 已验证（真实执行）

- pi 0.85.0 引擎包本机安装/启动成功；`--mode rpc` 官方 JSONL 协议真实往返 OK
  （get_commands / get_state；0.84.4 曾为基线，升级见 ENGINE-BUNDLE）。协议帧与 `packages/bridge/src/pi-host/pi-rpc.ts` 逐条核对一致。
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
- **引擎版本 0.85.0 冒烟（2026-09-04）**：裸装 `@earendil-works/pi-coding-agent@0.85.0`（`--ignore-scripts`，**不装 pi-server**）
  → `pi --version` = 0.85.0、`--mode rpc` get_commands/get_state 往返正常。CLI 入口为打包产物 `dist/bundle/cli.js`，
  不受 SDK `dist/index.js` 静态 import `pi-server` 缺口影响（该缺口仅影响进程内 SDK 方案，见 ENGINE-BUNDLE 备注）。
- **S5b 单机收敛完成**：机器管理收敛为只种子/跟踪本机 `127.0.0.1:8765`（删 增/改/删/收藏/SSH/跳板/探测
  与远程连接 deep link，deep link 仅留会话分享）；Settings 连接区改为本机引擎状态+Bridge 版本信息；
  同步清理约 85 个 `fcm*`/`machineEdit*`/`ssh*`/`server*`/`setup*`/`push*` 死 l10n 键（4 语言 arb）。
  验证：`build_runner` + `flutter analyze`（无 error/warning）+ `flutter test`（1664 全绿）+ bridge `tsc` 全过。
- **引擎包配方脚本化（scripts/engine-bundle.mjs）**：`build/verify/manifest` 三个子命令把
  ENGINE-BUNDLE 配方固化为一行命令——npm 安装（--ignore-scripts）→ `pi --version` 版本断言 →
  离线 JSONL RPC 冒烟（get_commands/get_state，PI_OFFLINE=1，自含不依赖 bridge dist）→ tgz 打包 →
  manifest.json + SHA256SUMS 生成；verify 复查版本/冒烟/tgz sha256 对照 manifest。
  单测 7/7 绿（scripts/engine-bundle.test.mjs），本机真实端到端 build→verify→manifest 全通过
  （0.85.0，tgz 1920b02a…）；并入 engine-smoke CI 门禁与 npm scripts（engine:bundle:*）。
- **Pi 引擎管理 UI 层落地（Flutter，2026-09-04）**：设置页新增 "Pi 引擎" 管理入口
  （`pi_engine_settings_screen.dart`），下辖三个子页，全部走 PiHost 控制面命令：
  - 系统提示词（`system_prompt_screen.dart`）：SYSTEM.md / APPEND_SYSTEM.md 全局+项目双作用域
    编辑（surface 算子 `read_prompt_file`/`write_prompt_file`），保存后提示重启引擎生效；
  - 启动参数开关（`engine_flags_screen.dart`）：--no-context-files/--no-skills/--no-prompt-templates/
    --no-themes/--no-extensions/--no-tools/--no-builtin-tools 开关 + --tools/--exclude-tools/
    --use-theme 带值输入，读写 `pix-config.json` engineArgs（`get_pix_config`/`update_pix_config`），
    未知参数原样保留（parseEngineArgs/buildEngineArgs 双向映射，单测覆盖）；
  - Provider/模型管理（`models_screen.dart`）：models.json 的 provider 增删改 + 模型列表
    （`get_models`/`upsert_model`/`remove_model`/`add_model`），4 种 API 类型选择；
  - 扩展 UI 对话框（`extension_ui_dialogs.dart` + `extension_ui_host.dart`）：confirm/select/input/
    editor 四个原生对话框挂在 root navigator（`PiExtensionUiHost`，MaterialApp.builder 装配），
    notify → SnackBar；响应经 `extension_ui_response` 回传引擎（confirmed/cancelled 语义闭环）。
  - 共享助手 `confirmRestartEngine`（各管理子页统一"重启引擎"入口）+ `ensurePiHostConnected`
    （首连/重连引导）；本地化键 `piEngine*` 补齐 en/zh/ja/ko 四个 arb。
    验证：flutter analyze 无 error/warning、pi_engine 模型层单测全绿、bridge tsc 全过（当时 1161 单测，
    后经 codex/claude 物理删除降至 43 文件 712 用例，见下）。
- **命令面板 + 扩展管理 UI（Flutter，2026-09-04）**：Pi 引擎设置页新增两个入口——
  - 命令面板（`commands_screen.dart` + `pi_engine_commands.dart`）：`get_commands` 拉取
    引擎全部斜杠命令/模板/技能，按来源（extension/prompt/skill）分组展示（名称+描述），
    点击复制 `/name ` 到剪贴板（命令由引擎侧展开，App 零模板逻辑，docs/ENGINE-UI-SURFACES §4）；
  - 扩展管理（`extensions_screen.dart`）：`list_extensions` 列出
    `~/.pi/agent/extensions/` 与项目 `.pi/extensions/` 下已发现的扩展，顶部信任警告
    （扩展=任意代码），空态说明放置位置，"重启引擎"入口复用 `confirmRestartEngine`；
  - 本地化键 `piEngineCommands*`/`piEngineExtensions*` 补齐 en/ja/zh/ko 四个 arb；
    新增 `pi_engine_commands_test.dart`（解析/缺失字段/相等性单测）。
- **Skills 管理 UI（Flutter + 网关，2026-09-04）**：Pi 引擎设置页新增"技能"入口——
  - 网关 `list_skills` 升级为全局+项目双作用域（`~/.pi/agent/skills/` + 项目 `.pi/skills/`），
    每条返回 `{name, scope, description}`（SKILL.md frontmatter 首行 description 提取）；
    新增 `read_skill` 算子（`{scope,name}` → SKILL.md 正文，含路径穿越防护）；
  - `skills_screen.dart`：按作用域分组（项目/全局）列表 + 顶部安全警告（技能=可让模型
    执行命令的提示词/脚本）+ 点击底部弹层查看 SKILL.md + 空态放置说明 + "重启引擎"入口
    （技能启动时扫描，复用 `confirmRestartEngine`）；
  - 本地化键 `piEngineSkills*` 补齐 en/zh/ja/ko 四个 arb（手工同步 5 个生成 .dart）；
    新增 `pi_engine_skills_test.dart`（解析/作用域/相等性单测）+ 网关端到端单测
    （全局/项目列表带描述、read_skill 正文与缺失、`../` 穿越拒绝）；
    验证：bridge tsc 全过（当时 1162 单测，后经 codex/claude 物理删除降至 43 文件 712 用例，见下）。
- **codex/claude 物理删除 + auto-rename 恢复（2026-09-05）**：删除 23 个 legacy 文件（sdk-process/
  claude-provider/codex-*/session/sessions-index/resume-metrics/auto-rename 等，约 4.3 万行）；
  `websocket.ts` 移除 29 个 codex/claude 消息 handler；`package.json` 移除 `@anthropic-ai/claude-agent-sdk`。
  随后以 pi 原生方式恢复会话自动命名：`pi --print --no-tools --no-session` 一次性生成 + `set_session_name`
  持久化（`auto-rename.ts` + `PiAdapter` 首条输入触发，失败静默降级）。验证：tsc 0 错误；vitest 43 文件
  712 用例通过；真实 pi 引擎 e2e 冒烟通过（详见 PI-ONLY-STATUS）。
- **引擎事件映射 1:1 补齐 + 会话表面打磨（2026-09-05）**：`cc-adapter.ts` 逐条对齐 pi RPC 官方事件
  （message_update 的 text/thinking/toolcall 各 delta、extension_ui_request、agent_*、compaction、
  auto-retry、bash_execution_update、tool_execution_*、extension_error 等），修复 tool 事件用
  `toolCallId` 而非 `id` 解析、compaction 错误走专用 error 消息、agent end + willRetry 不置 idle 等；
  `scanPiRecentSessions` 过滤参数（limit/searchQuery/namedOnly/provider）与 pi 目录扫描对齐；
  `PiSessionRegistry` 支持每项目多会话映射 + 引擎退出清理陈旧会话。验证：bridge 全量 vitest 通过。
- **Pi 引擎管理 UI 全量落地（Flutter，2026-09-05）**：设置页 "Pi 引擎" 管理入口下的管理页补齐，
  全部走 PiHost 控制面命令、尽量复用现有组件：
  - 模板管理（`prompts_screen.dart` + `pi_engine_prompts.dart`）：全局/项目分组 + 新建/编辑/删除
    纯 markdown（`list_prompts`/`read_prompt`/`write_prompt`/`delete_prompt`，官方模板语义 1:1）；
  - 包管理（`packages_screen.dart` + `pi_engine_packages.dart` + bridge `packages.ts`）：npm/git/本地
    三类源安装、更新/全部更新/卸载，npm root/git clone 路径语义与 pi 一致，项目级装到 `.pi/npm`；
  - 设置核心表单（`settings_core_screen.dart` + `pi_engine_settings.dart`）：defaultProvider/
    defaultThinkingLevel/compaction/retry/branchSummary/offline 等核心项 + **opaque JSON 编辑器兜底**
    （未知键永不丢失），已挂入设置中心；
  - 主题管理（`themes_screen.dart` + `pi_engine_themes.dart`）：引擎主题列表 + 选择 + JSON 导入 +
    删除（`list_themes`/`set_theme`/`import_theme`/`remove_theme`，`--use-theme` 可配）；
  - 上下文文件（`context_files_screen.dart`）：AGENTS.md/CLAUDE.md 全局+项目列表、向上合并检测、
    读写目标文件（`get_context_files`/`read_context_file`/`write_context_file`）；
  - 本地化：新增键全部补齐 en/zh/ja/ko 四个 arb；4 个 ARB 因恢复脚本损坏（@metadata 错位）后
    以"键值行 + 生成 dart 签名类型"重建为合法 JSON（含全部占位符元数据），重新 `flutter gen-l10n`。
    验证：flutter analyze 无 error/warning；flutter test 1672 用例通过；bridge vitest 44 文件
    764 用例通过（新增 import_models/import_models_json/update_models/packages/context-files 算子测试）。
- **模型导入（bridge + Flutter，2026-09-05）**：`pi-gateway.ts` 新增三算子——`import_models`
  （一批模型按 id upsert 进 provider）、`import_models_json`（粘贴 models.json providers 片段合并，
  非法输入拒绝不污染文件）、`update_models`（清 PI_OFFLINE 跑 `pi update --models`，130s 超时）；
  `models_screen.dart` 每个 provider 卡片新增"从服务器导入"（填 baseUrl/API key → 请求
  `/v1/models`（回落 `/models`，兼容 Anthropic `display_name`）→ 勾选列表默认全选 → 按 id 合并）、
  AppBar 新增 JSON 导入与目录刷新入口；`pi_engine_models.dart` 新增 `DiscoveredModel` 解析。端到端
  单测覆盖三算子（含 models.json 片段合并与 `pi update --models` 命令拼装断言）。

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
   （`pi_host_service.dart` + 管理页已就绪，待真机连本机引擎全链路冒烟）
3. ~~M1 页面：Provider/模型管理（models.json 表单）~~ ✅ `models_screen.dart` 已实现；
   ~~命令面板（get_commands）、扩展管理 UI（list_extensions）~~ ✅ `commands_screen.dart` +
   `extensions_screen.dart` 已实现（命令面板 M1 为浏览+复制，执行随 wire client 落地）
4. ~~引擎包运行时（APK 内置基线 + 热更）落地 ENGINE-BUNDLE 配方~~ ✅ 配方已脚本化并过 CI；APK 内置+热更运行时待 Android 侧落地
5. ~~Flutter 端补扩展 UI 四个对话框控件（confirm/select/input/editor，接已打通的
   `extension_ui_request/response` 闭环）~~ ✅ `extension_ui_dialogs.dart` + `PiExtensionUiHost` 已实现，扩展 UI 兼容在 App 层落地
6. ~~调整选项：设置页"系统提示词"（全局 SYSTEM.md/APPEND_SYSTEM.md 编辑 + 项目 .pi/ 编辑）
   + 启动参数开关（--no-context-files/--no-skills/--no-extensions/--tools 等，PiHost 拼 args）
   + PiHost control op `restart_engine(projectId)`（engine-pool stop + getOrStart 拉起）~~ ✅ 全部落地
   （`system_prompt_screen.dart`/`engine_flags_screen.dart` + `confirmRestartEngine`），剩余盘点见
   ENGINE-UI-SURFACES §6：skills 管理 UI（列表+查看 SKILL.md）已落地 `skills_screen.dart`；
   prompts/themes/packages/settings 核心表单/上下文文件管理 UI 已全部落地（2026-09-05）
7. ~~**会话内模型快捷切换**~~ ✅ 已落地（2026-09-05）：`pi_model_switch.dart` 的 `PiModelChip`
   替换模式条里的 legacy `CodexModelChip`（视觉同款，数据走 `get_state`/`get_available_models`/`set_model`），
   点击弹出按 provider 分组的切换面板；测试见 `pi_model_switch_test.dart`
8. 低优先表单兜底项（ENGINE-UI-SURFACES §6.2 标 ❌ 的键：httpProxy/shellPath/npmCommand/
   defaultTools/enabledModels/markdown/telemetry 等）——settings 核心表单已有 opaque JSON 编辑器兜底，
   无 UI 也能改

## 已锁定决策（规划层，详见 DECISIONS）
- 终端：**内置 runBash 命令卡片流（必需）**；真终端（xterm.dart + 原生 PTY）**远期可选**
- 文件：本地路径闭环——App Dart 直读工作区目录 + Pi Host 直连 FS(diff/git/受信任写回)；无远端、无远端文件 API
- 工作区数据模型（pi-home+workspace 两级、项目 .pi/AGENTS.md、worktree 并行、每项目一进程）：照用不变

## Termux 快速跑通（开发路径，不等自带运行时）
`scripts/termux-setup.sh`：手机装 Termux → node24 LTS + pi 引擎 → `pi-host-entry.js` 监听
127.0.0.1:8765 → App 连本机种子。UI/审批/会话树全链路当天可验证；
自带运行时（自编译 Node24 LTS + bash + 工具链，见 ENGINE-BUNDLE "运行时完整性"）作为第二步，见 DECISIONS #12。
