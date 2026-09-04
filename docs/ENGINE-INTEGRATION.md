# ENGINE-INTEGRATION — pi 接入最完美方案（调研结论）

> 结论先行：**引擎 = `pi --mode rpc` 子进程（官方 JSONL 协议），Pi Host = 薄网关**。
> 不内嵌 AgentSession 到 bridge（除非未来需要扩展自定义 GUI 组件）。

## 1. 两条路线对比（基于 pi 0.84.x 官方文档与源码）

| 维度 | A. `pi --mode rpc` 子进程（推荐） | B. bridge 进程内嵌 AgentSession |
|---|---|---|
| 引擎引导（扩展加载/信任/settings/providers/会话/模型目录） | pi CLI 现成，零重写 | 需自己复用 pi 内部 API 重写引导（Aether 就是这么啃的） |
| 版本跟随（每次 pi 更新安卓跟上） | **进程边界 = 版本隔离**：换 engines/<ver> 引擎包 + 重启子进程即可，bridge/UI 零改动 | bridge 与 pi 版本耦合，每次发版要重编译 bridge + 回归 |
| 审批/交互（ctx.ui） | **官方 Extension UI Protocol**：select/confirm/input/editor/notify/setStatus… 作为 JSON 请求发到 stdout，App 应答 | 需注入自定义 ExtensionUIContext（无官方协议文档） |
| 流式事件 | 官方 message_update（text/thinking/toolcall 各 delta + 累计 usage） | AgentSession 事件（同样丰富，但无协议文档） |
| 额外收益 | 稳定、文档化、命令全（见下） | 进程内 setWidget/setTitle 等深度定制（远期） |
| 代价 | 每会话一个引擎进程（手机端做进程池/空闲回收） | 内核引导耦合 pi 内部 API，版本漂移风险大 |

**结论**：A 在"官方支持、零内核重写、版本解耦"三方面全胜；B 的唯一增量（扩展自定义 GUI 组件）与移动端 GUI 无关（TUI custom() 在 RPC 下本就不可用）。→ 选 A。

## 2. 目标拓扑

```
Flutter App ──(CC Pocket 协议, ws@127.0.0.1)──▶ Pi Host(Node, 稳定层)
                                                   │ 每项目/会话组一个引擎子进程
                                                   ▼
                                     pi --mode rpc（stdio JSONL，engines/<ver>/current）
                                                        │ 官方协议全覆盖：
                                                        │ prompt/steer/follow_up/abort
                                                        │ model/thinking 切换
                                                        │ bash/abort_bash
                                                        │ 会话: tree/fork/clone/switch/export
                                                        │ Extension UI: confirm/select/input/editor/notify
```

## 3. 能力覆盖映射（CC Pocket UX ↔ pi RPC）

| 需要 | pi RPC 命令/事件 |
|---|---|
| 消息流式渲染 | `message_update`：text_start/delta/end、thinking_*、toolcall_*、累计 usage |
| 审批卡（bash/写文件/危险命令） | Extension UI：`confirm`/`select`/`input`（`extension_ui_request`/`response`） |
| 命令执行进度 | `bash` + `bash_execution_update`、`tool_execution_start/update/end` |
| 中途打断/插话 | `steer`、`follow_up`、`abort`、`clear_queue`、queue 模式 |
| 模型/思考切换 | `set_model`/`cycle_model`/`get_available_models`；thinking 三件套 |
| 会话树/分支 | `get_tree`、`fork`、`clone`、`switch_session`、`get_messages`、`get_entries` |
| 压缩/重试 | `compact`/`set_auto_compaction`；`set_auto_retry`/`abort_retry` |
| 用量/成本 | message_update.usage + `get_session_stats` |
| 状态/恢复 | `get_state`、会话 JSONL 由 pi 管理 |
| 扩展错误 | `extension_error` |

样例帧（官方格式，已核对）：
- 流式：`{"type":"message_update","usage":{...},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Hello"}}`
- 审批：`{"type":"extension_ui_request","id":"uuid-2","method":"confirm","title":"Clear session?","message":"...","timeout":5000}` → 应答 `{"type":"extension_ui_response","id":...,"confirmed":true}`

## 4. 版本跟随（每次 pi 更新 → 安卓跟上）

1. watch npm：`@earendil-works/pi-coding-agent` 发版
2. CI 构建引擎包：`npm ci --ignore-scripts` → 产出 `engines/<ver>/`（含 pi CLI + shrinkwrap）→ manifest{version, requiresRuntime, sha256, breaking}
3. **RPC 冒烟门禁（每个版本必跑）**：prompt 回声、set_model、一次 confirm 审批回路、流式 text_delta 接收、session tree/fork —— 协议漂移在发版前暴露
4. App 更新器：下载 → 校验 → 切 `engines/current` → 重启引擎子进程 → 旧版回滚保留
5. 引擎子进程按需拉起/空闲回收；`PI_SKIP_VERSION_CHECK=1` 常驻

## 5. 注意事项

- 并行会话（git worktree）→ Pi Host 按 project 管理多个引擎子进程（复用 CC Pocket worktree-store 概念）
- 文件能力在本地路径闭环：工作区/文件浏览走 App Dart 直读目录（最快最省），diff 查看、git 操作与受信任写回依托 Pi Host 直连 FS；**无远端引擎 → 远端文件 API 整个移除**
- 命令执行 = **runBash 卡片流（必需）**始终为主；真终端（xterm.dart + 原生 PTY）**远期可选**，不内置为必须
- RPC 无 `ctx.ui.custom()`/TUI 键盘组件 → GUI 不依赖，无需支持
- 扩展的 `notify`/`setStatus`/`setTitle` → 映射为 App 内通知/状态条/标题
- 若未来需要进程内扩展 GUI（setWidget 级别）→ 再评估 AgentSession 内嵌（B），届时 pi-provider 作为独立 bundle 维护

## 6. 决策修订：wire = pi 直通（薄转发），映射表降级为可选过渡

- 长期目标：Pi Host = 薄网关（进程池 + FS 操作 + **pi 帧直通**），App 直接消费 pi 事件模型
  （message_update text/thinking/toolcall delta、extension_ui_request、agent_*、compaction…）——
  与引擎 1:1、单一版本维度、无双重翻译。
- 映射表（M2-WIRING）仅作"复用上游 CC Pocket UI"的过渡路径，不作为最终形态。
- 帧 envelope：`{engineVersion, protocolVersion}` + manifest。App 按版本前向兼容；
  事件契约冒烟（get_commands/prompt/审批回路字段断言）进版本管道；破坏性协议变化走
  `breaking.protocol` → 客户端适配版随引擎一起发。
