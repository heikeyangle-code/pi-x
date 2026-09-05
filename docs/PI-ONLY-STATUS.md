# PI-ONLY-STATUS — “只连本地 pi、去掉 codex/claude”实施进度

> 目标：CC Pocket（bridge）只连**本地的 pi 引擎**，codex/claude 不再作为对话引擎被拉起，
> 所有 CC 功能（对话、文件、工作区、git、历史、用量、上传下载、会话列表）都落在本地 pi 上。
> 本文记录已做、未做，作为后续阶段执行的依据。配合 `docs/M2-WIRING.md`、
> `docs/ENGINE-INTEGRATION.md`、`docs/ENGINE-BUNDLE.md` 阅读。

## 一句话现状

**已 100% pi-only：** 对话、会话列表、会话历史、最近会话、会话改名、会话自动命名、图片提取、git 提交信息生成
全部走本地 pi；文件/工作区/git/上传下载本就是本地直连；入口强制 pi-only（缺 `PI_ENGINE_ENTRY` 拒启）；
Firebase 推送中继已删除；codex/claude 的 provider 源码、运行时耦合与依赖已物理删除。协议层保留客户端仍在
发送的 codex/claude 字段解析（app 契约兼容），但运行时不存在任何 codex/claude 引擎路径。

## 已完成（带提交与验证）

| 项 | 说明 | 提交 |
|---|---|---|
| 对话引擎切 pi | 同一个 `BridgeWebSocketServer` 内注入 `PiAdapter`，`start/input/approve/reject/answer/stop_session` 路由到 pi（`PiGateway` + `engine-pool`）；文件/工作区/git/上传下载原样走原实现 | 先前 pi 接入提交 |
| 消息契约对齐 App | 重写 `cc-adapter` 出站映射，产出与 App `ServerMessage.fromJson` 严格兼容的规范字段（`status.status`、`stream_delta/thinking_delta.text`、`assistant.message.content`、`tool_result.toolUseId/content`、`permission_request.toolUseId/toolName/input`）；`PiAdapter.start` 兼容真实 wire 的 `projectPath` | `000068e` |
| 入口强制 pi-only | `index.ts` 去掉 `PI_HOST` 开关：无条件构造 `PiAdapter`，缺 `PI_ENGINE_ENTRY` 直接拒启，codex/claude 不再可作为对话引擎启动 | `0486160` |
| 会话表面切 pi | 新增 `pi-host/pi-sessions.ts`：pi `AgentMessage[]` → CC 历史消息转换、`~/.pi/agent/sessions` JSONL 解析与最近会话扫描、运行时 `PiSessionRegistry`；`websocket.ts` 的 `list_sessions` / `list_recent_sessions` / `get_history` / `get_history_delta` / `get_session_context` / `resume_session` / `resolve_session_link` / `rename_session` 全部改由 pi 引擎 + pi 会话目录供给 | 会话表面提交 |
| 会话回放兼容 App | `get_history` 返回 `user_input/assistant/tool_result` 严格字段；`resume_session` 复用同一 sessionId 供 `get_history`/`input` 关联；`session_created` + `status` 让 App 正确导航与就绪 | 会话表面提交 |
| 历史磁盘回退 | 引擎内存未加载会话时（`get_messages` 为空），`get_history`/`get_history_delta` 直接解析 `~/.pi/agent/sessions/<proj>.jsonl` 回放（`piSessionFileToHistoryMessages`），列表里每个会话都能完整回放 | 会话表面提交 |
| 图片提取 pi 原生 | `piSessionImagesFromJsonl` 解析 pi 会话 JSONL 中 `{type:"image",source:{type:"base64",...}}` 块，替代 claude 图片读取路径 | 本次 |
| git 提交信息生成 pi | `git-assist.ts` 改用 `pi --print --no-tools --no-session` 一次性生成（`engine-assist.ts`），替代 codex/claude CLI | 本次 |
| 会话自动命名恢复 | 被物理删除的 legacy `auto-rename.ts` 以 pi 原生方式重写：`pi --print --no-tools --no-session` 一次性生成（`engine-assist.ts`），`PiAdapter` 在首条用户输入触发，`set_session_name` 持久化到引擎会话元数据；失败静默降级到引擎首条消息兜底，不阻塞主流程。新增单测 + adapter 集成测试 | 本次 |
| 引擎失败反馈 | `isFailedEngineResponse` 把引擎失败（如无 provider）转成 CC `error` 消息，App 不再无响应挂起 | `ddbee57` |
| 健康检查 pi-only | `doctor.ts` 只查 pi 引擎（`PI_ENGINE_ENTRY` + 凭据），去掉 claude/codex CLI、Tailscale、Firebase、Keychain 检查 | 先前 |
| 用量 pi-only | `usage.ts` 去掉 codex 磁盘扫描，改为报告本地 pi 引擎 | 先前 |
| mDNS 关闭 | `mdns.ts` 默认不再广播 LAN 服务 | 先前 |
| 移除 Firebase 推送中继 | 删除 `firebase-auth.ts`、`push-relay.ts`、`push-i18n.ts` 及测试；`index.ts` 不再初始化 Firebase Anonymous Auth；`websocket.ts` 删除 `push_register`/`push_unregister` 处理与全部推送通知路径；App 侧 `push_registration_result` 协议仍保留解析（bridge 不再发送） | 推送移除提交 |
| 阶段 3：物理删除 | 删除 23 个 codex/claude 源码与测试文件（`sdk-process`、`claude-provider`、`codex-*`、`session`、`sessions-index`、`resume-metrics` 等；`auto-rename` 随后以 pi 原生方式恢复，见上）；`websocket.ts` 移除 29 个 legacy 消息 handler；`cli-args`/`cli` 移除 codex flags；`setup-launchd`/`setup-systemd` 移除 codex/claude 环境变量；`package.json` 移除 `@anthropic-ai/claude-agent-sdk`；README 重写为 pi-only | 本次 |
| 单元测试 | `pi-sessions.test.ts`（历史转换/JSONL 解析/扫描/注册表）；`pi-adapter.test.ts` 覆盖 `session_created` 与状态流、auto-rename 首条输入触发；`auto-rename.test.ts`（提示词构建/清洗/生成）；`git-assist.test.ts` 覆盖 `pi --print` 集成；`websocket.test.ts` 重写为 pi 兼容 | 本次 |
| 验证 | `tsc --noEmit` 0 错误；bridge 全量 vitest 43 文件 712 用例通过 | 本次 |

## 未完成

### 阶段 4：可选的后续收尾

- **双入口收敛**：`index.ts`（piAdapter 注入式）与 `pi-host-entry.ts`（独立 `startPiHostServer`）
  两条启动路径仍并存，可按需合并为单一入口。
- **协议层 Codex 字段归档**：`parser.ts` 仍解析客户端发送的 `codexPermissionsMode`、`set_codex_model`、
  `set_codex_speed`、`codexCliJoin` 等字段（app 契约兼容，pi 引擎忽略）。待 Flutter App 端移除这些
  字段后，可同步裁剪 parser 与对应测试。
- **端到端验证**：依赖 Flutter App（`apps/mobile`）真机/模拟器跑通完整流程（当前靠单测 + 协议契约
  契约测试保证）。

## 关键风险与依赖

- **协议兼容优先于命名洁癖**：`claudeSessionId`（`recording_list` 响应、`get_message_images`/`resume_session`
  请求）、`usage.ts` 的 `provider: "claude" | "codex" | "pi"`、parser 的 Codex 字段均为 App 契约，字段名
  保留，仅在注释中说明 pi-only 语义。
- **测试数量下降是预期**：删除 23 个 legacy 文件及其测试后，vitest 从 53 文件 1197 用例降到 43 文件
  712 用例（含 pi 原生 auto-rename 恢复新增用例），均为 pi-only 路径的有效覆盖。
- **部分验证依赖 Flutter App**（`apps/mobile`）端到端运行，当前主要靠单测与协议契约保证。
