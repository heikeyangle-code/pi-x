# UPSTREAM 基线记录

## CC Pocket（UI 壳基底，MIT）

- 仓库：https://github.com/K9i-0/ccpocket
- 基线：main 分支源码导入（2026-09-03 下载，git 基线提交 `5f20825`）
- 合并策略：
  - `git remote add upstream https://github.com/K9i-0/ccpocket.git`（已配置）
  - 上游发版后：`git fetch upstream && git merge upstream/main`（或按需 cherry-pick 关心的修复）
  - 我们的本地化删除/改动保持独立小提交，降低冲突面；合并后更新本文件基线。
- 我们不点 GitHub Fork：独立品牌；将来若需给上游提 PR，再临时 Fork。

## pi（引擎依赖，MIT）

- 仓库：https://github.com/earendil-works/pi · npm: @earendil-works/pi-coding-agent
- 更新方式：**不走 git merge**，走版本跟随管道（npm 发版 watch → pi-engine-<ver>.tgz + manifest → engines/<ver> 热换+回滚）。
- 基线调研：npm latest ≈ 0.84.4（node ≥22.19）；legacy-node20 通道 = 0.74.2 保底。
