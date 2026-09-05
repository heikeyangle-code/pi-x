# DECISIONS — 已锁定的架构决策（勿推翻，改需新评审）

| # | 决策 | 值 | 出处 |
|---|---|---|---|
| 1 | 引擎形态 | pi 以 **`--mode rpc` 子进程**运行（官方 JSONL，进程边界=版本隔离） | ENGINE-INTEGRATION.md |
| 2 | App⇄引擎 wire | **pi 帧直通**：Pi Host 薄网关 + envelope `{engineVersion, protocolVersion, frame}`；映射表仅作过渡 | ENGINE-INTEGRATION.md §6 |
| 3 | 引擎分发 | **基线打进 APK + 新版本后台热更**（npm+pi.dev 双源、sha256、冒烟、回滚 2 份） | ENGINE-BUNDLE.md |
| 4 | 引擎进程模型 | **每项目一个引擎进程**（cwd=项目，对应 pi 按工作目录组织会话）；全局资源每进程共享 | engine-pool.ts + docs |
| 5 | 审批流 | 官方 `extension_ui_request/response`（confirm/select/input/editor）→ App 审批卡 | ENGINE-INTEGRATION.md |
| 6 | 设置/模型 UI | **1:1 文件面**：settings.json 双模（核心项+opaque JSON）、models.json 表单 | ENGINE-UI-SURFACES.md |
| 7 | **终端** | **内置"命令执行卡片流"（runBash 卡片，必需）**；**真终端（`TerminalStudio/xterm.dart`(MIT) UI + Kotlin /dev/ptmx 原生 PTY）列为远期可选**，不内置为必须。日常 bash=agent 执行+流式返回（无需 PTY）；真 PTY 仅服务用户手敲 vim/REPL/ssh 的低频场景，成本高故推迟。已验 xterm.dart 支持移动端、原生 PTY 在安卓可行（JNI /dev/ptmx），远期要加仅是新增一个页面 | 对话评审+核验 |
| 8 | 工作区 | 两级：pi-home（私有，配置/会话/包）+ workspace（用户可见/可 SAF 挂任意目录）；项目含 .pi/+AGENTS.md+git worktree 并行 | 调研 + M2-WIRING |
| 9 | 资源作用域 | 用户级（~/.pi/agent/*，所有项目共享）vs 项目级（.pi/*，先信任）；包默认用户级，`-l` 项目级 | 调研（与 pi 官方一致） |
| 10 | 斜杠命令 | 命令面板 = `get_commands` + 发送 `prompt "/name"`（服务端展开）；TUI 内置命令用等价 RPC | ENGINE-UI-SURFACES.md §4 |
| 11 | 平台 | **只做安卓**（ios/macos/linux/windows/web 源码已删；iOS 受 exec/后台限制不现实） | 对话评审 |
| 12 | 安卓运行时 | **不依赖 nodejs-mobile(仅18.x) 也不依赖 bun(无Android目标)**；**双路线并存**：主路径=自带 Termux 系 bionic **node 24 LTS**（Termux `nodejs-lts` 24.18.0-1，2026-09-05 实测）+ **bash 5.3 + 工具链 + apt/pkg 包管理器**（最小集见 ENGINE-BUNDLE "运行时完整性"；AI 可自行 `pkg/npm/pip` 装软件）+ 同 UID exec；兜底 B=proot 完整发行版（**proot 5.1.107.92 + proot-distro 5.8.0 + Ubuntu 26.04.1 LTS**，glibc，按需叠加不常驻，见 ENGINE-BUNDLE "双路线"）；兜底 C=nativeLibraryDir 放置；**绝不 targetSdk 28**；M2 真机矩阵验证 | 三方核实+本会话实测 |
| 13 | 更新稳定性 | App UI 不随 pi 发版变动；协议漂移由 engine-smoke CI + envelope 版本兜底 | ENGINE-UI-SURFACES.md §5 |
| 14 | 引擎包安卓入口 | 专用 `pi-host-entry.ts`（绕开 index.ts 的 sharp 链） | STATUS.md open#2 |
