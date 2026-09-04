# DECISIONS — 已锁定的架构决策（勿推翻，改需新评审）

| # | 决策 | 值 | 出处 |
|---|---|---|---|
| 1 | 引擎形态 | pi 以 **`--mode rpc` 子进程**运行（官方 JSONL，进程边界=版本隔离） | ENGINE-INTEGRATION.md |
| 2 | App⇄引擎 wire | **pi 帧直通**：Pi Host 薄网关 + envelope `{engineVersion, protocolVersion, frame}`；映射表仅作过渡 | ENGINE-INTEGRATION.md §6 |
| 3 | 引擎分发 | **基线打进 APK + 新版本后台热更**（npm+pi.dev 双源、sha256、冒烟、回滚 2 份） | ENGINE-BUNDLE.md |
| 4 | 引擎进程模型 | **每项目一个引擎进程**（cwd=项目，对应 pi 按工作目录组织会话）；全局资源每进程共享 | engine-pool.ts + docs |
| 5 | 审批流 | 官方 `extension_ui_request/response`（confirm/select/input/editor）→ App 审批卡 | ENGINE-INTEGRATION.md |
| 6 | 设置/模型 UI | **1:1 文件面**：settings.json 双模（核心项+opaque JSON）、models.json 表单 | ENGINE-UI-SURFACES.md |
| 7 | **终端** | **`TerminalStudio/xterm.dart`(MIT) 渲染 + App 原生 PTY 服务（Kotlin /dev/ptmx）**；用于 pi TUI 与手动 shell；日常走卡片流 | 调研（★655，Flutter 最成熟） |
| 8 | 工作区 | 两级：pi-home（私有，配置/会话/包）+ workspace（用户可见/可 SAF 挂任意目录）；项目含 .pi/+AGENTS.md+git worktree 并行 | 调研 + M2-WIRING |
| 9 | 资源作用域 | 用户级（~/.pi/agent/*，所有项目共享）vs 项目级（.pi/*，先信任）；包默认用户级，`-l` 项目级 | 调研（与 pi 官方一致） |
| 10 | 斜杠命令 | 命令面板 = `get_commands` + 发送 `prompt "/name"`（服务端展开）；TUI 内置命令用等价 RPC | ENGINE-UI-SURFACES.md §4 |
| 11 | 平台 | **只做安卓**（ios/macos/linux/windows/web 源码已删；iOS 受 exec/后台限制不现实） | 对话评审 |
| 12 | 安卓运行时 | exec 用"自带 runtime 目录 + 同 UID exec"模型（Termux 同原理）；**不降 targetSdk**；native 依赖（sharp 等）不引入 | 对话评审 |
| 13 | 更新稳定性 | App UI 不随 pi 发版变动；协议漂移由 engine-smoke CI + envelope 版本兜底 | ENGINE-UI-SURFACES.md §5 |
| 14 | 引擎包安卓入口 | 专用 `pi-host-entry.ts`（绕开 index.ts 的 sharp 链） | STATUS.md open#2 |
