# Pi X — 本地化改造计划（基于 CC Pocket MIT）

## 1. 目标

把 CC Pocket（手机遥控 Codex/Claude 的 Flutter App + Node Bridge，MIT）改造成**纯本地**的 pi 安卓壳：

- 引擎层：pi（MIT）跑在手机本地 runtime（node24 LTS + bash + 工具链），版本化热换、回滚，插件 100% 兼容 pi 原生（extensions/skills/prompts/themes、npm/git 包、trust）。
- UI/协议层：保留 CC Pocket 的会话/审批/diff/文件浏览/输入框/断线队列/恢复；**删除一切远程连接功能**（扫码、QR、mDNS、主机管理、远程 SSH、推送中与远程相关的部分）。
- 日常交互 = 原生 App 直接对话内嵌 pi 引擎（不经终端）+ **runBash 命令卡片流**（agent 执行命令/看输出/审批，必需）；真终端页（xterm.dart + 原生 PTY）**远期可选**，不内置为必须。

## 2. 本地化删除清单（按 bridge/src 实测文件清单）

### bridge（packages/bridge/src/）—— 远程功能删除
| 文件 | 处理 |
|---|---|
| `mdns.ts` + test | 删（mDNS 发现，本地不需要） |
| `firebase-auth.ts` + test | 删（远程认证） |
| `push-relay.ts` + test | 删（远程推送；如需本地通知另做） |
| `proxy.ts` + test | 删（SOCKS/远程代理） |
| `setup-launchd.ts` / `setup-systemd.ts` | 删（桌面服务安装） |
| `distribution.ts` + test | 删/替换（远程安装更新 agent → 换成我们的 pi 版本跟随管道） |
| `codex-*.ts`（process/transport/assist/permissions/app-server-config/service-tier）+ tests | 删（引擎换成 pi） |
| `claude-provider.ts` + test | 替换为 `pi-provider.ts`（形状一致：内嵌 SDK） |
| `sdk-process.ts` | 保留（通用 SDK 子进程/会话生命周期骨架，pi-provider 复用） |
| `qrcode`、`bonjour-service`、`socks`、`sharp`(原生,安卓无预编译) | 依赖移除/替换 |
| `cli.ts` 中的 QR/扫码启动输出 | 改为"本地已启动 127.0.0.1:PORT" |

保留：`websocket.ts`、`protocol-version.ts`、`protocol-contract`、`session.ts`/`sessions-index.ts`、`workspace-store.ts`、`git-operations.ts`/`worktree-*.ts`、审批/媒体/用量（按需审）。

### apps/mobile —— 删除远程 UX
- 扫码连接 / QR 扫描页、主机发现列表、手动添加主机、连接状态页 → 改为"本地引擎一键启动/状态"。
- 远程主机管理（start/stop/update over SSH）→ 删。
- 保留：会话列表、消息流、审批卡、diff 查看、文件浏览、输入框、设置。

## 3. Pi Host（新增内核工作）

```
Flutter App ──WS@127.0.0.1(JSONL, CC Pocket 协议)──▶ Pi Host(Node sidecar)
                                                        ├─ pi-provider: 内嵌 pi AgentSession
                                                        ├─ workspace 文件 API（App Dart 直读目录，diff/git 走此）
                                                        └─ runBash 命令执行卡片流（必需）；PTY 出口(远期可选)
                                                        ▼
                                             engines/<ver>/current (node24 LTS+pi, 热换回滚)
```

pi-provider 映射重点：增量文本/thinking/工具执行事件 → CC Pocket 消息；审批卡（bash/写文件）→ CC Pocket 审批流；pi JSONL 会话 ↔ bridge 会话模型；usage/cost → 用量事件。

## 4. 版本跟随（同时跟两个上游）

- **pi**：npm 发版 watch → 校验 → 重打包 engines/<ver> → manifest → 热换 + 回滚（见主设计）。
- **CC Pocket**：fork 保留上游 remote，需要时 rebase 上游 main（本地化删除用 diff 隔离，尽量不改上游核心协议文件）。

## 5. 路线图

M0 源码落地 + fork 初始化（git init，保留 upstream remote）
M1 本地化删除 + 更名（Pi X）+ 编译通过（Flutter app + bridge 单测）
M2 Pi Host：pi-provider + 本地 runtime + 版本跟随管道，端到端跑通一次对话
M3 runBash 卡片流/工作区/备份打磨；弱网队列语义本地化验证；真终端页（xterm.dart+PTY）远期可选
