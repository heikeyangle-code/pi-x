# ENGINE-UI-SURFACES — pi 引擎需要在 App 层补的 UI（调研）

> 依据 pi 0.84.x 官方文档（models/packages/skills/prompt-templates/themes/settings/extensions.md）。
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
| 7 | **Skills（需要吗？→ 需要）** | 标准：`~/.pi/agent/skills/`、项目 `.pi/skills/`、包 `pi.skills`、settings `skills[]`、`--skill`；Agent Skills 标准；按需加载 | 技能管理页：列表/启用停用/删除/查看 SKILL.md/从文件夹或包添加；**安全提示**（skill 可让模型执行任意命令） | M2 |
| 8 | **Extensions（插件=TS 代码）** | `~/.pi/agent/extensions/`、`.pi/extensions/` 自动发现；`/reload` 热重载；可注册工具/命令/事件钩子 | 扩展管理页：已加载列表、来源、启用/禁用、**任意代码信任警告**、重载按钮 | **M1** |
| 9 | **Prompt Templates** | 目录 + 包资源 + settings；`/模板名` 展开 | 模板管理页：列表/新建/编辑/删除（纯 markdown） | M2 |
| 10 | **Themes** | JSON 主题（默认在 ~/.pi/agent/…）；`/theme` | 主题选择器（拉引擎主题列表）+ 导入 | M3 |
| 11 | **Pi Packages（安装机制，见下）** | `pi install/list/remove/update`；npm/git/本地 | 包管理器 UI：搜索/安装/更新/卸载/版本与来源展示 | **M1（骨架）/M2（全）** |
| 12 | **llama.cpp 本地模型** | `/llama` 下载/加载路由（桌面二进制） | **App 不内置下载**；只支持"连接已有 llama.cpp router server"（M3 可选） | M3 |
| 13 | **AGENTS.md/上下文** | 目录向上合并 | 文件浏览器（已有 CC Pocket explorer 复用）+ 快捷打开/编辑 AGENTS.md | M2 |
| 14 | **用量/成本/会话** | RPC get_session_stats/message_update.usage | 会话头部用量显示（CC Pocket 已有 usage UI 复用） | M1 |

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

## 4. 斜杠命令（源码核实，pi 0.84.x）

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
