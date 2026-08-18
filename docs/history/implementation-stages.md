# 历史实施 Stage 1–4

状态：**历史**
适用时期：2026-08-11 至 2026-08-17

这套历史实施 Stage 1–4 描述的是“插件逆向 → 提炼协议 → 实现 Core → 再接在线采集”的研发和实施顺序，不是当前产品功能阶段。

| 历史实施阶段 | 内容 | 结果 |
|---|---|---|
| 历史实施 Stage 1 | 逆向 `rednote2obsidian` | 形成 Obsidian 插件行为、数据和输出分析 |
| 历史实施 Stage 2 | 逆向 `rednote2notion` | 补充 Notion 客户端同步、身份和协议分析 |
| 历史实施 Stage 3 | 根据逆向结果实现离线同步 Core | 已实现 SQLite canonical state、对象存储、状态机、失败恢复和派生输出 |
| 历史实施 Stage 4 | 以后实现浏览器扩展和在线采集 | 只形成研究与探索，没有完成真实在线实现 |

历史实施 Stage 3 的实现契约仍然有效，见 [Core 规格](../../projects/rednote-sync-core/docs/sync-core.md)。历史实施 Stage 1 和历史实施 Stage 2 的证据保存在[逆向报告](../../research/reverse/README.md)。

当前产品也使用“三阶段”描述功能，但含义是列表导出、内容下载、本地整理与后续操作；两套编号不能互换。
