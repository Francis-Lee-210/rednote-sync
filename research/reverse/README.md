# Reverse engineering

状态：**研究证据与实验工具索引**。两个客户端逆向对应历史实施 Stage 1 和历史实施 Stage 2；后续 xsec 实验单独记录，不使用历史实施阶段编号代替当前产品阶段。

此目录保存 Rednote2Notion 与 Rednote2Obsidian 客户端的离线静态分析材料，以及 xsec 协议登录与搜索发现实验工具。当前产品状态见[路线图](../../docs/design/roadmap.md)。

- [`targets/rednote2notion/`](targets/rednote2notion/)：浏览器扩展样本、网页快照、来源记录和分析报告。
- [`targets/rednote2obsidian/`](targets/rednote2obsidian/)：Obsidian 插件工作树、网页快照、来源记录和分析报告。
- [`targets/xhs-xsec-token/experiment/`](targets/xhs-xsec-token/experiment/README.md)：自有协议登录与搜索发现实验。操作范围及逐次结果见[方法与证据](targets/xhs-xsec-token/experiment/protocol-method.md)和[时间线](targets/xhs-xsec-token/timeline.md)；当前产品进度见[路线图](../../docs/design/roadmap.md)。本索引不重复维护实验状态。
- [`tools/`](tools/)：哈希锁定的只读静态提取工具及测试。
- `outputs/`：按需生成、可以重新构建的临时分析输出。

报告中的复核命令均以工作区根目录为当前目录。提取工具只把锁定样本当文本读取，不会导入或执行样本 bundle。
