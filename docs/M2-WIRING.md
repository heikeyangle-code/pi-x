# M2-WIRING — 把现有 Bridge 接到 Pi Host（设计）

> 策略：**不动现有 codex/claude 路径**，新增 `PI_HOST=1` 模式：websocket 客户端协议原样保留，
> 内部 agent 层换成 pi-host（每项目一个 pi --mode rpc 引擎）。干净 diff、可回退、易合上游。

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

## 实现结构（新增文件，改动最小）

```
src/pi-host/                     ← 已有：engine-process/pool/rpc/surfaces/index
src/pi-adapter.ts   (新)         输入消息 → EnginePool + rpc.* ；输出 pi 事件 → ServerMessage
src/websocket.ts    (小改)       if (process.env.PI_HOST === "1") 走 PiAdapter 分支
src/session.ts      (不改)       codex/claude 路径保留（非 pi 模式）
```

## 验收（端到端，真机或本机）

1. `PI_HOST=1 npm run bridge` + 本地 engines/<ver> pi → App 连 127.0.0.1
2. 一次完整对话：input → stream_delta 打字机 → 工具调用 → permission_request 审批 → approve → 继续 → result
3. 会话恢复：stop/重启 bridge → `continue` 回到原会话
4. 引擎热更：换 engines/current 版本 → 新进程 `pi --version` 验证
