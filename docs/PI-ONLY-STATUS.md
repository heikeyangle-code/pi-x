# PI-ONLY-STATUS — “只连本地 pi、去掉 codex/claude”实施进度

> 目标：CC Pocket（bridge）只连**本地的 pi 引擎**，codex/claude 不再作为对话引擎被拉起，
> 所有 CC 功能（对话、文件、工作区、git、历史、用量、上传下载）都落在本地 pi 上。
> 本文记录已做、未做，作为后续阶段执行的依据。配合 `docs/M2-WIRING.md`、
> `docs/ENGINE-INTEGRATION.md`、`docs/ENGINE-BUNDLE.md` 阅读。

## 一句话现状

**对话已走本地 pi、文件/工作区/git/上传下载本就是本地直连；入口已强制 pi-only，codex/claude
不再能作为对话引擎被拉起。** 但 codex/claude 的 provider 源码与依赖尚未物理删除，
会话历史/用量/会话列表的数据源仍是 claude/codex 磁盘，尚未切到 pi。

## 已完成（带提交与验证）

| 项 | 说明 | 提交 |
|---|---|---|
| 对话引擎切 pi | 同一个 `BridgeWebSocketServer` 内注入 `PiAdapter`，`start/input/approve/reject/answer/stop_session` 路由到 pi（`PiGateway` + `engine-pool`）；文件/工作区/git/上传下载原样走原实现 | 先前 pi 接入提交 |
| 消息契约对齐 App | 重写 `cc-adapter` 出站映射，产出与 App `ServerMessage.fromJson` 严格兼容的规范字段（`status.status`、`stream_delta/thinking_delta.text`、`assistant.message.content`、`tool_result.toolUseId/content`、`permission_request.toolUseId/toolName/input`）；`PiAdapter.start` 兼容真实 wire 的 `projectPath` | `000068e` |
| 入口强制 pi-only | `index.ts` 去掉 `PI_HOST` 开关：无条件构造 `PiAdapter`，缺 `PI_ENGINE_ENTRY` 直接拒启，codex/claude 不再可作为对话引擎启动 | `0486160` |
| 验证 | `tsc --noEmit` 0 错误；bridge 全量 vitest 1214 通过；`main` 与远端一致 | `0486160` |
| 文档 | `M2-WIRING.md`（规范消息映射 + pi-only 说明）、`ENGINE-INTEGRATION.md`（pi-only 状态）已同步 | `0486160` |

## 未完成

### 阶段 2：会话索引 / 历史 / 用量 仍在读 claude/codex 磁盘

以下功能的数据源还是 codex/claude 本地 JSONL，尚未换成 pi 会话：

- `sessions-index.ts`：读 `~/.claude` / `~/.codex` 的会话 JSONL，供给 `list_sessions` / 历史索引。
- `usage.ts`：读 codex 会话与 claude 用量，供给 `get_usage` 与 HTTP `/usage`。
- `websocket.ts`：`list_sessions`、`get_history`、`get_usage` 走 `SessionManager`（内部挂 claude/codex）。
- `/doctor`：`runDoctor` 仍检查 codex/claude 状态。

需要先确认/搭建 pi 侧的会话索引与用量/成本后端（pi RPC 的 `get_tree`/`get_messages`/`get_session_stats`，
或 `~/.pi/agent/sessions` 的 JSONL），再改数据源。

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

- **删除 provider 前必须先做完阶段 2 的运行时切换**：`session.ts` 的 SessionManager 是 CC 运行时，
  直接删 codex/claude 会编译失败并丢失历史/并行会话/resume，与“所有功能都能用”矛盾。
- 阶段 2+3 是数千行重构，按“每步 tsc + 全量 vitest 守绿、逐次提交”推进，不一次莽删。
- 部分验证依赖 Flutter App（`apps/mobile`）端到端运行，当前主要靠单测与协议契约保证。