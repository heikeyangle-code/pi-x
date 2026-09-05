# ENGINE-BUNDLE — 如何构建引擎包（engines/<ver>）

> 已实测（本环境，2026-09-04）：
> - `npm install --ignore-scripts @earendil-works/pi-coding-agent@0.84.4` → `pi --version` = 0.84.4；`--mode rpc` 冒烟通过（get_commands/get_state 返回正常）。
> - **0.85.0（npm latest）裸装同样通过**：`pi --version` = 0.85.0；`--mode rpc` 冒烟（get_commands/get_state）正常。
>   **无需额外安装 `@earendil-works/pi-server`**——该缺口只影响 import SDK（进程内方案）的 `dist/index.js` 静态 import 链
>   （`index.js → main.js → experimental/server.js → pi-server`，且 dependencies 未声明它）；CLI 入口是打包产物
>   `dist/bundle/cli.js`，不依赖 pi-server。若未来走进程内 SDK（ENGINE-INTEGRATION 路线 B），需 `pi-coding-agent` + `pi-server` 同版本钉死。

## 产物布局（App 运行时目录，随 APK 首启解压或首次下载）

```
engines/<ver>/                  # 例如 engines/0.85.0/
├── node_modules/               # npm ci --ignore-scripts 安装（shrinkwrap 锁死）
│   ├── .bin/pi                 # CLI 入口（Node ≥22）
│   └── @earendil-works/pi-coding-agent/…
├── manifest.json               # 见下
└── SHA256SUMS                  # 整包校验
engines/current → 0.85.0        # 原子切换符号（Android 上用目录切换+记录版本号）
```

## manifest.json

```json
{
  "version": "0.85.0",
  "requiresRuntime": ">=22.19.0",
  "publishedAt": "2026-09-04",
  "sha256": "…",
  "changelog": "https://pi.dev/docs/changelog",
  "breaking": { "settings": [], "sessionFormat": false, "notes": "" },
  "rpcSmoke": "pass"
}
```

## 构建（CI 或本机）

**推荐：一行脚本（本仓库已固化，含单测 + CI 门禁）**

```bash
# 构建（npm 安装 → pi --version 校验 → 离线 RPC 冒烟 → 打包 tgz → manifest + SHA256SUMS）
node scripts/engine-bundle.mjs build 0.85.0 --out engines
# 校验既有引擎包（version 一致性 + 离线 RPC 冒烟 + tgz sha256 对照 manifest）
node scripts/engine-bundle.mjs verify engines/0.85.0
# 查看/重写 manifest
node scripts/engine-bundle.mjs manifest engines/0.85.0
node scripts/engine-bundle.mjs manifest engines/0.85.0 --emit
```

- `build` 可选参数：`--changelog <url>`、`--breaking '<json>'`（如 `{"settings":["defaultProjectTrust"],"sessionFormat":true,"notes":"…"}`）。
- `verify` 在 manifest 缺 sha256 或 tgz 缺失时跳过 tarball 校验（staged 目录场景），其余严格失败。
- 产物：`<out>/<version>/`（node_modules + manifest.json）、`<out>/pi-engine-<ver>.tgz`、`<out>/SHA256SUMS`。
- CI（engine-smoke job）已固化：`build 0.85.0` → `verify` → `manifest` 断言 `rpcSmoke: pass` + SHA256SUMS 存在。
- 单测：`npm run test:engine-bundle`（版本/参数/manifest 校验纯逻辑，无需真实安装）。

**手动回退配方（等价于 build 子命令）**

```bash
mkdir -p engines/0.85.0 && cd engines/0.85.0
npm init -y
npm install --ignore-scripts --no-audit --no-fund @earendil-works/pi-coding-agent@0.85.0
# 校验
node_modules/.bin/pi --version
# RPC 冒烟（离线）：
printf '{"type":"get_commands","id":"c1"}\n{"type":"get_state","id":"s1"}\n' \
  | PI_OFFLINE=1 node_modules/.bin/pi --mode rpc --no-session
# 打包 + 校验和
tar -czf ../pi-engine-0.85.0.tgz .
sha256sum ../pi-engine-0.85.0.tgz > ../SHA256SUMS
```

## 运行时完整性（node + shell + 工具链，2026-09-05 定稿）

> 单独一个 Node 二进制 ≠ 完整运行时。pi 引擎本体只需 node，但 **bash 工具执行命令
> 需要 shell + 系统命令**（源码 `packages/coding-agent/src/utils/shell.ts` 解析顺序：
> `/bin/bash` → PATH 上 `bash` → `sh`，**bash 为硬依赖**）。因此 "运行时" =
> node + bash + 工具链，三者一起才算"能运行所有终端操作"。
> 这是 **bionic 精简版 Linux 运行时**：运行在 Android 的 Linux 内核上，所有二进制为
> bionic ABI（非 glibc），等价于 Termux 系的用户空间环境；桌面 Linux 的二进制不可直接使用。

### 最小工具集（随 APK 内置，aarch64 bionic）

版本来自 Termux 官方 aarch64 包索引实时抓取（2026-09-05）。

| 组件 | 版本 | 用途 |
|---|---|---|
| node（nodejs-lts） | 24.18.0-1 | pi 引擎运行时（上游 LTS 线 v24.20.0；`requiresRuntime >= 24`） |
| npm | 11.19.1 | 随 node 自带；AI 可自行 `npm i` 安装任意包 |
| bash | 5.3.15 | pi bash 工具 shell（硬依赖，`/bin/bash`） |
| coreutils | 9.11-1 | ls/cat/mv 等基础命令 |
| git | 2.55.0 | 版本操作 / 工作区 |
| ripgrep | 15.2.0 | 快速搜索 |
| apt + pkg | （Termux 系） | **包管理器：AI 自行安装/更新软件的入口**（`pkg install` / `apt update`） |
| termux-exec | 1:2.5.0-1 | 同 UID exec 补丁（bionic 必需） |
| openssl | 1:3.6.3 | TLS/HTTPS |
| ca-certificates | 1:2026.08.13 | HTTPS 信任链 |

建议内置（AI 脚本/数据分析常用）：python 3.14.6-1 + pip 26.2.1、busybox 1.38.0-1。

可选增强：curl 8.22.0、tar 1.35-3、unzip 6.0-10、openssh 10.5p1、jq 1.8.2、file 5.48-3、ruby 3.4.1、php 8.5.1、go 1.27.0、rust 1.98.1（AI 需要时随时 `pkg install`，不必全内置）。

### AI 自主装软件策略

运行时带包管理器后，pi 引擎（bash 工具）可完全自主维护环境，无需用户手动操作：

```bash
pkg install python golang    # 装新语言（Termux 官方源）
npm i -g typescript          # 装 npm 包
pip install requests         # 装 Python 包
```

- 联网时：AI 先 `apt update`，再装所需软件；全部走 Termux 官方 bionic 源。
- 离线时：仅可用随包内置的最小集；`pkg` 源可配置为内网镜像。
- 安全边界：与 pi 信任模型一致——安装动作需经审批流（extension_ui_request 确认）。

### 内置后冒烟验证（必须全过）

```bash
# 1. node + pi 引擎
node_modules/.bin/pi --version          # 0.85.0
# 2. bash 工具（pi 的 shell 解析）
bash -c 'echo ok && git --version && rg --version | head -1'
# 3. 离线 RPC 冒烟（确认 bash 工具可用：get_state 往返）
printf '{"type":"get_state","id":"s1"}\n' | PI_OFFLINE=1 node_modules/.bin/pi --mode rpc --no-session
# 4. bionic 自检
ldd --version 2>&1 | head -1            # bionic 而非 glibc
```

### 运行时版本策略

- 基线 = Node **24 LTS**（bionic），随 APK 内置；`requiresRuntime >= 24`（pi 要求 `>=22.19.0`，取 LTS 更稳）。
- 版本跟随 Termux `nodejs-lts` 包升级（上游 LTS 线，长期支持至 2028-04）。
- 新版本：启动/定时查远端 manifest → 下载（sha256 + 冒烟）→ `engines/current` 切换 + 旧版保留 2 份回滚。

### 双路线：bionic 直跑 + proot 完整发行版（并存）

两条路线**不冲突，同时保留**（见 DECISIONS #12 主路径 + 兜底 B）：

- **路线 A（默认）bionic 直跑**：内置 bionic 最小集（node/bash/工具链/apt）。轻、快、离线可用；覆盖 pi 引擎 + 绝大多数场景，AI 可用 `pkg` 自行扩展。
- **路线 B（兜底）proot 完整发行版**：proot 是**用户态 root 模拟器**（ptrace 拦截系统调用，把特权操作重定向到普通文件目录，不真正提权、无需 root）。在 bionic 之上再叠加一个完整 Linux 发行版（如 Ubuntu/Debian 的 glibc 环境），用于：
  - 运行 **glibc-only** 的桌面二进制（bionic 装不了的软件）；
  - 需要完整发行版包管理（`apt install` Ubuntu 系软件）。
- 代价：proot 有系统调用翻译开销（慢）、体积大（发行版数百 MB）、启动慢。**默认不启用**，仅当 AI 发现 bionic 源装不了目标软件时按需切到 proot 发行版执行。
- 运行时布局：路线 B 的发行版 rootfs 作为独立目录（如 `engines/proot/rootfs`），与路线 A 互不干扰，可随时下载/删除。

## App 更新流程

1. 检查 manifest（npm watch / 自有更新服务器）
2. 下载 tgz → sha256 校验 → 解压 staged
3. 冒烟（pi --version + get_state）→ `engines/current` 切换 → 旧版保留 2 份回滚

## 分发策略（定稿）：基线内置 + 新版本热更

- APK 内置基线引擎（release 锁定的版本）+ 基线 node runtime → 开箱即用、离线可用。
- 新引擎版本：启动/定时查远端 manifest → semver 对比 → 后台下载（sha256 校验 + 离线冒烟）→ current 切换 + 旧版保留 2 份回滚。
- 可选"瘦身模式"（设置：不内置、启动下载）；默认内置。
- 版本真实性三重校验：npm registry + pi.dev latest-version 双源；本地 current/manifest vs 远端 manifest；包 sha256 + pi --version 一致。
- requiresRuntime 高于当前 runtime → 提示需升级（等 APK 或 runtime 热更）。
