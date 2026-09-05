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
- **路线 B（兜底）proot 完整发行版**：proot 是**用户态 root 模拟器**（ptrace 拦截系统调用，把特权操作重定向到普通文件目录，不真正提权、无需 root）。在 bionic 之上再叠加一个完整 Linux 发行版（glibc 环境），用于：
  - 运行 **glibc-only** 的桌面二进制（bionic 装不了的软件）；
  - 需要完整发行版包管理（`apt install` Ubuntu 系软件）。
- **路线 B 版本组合（2026-09-05 调研定稿）**：
  - **proot 5.1.107.92**（Termux 官方维护 fork；proot-distro 官方明确要求用 Termux fork 而非上游原版，`5.1.107-71` 起为最低要求，本版本即当前最新维护版）；
  - **proot-distro 5.8.0**（当前最新 release v5.8，纯 Python OCI 容器管理，Termux 源实时一致）；
  - **Ubuntu 26.04.1 LTS（Resolute Raccoon）**（2026-04 发布的最新 LTS，支持至 2031，作为默认发行版；proot-distro 亦支持 Debian/Arch/Alpine 等按需另装）。
- 代价：proot 有系统调用翻译开销（慢）、体积大（发行版数百 MB）、启动慢。**默认不启用**，仅当 AI 发现 bionic 源装不了目标软件时按需切到 proot 发行版执行。
- 运行时布局：路线 B 的发行版 rootfs 作为独立目录（如 `engines/proot/rootfs`），与路线 A 互不干扰，可随时下载/删除。

### 路线切换 UI 落地（默认 A，可下载/切换 B）

默认启用路线 A（bionic 直跑，开箱即用）；路线 B 在 UI 中提供**按需下载并切换**入口，不预装（省几百 MB）。

- **入口**：设置 → Pi 引擎 → "运行时路线"（`pi_engine_settings_screen.dart` 管理区新增 ListTile）。
- **RPC 算子**（`PiGateway` 新增 3 个）：
  - `runtime_status` → `{ route: "bionic" | "proot", prootInstalled: bool, rootfsSize?: bytes, installedPackages?: string[] }`
  - `runtime_install_proot` → 下载流程：`pkg install proot proot-distro` → `proot-distro install ubuntu`（26.04.1 LTS）→ rootfs 内装 node 24 + pi 引擎 + git/rg/python；进度经事件流回传（percent + stage）。
  - `runtime_switch` → 切换路线并重启引擎进程（`EngineProcess` 增加 `commandPrefix?: string[]`，路线 B 用 `proot -r <rootfs> -0 -w <cwd> -- node <entry> --mode rpc`）。
- **UI 信息设计**（两条路线差异说明 + 已装包）：
  - 页面顶部显示**当前路线徽标**（A：bionic 直跑 / B：完整发行版）+ 一键切换按钮。
  - **路线说明必须给用户看**（一行核心差异 + 点开看对比表）：A=轻快省电、内置 bionic 工具集；B=完整 Ubuntu（glibc）、能装桌面软件但更慢更占空间。默认收起对比表，避免信息过载。
  - **已装包显示**：路线 A 显示"内置最小集 + AI 已装 n 个包"；路线 B 显示"Ubuntu 26.04.1 + 已装 n 个包"，点击展开包列表（`dpkg -l` / `pkg list-installed` 结果）。不常驻展开，避免长列表刷屏。
  - **切换确认**：切 B 前提示"下载约数百 MB、速度变慢、可随时切回"；切 A 前提示"返回内置环境，proot 发行版保留可再切"。
- **回退**：两条路线 rootfs/内置集并存，切换即时生效、随时往返，不破坏任何一侧。

### 路线 B 实现阶梯（2026-09 调研定稿）

调研结论：proot+完整发行版有 ~10-15% ptrace 开销、login 20-30s、体积数百 MB；2026 年出现更快更轻的替代方案。路线 B 按"新 → 稳"两级实现，共享模型不变：

| 优先级 | 方案 | 原理 | 实测 |
|---|---|---|---|
| 1（首选） | **Proroot** | LD_PRELOAD + 二进制补丁替代 ptrace，零 ptrace 开销 | 免 root；Node 22.22/Python 3.12/Git 实测通过 |
| 2（兜底） | **proot-distro + Ubuntu** | ptrace 拦截系统调用 | 官方成熟稳定、兼容最广（GPL-3.0） |

- 统一入口：路线 B 的 `runtime_install_proot` 实际按阶梯自动选择（首选 Proroot，缺兼容再兜底 proot-distro），对 UI/协议透明。
- 参考：
  - **Proroot**（`coderredlab/proroot`，42 commits 活跃）：5 个 `.so` 文件从 GitHub Releases 下载，直接进 `jniLibs/arm64-v8a/` 打包进 APK；Android 8.0+/arm64；启动方式 `libproroot.so -r <rootfs> -0 --link2symlink -w <cwd> -- node <entry> --mode rpc`，支持 `-b <host>:<guest>` bind 共享。**风险**：源码未公开（专有，不可再分发修改版）、作者重心转 proroom（更新放缓）。
  - **proot-distro**（`termux/proot-distro`，1207 commits，官方）：`pkg install proot-distro`（自动拉 proot），Ubuntu 26.04.1 LTS 从 Docker Hub 拉取 OCI 镜像；`proot-distro login ubuntu -- /bin/sh -c '<cmd>'` 支持 `--bind` 共享。最稳兜底。
- 体积对比：Proroot ~几十 MB；proot-distro + Ubuntu 数百 MB。下载入口默认推荐方案 1（Proroot）。

### 跨路线共享模型（工作区 / 配置 / 插件 / 软件）

换路线 = 换工具链（各自独立装软件），但**用户数据全部共享同一份**。proot 用 `-b`（bind）把宿主目录挂进 rootfs 同一路径实现。

| 层 | 内容 | 路径 | 共享？ |
|---|---|---|---|
| 工作区 | 项目文件（引擎 cwd） | 项目目录 | ✅ bind 同一份 |
| pi 配置 | 会话树 / 信任 / settings / prompts / themes | `~/.pi`（`$PI_HOME ?? $HOME`） | ✅ bind 同一份 |
| **插件** | **extensions + skills** | **`~/.pi/agent/{extensions,skills}`、`.pi/{extensions,skills}`（项目）** | ✅ **bind 同一份** |
| 软件包 | node / python / git 等 | A：`$PREFIX`（bionic 包）；B：rootfs 内（apt/glibc） | ❌ 各自独立 |

**extensions/skills 细节（官方规则，双路线不变）**：
- 官方加载位置（pi 源码 `loader.ts` + `docs/skills.md`）：项目级 `.pi/extensions/` 与 `.pi/skills/`（需信任）优先，全局 `~/.pi/agent/extensions/` 与 `~/.pi/agent/skills/` 其次；`~/.agents/skills/` 亦支持。
- **代码共享**：extensions 是 TS/JS、skills 是 markdown+脚本，均为源码非二进制 → bind 共享后两条路线看到同一份，A 装的插件 B 自动可见。
- **依赖各自装**：插件的脚本/npm 依赖运行在**当前路线的 node/python** 上 → 切换路线后需在目标路线重装依赖（`npm install` / `pip install`）。与"软件包各自独立"规则一致。
- 信任模型不变：项目级插件需项目被信任（官方语义），双路线下信任状态随 `~/.pi` 共享。

**命令行**：路线 B 启动引擎时 bind 三个共享挂载点：
```bash
proot -r <rootfs> \
  -b <workspace>:/data/pi/workspace -b <workspace>:<同路径> \
  -b $PI_HOME:$PI_HOME \
  -0 -w <cwd> -- node <entry> --mode rpc
```
（挂载点原则：宿主路径与 rootfs 内路径一致，引擎无需感知差异；具体路径由安卓端运行时解析后定稿。）

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
