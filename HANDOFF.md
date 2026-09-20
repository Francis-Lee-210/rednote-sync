# Rednote Sync 工作入口

状态：**任务导航**。更新日期：2026-09-21。

开始工作先读 [Agent 规则](AGENTS.md)和[文档权威导航](docs/README.md)。项目进度、阻碍与下一步统一见[当前路线图](docs/design/roadmap.md)，本页只维护阅读入口。

## 按任务阅读

只进入本次任务对应的分支；长规格和报告按相关章节查阅。

| 本次任务 | 阅读入口 |
|---|---|
| 产品目的、功能范围或验收边界 | [项目使命](docs/mission.md)、[产品设计](docs/design/product-design.md) |
| 运行、修改或排查 Core | 先读 [Core README](projects/README.md)；涉及输入时读 [offline-input-v1](projects/docs/offline-input-v1.md)，涉及实现契约时查 [Core 规格](projects/docs/sync-core.md)对应章节 |
| 导入帖子、维护本地资料库工具 | [note-library 说明](prototypes/note-library/README.md)；私人批次状态由资料库自身索引及导出记录维护，与 Core 分开 |
| 维护列表脚本或本地原型 | [原型目录](prototypes/README.md)，再进入对应原型的说明与源码 |
| 讨论不同账号的职责 | [账号身份概念模型](docs/design/account-identity-model.md)；产品已确认范围仍以产品设计为准 |
| 继续 xsec 实验 | [当前优先级](docs/design/roadmap.md#当前优先级)、[实验方法与证据](research/reverse/targets/xhs-xsec-token/experiment/protocol-method.md)；操作范围及恢复条件以该实验说明为准 |
| 复核研究证据或比较参考项目 | [研究入口](research/README.md)，再选相应专题或固定版本审查 |
| 追溯旧决定、评估候选方案或学习概念 | 按需进入[历史](docs/history/README.md)、[探索](docs/explorations/README.md)或[学习](learning/README.md) |

## 外部 Agent 审阅

审阅时在请求中指定 Git commit SHA，并要求报告列出实际读取的文件、执行的检查和未覆盖的部分。先确认 Agent 能读取该提交的一份源码及其测试，再开始全项目审阅。Chat 中只收到仓库链接不等于已读取所有文件；连接不可用时，可提供同一提交的分模块文本材料，并保留原始相对路径。

按以下范围分别审阅，避免把候选设计当成已实现要求：

1. 阅读本页、文档权威导航和当前路线图，确认产品阶段、实现契约及历史资料的层级。
2. 检查 Core 的源码、契约和测试：身份归属、任务补缺、合并、存储、导出与失败恢复。运行环境为 macOS + Node.js 26，验证入口见 [Core README](projects/README.md)。
3. 检查列表 userscripts 与 [各原型](prototypes/README.md#外部审阅与离线验证)。资料库原型尚未接入 Core；Notion 导入依赖相邻的 `prototypes/notion-stage3/audit_export.py`。真实库、会话与媒体缺失是上传边界，合成测试不能替代真实平台验收。
4. 按问题查阅研究报告和历史证据；第三方源码副本、逆向样本及实验运行材料不在仓库中，无法仅凭此仓库复核其全部外部证据。

默认只审阅和运行离线合成检查。账号登录、平台采集与写回需要独立授权。每项发现请注明文件位置、触发条件、影响、证据和修复建议，区分已确认缺陷、待验证疑点与设计建议。

首次 GitHub 上传的环境、离线测试和覆盖限制见[2026-09-21 审阅准备记录](docs/history/2026-09-21-github-review-preparation.md)。记录中的历史测试结果应与审阅提交对应，后续代码改变后按受影响范围重跑。
