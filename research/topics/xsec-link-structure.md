# xsec 链接结构专题研究：note_id / xsec_token / xsec_source 与账号隔离

> 状态：**研究证据**。本文综合公开资料、历史受监督实验及 §12–13 的协议身份与搜索增量；2026-09-14 复核时收窄了小样本、SSR 与生成机制的结论范围，未新增实验。文中的账号选择和“主账号不参与在线探测”只限定当次实验；当前产品允许用户自行选择账号路线，见[产品设计](../../docs/design/product-design.md)。

日期：2026-08-16（2026-08-16 更新：加入用户本人执行的受监督动态实验结果；2026-08-18 补充：display_title 性质、正文搜索重发现与详情页 SSR/HAR 观察，见 §6.3/§8/§11；2026-08-19 补充：14 个正式候选项目的 `note_id + Cookie` 固定版本审计，见 §3.3）
状态：公开资料层研究记录 + 用户执行的历史动态实验记录；本文所述 2026-08-16 至 2026-08-19 研究期间，自动化实现尚未开始。§12–13 记录 E 在 9 月 9–10 日的身份成功与搜索 461，后续协议结果见[实验说明](../reverse/targets/xhs-xsec-token/experiment/README.md)：G 在 2026-09-12 已完成身份及目标搜索并取得 token，未请求详情；9 月 13 日 A–F 身份复核均失败并清空 Cookie，G 未复测。不能把 E/F 的失败写成协议搜索普遍不可用；2026-08-16 第二次会话增补见 §10。
方法：初版只读固定 revision 审查报告、反向客户端样本报告、既有本地验证及公开资料，未访问小红书线上接口或读取工作区凭据。§12–13 单列后续用户授权自有实验的脱敏结果；本专题不包含真实 note_id、token、Cookie 或带凭据的完整 URL，不把原始会话材料复制进文档。

## 1. 要回答的问题

1. 主账号导出的帖子 URL 中的 `note_id + xsec_token + xsec_source` 组合，是否可能让平台把批量导出行为溯源到主账号？
2. 能否在登录小号或使用一次性 Cookie 的情况下，用这些低风险账号的信息拼出指向正确帖子的 URL 并完成导出，从而隔离主账号风险？
3. 哪些结论是现有证据能支持的，哪些只能通过受监督动态实验验证？
4. 已正式审查的项目是否都要求带 `xsec_token` 的链接；是否有固定版本真正证明“只给 `note_id + 已登录 Cookie`”即可导出单帖？

## 2. 证据等级

沿用 `research/catalog.md` 的标准：

- `[外部声明]`：README、博客、Issue 或其他人的描述。
- `[静态证据]`：仓库中固定 revision 的源码、配置或离线样本能直接确认的行为。
- `[本地验证]`：本项目曾实际运行并观察到的结果。
- `[公开资料]`：本轮从公开网页读取的材料；标记日期，不视为平台官方当前事实。
- `[待动态验证]`：只能通过真实环境实验回答。

## 3. 全部已审查项目的 xsec 证据矩阵

以下矩阵保留截至 2026-08-19 的研究范围，固定 revision 以所链专项报告为准；后续新增项目与当前研究总数见[研究目录](../catalog.md)。静态调用路径和作者描述不等于本项目的在线成功证据。

### 3.1 访问材料如何取得

| 项目 | 固定结论（摘要） | 对本次研究的意义 |
|---|---|---|
| XHS-Downloader | 用户脚本从页面状态同时读取 note ID 与 `xsecToken` 并构造链接；本地曾有一个较新图文样本成功、旧链接失败 | token 是“发现上下文”的产物，不是由 ID 单独推导；旧链接失败提示 token/上下文会失效 |
| OpenCLI | `saved/liked` 先拦截站内响应并校验 note ID + `xsec_token`，无结果才退 DOM；无可持续 cursor。其自身 sitemap 明确：手拼裸 `/explore/<note_id>` 会 403，`note/comments/download` 需要带 token 的完整 URL；首页 SSR Pinia store 中首屏条目有 token，而 `/homefeed` 下一页 XHR 条目没有 token | 最强静态证据：裸 `note_id` 在项目作者观察中不可靠，token 与“首屏发现上下文”绑定；这直接影响实验 E-A 的预期 |
| MediaCrawler | 搜索条目 `note_id + xsec_source + xsec_token` 成组传给详情；但 Store 丢弃真实 `xsec_source`，生成 URL 时硬编码 `pc_search`，并把 token 写入 URL、SQL 和日志 | 证明“成组配对”被当作访问契约；破坏配对被审查标记为风险 |
| ReaJason/xhs | `get_user_all_notes` 从列表项同时取 `note_id` 与 `xsec_token` 传详情；详情函数显式接收 `xsec_source`，默认固定 `pc_feed`；master 与文档已有漂移 | 再次证明 token 来自列表发现层；source 的真实约束未验证 |
| Spider_XHS | 发现结果原含 `note_id/xsec_token/xsec_source`，包装层重建详情 URL 时丢失 source，详情用默认 `pc_search`；线上影响未知 | token/source 配对关系存在，但项目本身未完整保留；不能作为正确实现模板 |
| xhs-cli-export | item 中显式识别 `xsec_token`；raw/detail/JSONL 会持久化访问材料，异常可能进入 Markdown/index | 采用任何第三方导出链路都必须先做 secret 清洗，不能直接落盘 |
| xiaohongshu-cli | 类型化错误分类与 Cookie/token 生命周期值得参考；但 auto 模式会扫描多个浏览器，没有 expected account 绑定 | 跨账号/会话边界不可用其默认逻辑 |
| xiaohongshu-mcp | Cookie 与 fingerprint seed 同存一个 JSON，`0644` 写入，无 expected account、profile lease 或会话 owner；无鉴权服务可读 xsec access material | fingerprint seed 是会话身份的一部分；这也是设备关联风险的一项静态证据 |
| XHS_ALL_IN_ONE | 与 Spider_XHS 高度重叠；平台写、运营、多账号面已排除 | 只参考任务审计，不提供在线安全证据 |
| Playwright | 通用浏览器底座；XHS 登录实际依赖 Cookie/localStorage/IndexedDB/sessionStorage/设备状态的组合，组合方式未知 | 隔离环境必须处理的不只是 Cookie，还有 profile 与设备状态 |
| Playwright MCP | 通用 Agent 工具，缺 expected account；production 集成已排除 | 探索与生产必须分离 |
| Obsidian 客户端逆向 | 列表接口用空 `xsec_token/xsec_source`；详情 `POST /api/sns/web/v1/feed` 带 `xsec_source:"pc_user"` 与 `xsec_token`；同步对象 URL 用 `xsec_source=pc_collect` | 旧客户端静态证据：不同入口有不同 source 值；当前有效性待动态验证 |
| Notion 客户端逆向 | 同上；且 token URL 会作为 Notion `Url` property 发送并持久化 | 任何知识库输出必须默认不保存 token URL |

### 3.2 已有本地验证与个案

| 来源 | 观察 | 适用边界 |
|---|---|---|
| 本项目 userscript 原型 | 在真实页面取得点赞/收藏链接列表 | 列表完整性、重复稳定性未验证 |
| XHS-Downloader 有限运行 | 一个较新图文链接无 Cookie 成功下载；旧链接失败 | 不能外推视频、批量、当前版本 |
| XHS-Downloader Issue #305 | 用户未输入 Cookie，批量到约 108 条后失败，回到主页发现账号被下线 | 单用户报告；说明请求可能被归因到当前浏览器会话/账号，而不仅是显式 Cookie |
| XHS-Downloader Issue #224 | 批量下载稳定触发风控，约 24 小时解除；报告建议 UA 轮换、IP 轮换、3–8 秒间隔 | 单用户报告；其建议属于本项目已排除的手段，不能作为安全承诺 |
| XHS-Downloader Issue #321 | 长期使用后网页端与手机端被强制退出，用户怀疑账号被制裁 | 单用户报告 |
| XHS-Downloader Issue #309 | 获取数据失败频率增加，需反复重试 | 单用户报告；说明无固定“安全量” |
| agent-reach 封号用户报告（2026-08 公开帖） | 单用户报告：用 agent-reach 接入后小号被封；agent-reach（Panniantong/Agent-Reach）的小红书通道依赖上游 xiaohongshu-mcp、读取本地浏览器 Cookie/Cookie-Editor 导出，登录态反复失效（Issue #108、#175） | 单用户报告；机制与既有风控案例一致，不能证明“必然封号” |
| xhs-read-mcp（usubamayoi）静态速览 | 无 Cookie 的 curl（iPhone UA）解析公开页 `__INITIAL_STATE__` 快照；无节流、无停止条件、无账号绑定；README 自称“不需要登录、Cookie、Puppeteer” | 仅确认所审代码尝试不附带 Cookie/token 读取单篇 SSR；是否在线成功、页面是否完整均待动态验证 |

### 3.3 2026-08-19：14 个正式候选项目 `note_id + Cookie` 审计

本节重新追踪每个固定 revision 的“输入解析 → token 来源 → 详情 API/HTML/DOM → 导出”链路。分层只描述固定源码能力，不表示当前平台仍接受该请求：

1. **① 明确强制 token**：现行详情入口要求 `xsec_token`；裸 ID 会在请求前拒绝，或函数签名/URL 构造没有无 token 契约。
2. **② tokenless/空 token 静态路径存在，但在线成功未证实**：源码会以无 query 的详情 URL、空 token 的 `/feed`，或公开 SSR 页面继续执行；没有当前线上可靠性证据。
3. **③ 浏览器页面上下文隐式取得访问材料**：项目依赖已登录页面、列表卡片、点击详情或页面网络上下文，不是“裸 ID + Cookie”详情接口。
4. **④ 无固定的平台详情实现 / 不适用**：项目只委托未固定的外部 provider，或只是通用浏览器底座。

| 项目（固定 revision 见专项审查） | 分层 | 裸 ID / token 来源与详情路径 | 对“只用 `note_id + Cookie` 导出”的结论 |
|---|---:|---|---|
| [XHS-Downloader](../projects/xhs-downloader/review.md) | ② | Python 核心接受不带 query 的完整 `/explore/{id}` URL，携可选 Cookie 获取 HTML，再解析 `window.__INITIAL_STATE__` 并进入详情、媒体和记录链；用户脚本的批量发现则从页面状态取得 `xsecToken`。[输入与 HTML 请求](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/application/app.py#L102-L112) [详情编排](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/application/app.py#L397-L425) [SSR 解析](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/expansion/converter.py#L9-L45) | **最接近但不是“裸 ID”入口**：固定源码有 tokenless URL + Cookie → HTML → 导出路径；没有该路径当前在线成功的测试或运行证据。 |
| [OpenCLI](../projects/opencli/review.md) | ① | `note/comments` 只接受受支持 host/path 且含 `xsec_token` 的完整 URL；`download` 额外接受短链，裸 ID 在导航前即被拒绝。[现行输入校验](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/clis/xiaohongshu/note-helpers.js#L32-L68) | **不能**；它的现行契约明确要求发现层给出的 token URL，不存在 ID + Cookie 详情入口。 |
| [xhs-cli-export](../projects/xhs-cli-export/review.md) | ④ | exporter 自身不实现平台详情；它只查找一个仓库未固定、manifest 未声明的外部 `xhs` executable，并尝试 `xhs read <id> --json`，有 token 时才追加 token 参数。[外部 provider 解析](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/src/xhs_export.py#L116-L188) [详情委托](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/src/xhs_export.py#L1257-L1268) | **本仓库不能证明**；是否支持 ID + Cookie 完全取决于未固定的外部 provider，不能归因给这个 fixed revision。 |
| [xiaohongshu-cli](../projects/xiaohongshu-cli/review.md) | ② | `read` 接受 ID、URL 或短索引；无显式/缓存 token 时，已登录 Cookie client 直接 GET 无 query 的 `/explore/{id}`，解析 `__INITIAL_STATE__`，再由公共 formatter 输出 JSON/YAML。[CLI 入口](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/commands/reading.py#L80-L109) [无 query HTML 与详情分层](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/client_mixins.py#L200-L220) [tokenless 分支](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/client_mixins.py#L318-L368) [SSR 提取](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/html_parser.py#L46-L73) | **固定源码明确实现了目标路径**；但测试只覆盖伪造 fallback shape，没有“无 token 当前在线成功”的证据，因此只能称静态实现，不能称当前可用。 |
| [xiaohongshu-importer](../projects/xiaohongshu-importer/review.md) | ② | 只接收公开分享 URL，不使用账号 Cookie；请求 SSR HTML，解析 `__INITIAL_STATE__` 后写 Obsidian 笔记和可选媒体。[URL 与获取](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/main.ts#L76-L131) [SSR 解析](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/main.ts#L257-L351) | 有 tokenless 公开 URL 尝试，但**不是**裸 ID + 已登录 Cookie；也没有当前在线可靠性证据。 |
| [MediaCrawler](../projects/mediacrawler/review.md) | ② | README/配置与 core 注释要求 token URL，但 parser 技术上可把裸 ID 解析成 `note_id` 与空 token/source；随后先向 `/feed` 传空 token，空结果或 `RetryError` 再构造空 query 值的 HTML URL并携 Cookie。[输入解析](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/xhs/help.py#L304-L317) [详情编排](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/xhs/core.py#L258-L320) [Feed 请求](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/xhs/client.py#L354-L389) [HTML fallback](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/xhs/client.py#L719-L752) | **裸 ID 静态可达请求和导出链**，但与作者文档契约冲突；没有在线成功证据，且部分访问错误不会进入 HTML fallback。 |
| [Spider_XHS](../projects/Spider_XHS/review.md) | ② | `get_note_info(url)` 从 path 末段取 ID；传裸 ID 时 query 为空，仍以默认 source 和空 token发签名 `/feed`。上层成功后可写 XLSX/JSON/TXT 或下载媒体；列表/搜索正常路径会先把发现 token 拼回详情 URL。[空 token Feed](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/apis/xhs_pc_apis.py#L470-L503) [导出包装](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/spider/spider.py#L14-L103) | **裸 ID + Cookie/session 的完整静态尝试存在**；无 HTML fallback、无空 token 在线成功测试，不能称当前可用。 |
| [XHS_ALL_IN_ONE](../projects/XHS_ALL_IN_ONE/review.md) | ② | 与 Spider_XHS 高度重叠的 PC API 同样从 path 取 ID，并向 `/feed` 传默认 source 与空 token；Web 应用另有本地保存/导出面，但没有证明平台接受空 token。[空 token Feed](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/apis/xhs_pc_apis.py#L470-L503) | **静态路径存在**；没有当前在线成功证据，不能从相似源码或应用 UI 推断可用。 |
| [xiaohongshu-mcp](../projects/xiaohongshu-mcp/review.md) | ① | service/action 入口同时要求 `feedID, xsecToken`，固定构造带 token 的详情 URL，再按请求 ID 精确读取 `noteDetailMap`。[详情入口与 URL](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/xiaohongshu/feed_detail.go#L94-L105) [精确提取](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/xiaohongshu/feed_detail.go#L944-L1005) | **不能**；现行契约是 ID + token + 浏览器 Cookie/page，不是 ID + Cookie。 |
| [ReaJason/xhs](../projects/xhs/review.md) | ① | 当前 `get_note_by_id` 与 HTML 方法的函数签名都要求 `xsec_token`；用户全量包装器也从列表项取 token 后才调详情。旧 helper、文档和测试仍按历史无 token 签名调用，已被专项审查确认是接口漂移，不构成兼容路径。[当前详情契约](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/core.py#L206-L264) [列表到详情](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/core.py#L456-L502) | **不能**；固定版本的现行详情契约要求 token，历史调用残留只会形成参数错误或漂移风险。 |
| [xhs_web_crawler](../projects/xhs-web-crawler/review.md) | ③ | Chrome content script 从当前页面逐卡点击、关闭和滚动；实际闭环依赖用户把页面网络保存为含正文 HAR，再由 Python 解析 `note_card`。没有裸 ID 输入或独立详情 client。[DOM 点击](https://github.com/leafiy/xhs_web_crawler/blob/8a7d1b6ec90d9c3d25f3d731cd83a15f8ab08c50/chrome_extension/content.js#L77-L124) [HAR 解析](https://github.com/leafiy/xhs_web_crawler/blob/8a7d1b6ec90d9c3d25f3d731cd83a15f8ab08c50/extract-content.py#L40-L126) | **不是 ID + Cookie 导出器**；token/详情若出现，来自已登录页面点击和网络上下文，而且当前自动采集链尚未接通。 |
| [RedCaChe](../projects/redcache/review.md) | ③ | 当前扩展从已登录收藏网格抽卡片、ID、`source_url/open_url`，后续只对缺标题项逐篇打开页面；ingest 会优先保留/刷新带 query 的可打开 URL。旧 backend 可为既有记录合成裸 URL，但公开 backfill 只取标题。[收藏网格](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/extension/content-script.js#L55-L120) [标题补全](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/extension/background.js#L61-L127) [open URL 刷新](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/extension/src/lib/ingest.js#L31-L43) | **不是完整单帖导出器**；依赖列表/页面上下文，现行扩展仅保存卡片与标题，不导出正文、完整媒体或 Live Photo。 |
| [Playwright](../projects/playwright/review.md) | ④（不适用） | 通用浏览器自动化底座，只提供 Context/Page、网络、Cookie、下载等机制，没有 XHS 的 ID/token/详情/导出契约。 | **不适用**；不能把“能打开浏览器”算作 ID + Cookie 单帖实现。 |
| [Playwright MCP](../projects/playwright-mcp/review.md) | ④（不适用） | 通用 Agent 浏览器控制面，没有 XHS 领域详情或导出实现。 | **不适用**；具体行为完全取决于调用方另写的站点流程。 |

跨项目结论是：**不是所有项目都只支持带 `xsec_token` 的链接。** 其中 `xiaohongshu-cli` 明确实现了“裸 ID + 已登录 Cookie → tokenless HTML SSR → JSON/YAML”，XHS-Downloader、MediaCrawler、Spider_XHS 与 XHS_ALL_IN_ONE 也存在不同程度的 tokenless/空 token 静态路径；xiaohongshu-importer 则是无 Cookie 的公开 URL SSR 尝试。但在这些固定版本中，**没有一个项目提供该路径当前在线可靠成功的证据**，更没有证据能推翻 §6.2 已记录的两次软 404 与一次 461。OpenCLI、xiaohongshu-mcp 和 ReaJason/xhs 的现行契约仍明确要求 token；xhs_web_crawler 与 RedCaChe 依赖浏览器页面/列表上下文，不能归类为裸 ID + Cookie 详情实现。

## 4. 公开资料层的新增证据

- `[公开资料，2026-07-19]` DEV Community 教程：note ID 不足以作为稳定请求输入；`xsec_token` 是“为该笔记和发现上下文生成”的短期材料；“token 属于提供它的那条链接”，不要自己发明、不要跨笔记搬移、不要作为永久配置保存。来源：<https://dev.to/mian_po_0ae30e900c601c8f5/why-xiaohongshu-xsectoken-links-expire-and-how-to-recover-21ko>
- `[公开资料，2025-05-09]` MediaCrawler 接口变更分析：详情接口新增必填 `xsec_token`；token 需要从搜索接口临时获得、有时效性、不能长期使用。来源：<https://blog.gitcode.com/b86d238b79b87d6dd23a5d66bb333a63.html>
- `[公开资料]` OpenCLI PR #1805：feed 首页 hydrated store 的首屏条目 35/35 携带 `xsecToken`；下一页 API 条目不带 token；其修复将 token 写入输出 URL，并声称详情端点只校验 `xsec_token`、`xsec_source` 可为空。这是单一维护者的观察，未做跨账号测试。来源：<https://github.com/jackwener/OpenCLI/pull/1805>
- `[公开资料]` 小红书用户服务协议（转载全文，更新日期 2025-12-08）：第 3.4 条禁止未经书面许可复制、读取、采用、统计平台信息内容或提供给第三方使用；第 4.1 条禁止反向工程、非法抓取、模拟下载，以及通过非小红书开发/授权/许可的第三方软件登录或使用平台，并禁止通过非平台或非法、违规、不正当手段获取账号等资产；第 2.1 条禁止恶意注册（频繁注册、批量注册、使用他人身份注册）；第 2.3 条规定账号仅限本人使用，未经同意授权第三方使用账号或获取账号项下信息的行为无效，平台可封禁、注销、收回账号。来源：<https://www.elawcn.com/agreement/2026/0301/1751.html>（官方协议页为 JS 渲染，本记录采用第三方转载全文，正式决策前建议人工核对官方页面）
- `[公开资料]` 社媒助手风控 FAQ：访问频次异常触发原因包括批量导出、行为模式非人类、同一 IP 多账号登录或频繁搜索、账号被标记；建议分批次小规模操作。来源：<https://smc.iszhouhua.com/faq/xiaohongshu/risk-control>
- `[外部声明，历史研究范围]` 公开网络存在声称提供 `xsec_token` 生成、App Shield 算法和账号池的商业/逆向项目。本专题当时**不采用、不验证、不复制**这些实现；仅记录其存在，不能据此认定“从 note_id 推导 token”可靠。当时的签名破解排除边界不能代替后续独立实验的[授权范围](../reverse/targets/xhs-xsec-token/scope.md)；当前本地 HTTP 签名也不等于采用这些项目或已破解 token。
- `[静态证据，2026-08-16]` 具体核实 `Cialle/RedCrack`：仓库真实存在（MIT），自述“小红书 Web 端全站所有加密参数 Python 纯算逆向”，覆盖 `a1/webId/acw_tc/web_session`（README 标注“游客生成”）`/sec_poison_id/websectiga/gid` 与 `x-s/x-t/x-b3-traceid/x-xray-traceid` 签名头，同时暴露 `follow_user` 等平台写接口，强制代理，demo 显示登录态需外部提供 `web_session`。**历史状态记录**：2026-08-16 曾将它从“仅记录存在、不采用”改为“购买 Cookie 路线候选参考”；这项研究选择没有被当前产品设计采纳，使用前仍需重新讨论只读范围、停止条件、供应链与许可证。详见 `research/topics/one-time-cookie.md` §8。

## 5. 综合结论（按证据强度）

1. `note_id` 是稳定标识；`xsec_token` 是短期、上下文相关的访问材料；`xsec_source` 是来源/上下文标记。没有项目证明可以从 `note_id` 推导 token；但 §3.3 确认若干固定版本存在**不推导 token**、直接尝试 tokenless HTML 或空 token API 的静态路径。这些实现没有当前在线可靠性证据，不能与“从 ID 推导 token”混为一谈，也不能据此写成当前可用。
2. 裸 `note_id` 是否足够请求详情：公开资料与 OpenCLI 静态证据倾向“不够”；2026-08-16 小号动态实验观察到两次软 404且未触发 `/feed` 详情接口，其中一次页面加载还出现 `note_info` 461。当前仅限该会话观察，不能外推为平台稳定规则，但它直接阻止把 §3.3 的静态路径提升为“当前可用”。
3. 主账号 token 能否被小号会话复用：**无任何正面证据**；现有材料反而建议不要把 token 搬离原链接。跨账号复用是否失败、是否产生风控信号，仍未实验（E-C 冻结）。
4. 批量导出是否会被归因到账号：Issue #305（无 Cookie 也导致账号下线）与多个风控 Issue 支持“可能被归因”，但不能证明归因机制，更不能证明安全阈值。
5. 设备/IP/会话是比单条 URL 更宽的归因面：多个审查报告显示平台身份可能包含 Cookie、fingerprint seed、设备状态和网络环境；仅换“账号身份”不能自动实现隔离。
6. `[本地验证，2026-08-16]` 小号 A 通过“标题搜索 → 路径 note_id 精确核对 → 正常点击”打开同一帖子，5/5 命中、5/5 打开、5/5 ID 完全相等、`feed` 均 200、无风控信号。这证明该会话的五个样本成功；样本是用户记得标题的帖子，不能代表全部 2000 条的覆盖率或当前可用性，也不是与后续协议实验同条件的路线对照。
7. `[本地验证，2026-08-16]` 主账号原浏览器中，约一个多月前导出的旧 token 拼接链接曾打开若干帖子，随后多次尝试无法复现并出现 HTTP 461。该观察只说明旧 token 曾在原会话中可用及随后失败的先后关系；未隔离重复直连与 461 的因果，不证明 token 可跨账号、跨会话或长期稳定。
8. `[本地验证，2026-08-18]` 用户观察到部分商家推广帖标题、正文搜索均未命中，部分无标题帖可由正文关键词命中；样本与数量未统计，不能推出整类帖子必然可搜或不可搜。已删除内容及未命中内容的补全能力仍未验证，应保留已有元数据并记录缺口；旧 token 直连只是历史候选，尚无稳定补全证据。
9. 搜索本身也是高频操作：短时间连续搜索是否触发风控，目前没有安全阈值；后续小号批量搜索必须按“低频、分批、可暂停、出现 461 立即停止”设计。

## 6. 受监督动态实验：设计 + 已执行结果

### 6.1 设计

目标：用低价值小号回答“裸 note_id 是否可用”和“跨账号 token 是否可复用”。“主账号不参与在线探测”是本次实验的范围控制，不是产品永久限制。

| 步骤 | 内容 | 推荐预算 | 回答的问题 | 状态 |
|---|---|---|---|---|
| E-A | 小号 A 隔离 profile 中，用裸 `note_id` 逐个请求详情 | 最多 5 个，单会话 ≤20 分钟，不下载媒体 | 裸 `note_id` 是否足够 | 已执行 2 条 |
| E-B | 小号 A 正常搜索/feed 发现 1 条笔记，同会话请求详情 | 1 条 | 同会话 token 配对是否有效 | 已执行 1 条 |
| E-C | 小号 B 隔离 profile 中，仅内存携带 A 的 token 请求同一笔记 | 1 条 | 跨账号 token 是否可复用 | 冻结，未执行 |
| E-D | 停止在线操作，观察账号 24–48 小时 | 0 请求 | 是否触发验证码/强退/频次异常 | 用户选择不等待冷却 |
| E-S2 | 小号 A 用标题搜索同一帖子，路径 `note_id` 精确核对后打开 | 1 条 | 小号能否不依赖主账号 token 重发现 | 已执行 1 条 |
| E-S3 | 小号 A 用标题搜索 5 条，核对路径 `note_id` 后打开 | 5 条，间隔 ≥60 秒 | 标题重发现机制与 ID 核对 | 已执行 5 条 |

硬停止条件：验证码/滑块/challenge、401/403/406/429、461、登录状态变化、账号身份不匹配、页面频次异常提示、任何账号被强制下线。命中任一信号立即停止，不重试、不换号、不换代理、不回退 HTML。

产物规则：token/Cookie/storage state 只在内存；不保存 HAR/Trace/截图；只记录脱敏结果表（账号标签、请求类别、token 来源、source 值、结果类别、是否触发停止）。

### 6.2 已执行结果（用户本人执行，2026-08-16；只记录脱敏现象）

| 实验 | 观察 | 结论 |
|---|---|---|
| E-A × 2 | 两条裸 `/explore/<note_id>` 均 `302 → /404/sec_... → /404 200`；未产生详情 `feed` 请求；其中一次页面加载里出现 `GET /api/sns/h5/v1/note_info → 461` | 该会话中裸 `note_id` 不可用；461 触发停止条件 |
| E-B | 正常搜索/feed 点击卡片，详情打开，`POST /api/sns/web/v1/feed → 200`；无 4xx/5xx | 本次正常点击成功取得详情 |
| E-S2 | 标题搜索命中同一帖子，详情打开，`feed` 200；无风控信号 | 该样本可通过标题重发现 |
| E-S3 | 5/5 命中、5/5 打开、5/5 路径 `note_id` 与目标完全相等、`feed` 均 200、无 461/验证码 | 本轮按用户记得的标题重发现五条成功；未验证五字段队列或全量覆盖率 |
| 主账号旧 token 直连（用户另行执行） | 约一个多月前的旧 `note_id + xsec_token` 在主账号原浏览器中曾打开若干帖子；多次尝试后无法复现并出现 461 | 旧 token 在原会话中不保证持续可用；未隔离重复直连与 461 的因果，也未证明跨账号可移植性 |

### 6.3 新发现的字段与覆盖缺口

- `user.xsec_token`：由 Fetch/XHR 捕获、不出现在帖子 URL 中的作者侧 token；机制未知。本次历史实验的安全队列不使用该字段，见 §9。
- 主账号 7 月导出的 `note_id + xsec_token` 拼链接曾在原会话打开帖子，随后复现失败并出现 461；旧导出只应作为“最后手段”研究，不应作为日常输入。
- 标题中的 emoji 在 Excel 显示异常，复制粘贴到搜索框仍正常；中间格式应使用 CSV/JSON，不用 Excel。
- 商家推广帖样本：`[本地验证，2026-08-18]` 用户观察到标题和正文搜索均未命中，网页端未见推广标记、手机端可见；样本与数量未统计，不代表所有推广帖的规则。
- `display_title` 的性质：`[本地验证，2026-08-18]` 用户观察导出中的 `display_title` 是卡片层的截断展示标题，与帖子实际标题（详情层）不一致；不能以它判断“帖子是否有标题”。安全清单中它只作展示提示，不作重发现搜索输入。
- 无标题帖样本：`[本地验证，2026-08-18]` 用户通过正文关键词命中并打开过帖子；正文关键词可以作为重发现候选输入，但尚未证明能覆盖所有无标题帖。
- 详情页正文获取路径（HAR 脱敏分析）：`[本地验证，2026-08-18]` 对用户本机导出的详情页 HAR（235 条目）做脱敏摘要分析：记录中的正文只出现在页面 HTML 文档的 `__INITIAL_STATE__`（含 `desc`）；全部 32 个 `application/json` 接口条目均不含笔记内容标记，且记录中没有 `/api/sns/web/v1/feed` 详情请求。这证明该次已返回的 HTML 可供提取正文；没有验证省略 token/source 或 Cookie 后是否仍返回相同页面，也不能外推全部帖子、媒体完整性或当前有效性。原始 HAR 保留在用户本机，本文件只记录脱敏结论。
- 对作者删号或删帖的内容，尚无经验证的重新获取路径；保留已有元数据及明确缺口，不能把未取得的正文或媒体标为成功。
- 短时间连续搜索是否触发风控没有安全阈值；`liked_count` 实时变化，只能作大致参考，不能作为去重键；`note_id` 仍是唯一稳定键。
- userscript 的捕获机制是包装 `XMLHttpRequest.prototype.open` 与 `window.fetch`，对已经返回浏览器的响应做解析；它不产生新的网络请求，服务端流量与正常浏览一致。但页面脚本会修改全局 fetch/XHR 方法，理论上可被页面安全脚本检测，仓库没有证据证明或否定这一点；导出按钮本身无额外请求，自动滚动功能才会产生更多分页请求。
- 公开页 `__INITIAL_STATE__` 静态路径：xhs-read-mcp（usubamayoi，`[静态证据]` 所审版本）使用 curl + iPhone UA，尝试不附带 Cookie/token 读取并解析 SSR（字段：标题/正文/作者/互动/首屏评论/≤9 图）。代码存在不证明服务端接受该请求；线上成功率、内容完整性、与 461/风控的关系均为 `[待动态验证]`，不能直接成为已验证的项目链路。

## 7. 风险声明（待用户确认后写入决策记录）

1. **平台规则风险**：无论使用主账号、小号还是购买 Cookie，批量读取与第三方工具登录都可能违反平台协议；低频和隔离账号不改变授权结论。后果可能是账号封禁、注销、收回及内容清空。
2. **账号来源风险**：购买 Cookie/账号可能属于来源异常资产，账号仅限本人使用的条款使第三方使用无效；账号可能被收回、轮换或本身为盗号产物。
3. **设备/IP 关联风险**：同一设备、浏览器 profile、fingerprint 或 IP 可能让小号与主账号被平台关联；小号触发风控时，隔离效果可能失效。
4. **token 错配风险**：把主账号 token 拿到小号会话使用，可能形成“token 与会话不匹配”的异常信号，反而制造账号间关联。
5. **搜索与直连频率风险（本次历史实验）**：连续打开旧 token 直连链接后出现 461，已在主账号实验中被观察到（`[本地验证]`），但没有隔离因果；5 条/15 分钟的搜索测试未出现 461，也不能据此推导安全阈值。因此当次实验冻结直连重放，搜索频率风险仍按未知处理；后续不同会话的协议搜索结果见[实验说明](../reverse/targets/xhs-xsec-token/experiment/README.md)。
6. **主账号当前观察状态**：主账号原浏览器在 2026-08-16 直连测试后出现 461；用户随后报告仍可正常登录、刷新、搜索。这个“事后正常”是有限观察，不能证明无后续影响；建议继续避免重复直连和批量实验，并保留对异常登录状态的敏感度。

## 8. 未回答或尚未充分验证的问题

- 裸 `note_id` 现在返回什么：2026-08-16 小号会话观察到两次软 404，但样本少、单会话，仍需更大范围才算充分验证。
- `xsec_source` 是否必须与发现入口一致；错配的当前表现。
- token 是否绑定账号/会话/设备/IP；有效期多长；跨账号复用的服务端行为（E-C 冻结，未验证）。
- 旧 token 在原会话中的实际有效期与 461 触发条件；用户观察为“曾打开若干条，随后复现失败”。
- 商家推广帖、无标题帖与已删除内容的实际覆盖率及补全路径；目前只有未统计数量的成功或未命中观察，不能把这些类别整体判为已覆盖或不可获取。
- 平台当前风控阈值与观察窗口；任何“安全频率”都没有官方依据。
- 小号批量搜索的每日安全预算；目前只有 5 条/15 分钟这一轮成功样本，不能作为阈值。

## 9. 安全清单字段（等待最新导出后生成）

本节保留 2026-08-16 实验的派生队列计划，五字段限定的是供该次重发现使用的清单，**不是 userscript 原始导出的统一字段契约**。原导出可以另含访问材料并按下述私有原始归档处理；不能仅凭两种产物字段不同判断脚本违反本节。此计划尚无生成验收记录。

用户 2026-07-07 的点赞导出包含：

`note_id, display_title, type, xsec_token, interact_info.liked, interact_info.liked_count, user.user_id, user.nickname, user.avatar, user.xsec_token, cover.url_pre, cover.url_default`

计划生成的安全队列只保留：

`note_id, display_title, type, user.nickname, user.user_id`

原则：

- `xsec_token`、`user.xsec_token`、`user.avatar`、`cover.*` 一律不进入安全队列；原导出文件按凭据/私有原始归档处理。
- `interact_info.liked_count` 只作大致排序参考，不作去重键；`note_id` 是唯一稳定键。
- 输出使用 CSV/JSON，不用 Excel 作为中间格式，避免 emoji 显示问题。
- 队列生成是纯本地离线操作；具体实现等用户取得最新导出后授权进行。

## 10. 2026-08-16 第二次会话增补

1. 三条情报核验结论已并入本文件：agent-reach 封号案例与 xhs-read-mcp 静态速览见 §3.2；RedCrack 核实与状态变更见 §4；`__INITIAL_STATE__` 快照路径见 §6.3。
2. C1–C6、E2 与一次性 Cookie 路线的研究记录保存在 [`one-time-cookie.md`](one-time-cookie.md)。这些内容是当时的候选实验决定，不是当前产品账号政策；现行产品只确认由用户选择账号形式，具体模式仍待研究。
3. 未改变的研究事实包括：裸 `note_id` 直连观察、标题重发现 5/5、旧 token 直连 461 和覆盖缺口。主账号不参与只适用于当次在线探测实验；离线 Core 边界不变。

## 11. 2026-08-18 第三次会话增补

- `[本地验证，2026-08-18]` 用户观察与 HAR 脱敏分析新增三条事实：① 导出字段 `display_title` 是卡片层截断标题，非详情层完整标题；② 所观察无标题帖样本可由正文关键词命中，推广帖样本标题、正文搜索均未命中，数量未统计；③ 该 HAR 中正文仅存在于 HTML `__INITIAL_STATE__`，未记录 `/api/sns/web/v1/feed` 详情请求（235 条目、32 个 JSON 接口均无笔记内容标记）。适用边界见 §5 结论 8、§6.3 与 §8；原始 HAR 保留在用户本机，未入库。

## 12. 2026-09-09：协议身份通过与生成机制研究的下一步

`[本地验证]` `test_e` 的完整 Cookie + `xhshow==0.2.0` 本地请求签名，经固定 HTTP 当前用户接口返回 `200 / 0`，非 guest 身份检查通过，首次观测身份摘要已绑定。此次只发送一次身份请求；没有搜索、详情或 token capture。规范证据见[协议登录实测说明](../reverse/targets/xhs-xsec-token/experiment/protocol-method.md#已验证的登录方式与结果)。这与 §6 的既有浏览器会话搜索成功是不同实验，不能合并计算成功率。

9 月 9 日据此拟进行受控 token 来源与使用研究：复核 E 身份、搜索一个批准样本、确认精确目标的 token/source，最后验证详情。搜索响应没有 source 时构造的 `pc_search` 必须与实际返回字段分开记录。后续 9 月 10 日尝试在搜索前置门禁处停止，见 §13；完整闭环未通过，不证明推广帖可发现、主号列表可见或跨账号 token 可复用。

“取得 token”“验证 token 可用”和“推导生成算法”是三个不同成果。现有静态记录只在所审前端 bundle 中找到 token 消费点，尚无本地生成器证据；如果目标 token 已在服务端响应中出现，可以研究下发条件和生命周期，但仅靠输入输出不能保证还原服务器内部算法。后续顺序及证据要求见[token 研究计划](../reverse/targets/xhs-xsec-token/experiment/protocol-method.md#登录成功后的-token-研究顺序)。9 月 9 日这一轮仅同步文档，没有新增线上实验或放开原有停止条件。

## 13. 2026-09-10：身份匹配通过，单帖搜索 HTTP 461

`[本地验证]` E 在一次单帖流程中通过当前用户身份复核（HTTP `200` / API `0`，摘要匹配已有绑定），随后搜索接口返回 HTTP `461`。流程硬停止，共两次请求，没有进入目标匹配或详情，未生成目标 token/source capture；未使用截图中的浏览器会话或 token。脱敏报告与实现证据见[协议方法](../reverse/targets/xhs-xsec-token/experiment/protocol-method.md)。

本结果不能说明帖子不存在、搜索未命中、Cookie 过期、确定出现了 CAPTCHA 或某个签名字段错误，也不能推定是搜索频率造成的限制。它表明本次身份能力与搜索能力不同；当前暂停在线请求，不重试、换账号或切路。下一步只复核已有脱敏证据与固定源码，仍没有本次 token 生成/下发机制的动态证据。
