# Rednote Sync 研究目录

状态：**研究证据索引** · 整理日期：2026-09-19

从问题对应的报告按需阅读。产品决策以[文档权威地图](../docs/README.md)为准，项目进度以[路线图](../docs/design/roadmap.md)为准；这里的评级只对应固定 revision 和既定审查范围。

先选阅读层：[当前相关](#当前相关) · [备用路线](#备用路线) · [历史证据](#历史证据)。分组只是导航，不表示已选定实现、弃用其他路线或授权实验；16 项专项报告仍按参考用途排列。

## 项目专项报告

以下 16 个仓库均已完成记录范围内的静态专项研究。审查完成不代表已接入产品或通过线上验收。每个项目的固定 revision、范围、限制、来源和 checkpoint 见其报告及同目录元数据。

2026-09-12：当时的 15 份审查文档顶部均已补充“身份验证方式”和“帖子详情获取方式”的通俗说明。2026-09-13 新增的 xhs-cli-headless 报告也沿用这两个维度。点击项目名称可打开审查文档阅读；原有固定版本审查结论继续保留。

按主要参考用途分组，相近项目放在一起；分组及组内顺序不表示优先级，也不表示某项功能只属于一个组。

“我的理解与参考价值”保留个人理解和潜在用途；“现成能力与关键前提”依据各项目固定版本的审查，说明实际处理范围、输出和依赖。批量处理表示连续处理多篇，不代表已收齐所有帖子或支持中断恢复。

### 浏览器自动化与网站工具箱

| 对象与报告 | 我的理解与参考价值 | 现成能力与关键前提 | 初始 → 专项后评级 |
| --- | --- | --- | --- |
| [Playwright](projects/playwright/review.md) |  | 浏览器操作、会话复用和页面／响应读取的通用工具；小红书列表发现、逐帖循环及文件导出需自己编写。操作网页时仍需浏览器进程，可无头运行。 | A → A |
| [Playwright MCP](projects/playwright-mcp/review.md) |  | 把浏览器导航、点击和页面读取封装为 MCP 工具；多帖处理需调用方编排，没有现成的小红书批量归档流程，仍需浏览器进程。 | B → B |
| [OpenCLI](projects/opencli/review.md) | 类似 Playwright，让脚本或 AI agent 借用已登录的浏览器 | 现成命令可取得列表、读取单帖正文或下载单帖媒体；批量详情需脚本逐篇调用。沿用已登录的 Chrome 与 Browser Bridge，详情入口需有效链接。 | A → A |
| [xiaohongshu-mcp](projects/xiaohongshu-mcp/review.md) | 供 AI 或脚本调用的小红书浏览器工具箱（登录、搜索、读取帖子等操作） | 读取页面当前一批列表；单帖详情需 ID＋token，多帖读取需调用方编排。恢复 Cookie 后用浏览器加载页面并返回数据，没有完整媒体归档流程。 | B → B |

### 页面采集与浏览器扩展

| 对象与报告 | 我的理解与参考价值 | 现成能力与关键前提 | 初始 → 专项后评级 |
| --- | --- | --- | --- |
| [xhs_web_crawler](projects/xhs-web-crawler/review.md) | 通过浏览器自动点击每篇帖子，导出详情 | 连续点击页面加载出的帖子并滚动；用户手动导出 HAR 后，Python 批量提取详情 JSON。沿用浏览器登录状态，没有图片／视频文件下载。 | D → **B** |
| [RedCaChe](projects/redcache/review.md) | 和油猴脚本功能基本一致+“补全标题”功能 | 扩展批量滚动收藏页，保存卡片信息到浏览器资料库；另可逐帖补标题，不采集完整正文及媒体。需已登录的 Chrome；旧后端与扩展分开。 | 未纳入 → **A（研究）/B（采用参考）** |

### 接口取数与命令行导出

| 对象与报告 | 我的理解与参考价值 | 现成能力与关键前提 | 初始 → 专项后评级 |
| --- | --- | --- | --- |
| [ReaJason/xhs](projects/xhs/review.md) | 输入ck，为请求准备签名，发送请求，取得响应，导出详情 | 提供列表和单帖 API／HTML 读取；Cookie 与外部签名函数由调用方提供，详情需 ID＋token。批量编排需外层实现，媒体 helper 存在参数兼容问题。 | B → B |
| [RedCrack](projects/redcrack/review.md) | 输入web_session，为请求准备签名，发送请求，取得响应，导出详情 | 输入 web_session 或建立游客会话，用 Python 准备请求；指定 ID＋token 读取单帖并返回 HTTP 响应。没有现成批量详情、媒体下载及文件归档，搜索有静态缺陷。 | 新增 → **B（局部设计参考）** |
| [xiaohongshu-cli](projects/xiaohongshu-cli/review.md) | 输入ck，为请求准备签名，发送请求，取得响应，导出详情 | 提供列表查询、分页参数及单帖 API／HTML 读取，返回数据和媒体地址；跨页、逐帖与文件导出需外层编排。使用保存的 Cookie，登录可借助浏览器。 | A → B |
| [xhs-cli-headless](projects/xhs-cli-headless/review.md) | 输入ck，为请求准备签名，发送请求，取得响应，发给 xhs-cli-export | 导入 Cookie 或 HTTP 扫码后，默认以 HTTP 搜索／读取单帖；返回数据及媒体地址，批量导出需外层编排。固定版缺少导出器依赖的收藏／点赞命令。 | 新增 → **B** |
| [xhs-cli-export](projects/xhs-cli-export/review.md) | 只负责下载详情，其他逻辑由 xhs-cli-headless 负责 | 调用外部 xhs 取得列表并逐帖补详情，自己下载图片、写 Markdown／JSON；不下载视频。固定版与已研究 headless 的收藏／点赞命令契约不兼容。 | A → A |

### 采集框架与内容管理平台

| 对象与报告 | 我的理解与参考价值 | 现成能力与关键前提 | 初始 → 专项后评级 |
| --- | --- | --- | --- |
| [MediaCrawler](projects/mediacrawler/review.md) | 输入ck，为请求准备签名，发送请求，取得响应，导出详情 | 按关键词、帖子链接清单或创作者安排多帖详情，保存到文件或数据库；媒体下载需开启。浏览器建立／恢复会话，详情主要由 HTTP 获取；开源版无完整断点恢复。 | B → B |
| [XHS_ALL_IN_ONE](projects/XHS_ALL_IN_ONE/review.md) | 带网页界面：输入ck，准备签名并请求详情，提供内容库、媒体下载和编辑发布功能。 | 链接批次逐帖取详情；普通搜索只取列表，带进度搜索另补详情。提供内容库及媒体下载；使用 Cookie 和后端请求，带进度搜索结果未接入入库流程。 | B → B |

### 链接下载与笔记导入

| 对象与报告 | 我的理解与参考价值 | 现成能力与关键前提 | 初始 → 专项后评级 |
| --- | --- | --- | --- |
| [XHS-Downloader](projects/xhs-downloader/review.md) | 完整链接（xsec_token）批量下载工具 | 多条有效完整链接→HTTP 获取网页详情→按设置下载图片／视频；无需保持浏览器运行，Cookie 可选。配套用户脚本可收集页面已加载的链接。 | A → A |
| [Spider_XHS](projects/Spider_XHS/review.md) | 完整链接（xsec_token）批量下载工具 | 按链接清单、用户发布列表或关键词批量请求详情，可保存图片／视频及 Excel；需 Cookie 或扫码／短信登录，详情使用链接中的 token；采集由 Python＋Node.js 执行。 | B → B |
| [xiaohongshu-importer](projects/xiaohongshu-importer/review.md) | 完整链接（xsec_token）下载成 Obsidian 笔记 | 在 Obsidian 中一次导入一个分享链接，解析 HTML 后生成 Markdown；媒体下载默认关闭，可选保存本地。没有专门的 Cookie 登录配置或批量任务入口。 | B → B |

### 版本与兼容性说明

此前 14 项的完整裁定与采用边界见[固定版本比较](topics/reference-project-comparison.md)。其中 xiaohongshu-cli 从 A 降为 B、xhs_web_crawler 从 D 调为 B；RedCaChe 区分研究价值 A 与采用参考 B。2026-09-12 新增的 RedCrack 单独见其[报告](projects/redcrack/review.md)：仅作会话和请求构造参考，未找到帖子 `xsec_token` 生成器，搜索构造存在静态缺陷，没有完整媒体归档链路，未执行在线验证。

2026-09-13 新增 [xhs-cli-headless](projects/xhs-cli-headless/review.md)：已克隆并固定源码，默认 HTTP 扫码登录与 API／HTML 读取不需要浏览器；它提供数据获取能力，没有完整媒体归档或逐帖导出进度。本次版本没有注册 `favorites`／`likes`，与已研究 xhs-cli-export 的收藏／点赞命令契约不兼容；搜索与单帖读取另有访问参数配对问题。详见[固定版本兼容性](projects/xhs-cli-headless/review.md#与-xhs-cli-export-的固定版本兼容性)，未执行登录或线上采集。

## 辅助对象

这些对象仍可查阅；C/D 是该次研究范围内的结论，未列入上面的 16 个仓库专项队列。

| 对象                      | 评级 | 原因与证据入口                                                                                            |
| ------------------------- | ---- | --------------------------------------------------------------------------------------------------------- |
| justoneapi-python         | C    | [商业远端详情 provider 的条件性备选](topics/reference-project-comparison.md#justoneapi-python)            |
| XHS-Downloader Issue #397 | C    | [token 数据契约背景；没有维护者解决结论](topics/reference-project-comparison.md#xhs-downloader-issue-397) |
| MediaCrawler Issue #915   | C    | [单用户风险报告；没有因果结论](topics/reference-project-comparison.md#mediacrawler-issue-915)             |
| Postman Spider collection | D    | [来源、版本、许可及有效性证据不足](topics/reference-project-comparison.md#postman-spider-collection)      |
| 阿里云文章 1689270        | D    | [泛化 HTTP 示例，无平台第一方证据](topics/reference-project-comparison.md#aliyun-1689270)                 |
| 阿里云文章 1661722        | D    | [当时未取得正文，不能确认内容与来源](topics/reference-project-comparison.md#aliyun-1661722)               |

<a id="topics-and-experiments"></a>

## 专题、逆向与实验

### 当前相关

| 问题或对象 | 范围与入口 |
|---|---|
| 帖子理解模型与处理成本 | [AI 分类与模型选型](../docs/explorations/ai-classification.md)：统一保存本地字段、官方及中转报价、Token Plan、分层成本和视频机制；2026-09-19核查，未做付费模型评测。 |
| 只凭帖子 ID 付费批量导出          | [供应商与成本对照](topics/paid-note-id-export-services.md)：2026-09-14 Rnote、Galaxy、TikHub、Apify 等公开参数与价格核查；区分媒体 ZIP、结构化数据和完整本地归档，该次核查未采购或实测新供应商；后续落盘实现见 [note-library](../prototypes/note-library/README.md)。                                                    |
| 按含义找回帖子与知识库            | [语义检索、RAG 与 LLM Wiki](topics/semantic-post-library.md)：2026-09-13 原始论文与官方文档研究；讨论无共同关键词的关联检索、多模态覆盖和召回评估，未实现或选定模型。                                                                       |
| 项目启发                          | [用户目标与候选思路](topics/project-inspirations.md)：已有清单与 Cookie 驱动后台导出，持续记录成功、失败和待处理项；并保留后台浏览器直接保存响应、Azure 临时代理等思路。这些新增流程尚未实施，不评级。                                      |
| 帖子本地导出链路                  | [综合专题](topics/note-local-export-paths.md)：14 个项目及两个客户端的获取与保存；Core 覆盖矩阵是 2026-08-19 历史快照，静态研究完成并独立复审，不评级。                                                                                                              |

### 备用路线

| 问题或对象 | 范围与入口 |
|---|---|
| Playwright 浏览器路线             | [综合专题](topics/playwright-human-like-route.md)：静态研究完成并独立复审；路线 B、底层 Playwright 为 A 级采用评估，“模拟人工可降低风控”主张为 D。                                                                                          |
| 阶段一无头浏览器列表导出          | [可行性研究](topics/stage1-headless-list-export.md)：2026-09-14 官方文档与现有脚本核查；Cookie 导入、弹窗登录、会话恢复及列表完整性验证，候选未采纳，未线上验收。 |
| Cookie 登录与会话恢复             | [2026-09-09 专项对照](topics/cookie-login-implementations.md)：固定源码登录逻辑及后续脱敏身份/搜索证据；不改变项目评级。                                                                                                                    |
| xsec 链接结构                     | [专题](topics/xsec-link-structure.md)：note ID、token/source、账号上下文与历史受监督实验，区分已知输入契约与待验证问题。                                                                                                                    |
| App 详情与 Android 验证           | [证据与最小实验](topics/app-detail-auth-and-android-validation.md)：2026-09-14 固定源码、供应商契约、Android 官方资料与本机配置核查；未证明原生详情不依赖 Web token，尚未运行 App 实验。 |
| xhs-xsec-token 协议登录与搜索发现 | [工具说明](reverse/targets/xhs-xsec-token/experiment/README.md)、[方法与证据](reverse/targets/xhs-xsec-token/experiment/protocol-method.md)、[时间线](reverse/targets/xhs-xsec-token/timeline.md)：自有协议实验，与第三方项目验收分开记录。 |

### 历史证据

| 问题或对象 | 范围与入口 |
|---|---|
| 参考项目比较                      | [固定版本比较与历史建议](topics/reference-project-comparison.md)：保留 2026-08-11 初查、08-13 补充、08-17 复核及 09-07 索引核对的沿革、2026-08-12 Star 快照、逐项证据和设计比较。                                                           |
| 一次性 Cookie 路线                | [2026-08-16 研究](topics/one-time-cookie.md)：公开资料与当时候选设想，不作为账号政策或登录成功证据。                                                                                                                                        |
| Obsidian / Notion 客户端          | [Obsidian 静态逆向](reverse/targets/rednote2obsidian/report.md)、[Notion 静态逆向](reverse/targets/rednote2notion/report.md)：列表、详情、会话、游标、媒体与知识库写入背景证据。                                                            |

实验当前状态查看[路线图](../docs/design/roadmap.md)，逐次证据查看方法与时间线。旧目录中的 2026-09-09 至 2026-09-10 摘要保留在[历史比较报告](topics/reference-project-comparison.md#archived-experiment-summary)，不作为完整时间线。

## 如何解释证据和评级

- 证据分为外部声明、静态证据、本地验证和待确认；一次本地结果不能外推到其他版本、账号或内容类型。
- A 表示优先研究或深入设计参考，B 表示局部组件参考，C 表示背景或条件性备选，D 表示该审查范围内排除。初始优先级与专项后评级分别记录，都不等于产品采用决定。
- 历史实施 Stage 1–4、实验账号限制、停止条件及候选安全默认均保留其日期和研究范围；当前产品要求从权威文档读取。
- 2026-09-19 Core 包上移后，普通链接使用 `projects/`。provenance 中带哈希的 `projects/rednote-sync-core/` 路径保留为取证时的原始位置，不据此改写固定来源记录；旧路径对应的新位置见[目录决策](../docs/decisions/2026-08-18-document-structure.md#2026-09-19目录轻整理与单包上移)。

详细定义见[证据与评级](topics/reference-project-comparison.md#evidence-and-ratings)。需要早期下载实验时，直接查看[历史记录](../docs/history/early-product-design.md#初始测试结论)。
