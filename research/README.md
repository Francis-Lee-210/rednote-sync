# Research

状态：**研究证据索引**

这里保存固定来源和范围下的项目审查、跨项目专题与逆向材料。研究可以支持产品讨论，但不能自行宣布产品决策。

## 目录

- [`catalog.md`](catalog.md)：研究对象、固定版本、状态、评级和报告入口。
- [`projects/`](projects/)：14 个第三方项目的专项研究；每个目录包含审查、来源和 checkpoint，`source/` 是被忽略的本地副本。
- [`topics/`](topics/)：跨多个项目或实验的专题综合。
- [`reverse/`](reverse/)：客户端逆向目标、报告、工具和被忽略的样本。

## 当前项目研究

| 项目 | 报告 | 项目 | 报告 |
|---|---|---|---|
| XHS-Downloader | [review](projects/xhs-downloader/review.md) | OpenCLI | [review](projects/opencli/review.md) |
| xhs-cli-export | [review](projects/xhs-cli-export/review.md) | Playwright | [review](projects/playwright/review.md) |
| xiaohongshu-cli | [review](projects/xiaohongshu-cli/review.md) | MediaCrawler | [review](projects/mediacrawler/review.md) |
| xiaohongshu-mcp | [review](projects/xiaohongshu-mcp/review.md) | ReaJason/xhs | [review](projects/reajason-xhs/review.md) |
| Playwright MCP | [review](projects/playwright-mcp/review.md) | xiaohongshu-importer | [review](projects/xiaohongshu-importer/review.md) |
| Spider_XHS | [review](projects/Spider_XHS/review.md) | XHS_ALL_IN_ONE | [review](projects/XHS_ALL_IN_ONE/review.md) |
| xhs_web_crawler | [review](projects/xhs-web-crawler/review.md) | RedCaChe | [review](projects/redcache/review.md) |

## 解释研究结论

- 评级只表示固定 revision 和既定问题下的研究或采用参考价值。
- 报告中的历史实施 Stage 1–4、实验账号限制和停止条件不自动成为当前产品要求。
- “在线探测”表示为验证未知行为而进行的研究实验，不等同于用户正常运行的在线采集。
- 当前产品权威见[产品设计](../docs/design/product-design.md)。

修改本目录前必须遵守 [`research/AGENTS.md`](AGENTS.md)。第三方源码、依赖环境、缓存和本地运行数据不得因目录整理而执行或加入 Git。
