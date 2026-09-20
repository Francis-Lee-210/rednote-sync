# Rednote Sync 工作区

Rednote Sync 用于把用户点赞和收藏的小红书帖子导出到本地，并逐步建立可搜索、可整理、可长期取用的个人资料库。

## 从哪里开始

| 我要做什么 | 入口与边界 |
|---|---|
| 导出点赞／收藏清单 | [Tampermonkey 脚本](prototypes/README.md#tampermonkey-脚本)：现有个人工具；全量完整性和中断恢复尚未完成工程验收。 |
| 下载／导入帖子，维护本地资料 | [个人笔记资料库工具](prototypes/note-library/README.md)：Notion／Galaxy 统一落盘；结果在 `资料库/`，尚未接入 Core。 |
| 整理帖子，探索搜索与知识库 | [Notion 归档与 OCR 原型](prototypes/notion-stage3/README.md)、[LLM Wiki 探索](docs/explorations/llm-wiki.md)、[语义资料库研究](research/topics/semantic-post-library.md)：工具与候选方案分开验收。 |
| 开发或检查离线 Core | [包说明](projects/README.md)：运行、测试、输入与输出契约。 |
| 查阅参考项目与历史证据 | [研究目录](research/catalog.md)：按当前相关、备用路线和历史证据选择入口。 |

本机帖子资料统一放在可见的 `资料库/`，包含正文、元数据、媒体、原始来源和导出记录；该目录被 Git 忽略。

- [工作入口](HANDOFF.md)：Agent 按任务选择阅读材料。
- [文档权威导航](docs/README.md)：区分已确认设计、实现契约、研究与历史。
- [当前路线图](docs/design/roadmap.md)：当前进度、最大阻碍和待研究问题。
- [Agent 规则](AGENTS.md)：Agent 修改本仓库前必须遵守的文档与安全约束。

## 工作区结构

```text
Rednote_Sync/
├── projects/       正式 Core 包：src、tests、schemas、scripts、dist、docs
├── prototypes/     列表脚本、note-library、Notion 与 LLM Wiki 原型
├── docs/           产品权威、探索、历史与决策
├── research/       参考项目、专题、逆向与实验方法
├── learning/       课程、独立学习记录与参考材料
├── 资料库/         实际正文、元数据、媒体与导出记录（Git 忽略）
└── .local/         私有运行材料与备份（Git 忽略）
```

`projects/` 现在就是 [Core 包根目录](projects/README.md)，不再嵌套同名子目录。产品设计在根目录下的 [docs/](docs/README.md)，实现契约在 [projects/docs/](projects/docs/sync-core.md)；[原型](prototypes/README.md)、[研究](research/README.md)和[学习](learning/README.md)各保留自己的用途，不混入安装包。

## 运行 Core

需要 macOS 和 Node.js 26。完整环境与命令说明见 [Core README](projects/README.md)。首次克隆后先安装锁定的开发依赖：

```bash
cd projects
npm ci --ignore-scripts
npm run check
npm test
npm run pack:check
```

本地凭据、运行数据和第三方副本的忽略规则见 [`.gitignore`](.gitignore)；默认搜索排除见 [`.rgignore`](.rgignore)。Core 的 `dist/` 是受版本控制的安装制品，按包内构建规则维护。

## 外部审阅

从 [工作入口的审阅说明](HANDOFF.md#外部-agent-审阅)开始，按固定提交检查代码、契约与测试。仓库包含自有源码、合成测试和研究说明；真实帖子库、账号会话及第三方研究副本保留在本机，不随仓库上传。历史实测的记录不代表当前线上能力已经通过验收。
