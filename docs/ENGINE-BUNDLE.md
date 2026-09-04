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
