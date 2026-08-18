# Rednote Sync 项目交接

更新日期：2026-08-18

这是一份简短状态快照，不是产品或实现权威。Agent 的强制规则见 [`AGENTS.md`](AGENTS.md)。

## 阅读顺序

1. [项目使命](docs/mission.md)
2. [当前产品设计](docs/design/product-design.md)
3. [当前路线图](docs/design/roadmap.md)
4. [Core README](projects/rednote-sync-core/README.md)与[实现规格](projects/rednote-sync-core/docs/sync-core.md)
5. 只有任务需要时再进入[探索](docs/explorations/README.md)、[历史](docs/history/README.md)或[研究](research/README.md)

## 当前快照

- 个人 MVP 是导出 2000 多条点赞/收藏帖子并在本地整理取用。
- 产品阶段一已有成熟 userscript 基础，但全量完整性和恢复尚未正式验收。
- 产品阶段二是当前最大阻碍；主号、小号和其他账号三条路线的风险与效率都未验证。
- 产品阶段三的本地整理方案尚未明确；平台写回只是新构想。
- 历史实施 Stage 3 的离线 Core 已完成，当前仍采用单账号输入和同步模型。
- 14 个第三方项目研究已迁入 `research/projects/`；专题和逆向材料分别位于 `research/topics/` 与 `research/reverse/`。

## 工作边界

- 开始修改前先检查 `git status --short`，确认工作区没有未提交的他人改动。
- 不读取或展示原型凭据、浏览器 profile、storage state、HAR 或第三方本地运行数据。
- 不把探索或研究结论表述成用户已经确认的产品设计。
- 未经用户明确要求，不访问真实平台、不修改 Core 协议或代码、不提交 Git。
