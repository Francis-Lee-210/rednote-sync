# Rednote Sync 项目交接

更新日期：2026-08-16

## 交接目的

这份文件帮助新的 agent 快速理解项目和当前进度。用户暂时不希望新 agent 立即开始实现；第一轮应先复述对现状的理解，区分事实、推断和建议，并与用户讨论下一阶段目标。

在用户选定方向前，不修改代码、不启动真实浏览器、不读取凭据，也不请求小红书线上接口。

## 建议阅读顺序

1. [`README.md`](README.md)：工作区结构和入口。
2. [`docs/mission.md`](docs/mission.md)：项目目标、当前状态、原则和范围。
3. [`docs/design/roadmap.md`](docs/design/roadmap.md)：需求、进度、研究结论和待讨论分叉。
4. [`docs/design/product-design.md`](docs/design/product-design.md)：产品目标、Stage 3 基线和待决定方向。
5. [`projects/rednote-sync-core/README.md`](projects/rednote-sync-core/README.md)：当前可运行的离线 Core。
6. [`projects/rednote-sync-core/docs/sync-core.md`](projects/rednote-sync-core/docs/sync-core.md)：Stage 3 权威实现契约和 Stage 4 边界。
7. [`research/catalog.md`](research/catalog.md)：候选项目的固定版本审查结论。
8. [`docs/design/ai-classification.md`](docs/design/ai-classification.md)：AI 分类设计与评测计划。

详细字段、算法和调查证据以这些文档为准，不要另建一套平行规格。

## 当前状态

### 已完成

- Stage 3 离线同步核心已完成并通过独立审查，包括 SQLite canonical state、不可变对象库、确定性合并、同步状态机、失败恢复、CLI，以及 Markdown、JSON、CSV 和媒体等可重建视图。
- 2026-08-16 使用 Node `v26.0.0` 验证：`npm run check` 通过，`npm test` 为 165/165 通过。
- 已有三个 userscript 原型：收藏 Excel、点赞 Excel、点赞 JSON；曾实际取得点赞和收藏链接列表。
- 对 12 个候选仓库、1 个 Playwright 路线专题，以及 Obsidian/Notion 客户端样本完成了固定版本源码或样本审查。
- XHS-Downloader 曾在一个较新的图文小样本上无 Cookie 成功取得详情、图片和 SQLite 记录；这只是一项有限样本证据。
- AI 分类已有多维分类卡、模态路由、sidecar 和评测方案。

### 未完成或尚未验证

- 真实小红书登录、当前接口和签名、完整列表分页、真实媒体、风控信号及端到端同步尚未动态验证。
- 原型尚未证明完整分页和长期稳定性；XHS-Downloader 的单一样本结果不能外推到其他账号、内容类型或批量同步。
- AI 分类尚未实现，也未使用真实个人样本评测。
- 项目目前没有可供用户日常使用的完整采集到知识库链路。
- 没有候选项目被认定为可直接充当完整产品。

## 已确定的基线

- 本地优先；用户账号安全优先于速度和自动化。
- `note_id` 是内容稳定标识，短期 token URL 不是长期主键。
- SQLite 与不可变对象是规范事实；Markdown、JSON、CSV 和媒体目录是派生视图。
- 原始归档、同步状态和 AI 派生结果分开保存。
- Cookie、token、storage state 和浏览器 profile 均按凭据处理，不进入 Git 或公开输出。
- 不做签名破解、账号池、Cookie 池、代理池、自动换号或平台写操作。
- Stage 3 只接受严格离线输入；任何 Stage 4 在线行为都需要用户另行确认动态测试范围。

## 下一阶段待讨论方向

当前没有预先选定的实现任务或优先级：

1. 离线输入桥接：把 userscript JSON 或 XHS-Downloader SQLite/媒体转换为 `offline-input-v1`，先闭合本地链路。
2. Stage 4 在线适配器：用专用浏览器环境，小范围验证列表、详情、媒体、会话和停止条件。
3. AI 分类原型：用合成或脱敏内容包验证分类 Schema、模型路由和人工复核。
4. 使用体验：先决定用户如何启动、查看进度、处理失败和浏览知识库，再选择 CLI、Obsidian、浏览器插件或桌面应用。

建议先与用户讨论：近期最想看到的实际结果、可接受的手动步骤、是否愿意用真实账号做受监督的小样本验证、第一份可用知识库的最低能力、AI 介入时点，以及下一阶段的完成和停止条件。

## Git 与安全边界

- 仓库为本地 `main`，已建立 Stage 3 基线和文档状态提交；开始工作前运行 `git status --short` 和 `git log -5 --oneline` 获取最新状态。
- 当前没有配置 Git 远端，也没有推送。
- 不读取、复制、展示或提交 `prototypes/test-cookie.txt` 与 `prototypes/xsec_token.txt`。
- `.gitignore` 已排除上述凭据、第三方 `research/*/source/`、逆向 samples/web snapshots/outputs、虚拟环境和构建包。
- 若需要真实浏览器 profile、storage state、HAR、trace 或真实导出数据，必须先和用户确认测试授权、忽略目录、权限及保留方式。

## 可选 skills

- `grill-me` / `grilling`：用户希望通过追问和压力测试明确下一阶段目标时使用。
- `research`：选定路线后，需要核对官方资料或其他不稳定事实时使用。
- `humanizer:humanizer`：继续整理设计文档时使用，避免把建议写成已经验证的事实。
- `browser-automation`：仅在用户明确选择 Stage 4 并授权动态浏览器验证后使用。
- `handoff`：下次交接时更新本文件，使其继续反映仓库中的最新状态。

## 给新 agent 的第一轮要求

先阅读上述材料，然后只做三件事：

1. 用自己的话简要复述项目目标、已完成基线和主要缺口。
2. 说明你认为最值得讨论的 2–4 条下一步路线及各自的价值、风险和依赖。
3. 与用户讨论并等待选择；此轮不要直接实现。
