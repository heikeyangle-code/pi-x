# PI-ONLY-STATUS — “只连本地 pi、去掉 codex/claude”实施进度

> 目标：CC Pocket（bridge）只连**本地的 pi 引擎**，codex/claude 不再作为对话引擎被拉起，
> 所有 CC 功能（对话、文件、工作区、git、历史、用量、上传下载、会话列表）都落在本地 pi 上。
> 本文记录已做、未做，作为后续阶段执行的依据。配合 `docs/M2-WIRING.md`、
> `docs/ENGINE-INTEGRATION.md`、`docs/ENGINE-BUNDLE.md` 阅读。

## 一句话现状

**对话、会话列表、会话历史、最近会话、会话改名全部走本地 pi；文件/工作区/git/上传下载本就是本地直连；
入口已强制 pi-only，Firebase 推送中继已删除。** 剩余 codex/claude provider 源码与依赖尚未物理删除，
但运行时路径已全部绕开（PI_HOST=1 下不再实例化任何 codex/claude 引擎）。

## 已完成（带提交与验证）

| 项 | 说明 | 提交 |
|---|---|---|
| 对话引擎切 pi | 同一个 `BridgeWebSocketServer` 内注入 `PiAdapter`，`start/input/approve/reject/answer/stop_session` 路由到 pi（`PiGateway` + `engine-pool`）；文件/工作区/git/上传下载原样走原实现 | 先前 pi 接入提交 |
| 消息契约对齐 App | 重写 `cc-adapter` 出站映射，产出与 App `ServerMessage.fromJson` 严格兼容的规范字段（`status.status`、`stream_delta/thinking_delta.text`、`assistant.message.content`、`tool_result.toolUseId/content`、`permission_request.toolUseId/toolName/input`）；`PiAdapter.start` 兼容真实 wire 的 `projectPath` | `000068e` |
| 入口强制 pi-only | `index.ts` 去掉 `PI_HOST` 开关：无条件构造 `PiAdapter`，缺 `PI_ENGINE_ENTRY` 直接拒启，codex/claude 不再可作为对话引擎启动 | `0486160` |
| 会话表面切 pi | 新增 `pi-host/pi-sessions.ts`：pi `AgentMessage[]` → CC 历史消息转换、`~/.pi/agent/sessions` JSONL 解析与最近会话扫描、运行时 `PiSessionRegistry`；`websocket.ts` 的 `list_sessions` / `list_recent_sessions` / `get_history` / `get_history_delta` / `get_session_context` / `resume_session` / `resolve_session_link` / `rename_session` 全部改由 pi 引擎 + pi 会话目录供给 | 本次 |
| 会话回放兼容 App | `get_history` 返回 `user_input/assistant/tool_result` 严格字段；`resume_session` 复用同一 sessionId 供 `get_history`/`input` 关联；`session_created` + `status` 让 App 正确导航与就绪 | 本次 |
| 历史磁盘回退 | 引擎内存未加载会话时（`get_messages` 为空），`get_history`/`get_history_delta` 直接解析 `~/.pi/agent/sessions/<proj>.jsonl` 回放（`piSessionFileToHistoryMessages`），列表里每个会话都能完整回放 | 本次 |
| 引擎失败反馈 | `isFailedEngineResponse` 把引擎失败（如无 provider）转成 CC `error` 消息，App 不再无响应挂起 | 本次 |
| 健康检查 pi-only | `doctor.ts` 只查 pi 引擎（`PI_ENGINE_ENTRY` + 凭据），去掉 claude/codex CLI、Tailscale、Firebase、Keychain 检查 | 先前 |
| 用量 pi-only | `usage.ts` 去掉 codex 磁盘扫描，改为报告本地 pi 引擎 | 先前 |
| mDNS 关闭 | `mdns.ts` 默认不再广播 LAN 服务 | 先前 |
| 移除 Firebase 推送中继 | 删除 `firebase-auth.ts`、`push-relay.ts`、`push-i18n.ts` 及测试；`index.ts` 不再初始化 Firebase Anonymous Auth；`websocket.ts` 删除 `push_register`/`push_unregister` 处理与全部推送通知路径；App 侧 `push_registration_result` 协议仍保留解析（bridge 不再发送） | 本次 |
| 单元测试 | `pi-sessions.test.ts` 21 个用例（历史转换/JSONL 解析/扫描/注册表）；`pi-adapter.test.ts` 覆盖 `session_created` 与状态流 | 本次 |
| 验证 | `tsc --noEmit` 0 错误；bridge 全量 vitest 53 文件 1197 通过 | 本次 |

## 未完成

### 阶段 3：codex/claude 的 provider 源码与依赖尚未删除

与 codex/claude 深度耦合、尚未删除的源码文件：

- 引擎进程/Provider：`sdk-process.ts`、`claude-provider.ts`、`codex-process.ts`、
  `codex-transport.ts`、`codex-assist.ts`、`codex-permissions.ts`、`codex-app-server-config.ts`、
  `codex-service-tier.ts`、`resume-metrics.ts`。
- 运行时耦合：`session.ts`（SessionManager：历史、排队输入、worktree 并行会话、resume 都挂
  claude/codex，删除前必须先切到 pi，否则编译失败）。
- 依赖：`package.json` 中 `@anthropic-ai/claude-agent-sdk` 等。
- 对应测试：`sdk-process.test.ts`、`claude-provider.test.ts`、`codex-*.test.ts`、
  `session.test.ts`、`usage.test.ts`、`sessions-index.test.ts`、`resume-metrics.test.ts`、`doctor.test.ts` 等。
- 双入口待收敛：`index.ts`（piAdapter）与 `pi-host-entry.ts`（独立 `startPiHostServer`）。

## 关键风险与依赖

- **删除 provider 前必须确认运行时已全部绕开**：会话表面已切 pi，但 `session.ts` 的 SessionManager
  仍被非会话功能（工作区持久化、debug 事件、录音）引用，直接删 codex/claude 需先拆解这些引用，
  否则编译失败。
- 阶段 3 是数千行重构，按“每步 tsc + 全量 vitest 守绿、逐次提交”推进，不一次莽删。
- 部分验证依赖 Flutter App（`apps/mobile`）端到端运行，当前主要靠单测与协议契约保证。
