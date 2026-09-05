# M2-WIRING — 把现有 Bridge 接到 Pi Host（设计）

> 策略：**不动现有 codex/claude 路径**，新增 `PI_HOST=1` 模式：websocket 客户端协议原样保留，
> 内部 agent 层换成 pi-host（每项目一个 pi --mode rpc 引擎）。干净 diff、可回退、易合上游。

> **状态（已落地）**：`PI_HOST=1` 不再替换整台服务器。`index.ts` 在同一个
> `BridgeWebSocketServer` 里注入 `PiAdapter`——只有聊天回合消息（start/input/approve/
> reject/answer/stop_session）路由到 pi 引擎；文件/工作区/git/上传下载原样保留。
> `src/pi-host/pi-adapter.ts` 为这层翻译（入站 op → `PiGateway.handleControl`/`respondUi`，
> 出站 pi 事件 → `cc-adapter` → CC Pocket `ServerMessage`），全部单测覆盖。

## 消息映射（CC Pocket 协议 ⇄ pi RPC）

### Client → Server（parseClientMessage，parser.ts 类型）

| CC Pocket 消息 | Pi Host 动作 |
|---|---|
| `start {projectPath, sessionId?, continue?, permissionMode?}` | `EnginePool.getOrStart(projectId, cwd)`；`continue` → `switch_session`；否则引擎内新建会话（`new_session`/直接 prompt） |
| `input {text}` | `prompt(message)`；引擎流式中自动加 `streamingBehavior:"steer"`（对应 CC Pocket 的 steer 语义） |
| `approve {id}` | 查该 `extension_ui_request.id` → 回 `extension_ui_response {confirmed:true}` |
| `reject {id}` | 同上 `{confirmed:false}` 或 `{cancelled:true}` |
| `answer {toolUseId, result}` | `extension_ui_response {id: toolUseId, value: result}` |
| `stop_session` | `abort`（+ 可选 `abort_bash`） |
| `list_sessions` | 项目会话 = pi JSONL 索引（`~/.pi/agent/sessions` 按项目目录）；引擎进程内可 `get_tree` 补充分支 |
| `get_history` | `get_messages` / `get_entries` |
| `get_diff` / `list_directory` / `get_usage` | 保留 bridge 现有直连 FS 实现（agent 无关） |

### Server → Client

| CC Pocket 消息 | pi 事件来源 |
|---|---|
| `status {idle/running/waiting_approval}` | 引擎 agent_start/end/settled + 未决 extension_ui_request |
| `stream_delta` | `message_update`：text_delta→文本；thinking_delta→思考块；toolcall_delta→工具参数缓冲 |
| `assistant`（整条） | `message_end.message`（权威快照） |
| `tool_result` | `tool_execution_start/update/end` + `toolcall_end.toolCall` 结果 |
| `permission_request` | `extension_ui_request{method:confirm}`（工具/扩展审批）→ UI 弹审批卡 |
| `result {cost, duration}` | `agent_settled` + `message_update.usage`/`get_session_stats` |
| `error` | response `success:false` 或 `extension_error` |
| `session_list`/`diff_result`/`directory_listing` | 现有一致（session 索引/FS） |

## 实现结构（已落地，最小改动，单服务器）

```
src/pi-host/pi-adapter.ts   ✅ 新：入站 CC 聊天 op → PiGateway 控制 + respondUi；出站 pi 事件 → CC Pocket 消息
src/websocket.ts            ✅ 小改：BridgeServerOptions.piAdapter 可选注入；handleClientMessage 顶部拦截聊天回合 op
src/index.ts                ✅ 改：PI_HOST=1 不再换整台服务器，改为普通完整服务器 + 注入 PiAdapter
src/session.ts              🔒 不改：codex/claude 路径保留（非 PI 模式）
src/pi-host/server.ts       🔒 保留：§6 直通传输仍旧导出，供直接读 pi 帧的 App 用（index.ts 不再走它）
```

> **引擎更新不受影响**：`PiAdapter` 只依赖 `PI_ENGINE_ENTRY`（pi CLI 入口）+ pi RPC 协议
> （prompt/get_state/abort/handleControl），不钉引擎版本；`engineVersion` 仅作为包在
> frame/envelope 里的版本标签。引擎换 `engines/current` 版本 → 重启引擎子进程即可，
> bridge/UI/本 adapter 接线零改动（见 ENGINE-INTEGRATION §4）。

## 验收（端到端，真机或本机）

1. `PI_HOST=1 npm run bridge` + 本地 engines/<ver> pi → App 连 127.0.0.1
2. 一次完整对话：input → stream_delta 打字机 → 工具调用 → permission_request 审批 → approve → 继续 → result
3. 会话恢复：stop/重启 bridge → `continue` 回到原会话
4. 引擎热更：换 engines/current 版本 → 新进程 `pi --version` 验证
