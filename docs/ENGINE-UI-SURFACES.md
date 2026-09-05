# ENGINE-UI-SURFACES — pi 引擎需要在 App 层补的 UI（调研）

> 依据 pi 0.85.x 官方文档（models/packages/skills/prompt-templates/themes/settings/extensions.md + 源码核实）。
> 原则：**引擎 = 唯一事实源（文件/目录/settings），App 只做"查看/编辑/安装/开关"的管理面**，不做第二份状态。

## 1. 引擎能力 → App UI 清单

| # | 引擎能力 | pi 机制（文件/命令） | App 层 UI | 优先级 |
|---|---|---|---|---|
| 1 | **Provider 列表/登录** | 内置 provider（订阅 OAuth 设备码 + API key）；`/login` | Provider 管理页：选择器、订阅登录（WebView 设备码/回调）、API key 输入（安全存储）、登出 | **M1** |
| 2 | **模型选择/切换** | 内置目录 + 自定义；`get_available_models`/`set_model`（RPC 已有） | 模型选择 bottom sheet（绑 pi 目录，含 thinking 层级显示）；会话内快捷切换 | **M1** |
| 3 | **添加自定义模型** | `~/.pi/agent/models.json`：`providers{id:{baseUrl,api(4种),apiKey,models[]}}`；4 种 API：openai-completions/openai-responses/anthropic-messages/google-generative-ai | "模型管理"页：新增/编辑 provider（Ollama/OpenRouter/自定义 baseUrl）+ 模型列表 + JSON 预览/导入导出 | **M1** |
| 4 | **模型目录刷新** | `pi update --models` | 设置内"刷新模型目录"按钮 + 上次刷新时间 | M2 |
| 5 | **Settings** | `~/.pi/agent/settings.json`（+ 项目 `.pi/settings.json`）；RPC `get_state` | 设置页：核心项（defaultProjectTrust/offline/telemetry/…）+ 完整 JSON 编辑器双模 | M2 |
| 6 | **项目信任** | `trust.json` + `defaultProjectTrust`；启动/切项目询问 | 首次打开工作区弹信任对话框（ask/always/never + 记住） | **M1** |
| 7 | **Skills（需要吗？→ 需要）** | 标准：`~/.pi/agent/skills/`、项目 `.pi/skills/`、包 `pi.skills`、settings `skills[]`、`--skill`；Agent Skills 标准；按需加载 | 技能管理页：列表/查看 SKILL.md 已落地（`skills_screen.dart`，全局+项目分组 + 安全提示）；启用停用/删除/从文件夹或包添加 M2 | M2 |
| 8 | **Extensions（插件=TS 代码）** | `~/.pi/agent/extensions/`、`.pi/extensions/` 自动发现；`/reload` 热重载；可注册工具/命令/事件钩子 | 扩展管理页：已加载列表、来源、启用/禁用、**任意代码信任警告**、重载按钮 | **M1** |
| 9 | **Prompt Templates** | 目录 + 包资源 + settings；`/模板名` 展开 | 模板管理页：列表/新建/编辑/删除（纯 markdown） | M2 |
| 10 | **Themes** | JSON 主题（默认在 ~/.pi/agent/…）；`/theme` | 主题选择器（拉引擎主题列表）+ 导入 | M3 |
| 11 | **Pi Packages（安装机制，见下）** | `pi install/list/remove/update`；npm/git/本地 | 包管理器 UI：搜索/安装/更新/卸载/版本与来源展示 | **M1（骨架）/M2（全）** |
| 12 | **llama.cpp 本地模型** | `/llama` 下载/加载路由（桌面二进制） | **App 不内置下载**；只支持"连接已有 llama.cpp router server"（M3 可选） | M3 |
| 13 | **AGENTS.md/上下文** | 目录向上合并 | 文件浏览器（已有 CC Pocket explorer 复用）+ 快捷打开/编辑 AGENTS.md | M2 |
| 14 | **用量/成本/会话** | RPC get_session_stats/message_update.usage | 会话头部用量显示（CC Pocket 已有 usage UI 复用） | M1 |
| 15 | **系统提示词（替换/追加）** | `SYSTEM.md`/`APPEND_SYSTEM.md`（全局 `~/.pi/agent/` + 项目 `.pi/`，项目需信任）；CLI `--system-prompt`/`--append-system-prompt` | 设置页"系统提示词"编辑（全局）+ 项目页编辑（.pi/）+ 会话级启动参数 | **M1** |
| 16 | **上下文文件开关** | CLI `--no-context-files`（AGENTS.md/CLAUDE.md 关闭） | 设置页开关 → PiHost 引擎启动参数 → 重启引擎生效 | M2 |
| 17 | **工具启用范围** | CLI `--no-tools`/`--no-builtin-tools`/`--tools`/`--exclude-tools`；settings `defaultTools` | 设置页工具多选 + 白/黑名单 | M2 |

## 2. "以后安装这个/插件是什么机制"（回答）

pi 的资源**全部是进程内按目录发现 + settings 记录**，没有编译/注册中心：

- **存放点**：用户级 `~/.pi/agent/{extensions, skills, npm, git, theme…}`；项目级 `.pi/`；设置 `settings.json` 记录包与技能路径。
- **安装来源**：npm registry（`pi install npm:@x/y@ver`，装到 `~/.pi/agent/npm/<pkg>`，npm-shrinkwrap 锁依赖）；git（clone 到 `~/.pi/agent/git/<host>/<path>`，支持 tag/commit 钉版本）；本地目录/zip（SAF 导入 → 复制进包目录）；单文件（extension .ts 直接丢 extensions/）。
- **生效**：extensions 支持 `/reload` 热重载（App 一键重载）；skills/templates/themes 启动时扫描。
- **App 层实现** = Pi Host 转发 `pi install/list/remove/update --extensions` 或直接文件操作 + 解析 `package.json` 的 `pi` 声明 → UI 展示名称/版本/资源类型（extensions/skills/promptTemplates/themes）。
- **信任边界**：extensions = 任意代码（装前弹警告 + 来源展示）；skills 仅指导模型（提示审查）；themes/templates 纯数据。
- **更新**：`pi update --all/--extensions` 语义 → App"包更新"页（与引擎版本更新分开）。

## 3. Skills 到底需不需要？（直接回答）

**需要，M2 做。** 理由：skill = 让 pi 现学现用某类任务（流程+脚本+参考）的标准格式（Agent Skills 规范，Claude/Codex 生态通用），社区仓库多；不装 UI，用户只能手动往 `~/.pi/agent/skills/` 塞文件。最小 UI = 列表 + 启用/停用 + 从文件/包导入 + SKILL.md 查看（编辑用文件浏览器）。**不需要**在 App 里做技能运行逻辑——加载/按需注入全在引擎侧。

## 4. 斜杠命令（源码核实，pi 0.85.x）

- 三类来源：扩展 `registerCommand`(`/name`)；prompt 模板 `.md`(`/name`)；skills(`/skill:name`)。
- **RPC 一键方案（App 不需要解析模板）**：`get_commands` 返回 `{name,description,source(extension/prompt/skill),location,path}`；**执行 = 直接发 `prompt` 消息，正文以 `/name args` 开头，pi 服务端展开**。
- TUI 内置命令（/settings、/hotkeys…）不进 get_commands、RPC 也不执行 → App 用等价 RPC 命令实现（set_model/compact/set_thinking_level…）。
- App UI = "命令面板"（输入 `/` 弹出 get_commands 列表，含分组：插件/模板/技能），点击 → prompt `/name …`。零客户端模板逻辑。

## 5. pi 更新后 UI 要动吗？（稳定性分层）

| 层 | pi 更新时 | 对策 |
|---|---|---|
| App UI 代码 | **基本不动** | UI 只消费：①自己的事件协议 ②文件格式（settings/models.json/skills 目录——pi 保证向后兼容）③ get_commands/schema 数据 |
| settings 表单 | 新增 key 时 | 双模：核心项手写 + **未知键 opaque JSON 编辑器**（永远兜底） |
| 模型/provider 目录 | 变化频繁 | 运行时拉取（RPC get_available_models / provider 列表），UI 无硬编码 |
| RPC 协议 | 偶发演进 | 版本跟随管道里跑"RPC 冒烟门禁"，漂移先拦截 |
| 扩展 API | 插件作者侧 | 与我们 UI 无关（扩展跑在引擎内） |
| Pi Host 适配层 | pi 内部 API 变化时 | 唯一可能改动点 = 桥的协议翻译；随 engines 包版本化，CI 冒烟验证 |

结论：**架构把 UI 与 pi 版本解耦**——日常 pi 更新只换引擎包（热更新），UI 不需要跟随改动；个别大版本如 RPC 消息变化，改 Pi Host 翻译层（独立版本），App 依旧不动。

## 6. 调整选项全清单 × pi-x 现状（pi 0.85.x 全面盘点，2026-09-04）

三组来源：**文件资源**（引擎启动/会话时发现）、**settings.json**（运行时可改，RPC get_settings/update_settings 已通）、**CLI 启动参数**（引擎进程启动时固定，改后重启引擎生效）。
现状标注：✅ 后端+UI 已有；🔶 后端有、UI 待补；❌ 皆无。

### 6.1 文件资源（App 编辑文件 + 引擎重启生效）

| 资源 | 路径（全局/项目） | 作用 | 现状 |
|---|---|---|---|
| `SYSTEM.md` | `~/.pi/agent/` + `.pi/`（项目需信任） | 整段替换默认系统提示 | ✅ 设置页"系统提示词"（`system_prompt_screen.dart`，全局/项目双作用域 + 保存后重启提示） |
| `APPEND_SYSTEM.md` | `~/.pi/agent/` + `.pi/`（项目需信任） | 追加默认系统提示 | ✅ 同上（同屏编辑） |
| `AGENTS.md`/`CLAUDE.md` | 工作区目录向上合并 | 项目约定/命令/安全规则 | ✅ 上下文文件快捷编辑页（`context_files_screen.dart`：列表 + 向上合并检测 + 读写目标文件） |
| `skills/` | `~/.pi/agent/skills`、`.pi/skills`、包 `pi.skills` | Agent Skills（按需注入） | ✅ 技能管理页（`skills_screen.dart`：全局/项目列表 + 查看 SKILL.md + 安全警告；启用停用/导入 M2） |
| `extensions/` | `~/.pi/agent/extensions`、`.pi/extensions` | 扩展（TS 代码，任意代码信任警告） | ✅ 扩展管理页（`extensions_screen.dart`：已加载列表/来源/重载/任意代码信任警告；启用禁用 M2） |
| `prompts/` | `~/.pi/agent/prompts`、`.pi/prompts` | 斜杠命令模板（markdown） | ✅ 模板管理页（`prompts_screen.dart`：全局/项目列表 + 新建/编辑/删除纯 markdown） |
| `themes/` | `~/.pi/agent/theme` 等 | 引擎主题 JSON | ✅ 主题管理页（`themes_screen.dart`：引擎主题列表 + 选择 + 导入；`--use-theme` 启动参数可配） |
| `packages` | settings `packages[]`（npm/git 包） | 扩展/技能/模板来源 | ✅ 包管理页（`packages_screen.dart`：列表 + npm/git 安装 + 更新/卸载；后端 `packages.ts` 与 pi 语义 1:1） |

### 6.2 settings.json 全键（双模：核心项表单 + opaque JSON 兜底）

| 组 | 键 | 现状建议 |
|---|---|---|
| Model & Thinking | `defaultProvider`/`defaultModel`/`defaultThinkingLevel`/`modelThinkingLevels`/`hideThinkingBlock`/`showCacheMissNotices`/`thinkingBudgets` | ✅ 模型选择 UI 有 + 核心表单（`settings_core_screen.dart`） |
| UI & Display | `theme`/`quietStartup`/`defaultProjectTrust`/`doubleEscapeAction`/`treeFilterMode`（TUI 专属项 App 忽略） | ✅ `defaultProjectTrust`→信任对话框 M1 + 核心表单 |
| Compaction | `compaction.enabled`/`reserveTokens`/`keepRecentTokens` | ✅ 核心表单 |
| Retry | `retry.enabled`/`maxRetries`/`baseDelayMs`/`provider.timeoutMs`/`provider.maxRetries`/`provider.maxRetryDelayMs` | ✅ 核心表单 |
| Branch Summary | `branchSummary.reserveTokens`/`skipPrompt` | ✅ 核心表单 |
| Message Delivery | `steeringMode`/`followUpMode`/`transport`/`httpIdleTimeoutMs`/`websocketConnectTimeoutMs` | 🔶 steering/followUp 已有 RPC `set_*`；App 开关 M2 |
| Network | `httpProxy` | ❌ 表单（安卓本机代理通常不需要，低优先） |
| Shell | `shellPath`/`shellCommandPrefix`/`npmCommand` | ❌ 表单（低优先） |
| Tools | `defaultTools` | ❌ 表单（可叠加 CLI `--tools`/`--exclude-tools`） |
| Sessions | `sessionDir` | ❌ 表单（App 会话由引擎 cwd 组织，一般不改） |
| Model Cycling | `enabledModels` | ❌ 表单 |
| Markdown | `markdown.codeBlockIndent`/`markdown.mermaid` | ❌ 表单（低优先） |
| Resources | `packages`/`extensions`/`skills`/`prompts`/`themes`/`enableSkillCommands` | ✅ 见 6.1（各管理页已落地） |
| Telemetry/警告 | `enableInstallTelemetry`/`warnings.anthropicExtraUsage` | ❌ 表单（低优先） |

### 6.3 CLI 启动参数（PiHost 引擎启动 args；App 设置开关 → 重启引擎生效）

| 参数 | 作用 | 现状 |
|---|---|---|
| `--system-prompt <text>` | 替换系统提示（覆盖默认，上下文文件仍追加） | ✅ 走官方文件面 `SYSTEM.md`（6.1），无需 CLI 参数 |
| `--append-system-prompt <text>` | 追加（可多次） | ✅ 走官方文件面 `APPEND_SYSTEM.md`（6.1） |
| `--no-context-files`/`-nc` | 关闭 AGENTS.md/CLAUDE.md 发现 | ✅ 启动参数开关页（`engine_flags_screen.dart`，`pix-config.json` engineArgs → 重启引擎生效） |
| `--no-skills`/`-ns`、`--no-prompt-templates`/`-np`、`--no-themes`、`--no-extensions`/`-ne` | 关闭各类资源发现 | ✅ 同上（开关列表） |
| `--no-tools`/`-nt`、`--no-builtin-tools`/`-nbt` | 关闭全部/内置工具 | ✅ 同上（开关列表） |
| `--tools <list>`/`--exclude-tools <list>` | 工具白名单/黑名单 | ✅ 同上（带值输入框） |
| `--use-theme <name>` | 初始主题 | ✅ 同上（带值输入框） |

**生效机制（唯一入口，已实现）**：App 写 `~/.pi/agent/pix-config.json`（`engineArgs`）→ PiHost `update_pix_config` 保存、`restart_engine(projectId)`（= engine-pool `stop()` + 下次 `getOrStart` 带新 args 拉起）→ 新会话读新配置。设置页每个管理子页均提供"重启引擎"入口（`confirmRestartEngine` 共享助手）。

### 6.4 扩展 UI 面（RPC 子协议，已 1:1 闭环）

- **Dialog（需应答）**：`select`/`confirm`/`input`/`editor` → `extension_ui_request` ↔ `extension_ui_response`（含 `confirmed`/`cancelled`，已实测回传引擎）。✅ 四个原生对话框已实现（`extension_ui_dialogs.dart`，由 `PiExtensionUiHost` 挂在 root navigator 上，串行防叠，任意页面可弹）。
- **Fire-and-forget（无需应答）**：`notify` → ✅ SnackBar 通知（`extension_ui_dialogs.dart`）；`setStatus`/`setWidget`/`setTitle`/`set_editor_text` → TUI 专属，RPC 模式记日志不渲染（`ctx.mode="rpc"`、`ctx.hasUI=true`）。
- **RPC 模式不可用**：`ctx.ui.custom()`（仅 TUI）、`getToolsExpanded()`=false、`getTheme()`=undefined。
- 网关 `extension_ui_request/response` 全量方法透传 1:1（STATUS 已验 confirmed/cancelled 闭环）。
