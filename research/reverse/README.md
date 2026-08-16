# Reverse engineering

此目录保存 Rednote2Notion 与 Rednote2Obsidian 客户端的离线静态分析材料。

- [`targets/rednote2notion/`](targets/rednote2notion/)：浏览器扩展样本、网页快照、来源记录和分析报告。
- [`targets/rednote2obsidian/`](targets/rednote2obsidian/)：Obsidian 插件工作树、网页快照、来源记录和分析报告。
- [`tools/`](tools/)：哈希锁定的只读静态提取工具及测试。
- `outputs/`：按需生成、可以重新构建的临时分析输出。

报告中的复核命令均以工作区根目录为当前目录。提取工具只把锁定样本当文本读取，不会导入或执行样本 bundle。
