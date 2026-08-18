# Rednote Sync 工作区

Rednote Sync 用于把用户点赞和收藏的小红书帖子导出到本地，并逐步建立可搜索、可整理、可长期取用的个人资料库。

## 从哪里开始

- [项目使命](docs/mission.md)：长期目的和稳定原则。
- [当前产品设计](docs/design/product-design.md)：三个产品功能阶段和已确认边界。
- [当前路线图](docs/design/roadmap.md)：当前进度、最大阻碍和待研究问题。
- [项目交接](HANDOFF.md)：面向下一次工作的简短状态快照。
- [Agent 规则](AGENTS.md)：Agent 修改本仓库前必须遵守的文档与安全约束。

## 工作区结构

- [`projects/`](projects/)：可维护、可运行的正式实现；当前主要项目是 [Rednote Sync Core](projects/rednote-sync-core/README.md)。
- [`docs/`](docs/README.md)：当前产品、概念草案、探索方案、历史资料和决策记录。
- [`research/`](research/README.md)：第三方项目研究、跨项目专题和逆向材料。
- [`prototypes/`](prototypes/README.md)：成熟的个人脚本基础和其他尚未产品化的实验。
- [`learning/`](learning/README.md)：课程、学习记录和派生参考资料，不是产品权威来源。

## 运行 Core

```bash
cd projects/rednote-sync-core
npm run check
npm test
```

凭据、缓存、第三方本地副本和可重新生成的输出不得提交；忽略规则见 [`.gitignore`](.gitignore)。
