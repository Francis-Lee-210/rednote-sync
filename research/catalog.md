# 候选项目与链接调研：对 Rednote Sync 的作用和参考价值

初始调研日期：2026-08-11  
补充核查日期：2026-08-13（GitHub Star 快照补录、可借鉴方面与风控边界复核）  
调研方式：官方仓库、README、许可证、提交记录、指定 Issue、官方项目文档和少量关键源码的只读检查  
动态验证：本次调研没有新增运行；仅引用既有的一次有限本地运行记录。未安装依赖，未访问小红书接口，未读取 Cookie、token、HAR 或 `Volume` 数据

### 专项源码审查进度

| 对象 | 原等级 | 状态 | 固定 revision | 专项结论与报告 |
|---|---|---|---|---|
| XHS-Downloader | A | **完成；独立复审通过** | `56c912e0df7920ad0fbf5cd9d911628587b9c7e6` | 维持 A，但只借鉴行为或独立重写；见[专项源码审查](xhs-downloader/review.md) |
| OpenCLI | A | **完成；独立复审通过** | `a86d64705c526dc710f790e66cfcabf6ecf786b9` | 维持 A 级设计专项参考；整体 Bridge/daemon/高权限路径不集成；见[专项源码审查](opencli/review.md) |
| xhs-cli-export | A | **完成；独立复审通过** | `6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83` | 维持 A 级输出/恢复语义参考；JSONL 不是 resume checkpoint，现有 provider/下载/脚本不集成；见[专项源码审查](xhs-cli-export/review.md) |
| Playwright | A | **完成；独立复审通过** | `bcb3563aa73d7ac71ac8cb877433201b1b97b7da` | 维持 A 级阶段四项目级采用评估；只作通用浏览器底座，不提供 XHS/账号/风控语义；见[专项源码审查](playwright/review.md) |
| xiaohongshu-cli | A | **完成；独立复审通过** | `4d63f3c0c85ccd9054fa8e96d7f761aaf2507449` | 降为 B 级局部设计参考；现成网络 client、签名、Agent Skill、浏览器扫描和平台写面均为 D；见[专项源码审查](xiaohongshu-cli/review.md) |
| MediaCrawler | B | **完成；独立复审通过** | `5665a271ef15e0ec82b1f48a951b66760e054db9` | 维持 B 级局部架构、错误类型和反例参考；现成 Provider、浏览器/签名/代理、WebUI、媒体与状态层均为 D；见[专项源码审查](mediacrawler/review.md) |
| xiaohongshu-mcp | B | **完成；独立复审通过** | `da9ba0365e176bc0eb11885f1941271d895feb73` | 维持 B 级数据/状态与 capability 参考；现成 REST/MCP、浏览器/下载、平台写、Skill/Agent 部署均为 D；见[专项源码审查](xiaohongshu-mcp/review.md) |
| ReaJason/xhs | B | **完成；独立复审通过** | `f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0` | 维持 B 级访问材料、单页 cursor 与错误分类参考；现成 SDK、全量循环、媒体下载、签名服务和平台写面均为 D；见[专项源码审查](reajason-xhs/review.md) |
| Playwright MCP | B | **完成；独立复审通过** | `7e0457a7cbf88823bf0146d12c46ae12c6818247` | 维持 B 级 Agent 探索与能力边界参考；通用 MCP、HTTP 服务、unsafe 工具和生产直接集成均为 D；见[专项源码审查](playwright-mcp/review.md) |
| xiaohongshu-importer | B | **完成；独立复审通过** | `b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37` | 维持 B 级知识库输出与交互参考；现成采集、解析、下载、状态和生产接入均为 D；见[专项源码审查](xiaohongshu-importer/review.md) |
| Spider_XHS | B | **完成；独立复审通过** | `2030f5d4454e556ad7a9caa83b3ec532d4df20c7` | 维持 B 级单页接口、字段与cursor边界参考；全量循环、状态/媒体、远端程序、登录/写操作、Docker及源码复用均为 D；见[专项源码审查](Spider_XHS/review.md) |
| XHS_ALL_IN_ONE | B | **完成；独立复审通过** | `63b85de2b15b3f79134b08fa675381505f45d4db` | 维持 B 级 Adapter/审计/逐项状态参考；状态/媒体恢复、部署、安全、自动运营、平台写和源码复用均为 D；见[专项源码审查](XHS_ALL_IN_ONE/review.md) |
| Playwright 浏览器路线专题 | B | **完成；独立复审通过** | 综合固定报告，无独立源码 revision | Playwright 底层执行能力为 A 级 Stage 4 采用评估；“模拟人工可降低风控”为 D；见[综合专题](topics/playwright-human-like-route.md) |

12 个仓库对象和 1 个非仓库 Playwright 综合专题均已完成，并通过独立复审。当前队列没有活动对象。

## 1. 结论先行

这批资料里没有一个项目能够直接成为 Rednote Sync 的完整实现。最有价值的做法是拆开参考：

1. **XHS-Downloader**：参考“浏览器发现带 token 的链接”与“详情、图片、视频、Live Photo 下载”分层，以及媒体和 SQLite 输出；已有一次有限本地运行记录，但远不足以证明批量稳定性。
2. **OpenCLI**：参考已登录浏览器中的 `saved`、`liked`、详情和下载适配器；它的 Browser Bridge 权限很高，只适合作为后续专项审查对象。
3. **xhs-cli-export**：参考增量水位、失败时不推进 checkpoint、逐条中间结果和 Markdown 输出；它依赖另一个上游 CLI，且不下载视频。
4. **Playwright**：参考未来阶段四的自有浏览器适配器底座；它提供可靠的浏览器控制，不提供小红书业务语义，也不提供账号安全保证。
5. **xiaohongshu-cli**：参考机器可处理的错误分类、Cookie/token 生命周期、抖动与退避；逆向签名、宽泛浏览器凭据读取和大量写操作使它不适合直接接入。

当前阶段三仍应保持完全离线。所有 Cookie、浏览器、签名、远端 API 和平台风控处理只能进入未来阶段四的可替换适配器，不应渗入 [`sync-core.md`](../projects/rednote-sync-core/docs/sync-core.md)。

既有的 [Obsidian 客户端静态逆向](reverse/targets/rednote2obsidian/report.md) 和 [Notion 客户端静态逆向](reverse/targets/rednote2notion/report.md) 已经提供列表、详情、会话、游标、媒体和知识库写入的背景证据。本报告只引用其阶段边界，不重复逆向这两个客户端。

## 2. 证据和等级

### 2.1 证据等级

- `[外部声明]`：README、官网、作者或 Issue 用户的描述。
- `[静态证据]`：源码、配置、许可证或离线样本能直接确认的行为。
- `[本地验证]`：本项目曾实际运行并观察到的结果；不能外推到当前最新版、其他账号或其他内容类型。
- `[待确认]`：必须运行、使用真实环境或取得更多第一方材料才能判断。

存在延迟、指纹、真实浏览器、验证码冷却或重试代码，只能算静态实现证据。没有候选项目提供可重复的账号对照实验或平台承诺，因此本报告不把任何项目描述为“已经解决反风控”。

### 2.2 建议等级

- **A**：值得下一轮专项静态审查，不表示建议直接安装或采用。
- **B**：只参考特定组件、数据契约或设计边界。
- **C**：保留为背景资料或条件性备选，目前不投入专项审查。
- **D**：当前排除；记录原因，避免以后重复调查。

## 3. 总览矩阵

| 对象 | GitHub Star（2026-08-12） | 最适合承担或参考的职责 | 主要依赖 | 维护/许可快照 | 结论 |
|---|---:|---|---|---|---|
| [XHS-Downloader](https://github.com/JoeanAmier/XHS-Downloader) | 12,313 | signed URL 发现、详情、图片/视频/Live Photo、SQLite | 页面状态、可选 Cookie、`xsec_token` | 2026-08 仍更新；GPL-3.0 文件，README 另有商业限制措辞 | **A** |
| [XHS-Downloader Issue #397](https://github.com/JoeanAmier/XHS-Downloader/issues/397) | — | token 数据契约问题的背景 | 未解决提问、非维护者回复 | 2026-05 创建；没有正式解决结论 | **C** |
| [xhs-cli-export](https://github.com/DoYitNow/xhs-cli-export) | 3 | 增量状态、中间结果、Markdown/图片输出 | `xhs-cli-headless`、二维码登录 | 2026-06；MIT | **A** |
| [xiaohongshu-cli](https://github.com/jackwener/xiaohongshu-cli) | 2,477 | API 适配器、错误分类、退避/token cache | Cookie、逆向签名、浏览器凭据读取 | 2026-03；声明 Apache-2.0，但缺 LICENSE 文件 | **B**（专项审查后降级） |
| [OpenCLI](https://github.com/jackwener/OpenCLI) | 28,081 | 已登录 Chrome 中的 saved/liked/detail/download 外部适配器 | 高权限扩展、本地 daemon、浏览器 Cookie | 2026-08；Apache-2.0 | **A** |
| [Playwright](https://github.com/microsoft/playwright) | 94,368 | 自有确定性浏览器适配器底座 | 专用 profile 或敏感 `storageState` | 2026-08；Apache-2.0 | **A** |
| [xiaohongshu-importer](https://github.com/bnchiang96/xiaohongshu-importer) | 124 | Obsidian Markdown、媒体相对路径、分类目录 | 公开页 `__INITIAL_STATE__` | 2026-01；MIT | **B** |
| [MediaCrawler](https://github.com/NanmiCoder/MediaCrawler) | 61,715 | 浏览器/API/签名/存储分层，多格式输出 | CDP、Cookie、私有接口和签名 | 2026-08；非商业学习许可证 | **B** |
| [MediaCrawler Issue #915](https://github.com/NanmiCoder/MediaCrawler/issues/915) | — | CDP 仍可能出现风控提示的背景 | 一名用户在含多个未控制变量环境下的报告 | 2026-06 创建；没有维护者因果结论 | **C** |
| [Spider_XHS](https://github.com/cv-cat/Spider_XHS) | 7,247 | 接口面、会话材料和签名状态边界 | Cookie、多套逆向签名 | 2026-07；许可证冲突/未知 | **B** |
| [XHS_ALL_IN_ONE](https://github.com/cv-cat/XHS_ALL_IN_ONE) | 674 | 内容/资产分离、任务审计、逐项结果 | Spider_XHS、多账号和运营平台；阶段三不引入 | 2026-07；许可证冲突/未知 | **B** |
| [xiaohongshu-mcp](https://github.com/xpzouying/xiaohongshu-mcp) | 15,204 | 浏览器会话、操作后校验、MCP/REST 工具面 | 自带浏览器、Cookie、默认绑定全接口的未鉴权服务 | 2026-08；Apache-2.0 | **B** |
| [ReaJason/xhs](https://github.com/ReaJason/xhs) | 2,200 | 收藏/点赞分页、详情、媒体字段和异常类型 | Cookie、Playwright/stealth 或签名服务 | 2025-07；MIT | **B** |
| [Playwright MCP](https://github.com/microsoft/playwright-mcp) | 36,014 | DOM 探索、诊断和人工登录/验证码恢复 | 持久浏览器 profile、Agent 工具权限 | 2026-08；Apache-2.0 | **B** |
| 使用 Playwright 模拟人工操作 | — | 阶段四浏览器获取路线 | 自行实现限速、暂停、checkpoint | 不是现成方案 | **B**；若作为反风控保证则 **D/未知** |
| [justoneapi-python](https://github.com/justoneapi/justoneapi-python) | 240 | 条件性的商业远端详情 provider | 付费 API、query token、数据外发 | 2026-08 有含自动空提交的仓库活动；MIT 条款完整但版权归属行未填写 | **C** |
| [xhs_web_crawler](https://github.com/leafiy/xhs_web_crawler) | 55 | 仅剩 HAR 离线解析概念 | 已登录 Chrome、敏感 HAR | 2025-02；README 声称 MIT 但 LICENSE 缺失，另含禁止商业用途声明 | **D** |
| [Postman Spider collection](https://www.postman.com/solar-flare-375895/spider/collection/vykmhw7/) | — | 历史请求类别目录 | 来源、版本和认证未知 | 无可确认许可证/日期 | **D** |
| [阿里云文章 1689270](https://developer.aliyun.com/article/1689270) | — | 泛化 HTTP 示例 | 无小红书第一方证据 | 用户投稿文章 | **D** |
| [阿里云文章 1661722](https://developer.aliyun.com/article/1661722) | — | 本次无法取得正文 | 全部未知 | 本次工具无法读取 | **D** |

Star 数量来自 GitHub 官方仓库元数据，是 2026-08-12 的动态快照；Issue、文章和路线类对象不单独计数。Star 只表示关注度，没有进入评级。维护时间也只代表仓库有变动，不代表平台功能仍然有效。

## 4. A 级：值得下一轮专项静态审查

### 4.1 XHS-Downloader

**专项审查状态。** 固定 revision 的 tracked-only 源码审查已完成并通过三类独立复审，详见[专项源码审查报告](xhs-downloader/review.md)和[来源记录](xhs-downloader/provenance.json)。专项审查维持 A 级，但明确限制为行为借鉴或独立重写，不建议直接嵌入源码。

**它是什么。** README 将项目描述为链接提取、详情采集和媒体下载工具，支持用户脚本、CLI、API 和 MCP；其用户脚本覆盖发布、收藏、点赞、专辑、搜索和推荐页面。[README](https://github.com/JoeanAmier/XHS-Downloader/blob/master/README.md)

**证据。**

- `[静态证据]` 本地固定 commit `56c912e0df7920ad0fbf5cd9d911628587b9c7e6` 的详情转换代码包含 note ID、标题、正文、类型、标签、时间、作者、互动数据、图片、视频和 Live Photo 动态资源；下载结果可写媒体目录、`ExploreData.db` 和 `ExploreID.db`。[converter.py](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/expansion/converter.py) [recorder.py](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/module/recorder.py)
- `[静态证据]` 下载器存在临时文件和 HTTP `Range` 续传路径，并在本次计划任务全部成功后记录 note ID；`416` 会删除缓存并按 retry 配置从零重试，但未验证服务端忽略非零 Range、最终长度/哈希或资源变化。[download.py](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/application/download.py)
- `[本地验证]` 较早的项目记录显示：程序曾成功启动；一个旧链接失败，一个较新图文链接在无 Cookie 情况下成功下载图片并写入 SQLite。该结果没有锁定到当前 upstream commit，也没有验证视频、Live Photo 或批量同步，详见[项目设计记录](../docs/design/product-design.md)。
- `[外部声明]` Cookie 不是强制项，但无 Cookie 时视频只能获得低分辨率；README 已把“自动读取浏览器 Cookie”标为失效，需要人工或外部适配器处理。[Cookie 说明](https://github.com/JoeanAmier/XHS-Downloader/blob/master/README.md#cookie)

**参考价值。** 重点参考“浏览器发现 → 带来源和 token 的 URL 队列 → 详情/媒体下载”分层、Live Photo 同 ordinal 双资源模型和临时文件两阶段落盘。Rednote Sync 不应照搬作品级 skip；特别是只下载部分图片也可能写整条 note ID，应继续保存逐资产状态、长度、哈希、失败原因和可恢复 checkpoint。

**限制和风险。** 固定审查版本的用户脚本从页面状态同时读取 ID 和 `xsecToken`，证明该实现依赖成对输入，不证明 token 在理论上绝对不能推导。[用户脚本源码](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/static/XHS-Downloader.js#L809-L858) 专项审查还确认：服务模式默认监听所有接口且没有显式应用层鉴权、请求客户端关闭 TLS 验证、Cookie/动态 URL 缺少统一 secret 边界。仓库包含 GPL-3.0 LICENSE，但 README 另有附加限制措辞；不判断法律效力，当前只借鉴行为或独立实现。

### 4.2 xhs-cli-export

**专项审查状态。** 固定 revision 的 tracked-only 源码审查已完成并通过三类独立复审，详见[专项源码审查报告](xhs-cli-export/review.md)和[来源记录](xhs-cli-export/provenance.json)。专项结论维持 A 级输出设计参考，但 JSONL 只算 partial evidence；当前状态、下载、provider 与快捷脚本均不进入生产链。

**它是什么。** 把收藏、点赞和搜索结果导出为 Obsidian 友好的 Markdown、JSON、索引和本地图片，并维护 `xhs_state.json`。[README](https://github.com/DoYitNow/xhs-cli-export/blob/main/README.md)

**静态价值。**

- 按来源保存 `last_success_at`、已见 note ID 和运行记录；只有完整成功才推进 checkpoint。
- streaming 模式能保留本次运行已收到的 JSONL，并在上游失败时不误推进成功水位。
- 输出包含原始 JSON、详情 JSON、运行索引、Markdown 和图片，接近 Rednote Sync 希望的可审计产物。

关键边界是：新运行会清空 stream 文件，未实现读取旧 partial JSONL 自动续跑；详情模式也不一定逐条持久化。源码只下载图片，不含视频或 Live Photo。项目完全依赖 `xhs-cli-headless`，其可靠性和许可证需另行核对。[主脚本](https://github.com/DoYitNow/xhs-cli-export/blob/main/src/xhs_export.py) [MIT LICENSE](https://github.com/DoYitNow/xhs-cli-export/blob/main/LICENSE)

**对本项目的作用。** 专项审查 checkpoint 只在成功推进、动作时间与 seen-ID 组合、失败原因可解释、运行级索引和中间产物；不采用其上游采集层或最终 Schema。

### 4.3 xiaohongshu-cli

**专项审查状态。** 固定 revision 的 tracked-only 源码审查已完成并通过三类独立复审，详见[专项源码审查报告](xiaohongshu-cli/review.md)和[来源记录](xiaohongshu-cli/provenance.json)。专项评级由初始 A 降为 **B（局部设计参考）**；现成网络 client、签名/Camoufox、“anti-detection”、Agent Skill、浏览器扫描和平台写能力均按 D 排除。

**它是什么。** Python CLI，覆盖搜索、详情、评论、用户、收藏和点赞，也包含关注、互动、发布、删除等写操作。[README](https://github.com/jackwener/xiaohongshu-cli/blob/main/README.md)

**静态价值。** 最值得独立实现的是 `note_id + token + source` 的短期访问材料配对、类型化错误代码、外层 envelope、Cookie 名称 allowlist 和 command/domain/transport 分层。[client.py](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/client.py) [SCHEMA.md](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/SCHEMA.md) 但 envelope 内的 `data` 没有版本化 Schema，token/search/index cache 也不是 checkpoint。

**风险。** 缺少/过期 Cookie或强制刷新时，auto 模式会扫描多个本地浏览器却不绑定预期账号。验证码、IP、签名和会话错误在部分读取路径会被捕获后继续，统一 retry 还会重放非幂等写操作。默认 browser-assisted QR 的 guest 状态可能 fail-open，日志可暴露 session/token/验证挑战。高斯延迟、固定指纹和 Camoufox 不是账号安全证明。`pyproject.toml` 声明 Apache-2.0，但固定树没有 LICENSE/NOTICE，当前不复制或链接源码。[pyproject.toml](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/pyproject.toml)

### 4.4 OpenCLI

**专项审查状态。** 固定 revision 的 tracked-only 源码审查已完成并通过三类独立复审，详见[专项源码审查报告](opencli/review.md)和[来源记录](opencli/provenance.json)。专项结论维持 A 级设计参考，但 Browser Bridge、daemon、高权限扩展、stealth 和平台写路径均不直接集成。

**它是什么。** Browser Bridge 扩展和本地 daemon 将网站操作封装为 CLI/Agent 接口；内置小红书 `saved`、`liked`、`note`、`comments`、`download` 等读取命令，也包含发布、关注和删除等写命令。[XHS adapter 文档](https://github.com/jackwener/OpenCLI/blob/main/docs/adapters/browser/xiaohongshu.md)

**静态价值。** XHS 适配器混合使用 DOM、hydrated store 和浏览器网络响应；收藏/点赞结果保留 signed URL/token，导航、滚动和评论读取有上限，并能把安全限制和登录墙映射成类型化错误。它是最快验证未来 `BrowserSourceAdapter` 输入契约的候选。[collection helper](https://github.com/jackwener/OpenCLI/blob/main/clis/xiaohongshu/collection-helpers.js)

**风险。** Browser Bridge 在隔离自动化窗口中执行，并按目标域读取现有 Chrome Cookie；扩展请求 `debugger`、`tabs`、`cookies`、`downloads` 和 `<all_urls>` 等广泛权限。[PRIVACY.md](https://github.com/jackwener/OpenCLI/blob/main/PRIVACY.md) [extension manifest](https://github.com/jackwener/OpenCLI/blob/main/extension/manifest.json) “localhost only/不外传”是项目声明，不能替代 daemon 鉴权、供应链和扩展源码审计。若以后验证，平台读取只允许 `saved/liked/note`；`download` 作为受限输出根目录内的独立本地写能力处理；其余写操作不暴露。[Apache-2.0 LICENSE](https://github.com/jackwener/OpenCLI/blob/main/LICENSE)

### 4.5 Playwright

**专项审查状态。** 固定 revision 的 sparse/tracked-only 源码审查已完成并通过三类独立复审，详见[专项源码审查报告](playwright/review.md)和[来源记录](playwright/provenance.json)。专项结论维持 A 级，但严格限定为未来阶段四的项目级采用评估；当前 `1.63.0-next` 快照不是已审查的正式发布制品。

**它是什么。** Microsoft 维护的通用浏览器自动化框架，提供浏览器 context、locator 自动等待、网络观察、下载、trace 和多浏览器支持。[仓库](https://github.com/microsoft/playwright) [官方文档](https://playwright.dev/docs/library)

**对本项目的作用。** 它适合作为阶段四自有浏览器适配器的底座，让 Rednote Sync 自己掌握 selector、业务状态、限速、错误分类、checkpoint 和规范化输出。`storageState` 和持久 profile 含登录信息，必须按凭据处理；官方也警告不要自动化日常 Chrome 的默认 User Data 目录。[认证状态](https://playwright.dev/docs/auth) [persistent context](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context)

专项审查进一步确认：外层必须实现 `ProfileLease + SessionBinding`；Download/HAR/Trace 不能作为 canonical 媒体或脱敏证据；context-bound HTTP 会读写浏览器 Cookie；网络暴露的 `launchServer` 应排除。Playwright 的自动等待和 `slowMo` 不是反检测能力。A 级只表示它值得阶段四采用评估，不表示已经解决小红书获取或账号风险。[Apache-2.0 LICENSE](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/LICENSE)

## 5. B 级：只参考部分组件或边界

### 5.1 xiaohongshu-importer

**专项审查状态。** 固定 revision 的 tracked-only 源码审查已完成并通过三类独立复审，详见[专项源码审查报告](xiaohongshu-importer/review.md)和[来源记录](xiaohongshu-importer/provenance.json)。专项结论维持 **B（知识库输出与交互参考）**；候选没有独立 writer，现成页面解析、媒体下载、状态与生产同步接入均按 D 排除，Rednote 只 clean-room 借鉴输出 UX，并重构为消费安全 canonical 数据的独立 projector。

该 Obsidian 插件接收单篇分享链接或 URL，解析页面 `__INITIAL_STATE__`，生成 Markdown 并选择远程嵌入或下载图片/视频。[README](https://github.com/bnchiang96/xiaohongshu-importer/blob/main/README.md) [main.ts](https://github.com/bnchiang96/xiaohongshu-importer/blob/main/main.ts)

值得参考的是文件夹、frontmatter、媒体相对路径和下载失败后的降级；不能参考同步策略，因为它没有列表发现、稳定 ID 幂等、冲突处理、checkpoint、媒体完整性校验或批量恢复。远端内容直接进入 YAML/Markdown 也需要更严格的转义。许可证为 MIT。[LICENSE](https://github.com/bnchiang96/xiaohongshu-importer/blob/main/LICENSE)

### 5.2 MediaCrawler

**专项审查状态。** 固定 revision 的 tracked-only 源码审查已完成并通过三类独立复审，详见[专项源码审查报告](mediacrawler/review.md)和[来源记录](mediacrawler/provenance.json)。专项结论维持 **B（局部架构、错误类型与反例参考）**；现成 Provider、签名、CDP/stealth/代理、WebUI 控制面、媒体下载与 checkpoint 语义均按 D 排除。

MediaCrawler 是多平台公开内容采集器，XHS 方向覆盖搜索、指定笔记、创作者主页、评论和可选媒体，不针对当前账号的点赞/收藏同步。[README](https://github.com/NanmiCoder/MediaCrawler/blob/main/README.md)

它对阶段四最有价值的是 Playwright/CDP 会话、HTTP 客户端、签名、存储后端和“API 失败回退页面初始状态”的分层。当前实现没有 Rednote Sync 所需的持久逐页/逐项 checkpoint，媒体下载也不是逐资产可恢复。项目采用自定义非商业学习许可证，禁止商业用途和大规模采集，因此只能学习边界和接口，不能作为未来商业产品的代码依赖。[LICENSE](https://github.com/NanmiCoder/MediaCrawler/blob/main/LICENSE)

### 5.3 Spider_XHS

**专项审查状态。** 固定 revision 的 tracked-only 源码审查已完成并通过三类独立复审，详见[专项源码审查报告](Spider_XHS/review.md)和[来源记录](Spider_XHS/provenance.json)。专项结论维持 B：只参考单页字段、访问材料配对意图与重复cursor防停滞；现成全量循环、状态/媒体、远端程序、设备重建/406、平台写、Docker和源码/算法复用均为D。

Spider_XHS 展示了用户发布、喜欢、收藏、详情、搜索、评论、媒体和多个创作者/运营接口，以及本地维护会话材料和逆向签名的结构。[README](https://github.com/cv-cat/Spider_XHS/blob/master/README.md)

它适合作为“API 门面、会话拥有者、参数来源和签名状态机”的静态研究样本；不具备可确认的持久同步 checkpoint，且接口和算法维护成本高。README badge 声称 MIT，但仓库中未能读取 LICENSE 文件，同时 README 写有禁止商业化限制，许可状态按冲突/未知处理。在作者提供一致的正式许可证前不复制源码。[LICENSE 链接](https://github.com/cv-cat/Spider_XHS/blob/master/LICENSE)

### 5.4 XHS_ALL_IN_ONE

这是建立在相近采集能力上的全栈运营平台，覆盖账号、内容库、资产、AI 改写、发布、调度和分析。[README](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/master/README.md)

可参考内容与资产表分离、任务审计、逐项结果和“采集 → 归一化 → 入库”的产品流程；不应引入整套运营单体、自动发布、多账号和 AI 边界。任务字段不等于可靠恢复已经闭环。许可证同样存在 MIT badge、缺失 LICENSE 和禁止商业化措辞冲突。[LICENSE 链接](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/master/LICENSE)

### 5.5 xiaohongshu-mcp

**专项审查状态。** 固定 revision 的 tracked-only 源码审查已完成并通过三类独立复审，详见[专项源码审查报告](xiaohongshu-mcp/review.md)和[来源记录](xiaohongshu-mcp/provenance.json)。专项结论维持 **B（局部设计参考）**；现成无鉴权 REST/MCP、浏览器/下载、平台写、Python Skill、Agent examples 和部署方案均按 D 排除。

Go 项目通过 Rod/内置浏览器驱动页面，同时暴露 MCP 和 REST。`[外部声明]` README/API 文档描述二维码登录、有界滚动、“人性化”输入和操作后检查；`[静态证据]` Cookie 数据结构会持久化 `FingerprintSeed`。[README](https://github.com/xpzouying/xiaohongshu-mcp/blob/main/README.md) [API 文档](https://github.com/xpzouying/xiaohongshu-mcp/blob/main/docs/API.md) [cookies.go](https://github.com/xpzouying/xiaohongshu-mcp/blob/main/cookies/cookies.go)

值得参考的是单一登录会话、会话与 fingerprint seed 绑定、操作后读取状态确认和可取消的有限循环。不能把人性化轨迹写成账号安全证据。

默认实现存在更直接的安全问题：Cookie 写入代码请求 `0644` mode，未主动强制 `0600`，实际权限可能被系统 `umask` 收紧；服务默认使用 `:18060` 监听所有网络接口，CORS 为 `*`，没有可确认的认证 middleware，同时暴露发布、评论、点赞和收藏等写操作。[main.go](https://github.com/xpzouying/xiaohongshu-mcp/blob/main/main.go) [middleware.go](https://github.com/xpzouying/xiaohongshu-mcp/blob/main/middleware.go) 若继续研究，只能绑定回环地址、加入鉴权、把凭据明确限制为 `0600` 并裁剪为只读工具。[Apache-2.0 LICENSE](https://github.com/xpzouying/xiaohongshu-mcp/blob/main/LICENSE)

### 5.6 ReaJason/xhs

**专项审查状态。** 固定 revision 的 tracked-only 源码审查已完成并通过三类独立复审，详见[专项源码审查报告](reajason-xhs/review.md)和[来源记录](reajason-xhs/provenance.json)。专项结论维持 **B（局部设计参考）**；现成在线 SDK、两个全量循环、媒体 downloader、两套签名服务、Cookie/secret模式、平台写与Docker制品链均按D排除。

该 Python SDK 的文档和源码包含用户收藏、点赞分页、详情、评论、媒体 URL、验证码/IP/signature 异常和多种写操作。[接口文档](https://reajason.github.io/xhs/crawl.html) [core.py](https://github.com/ReaJason/xhs/blob/master/xhs/core.py)

它最适合参考发现、详情和媒体的接口分层，以及 `cursor`、领域字段和异常类型。当前 master 与文档已有漂移：详情函数要求额外 `xsec_token`，部分 helper 仍按旧签名调用。截至 2026-08-11，最近可见提交停留在 2025-07；这只能说明维护快照较旧，不能确认项目已经停止维护。Cookie、Playwright/stealth 或本地签名服务依赖也不应进入阶段三。[快速入门](https://reajason.github.io/xhs/basic.html) [提交记录](https://github.com/ReaJason/xhs/commits/master/) [MIT LICENSE](https://github.com/ReaJason/xhs/blob/master/LICENSE)

### 5.7 Playwright MCP

Playwright MCP 将通用浏览器操作暴露给 Agent，支持持久或 isolated profile、storage state、扩展连接、页面快照、下载和调试能力。[README](https://github.com/microsoft/playwright-mcp/blob/main/README.md)

它适合开发期探索 DOM、诊断站点变化、人工扫码或验证码恢复，不适合无人值守同步主链路：没有 XHS 领域契约、限速、幂等或 checkpoint。官方明确说明 origin allowlist 和 secrets 替换不构成完整安全边界；页面、网络、console 和 profile 都可能含敏感数据。只应在受监督、isolated profile 下使用。[Apache-2.0 LICENSE](https://github.com/microsoft/playwright-mcp/blob/main/LICENSE)

**专项审查状态。** 固定 revision 的 tracked-only 源码审查已完成并通过三类独立复审，详见[专项源码审查报告](playwright-mcp/review.md)和[来源记录](playwright-mcp/provenance.json)。专项结论维持 **B（Agent 浏览器探索与能力边界参考）**；根仓库只是 `playwright-core` 的薄包装层，精确 alpha 实现来源仍有 provenance 缺口。通用 MCP/HTTP 服务、任意页面/代码工具、秘密和本地文件能力以及生产直接集成均按 D 排除。

### 5.8 “使用 Playwright 模拟人工操作”

**综合专题状态。** 六份已完成专项报告的静态综合研究已完成并通过三路独立复审，详见[“使用 Playwright 模拟人工操作”路线专题](topics/playwright-human-like-route.md)和[中断恢复记录](topics/playwright-human-like-route.checkpoint.json)。

更准确的路线是“基于 Playwright 的受授权、受监督、窄只读浏览器适配器”。Playwright 的 Browser/Context/Page、网络、下载和生命周期能力可列为 Stage 4 的 A 级采用评估；OpenCLI 的获取分层、会话租约和 unknown-outcome 模式只 clean-room 借鉴；Playwright MCP 仅用于合成、脱敏的 Agent 探索，真实账号原始诊断由人类本地 ArtifactBroker 隔离。生产实现必须建立 `ProfileLease + SessionBinding + BrowserRednoteClient`、方法级 capability vector、版本化 receipt、全局停止闸和人工恢复。

真实页面点击、滚动、延迟、persistent profile、真实浏览器或 CDP 都不是平台许可、账号安全或降低封禁概率的证明；stealth、验证码求解、代理/账号轮换、指纹伪装和签名绕过明确排除。因此 Playwright 执行底座为 A 级评估对象，但“模拟人工可降低风控”的主张为 **D（无证据）**。

## 6. C 级：条件性备选和风险背景

### 6.1 justoneapi-python

这是商业托管数据服务的官方 Python SDK。公开文档包含搜索、用户发布、详情、评论、分享链接解析和视频详情等接口；本次在公开目录中未发现“当前用户点赞/收藏列表”接口，因此本轮不能把它作为核心发现入口，私有或未公开能力仍属未知。[SDK](https://github.com/justoneapi/justoneapi-python) [小红书接口目录](https://docs.justoneapi.com/zh/api/xiaohongshu-rednote/) [使用与计费](https://docs.justoneapi.com/zh/usage)

它可以作为未来“接受数据外发和商业远端依赖”前提下的详情 provider 候选，并可参考统一业务错误、配额和 provider 隔离。主要风险是付费、供应商锁定、字段变化、Token 放在 query 导致日志泄漏，以及文档提供明文 HTTP 备用地址。2026-08 的仓库活动含自动空提交，不能据此判断人工维护质量或 SLA。[提交记录](https://github.com/justoneapi/justoneapi-python/commits/main/) 仓库明确采用完整 MIT 文本，但版权归属行仍为模板占位符；许可证意图明确而权利人信息不完整，复制代码前需复核。[LICENSE](https://github.com/justoneapi/justoneapi-python/blob/main/LICENSE) [服务条款](https://justoneapi.com/zh/terms)

### 6.2 XHS-Downloader Issue #397

[Issue #397](https://github.com/JoeanAmier/XHS-Downloader/issues/397) 本身是一条“已知 note ID 如何获得 xsec_token”的未解决提问；bot 或普通用户回复不是维护者结论。它的作用是提示数据契约风险，而不是提供解决方案。

真正的静态证据来自固定 commit `135beb23982e99668e4a2cd92eab76b4ba64b47c` 的用户脚本：该历史实现从页面状态同时读取 note ID 和 `item.xsecToken` 并构造 URL。因此阶段四发现客户端需要在内存私有 envelope 中把 access secret 与安全 note reference 配对，但不能由此声称平台 token 永远不可推导或可刷新，也不能把 token 或原始 URL持久化。[用户脚本源码](https://github.com/JoeanAmier/XHS-Downloader/blob/135beb23982e99668e4a2cd92eab76b4ba64b47c/static/XHS-Downloader.js#L809-L858)

### 6.3 MediaCrawler Issue #915

[Issue #915](https://github.com/NanmiCoder/MediaCrawler/issues/915) 中有一名用户报告出现疑似“AI 操作/风控”提示；原始环境包含 CDP、VPN 等无法隔离的变量。它证明真实浏览器/CDP 不能被当作零风险保证，但不能建立因果，也不能证明当前版本普遍不可用或代理/降频能够修复。

对 Rednote Sync 的直接影响是：阶段四默认单任务、低频、可人工暂停；验证码、安全限制或登录变化出现时停止，不自动切换代理或继续重试。

## 7. D 级：当前排除

### 7.1 xhs_web_crawler

该原型要求已登录 Chrome、模拟点击，并把 DevTools 导出的 HAR 解析为 JSON。[README](https://github.com/leafiy/xhs_web_crawler/blob/main/README.md)

静态检查发现 manifest 没有注册 background service worker，也缺少代码所用的 `debugger`、`webRequest`、`downloads` 等权限；执行上下文与 API 使用不一致。[manifest](https://github.com/leafiy/xhs_web_crawler/blob/main/chrome_extension/manifest.json) [background.js](https://github.com/leafiy/xhs_web_crawler/blob/main/chrome_extension/background.js) README 的“不触发反爬”没有证据；它一方面声称 MIT 并链接不存在的 LICENSE，另一方面又写有“请勿用于商业用途”，许可状态冲突/未知。“Save all as HAR with content” 还可能包含 Cookie、Authorization 和完整响应。当前只保留“浏览器采集与经脱敏后的离线样本分离”的概念，不运行或复用该项目。

### 7.2 Postman Spider collection

页面可访问，也能看到推荐、用户、详情、评论、搜索和验证码等请求名称，但没有第一方归属、版本、许可证、维护日期或有效性证据。[Collection](https://www.postman.com/solar-flare-375895/spider/collection/vykmhw7/) 不导入、不执行，不把请求名称当作可用接口事实。

### 7.3 阿里云文章 1689270

文章给出 API Key/Bearer Token 和 `api.xiaohongshu.com/v1/notes/{id}` 示例，但没有小红书第一方文档支持；页面也说明内容来自用户投稿、阿里云不拥有著作权且不承担责任。[文章](https://developer.aliyun.com/article/1689270) 它没有超过一般 HTTP/JSON 教程的新增价值，不作为实现依据。

### 7.4 阿里云文章 1661722

本次调研工具没有取得正文，无法验证作者、内容、来源、日期或许可。[目标链接](https://developer.aliyun.com/article/1661722) 当前按证据不足排除，不断言页面永久失效；如用户仍记得其来源和价值，可另行人工只读复核。

## 8. 按可借鉴方面比较

本节比较的是候选对象在具体设计方面的参考价值，而不是再次给项目整体排名。第 3 节的 A–D 是研究优先级，不等于采用等级；同一项目可以同时提供正面模式和风险反例。下表中的“已有实现”仍按第 2 节区分外部声明、静态证据和待确认项，不能据此推导线上稳定性、平台授权或账号安全。

### 8.1 核心架构与同步设计

| 编号与可借鉴方面 | 主要参考对象 | 建议借鉴的具体设计 | 采用边界与不应照搬内容 |
|---|---|---|---|
| **M1 链接发现与访问材料配对** | [OpenCLI collection helper](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/clis/xiaohongshu/collection-helpers.js)、[XHS-Downloader 用户脚本](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/static/XHS-Downloader.js)；[ReaJason/xhs](https://github.com/ReaJason/xhs/blob/master/xhs/core.py) 补充分页接口形状 | `[静态证据]` 结构化网络响应或页面状态优先，DOM 只作回退；未来 `TransientListPage` 应把安全 `ListItem` 与不可序列化的 `PrivateNoteAccess` 一对一配对，并保留 membership、页面顺序及服务端确实返回的 cursor | token、完整 signed URL 只在内存使用；不把固定滚动次数、数组位置或 DOM selector 当平台协议。OpenCLI 当前结果没有足以支持可靠全量同步的服务端 cursor，分页深度仍待验证 |
| **M2 详情字段提取与规范化契约** | [XHS-Downloader converter](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/expansion/converter.py)、[详情映射](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/application/explore.py)；[MediaCrawler](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/xhs/core.py) 补充 fallback | 在 provider 内把页面/API 字段解码成版本化 `Note`，对时间、计数和媒体采用明确的 nullable 规则；重新计算语义 payload hash 和 `SourceRank`，进入核心前移除访问材料 | 不复制候选项目的中文键名、`-1` 哨兵、逗号拼接媒体或原始 dict；不持久化 token/signed URL。DOM 详情字段不完整，不能单独定义 canonical Schema |
| **M3 图片、视频与 Live Photo 资产建模** | [XHS-Downloader image](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/application/image.py)、[download](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/application/download.py)；OpenCLI、MediaCrawler 仅补充普通媒体 | 保留页面 ordinal；把 Live Photo 表示为共享 ordinal/group 的 still image 与 motion video 两个物理资产。每项分别记录 role、状态、MIME、长度、hash 和 object receipt，远端 URL 只进入瞬态 `TransientMediaSource` | 当前 [`sync-core.md`](../projects/rednote-sync-core/docs/sync-core.md) 尚无显式 Live Photo group，需留待未来 Schema 评审；不靠文件名推断配对、不作品级 skip，也不把普通图片/视频下载器表述成完整 Live Photo 支持 |
| **M4 游标、水位与稳定 ID 幂等** | [xhs-cli-export](https://github.com/DoYitNow/xhs-cli-export/blob/main/src/xhs_export.py)、[XHS-Downloader recorder](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/module/recorder.py) | 借鉴“完整成功后才推进水位”和成功后登记稳定 ID；继续由 `StateStore` 分开保存服务端 `ServerCursor`、head frontier、seen IDs 与运行记录 | note ID、最后成功项和时间戳都不能冒充 cursor；候选水位不能替代 Rednote Sync 的 cursor provenance，以及 host/account/target/board 分区 |
| **M5 中间结果、checkpoint 与失败恢复** | [xhs-cli-export](https://github.com/DoYitNow/xhs-cli-export/blob/main/src/xhs_export.py)、[XHS_ALL_IN_ONE](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/master/README.md) | 保留逐条中间结果、失败原因和运行索引；失败或暂停时保留旧 progress，从 SQLite/object store 的 durable checkpoint 恢复，短事务提交前重新校验 revision | xhs-cli-export 新运行会清空 partial stream，并没有真正续读旧 JSONL；任务表和逐项结果字段也不等于恢复闭环。不得引入 XHS_ALL_IN_ONE 的运营单体、多账号或发布能力 |
| **M6 媒体续传、完整性与逐资产状态** | [XHS-Downloader download](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/application/download.py)；xhs-cli-export 作媒体范围反例 | 借鉴临时文件、HTTP `Range` 尝试和成功后登记；由 `MediaStore` 对每个 `MediaSlot` 单独保存状态、长度、内容哈希、magic-byte MIME、原子 object receipt 和失败原因 | 作品级成功 ID 不是完整性证明；候选代码遇 `416` 会删除缓存，若配置了重试，后续尝试将从字节 0 重新下载，但没有最终完整性校验；也未防止服务端忽略非零 `Range` 后以 `200` 返回全量内容却继续追加，或资源版本变化。xhs-cli-export 只覆盖图片，不能代表视频或 Live Photo 恢复 |
| **M7 DOM、页面状态、网络响应与 API 的分层获取** | [OpenCLI collection helper](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/clis/xiaohongshu/collection-helpers.js)、[MediaCrawler core](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/xhs/core.py)、[Playwright network](https://playwright.dev/docs/network) | 阶段四采用有序 fallback：页面导航和身份确认 → 页面自身网络响应 → hydrated/SSR state 或 HTML → DOM。产物记录 `sourceLayer`、adapter/schema/selector 版本和类型化失败原因 | 不复制私有 endpoint、签名、固定指纹或代理路线；不同候选的 fallback 顺序并不一致，应借鉴分层和来源标记，而不是宣称某一层永远可靠 |
| **M8 浏览器 profile、会话复用与隔离** | [Playwright persistent context](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context)、[认证状态](https://playwright.dev/docs/auth)、[Playwright MCP](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/README.md) | 阶段四建立显式 `ProfileLease`：专用目录、单实例排他锁、干净关闭和崩溃恢复。明确授权的常规同步可使用 persistent profile；一次性诊断或人工恢复优先 isolated profile | 不扫描或自动复用日常 Chrome profile，不让多个 Agent 共享 profile。profile、storage state、trace 和 HAR 均为敏感材料；persistent profile、CDP 和 `slowMo` 不是反风控证明 |
| **M9 单账号约束、身份校验与会话所有权** | [OpenCLI 身份/页面校验](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/clis/xiaohongshu/collection-helpers.js)、[xiaohongshu-mcp login](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/xiaohongshu/login.go) | 设计 `SessionBinding(hostId, accountId, profileId, sessionRevision)`；每轮开始、checkpoint 恢复和人工重新登录后读取实际账号 ID，不一致或无法确认均以 `AUTH_REQUIRED` 暂停。同一账号只允许一个同步 owner | “已登录”不等于登录了预期账号，昵称和 fingerprint seed 都不能代替稳定账号 ID。候选项目没有完整实现跨登录、发现、详情和媒体任务的全局绑定，该设计仍待阶段四验证 |
| **M10 Provider/Adapter 隔离与版本化 Schema 校验** | [MediaCrawler 抽象接口](https://github.com/NanmiCoder/MediaCrawler/blob/main/base/base_crawler.py)、[Just One API 资源](https://github.com/justoneapi/justoneapi-python/blob/main/justoneapi/generated/resources/xiaohongshu.py)、[Spider_XHS session owner](https://github.com/cv-cat/Spider_XHS/blob/master/xhs_utils/xhs_pc/auth.py) | 将浏览器、CLI、MCP 和 SaaS 都视为可替换 provider；只允许输出经过版本匹配、运行时 Schema 校验、敏感字段清洗和领域规范化的安全 DTO。cursor、checkpoint 和 canonical state 继续由核心独占 | 不让原始 dict、`Any/raw_json` 或 provider 自有字段直接进入 SQLite、object store 与 exporter；不复制 Spider_XHS 的私有接口和签名。接口带版本号也不等于下游字段已有类型保证 |

### 8.2 运行、安全与复用约束

| 编号与可借鉴方面 | 主要参考对象 | 建议借鉴的具体设计 | 采用边界与不应照搬内容 |
|---|---|---|---|
| **A1 Markdown、frontmatter、目录与媒体相对路径** | [xiaohongshu-importer](https://github.com/bnchiang96/xiaohongshu-importer/blob/main/main.ts)、[xhs-cli-export](https://github.com/DoYitNow/xhs-cli-export/blob/main/src/xhs_export.py) | 借鉴分类目录、可追溯 frontmatter、媒体相对路径、原始/详情 JSON 与下载失败降级；exporter 只消费安全 canonical `Note`，派生视图可从 object store 重建 | 采集器输出格式不能反向定义核心模型；远端标题、标签和正文进入 YAML/路径前必须转义、规范化并处理碰撞。候选工具没有完整批量幂等和媒体完整性保证 |
| **A2 限速、退避与人工暂停** | [xiaohongshu-cli client](https://github.com/jackwener/xiaohongshu-cli/blob/main/xhs_cli/client.py)、[OpenCLI collection helper](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/clis/xiaohongshu/collection-helpers.js)；MediaCrawler 作反例 | 保持一轮一页、详情/媒体串行、硬任务预算和所有循环有上限；仅瞬时网络错误及部分 5xx 可有限退避。429、验证码、登录墙或安全限制触发全局 circuit breaker，旧 progress 不变 | 平台没有公开安全频率；随机延迟、`slowMo`、高斯抖动和“模拟阅读”都不是安全证明。不得遇限制后继续批次，或自动切换网络、代理与账号 |
| **A3 登录、验证码、风控与签名错误分类** | [xiaohongshu-cli exceptions](https://github.com/jackwener/xiaohongshu-cli/blob/main/xhs_cli/exceptions.py)、[输出 Schema](https://github.com/jackwener/xiaohongshu-cli/blob/main/SCHEMA.md)、[OpenCLI note](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/clis/xiaohongshu/note.js) | adapter 内区分 `AUTH_REQUIRED`、`VERIFICATION_REQUIRED`、`RATE_LIMITED`、`SECURITY_BLOCK`、`SIGNATURE_REJECTED`、`CONTENT_UNAVAILABLE`、`TRANSIENT_NETWORK` 与 `SCHEMA_DRIFT`，再映射到核心安全错误 | 不把空结果直接解释为没有内容，也不把验证码、签名拒绝和安全限制当成网络错误重试。候选项目里的数字错误码不是平台公开稳定契约 |
| **A4 运行索引、任务审计、Trace 与诊断** | [OpenCLI artifact](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/src/observation/artifact.ts)、[retention](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/src/observation/retention.ts)、[Playwright Trace Viewer](https://playwright.dev/docs/trace-viewer-intro) | 以 canonical `RunRecord` 保存安全计数和结果；详细 trace 仅失败时保留，附版本、状态、过期时间、容量上限和 artifact hash，并优先生成脱敏摘要 | Trace/HAR/DOM/截图/console 可能包含账号与正文，不能作为普通日志或第二份 canonical state；通用字符串脱敏无法保证清除截图和任意页面数据 |
| **A5 风控风险的预防、识别、暂停与恢复** | [小红书用户服务协议](https://agree.xiaohongshu.com/h5/terms/ZXXY20220331001/-1)、[MediaCrawler Issue #915](https://github.com/NanmiCoder/MediaCrawler/issues/915)、OpenCLI | `[平台官方规则]` 先确认官方授权或书面许可；获授权后，仍以单账号互斥、专用 profile、保守预算和身份校验做纵深保护。登录变化、验证码、429、安全限制、身份不匹配、签名拒绝或 Schema 漂移立即停止，人工检查后显式恢复 | 协议于 2026-03-23 更新，并限制未经许可读取/统计、非法抓取、模拟下载及未授权第三方工具登录；低频不能改变合规结论。Issue #915 只有特定环境下的一名用户报告，没有因果结论。不得自动解验证码、轮换代理/账号、伪造指纹、使用 stealth 隐藏自动化或绕过签名拒绝 |
| **A6 Cookie、token、signed URL 与 storage state 保密处理** | [Playwright auth](https://playwright.dev/docs/auth)、[Playwright MCP](https://github.com/microsoft/playwright-mcp/blob/main/README.md)；[xiaohongshu-mcp cookies](https://github.com/xpzouying/xiaohongshu-mcp/blob/main/cookies/cookies.go) 和 HAR 路线作反例 | 所有会话材料按可冒充账号的 secret 处理；signed URL 仅放内存 envelope，必须落盘的文件和目录分别限制为 `0600`/`0700`，并在日志、异常、Trace、知识库及 Git 中禁止出现 | xiaohongshu-mcp 以 `0644` 请求写 session file，Just One API 将 token 放 query，`HAR with content` 可能包含 Cookie/Authorization；这些都不能作为安全默认。Playwright MCP 的 secret replacement 也不是安全边界 |
| **A7 只读 allowlist、最小权限与本地写能力分离** | [OpenCLI 命令面](https://github.com/jackwener/OpenCLI/blob/main/docs/adapters/browser/xiaohongshu.md)、[daemon](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/src/daemon.ts)、[xiaohongshu-mcp routes](https://github.com/xpzouying/xiaohongshu-mcp/blob/main/routes.go) | 生产适配器只注册精确的 `saved/liked/note` 读取能力；平台读取、本地媒体写、诊断和平台写操作分成独立 capability。服务仅绑定 loopback，并增加客户端身份认证与逐能力授权 | `download` 仍是本地写能力，默认禁用并限制输出根目录。OpenCLI 现有回环/Origin/请求头防护不是完整用户鉴权；不得整体暴露其宽扩展权限和平台写命令。xiaohongshu-mcp 的全接口监听、宽 CORS 与混合写操作是反例 |
| **A8 CLI/MCP/Agent 探索工具与生产同步器边界** | [Playwright MCP](https://github.com/microsoft/playwright-mcp/blob/main/README.md)、[OpenCLI output](https://github.com/jackwener/OpenCLI/blob/main/src/output.ts)、[xiaohongshu-mcp API](https://github.com/xpzouying/xiaohongshu-mcp/blob/main/docs/API.md) | 通用工具只用于受监督的 DOM/网络探索、selector 更新、诊断和人工登录恢复；生产链路应使用确定性的 `BrowserRednoteClient`，只开放版本化领域方法 | 不把通用 Agent 直接作为无人值守同步器，不开放任意 evaluate/click/navigation、文件访问或平台写能力；工具标注 `read-only` 不代表平台只读或本地无副作用 |
| **A9 远端依赖、许可证与代码复用隔离** | [Just One API 条款](https://justoneapi.com/zh/terms)、[MediaCrawler LICENSE](https://github.com/NanmiCoder/MediaCrawler/blob/main/LICENSE)、[Spider_XHS README](https://github.com/cv-cat/Spider_XHS/blob/master/README.md)、[xhs_web_crawler README](https://github.com/leafiy/xhs_web_crawler/blob/main/README.md) | 将“借鉴行为”“复制源码”“调用远端服务”分别决策；阶段四维护许可证/NOTICE 清单。SaaS provider 必须可关闭、可替换，并独立配置成本、配额、超时、数据外发和降级，不拥有 canonical state | MediaCrawler 的非商业学习许可不适合作为商业代码依赖；Spider_XHS 与 xhs_web_crawler 许可冲突/未知，只借鉴行为；Just One API SDK 许可不授予远端服务或数据权利，其点赞/收藏发现、SLA、保留期和实时费用仍未知 |

**风控处置边界。** 这里的目标不是“绕过风控”，而是先满足官方授权与合规要求，再预防工程失控并安全停止。若阶段四未来获得相应授权：每轮和每次恢复前都要校验 `(hostId, accountId)`；出现登录变化、验证码、429、安全限制、签名拒绝或身份不匹配时，原子保存已完成项与停止原因，停止所有滚动、详情和媒体任务并释放会话锁。用户必须在专用 profile 中人工检查，显式触发恢复后重新校验身份与 checkpoint；同类信号再次出现则保持 adapter 禁用并转入人工审查或官方支持。任何延迟、真实浏览器、CDP 或“模拟人工”都不能作为平台许可、账号安全或降低封禁概率的证明。

## 9. 对阶段三和阶段四的具体影响

### 阶段三：不改变

- 保持 fixture/import adapter、规范化领域模型、本地状态、媒体清单、exporter 和运行日志。
- 不引入任何候选仓库的 Cookie、签名、浏览器、MCP、私有 endpoint 或远端服务。
- 阶段三 fixture 必须继续使用合成、脱敏、确定性数据。未来经明确授权取得的真实输出只能进入 import 流程或阶段四 client，并在进入核心前完成 Schema 校验、secret envelope 封装和敏感字段清洗。

### 阶段四：建议拆成可替换边界

```text
BrowserSession / ProviderSession
        ↓
BrowserRednoteClient
  listPage()  → TransientListPage
                = 安全 ListItem + 内存态 PrivateNoteAccess
  getDetail() → TransientNote
                = 安全 Note 字段 + TransientMediaSource
        ↓
SyncEngine
  StateStore 独占 cursor/checkpoint
  MediaStore 通过 transient source 流式落盘并生成 receipt
        ↓
阶段三离线 sync-core 的安全持久模型与 exporters
```

`xsec_token`、Cookie、完整 signed URL 和远端媒体 URL 不属于普通 adapter 输出字段，只能存在于不可序列化的内存态 `PrivateNoteAccess` 或 `TransientMediaSource` 中。checkpoint 由 `SyncEngine/StateStore` 持久管理，不能由 discovery/detail/media client 自行拥有。

阶段四的安全默认应包括：

- 只使用用户明确授权的单一账号和专用自动化 profile；每轮和恢复后校验 `(hostId, accountId)`，身份不匹配立即 `AUTH_REQUIRED` 暂停。禁止自动扫描、切换账号或迁移状态。
- 平台能力默认只允许精确、命名空间化的 `saved/liked/note` 读取命令；不注册发布、关注、评论、点赞/取消或删除命令。
- `download` 是本地写能力，不与平台只读混为一谈。默认禁用；若启用，必须限制到明确输出根目录，并由 `MediaStore` 完成长度、哈希、原子写和 receipt 校验。
- Cookie、token、storage state、HAR 和完整 signed URL 均按 secret 处理，不进入普通日志或知识库输出。
- 登录变化、验证码、安全限制和疑似风控立即暂停，人工处理后从 checkpoint 恢复。
- 每条笔记和每个媒体资产分别记录状态、长度、哈希和失败原因。
- 对外部 CLI、MCP 或 SaaS 返回值先做版本化 Schema 校验，再提交给核心。

## 10. 下一步建议

12 个候选仓库和非仓库 Playwright 综合专题已经全部完成。后续若继续，应另立 **Stage 4 规格研究**：先处理平台/账号授权、产品范围、威胁模型、正式 Playwright release 与浏览器制品审计，再把专题中的 profile lease、身份校验、只读 capability、receipt、停止和人工恢复要求转成可执行规格与离线验收；这不是本轮自动启动的项目。

静态边界继续有效：不运行候选项目、不访问平台、不读取账号材料。任何未来真实账号动态验收都必须另行取得明确授权，并设置最小范围、硬预算、kill switch、首个限制信号停止和人工负责边界。
