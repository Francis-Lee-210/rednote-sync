# 产品文档

这里保存 Rednote Sync 的产品权威、概念草案、候选探索和历史背景。具体实现契约保存在 `projects/docs/`，不在本目录重复定义。

`design/` 只保存当前产品权威和概念草案；候选方案、日期化历史分别进入 `explorations/`、`history/`。

先用[当前路线图](design/roadmap.md)确认进度，再按下面的问题选择文档；具体任务入口见[工作入口](../HANDOFF.md)。表中的文档按需查阅。

## 权威入口

| 文档 | 状态 | 回答的问题 |
|---|---|---|
| [项目使命](mission.md) | 当前权威 | 为什么做、成功意味着什么 |
| [产品设计](design/product-design.md) | 当前权威 | 当前三个产品功能阶段是什么 |
| [当前路线图](design/roadmap.md) | 当前权威 | 已完成什么、当前阻碍和待研究问题是什么 |
| [账号身份概念模型](design/account-identity-model.md) | 概念草案，标明已实现边界 | 账号角色如何区分，哪些已在 Core 实现 |
| [Core 实现规格](../projects/docs/sync-core.md) | 已实现契约 | 当前离线 Core 实际怎样工作 |

## 其他材料

- [探索方案](explorations/README.md)：浏览器采集、AI 分类等未确认方案。
- [历史资料](history/README.md)：旧的历史实施 Stage 1–4、早期产品设计和早期路线图。
- [决策记录](decisions/README.md)：已经确认的跨文档治理决定。
- [术语表](glossary.md)：产品阶段、历史实施阶段、在线采集和在线探测等术语。
- [研究目录](../research/README.md)：固定来源和版本下的证据，不是产品决策。

修改本目录前必须遵守 [`docs/AGENTS.md`](AGENTS.md)。
