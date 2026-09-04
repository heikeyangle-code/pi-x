# Pi X

纯本地运行的安卓 AI 编码 Agent —— 以 **pi**（earendil-works/pi，MIT）为引擎内核，UI 与交互层基于 **CC Pocket**（K9i-0/ccpocket，MIT）源码直接改造（不使用 fork 血缘，按 MIT 许可保留上游版权声明，见 `LICENSE` 与 `README.upstream.md`）。

## 项目状态（施工中）

- [x] 基线入库：CC Pocket main 源码（apps/mobile Flutter + packages/bridge Node）
- [x] **UI 本地化手术**：删除扫码/QR、机器管理、mDNS 发现、SSH 隧道等全部远端连接功能（收敛为单本机 127.0.0.1）
- [x] 更名与品牌：显示名 → Pi X
- [x] Pi Host：`pi --mode rpc` 子进程（官方 JSONL 协议）+ 薄网关（进程池/FS/帧直通，见 `docs/ENGINE-INTEGRATION.md`）
- [ ] 本地运行时：node ≥22.19 + shell；引擎版本化热换 + 回滚（跟随上游 pi 发版）
- [x] pi 兼容 UI（第一批）：系统提示词（SYSTEM.md/APPEND_SYSTEM.md 全局+项目）、启动参数开关、Provider/模型管理、扩展 UI 对话框（confirm/select/input/editor/notify）
- [ ] pi 兼容 UI（第二批）：命令面板（get_commands）、扩展/包管理 UI、trust 对话框等（见 `docs/REMOTE-AUDIT.md`、`docs/ENGINE-UI-SURFACES.md` 与 `docs/PROJECT-PLAN.md`）

## 许可

- 本项目：MIT（上游 CC Pocket MIT + pi MIT；保留各自版权声明）。
- 不使用 Aether（GPL-3.0）等任何 copyleft 代码。

## 目录

- `apps/mobile` — Flutter 客户端（改造中）
- `packages/bridge` — Node Bridge（本地化后 = Pi Host）
- `docs/` — 改造审计与计划
