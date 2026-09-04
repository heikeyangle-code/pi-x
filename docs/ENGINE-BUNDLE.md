# ENGINE-BUNDLE — 如何构建引擎包（engines/<ver>）

> 已实测（本环境）：`npm install --ignore-scripts @earendil-works/pi-coding-agent@0.84.4`
> → `pi --version` = 0.84.4；`--mode rpc` 冒烟通过（get_commands/get_state 返回正常）。

## 产物布局（App 运行时目录，随 APK 首启解压或首次下载）

```
engines/<ver>/                  # 例如 engines/0.84.4/
├── node_modules/               # npm ci --ignore-scripts 安装（shrinkwrap 锁死）
│   ├── .bin/pi                 # CLI 入口（Node ≥22）
│   └── @earendil-works/pi-coding-agent/…
├── manifest.json               # 见下
└── SHA256SUMS                  # 整包校验
engines/current → 0.84.4        # 原子切换符号（Android 上用目录切换+记录版本号）
```

## manifest.json

```json
{
  "version": "0.84.4",
  "requiresRuntime": ">=22.19.0",
  "publishedAt": "2026-08-28",
  "sha256": "…",
  "changelog": "https://pi.dev/docs/changelog",
  "breaking": { "settings": [], "sessionFormat": false, "notes": "" },
  "rpcSmoke": "pass"
}
```

## 构建（CI 或本机）

```bash
mkdir -p engines/0.84.4 && cd engines/0.84.4
npm init -y
npm install --ignore-scripts --no-audit --no-fund @earendil-works/pi-coding-agent@0.84.4
# 校验
node_modules/.bin/pi --version
# RPC 冒烟（离线）：
printf '{"type":"get_commands","id":"c1"}\n{"type":"get_state","id":"s1"}\n' \
  | PI_OFFLINE=1 node_modules/.bin/pi --mode rpc --no-session
# 打包 + 校验和
tar -czf ../pi-engine-0.84.4.tgz .
sha256sum ../pi-engine-0.84.4.tgz > ../SHA256SUMS
```

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
