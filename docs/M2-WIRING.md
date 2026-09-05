# M2-WIRING — 把现有 Bridge 接到 Pi Host（设计）

> 策略：**不动现有 codex/claude 路径**，新增 `PI_HOST=1` 模式：websocket 客户端协议原样保留，
> 内部 agent 层换成 pi-host（每项目一个 pi --mode rpc 引擎）。干净 diff、可回退、易合上游。

> **状态（已落地）**：`PI_HOST=1` 不再替换整台服务器。`index.ts` 在同一个
> `BridgeWebSocketServer` 里注入 `PiAdapter`——只有聊天回合消息（start/input/approve/
> reject/answer/stop_session）路由到 pi 引擎；文件/工作区/git/上传下载原样保留。
> `src/pi-host/pi-adapter.ts` 为这层翻译（入站 op → `PiGateway.handleControl`/`respondUi`，
> 出站 pi 事件 → `cc-adapter` → CC Pocket `ServerMessage`），全部单测覆盖。

## 消息映射（CC Pocket 协议 ⇄ pi RPC）

### Client → Server（已收编到 pi 的范围以 `PiAdapter.accepts` 为准）

| CC Pocket 消息 | 状态 | Pi Host 动作 |
|---|---|---|
| `start {projectId, projectPath}` | ✅ 收编 | `Adapter.handle`：`bind` socket→project + `get_state` 预热引擎 + 回 `status{idle}`；引擎进程随首个 `input` 启动 |
| `input {text}` | ✅ 收编 | `prompt(message)`（`inboundToActions` → gateway `handleControl{op:"prompt"}`） |
| `approve {id}` | ✅ 收编 | `respondUi(id, {confirmed:true})` 回答对应 `extension_ui_request` |
| `reject {id}` | ✅ 收编 | `respondUi(id, {confirmed:false})` |
| `answer {toolUseId, result}` | ✅ 收编 | `respondUi(toolUseId, {value:result})` |
| `stop_session` | ✅ 收编 | `handleControl{op:"abort"}`（中断当前生成，若需停引擎则用 `abort`+`pool.stop`） |
| `list_sessions` / `get_history` | 🔒 保留 bridge | 未收编（不走 pi 引擎）；注意：PI 模式下由 bridge 原 session 索引（codex/claude）响应，可能为空 |
| `get_diff` / `list_directory` / `get_usage` | 🔒 保留 bridge | 直连 FS，agent 无关（原实现不变） |

### Server → Client（`cc-adapter.piFrameToServerMessages` 实际落地子集）

| CC Pocket 消息 | pi 事件来源 | 状态 |
|---|---|---|
| `status {status: idle/running}` | `agent_start`→running；`agent_settled`/`agent_end`/`engine_exit`→idle | ✅ 已落地 |
| `stream_delta {text}` / `thinking_delta {text}` | `message_update.assistantMessageEvent`：`text_delta`→`stream_delta{text}`，`thinking_delta`→`thinking_delta{text}`；`text_end`→`assistant{ message.content:[{type:text,text}] }`（`text_start`/`thinking_start` 不产消息，流从首个 delta 起） | ✅ 已落地 |
| `tool_result {toolUseId, content}` | `toolcall_start/end`（`toolCall`）、`tool_execution_start/end`、`bash_execution_update`（content=delta） | ✅ 已落地 |
| `permission_request {toolUseId, toolName, input}` | `extension_ui_request{method:confirm}`（工具/扩展审批）→ UI 弹审批卡 | ✅ 已落地 |
| `result {cost, duration}` | `agent_settled` + usage/get_session_stats | ⬜ 未映射（后续加） |
| `error` | response `success:false` / `extension_error` | ⬜ 未映射（后续加） |
| `session_list`/`diff_result`/`directory_listing` | session 索引 / FS（bridge 直连） | 🔒 原实现不变 |

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
