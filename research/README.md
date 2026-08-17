# Research

这里集中保存项目调研、第三方源码快照和逆向分析材料，不属于正式产品源码或发布包。

- [`catalog.md`](catalog.md)：研究对象总目录、状态和结论索引。
- [`reverse/`](reverse/)：客户端样本、网页快照、静态分析工具与报告。
- [`xhs-downloader/review.md`](xhs-downloader/review.md)：XHS-Downloader 固定 revision 的专项源码审查；同目录保存来源和中断恢复记录，`source/` 为忽略的第三方本地副本。
- [`opencli/review.md`](opencli/review.md)：OpenCLI 固定 revision 的专项源码审查；重点覆盖 XHS adapter、Browser Bridge、daemon、敏感数据、插件与供应链边界。
- [`xhs-cli-export/review.md`](xhs-cli-export/review.md)：xhs-cli-export 固定 revision 的专项源码审查；重点覆盖 partial JSONL、水位/seen 语义、Markdown/媒体、provider 与供应链边界。
- [`playwright/review.md`](playwright/review.md)：Playwright 固定 revision 的专项源码审查；重点覆盖 Context/profile、storage state、网络/下载、HAR/Trace、安全与供应链边界。
- [`xiaohongshu-cli/review.md`](xiaohongshu-cli/review.md)：xiaohongshu-cli 固定 revision 的专项源码审查；重点覆盖访问材料、Schema/分页、Cookie/QR 身份、重试/风控、Agent 权限和许可证边界。
- [`mediacrawler/review.md`](mediacrawler/review.md)：MediaCrawler 固定 revision 的专项源码审查；重点覆盖获取分层、访问材料、分页/媒体/checkpoint、浏览器/风控、WebUI/API、供应链与许可证边界。
- [`xiaohongshu-mcp/review.md`](xiaohongshu-mcp/review.md)：xiaohongshu-mcp 固定 revision 的专项源码审查；重点覆盖数据/媒体契约、MCP/REST 能力、Cookie/会话、Agent Skill、浏览器制品链与许可证边界。
- [`reajason-xhs/review.md`](reajason-xhs/review.md)：ReaJason/xhs 固定 revision 的专项源码审查；重点覆盖访问材料、分页/媒体、checkpoint缺口、Cookie/签名服务、平台写与供应链边界。
- [`playwright-mcp/review.md`](playwright-mcp/review.md)：Playwright MCP 固定 revision 的专项源码审查；重点覆盖薄包装层与 core provenance、工具/会话/文件/secret 能力、HTTP 暴露、供应链及 Stage 4 适配边界。
- [`xiaohongshu-importer/review.md`](xiaohongshu-importer/review.md)：xiaohongshu-importer 固定 revision 的专项源码审查；重点覆盖 Obsidian 输出 UX、页面解析、媒体/状态缺口、安全边界、供应链和独立 projector 适配判断。
- [`Spider_XHS/review.md`](Spider_XHS/review.md)：Spider_XHS 固定 revision 的专项源码审查；重点覆盖分页/访问材料、详情/媒体/恢复、远端程序与会话、平台写、Docker和许可边界。
- [`XHS_ALL_IN_ONE/review.md`](XHS_ALL_IN_ONE/review.md)：XHS_ALL_IN_ONE 固定 revision 的专项源码审查；重点覆盖 Adapter/内容/资产/Task、SSE 与 checkpoint 缺口、账号/安全、自动运营/发布、供应链和许可边界。
- [`xhs-web-crawler/review.md`](xhs-web-crawler/review.md)：xhs_web_crawler 固定 revision 的专项源码审查；评级由 D 调整为 B，重点覆盖原生 MV3 点击/滚动状态机、现有 userscript 互补方式、长任务 checkpoint、HAR/CDP 接线与插件升级边界。
- [`redcache/review.md`](redcache/review.md)：RedCaChe 固定 revision 的专项源码审查；重点区分纯 Chrome 扩展与旧 Playwright/SQLite 服务，覆盖 saved 导入、本地人工 review、状态/恢复、平台写审批、Obsidian、权限与许可边界。
- [`topics/playwright-human-like-route.md`](topics/playwright-human-like-route.md)：Playwright 浏览器路线综合专题；区分确定性浏览器能力、Agent 合成探索、人类真实账号诊断、生产只读 Adapter、硬停止和人工恢复，并明确排除“模拟人工可降低风控”的无证据主张。

研究材料按当前工作区状态原样保留，可能包含第三方 Git 历史、依赖环境、运行数据和缓存。不要把其中的代码自动视为第一方实现，也不要在未核对来源、许可和运行边界前执行第三方样本。
