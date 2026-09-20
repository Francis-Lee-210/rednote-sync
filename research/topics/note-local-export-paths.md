# 小红书帖子本地导出链路专题：先决条件、获取方式与保存结构

状态：**研究证据**

日期：2026-08-19

> 本文是固定版本、离线静态分析形成的研究综合，不是当前产品权威、产品决定或在线兼容性承诺。当前产品定义见[产品设计](../../docs/design/product-design.md)，当前优先级与阻碍见[路线图](../../docs/design/roadmap.md)，已实现离线能力以 [Core 实现规格](../../projects/docs/sync-core.md)为准。本文没有运行第三方项目、访问平台，也没有读取 Cookie、token、浏览器 profile、storage state、HAR 或个人数据。

## 1. 结论先行

1. 16 个对象不能用同一个“导出器”标签概括。它们至少分为本地文件/数据库导出器、浏览器内资料库、远端知识库同步器、一次性 stdout/REST/MCP reader，以及纯浏览器基础设施五类。
2. 真正形成 `discovery → detail → media → store` 本地闭环的对象也不等于可靠同步器。MediaCrawler、Spider_XHS、XHS_ALL_IN_ONE、xhs-cli-export 和 Rednote2Obsidian 都能在各自范围内落盘，但普遍缺少服务端 cursor 证明、逐资产 receipt、原子完成语义或可验证恢复。
3. XHS-Downloader 的批量能力必须拆开理解：用户脚本负责从当前页面已加载状态发现 URL，Python 负责传入 URL 的单帖详情与媒体；Python 中的服务端发布列表骨架没有接线。
4. OpenCLI 的 `saved/liked` 列表命令组、`note`、`download` 构成本专题讨论的三个独立链段；列表结果可被调用者手工传给后两段，但项目没有实现逐帖编排或统一批次 checkpoint。
5. Playwright 与 Playwright MCP 只是通用浏览器基础设施。profile、storage state、Download、HAR、Trace、snapshot、session transcript 等是会话、传输或诊断制品，不是帖子保存结构。
6. xiaohongshu-cli、xiaohongshu-mcp 和 ReaJason/xhs 的主要可达结果分别停在 stdout、REST/MCP 响应或进程内存；不能因为它们返回详情或媒体 URL，就把它们写成本地 exporter。
7. RedCaChe 必须分成两套不互通实现：纯扩展版写浏览器 IndexedDB；旧服务器版才写 SQLite 并投影 Obsidian Markdown。两者均不下载帖子媒体。
8. Rednote2Notion 的业务目标是远端 Notion workspace；本地 `chrome.storage.local` 只保存同步状态、配置和凭据。因此它不是“帖子本地导出器”。
9. Rednote2Obsidian 是 16 个对象中最完整的本地知识库客户端：它覆盖发布、收藏、点赞、收藏专辑、详情、可选评论和媒体，并写 Vault Markdown/media/Base；但视频默认可保留远端，图片失败可留下断链，页内失败也可能被 cursor 越过。
10. 研究当时的 Core（2026-08-19）**没有完整移植两份逆向客户端的能力**。它实现的是由逆向结果独立提炼出的离线下游核心：四目标模型、严格 scope、状态机、SQLite canonical state、内容寻址对象和本地派生投影；浏览器登录、页面签名、真实接口、在线媒体获取、Notion 写入与客户端专用 UI/布局均未实现。本条及 §7 保留历史基线，不追踪后续重构。

## 2. 范围、方法与证据合同

### 2.1 研究对象

本报告覆盖 14 个固定 revision 的第三方项目：

- XHS-Downloader、OpenCLI、xhs-cli-export、Playwright；
- xiaohongshu-cli、MediaCrawler、xiaohongshu-mcp、ReaJason/xhs；
- Playwright MCP、xiaohongshu-importer、Spider_XHS、XHS_ALL_IN_ONE；
- xhs_web_crawler、RedCaChe。

另覆盖两份哈希锁定历史客户端逆向结果：

- Rednote2Obsidian 1.2.3；
- Rednote2Notion 1.0.6。

第三方项目结论绑定各自 `review.md` 记录的 revision/tree。Rednote2Obsidian 绑定脏 working-tree 插件快照及三文件 SHA-256，不能只用其 HEAD 表示工件身份；Rednote2Notion 没有来源 revision，只能绑定版本、工件类型及三文件 SHA-256。

### 2.2 离线方法

- 先核对 14 个项目的 `provenance.json`、`checkpoint.json` 与专项 `review.md`；只有证据不足时才检查固定源码。
- 两个逆向对象只使用已有 `provenance.json` 与 `report.md`，没有重新打开或执行 bundle。
- 没有安装依赖、构建或运行任何第三方项目，也没有验证当前平台 endpoint、页面 selector、签名、登录或媒体 CDN。
- 研究目录里的 `checkpoint.json` 只表示专项审查工作完成，不是候选项目的运行时同步 checkpoint。

### 2.3 证据标签

- `[源码事实]`：固定 revision 的可达源码、配置或直接可见结构；测试文件只证明测试意图，不证明已经运行。
- `[逆向报告事实]`：哈希锁定样本的既有静态逆向报告直接结论；本轮没有独立复读 bundle。
- `[项目声明]`：README、项目文档、manifest 或工具描述；不能证明当前兼容、安全、完整或动态成功。
- `[静态推断]`：由多个直接事实组合出的范围或失败后果；必须保留成立前提。
- `[未知]`：缺少运行、平台一手契约或精确 runtime provenance，当前材料不能裁定。

若项目声明与可达源码冲突，本文以固定可达源码为准；不能解决的线上问题保留为 `[未知]`。

### 2.4 保存目标分类

| 类别 | 本文含义 | 不应混入的对象 |
|---|---|---|
| `local` | 项目管理的普通本地文件或数据库，如 Markdown、JSON、SQLite、媒体目录 | stdout renderer、临时响应、远端页面 |
| `browser` | 扩展 origin 或浏览器 profile 内部状态，如 IndexedDB、`chrome.storage.local` | 可携带的普通帖子文件 |
| `remote` | 远端知识库或服务端目标，如 Notion page/database | 本地归档 |
| `none` | 只返回 stdout、REST/MCP response 或内存对象，没有帖子保存契约 | Cookie/token cache、HAR/Trace、发布 staging |

浏览器下载到普通文件时按 `local` 说明，但必须注明最终目录由浏览器设置决定。Cookie、token、profile、storage-state、HAR、Trace、截图与 session transcript 无论是否落盘，都不算帖子归档。

## 3. 16 个对象横向总览矩阵

下表表体恰好 16 行。`discovery/detail/media/store` 只写固定版本已接线能力；底层未接线方法、README 宣称能力和外部调用者可自行完成的动作不计入。

| # | 对象与固定身份 | 类型 | 主要先决条件/主体 | discovery | detail | media | 保存目标与结构 | checkpoint / 关键边界 |
|---:|---|---|---|---|---|---|---|---|
| 01 | XHS-Downloader `56c912e…` | 页面发现器 + 单帖下载器 | 完整帖子 URL/短链；页面路径需当前浏览器 session；Cookie 可选仅属项目声明 | userscript 读 profile/search/board/feed 已加载 state 并复制 URL；无服务端 cursor | Python GET 页面 HTML 解析 `__INITIAL_STATE__` | 图片、视频、Live Photo；浏览器下载或 Python HTTP | `local`：`Volume/Download`、`Temp`；详情 DB 在 Download，ID/作者 DB 在 Volume 根；userscript 文件/ZIP | 作品级 ID skip + 不完整 Range 续传；无列表恢复；`UserPosted` 未接线 |
| 02 | OpenCLI `a86d647…` | Browser Bridge CLI | 扩展连接的已登录 Chrome profile；detail 要 signed URL；download 另收短链 | search/feed/user/saved/liked 各自返回一次性结果；saved/liked 最多滚动 4 次 | 独立 `note` 命令读 DOM | 独立 `download` 从 state/script/DOM 找 URL | `local/none`：读取命令 stdout；媒体 `xiaohongshu-downloads/<id>/...` | discovery/read/download 不编排；无 cursor/manifest/跨进程资产恢复 |
| 03 | xhs-cli-export `6c9bcbd…` | 外部 provider 驱动的文件 exporter | 已登录外部 `xhs` executable；search 另需 keyword | provider stdout：favorites/likes stream 或 search page | `xhs read <id>`，可带 token | 只下载图片 | `local`：run Markdown/raw/detail/images/index + root JSONL/state | JSONL 启动即清空且不回读；seen 可早于详情/媒体完成 |
| 04 | Playwright `bcb3563…` | 浏览器基础设施 | 调用方自行给浏览器、URL、会话、页面规则和输出路径 | 不提供 XHS 实现 | 不提供 XHS 实现 | 仅通用 Download/response 原语 | `none`：profile/storage/HAR/Trace/Download 均非帖子库 | 无业务 cursor、去重、逐资产 receipt 或恢复 |
| 05 | xiaohongshu-cli `4d63f3c…` | 签名 API/HTML reader CLI | 当前 Cookie 主体；详情用 ID/URL/短索引及可选 token/source | search/feed/user-posted/favorites/likes 单页 | feed API 优先，HTML `/explore/{id}` fallback | 不下载 | `none`：stdout JSON/YAML/Rich；本地仅 access caches | raw cursor 由调用者手工透传；无自动全量、业务 checkpoint |
| 06 | MediaCrawler `5665a27…` | 浏览器会话 + HTTP client + 多 Store crawler | 登录 session/Cookie、`xhshow` signer；keyword 或 creator ID | search、creator posted；无收藏/点赞 discovery | feed API，条件性 HTML fallback | 图片/视频直写 | `local`：CSV/JSON/JSONL/XLSX/SQLite/其他 DB；`data/xhs/{images,videos}` | note 先存、媒体后写；ordinal 压缩；开源版无 durable resume |
| 07 | xiaohongshu-mcp `da9ba03…` | REST/MCP 浏览器读取层 | 单一 `cookies.json` session；详情需 feed ID + token | 首页/search/指定或当前用户 tabs 的当前数组 | 页面 `noteDetailMap[id]` + 当前已加载评论 | 只返回 descriptor/URL | `none`：REST JSON / MCP TextContent；Cookie 文件仅会话 | 无列表分页/去重/checkpoint；评论 cursor 无续页入口 |
| 08 | ReaJason/xhs `f4b62d9…` | Python SDK/内存 reader | Cookie/session + 外部 signer；详情强制 ID + token | search/feed/user posted；收藏/点赞仅单页 | feed API 或显式 HTML 方法 | URL helper；落盘 helper fixed revision 不可用 | `none`：raw dict / `list[Note]`；目录仅不可达意图 | posted cursor 只在内存；broken helper 网络前 TypeError |
| 09 | Playwright MCP `7e0457a…` | MCP 浏览器基础设施 | Node、MCP client、浏览器；账号/URL/规则由上层提供 | 不提供 XHS 实现 | snapshot/evaluate/network 只是通用观察 | 通用 download artifact，精确 alpha 行为未知 | `none`：outputDir 是诊断/会话制品，不是帖子库 | 无业务 key/cursor/receipt；exact alpha provenance 未闭合 |
| 10 | xiaohongshu-importer `b1d3e3b…` | 单帖 Obsidian importer | Obsidian/Vault、含认可 URL 的 share text、category | 不提供；用户自行取得单帖 URL | `requestUrl` HTML + `__INITIAL_STATE__` 第一项 | 可选 fetch 图片/视频 | `local`：`XHS Notes/<category>/<title>.md` + 共享 `media/` | 无 stable ID/checkpoint；媒体先写可留孤儿；失败回退远端 URL |
| 11 | Spider_XHS `2030f5d…` | PC API 聚合 + 本地文件 exporter | Cookie/QR/phone 登录；URL list、目标用户或 query | 已接线 URL list、user-posted、search；like/collect 仅底层 | feed POST | JPG/MP4 直写 | `local`：每帖 info JSON/TXT/media + 19 列 XLSX | 内存 cursor、无 ID 去重/receipt；整帖 retry 不是 resume |
| 12 | XHS_ALL_IN_ONE `63b85de…` | 内容库/运营平台 + 文件 export | 本地系统用户、其平台账号/加密 Cookie；export 要内部 note IDs | 已接线 search、note URLs、user notes；SSE 不入库 | adapter 规范化详情 | 同步写 `note_assets`/随机名媒体 | `local`：SQLite `spider_xhs.db`、media、`exports/*.json|csv` | 无 durable cursor；Task completed 可掩盖 partial；SSE/store 分离 |
| 13 | xhs_web_crawler `8a7d1b6…` | DOM 点击原型 + 人工 HAR parser | 已登录 Chrome、keyword、人工 HAR with content、HAR path | 搜索页点击/关闭/滚动 | 未证明 request-note 绑定；parser 不按 endpoint 筛选 | 不提供 | `local`：CWD `<har>_content.json` 裸 `note_card[]`；HAR 是敏感输入 | 内存 data-index Set；无 note-ID 去重、schema、cursor、恢复 |
| 14 | RedCaChe `b3526e6…` | 两套不互通实现 | 扩展：已登录浏览器+收藏页；旧服：持久 Playwright profile+收藏页 | 两套都读当前账号 favorites DOM | 只可达标题补全；旧 enrich 无路由 | 不提供 | `browser`：扩展 IndexedDB；`local`：旧服 SQLite→daily/evergreen Markdown | 扩展无 run；旧 ImportRun 只记结果无 resume；两库不互通 |
| 15 | Rednote2Notion 1.0.6（哈希锁定） | 远端 Notion 同步器 | 已登录 Chrome + 页面签名环境；Notion secret/page/预建 DB | post/bookmark/like/album endpoints | feed | 图片上传 Notion；视频 external embed | `remote`：Notion pages/relations/files；`browser` 仅 state/credentials | 本地 cursor/cache 有多处停滞与 partial；没有本地帖子文件 |
| 16 | Rednote2Obsidian 1.2.3（哈希锁定） | 本地 Obsidian 同步器 | Obsidian/Vault、`persist:rednote` 登录 session、页面签名环境 | post/bookmark/like/album；一页一轮 | feed；可选评论首屏 | 图片本地；视频可本地或远端；可选 OCR/ASR | `local`：Vault Markdown、`Media/<id>`、可选 Base | 设置型 cursor/ID 数组；页内失败可被推进；不是全媒体离线保证 |

## 4. 横向调用路径

### 4.1 Path P-01：真正本地闭环的共同形状

```text
登录或访问主体
  → discovery：列表页 / Web endpoint / 外部 provider
      → (note ID, xsec token/source, relation, cursor?)
  → detail：feed API / 页面 HTML / __INITIAL_STATE__
      → 正文、作者、时间、metrics、media descriptor
  → media：选择 variant → fetch/download bytes
  → store：本地文件或数据库
      → 可选 derived Markdown/JSON/CSV/index
```

这个路径只在部分对象中完整可达。`cursor?`、媒体完整性和 store commit 必须分别举证；发现能返回 ID，不等于详情或媒体已经持久化。

### 4.2 Path P-02：response-only reader

```text
session / Cookie
  → list or detail request
  → raw dict / stdout / REST JSON / MCP TextContent
  → store：不提供
```

xiaohongshu-cli、xiaohongshu-mcp 和 ReaJason/xhs 的主要路径属于这一类。调用者可以重定向或另写 downloader，但那不是这些项目自身的保存契约。

### 4.3 Path P-03：远端 Notion 与本地 Core 的分叉

```text
Rednote2Notion：browser discovery → detail → image fetch → remote Notion

2026-08-19 Core：fixture/import envelope → detail/media decoder → SQLite/object store
                                      → local derived views
```

两条路径没有在当前代码中连接。逆向客户端的浏览器 session、签名和 endpoint 尚未进入 Core；Core 也没有 Notion destination writer。

### 4.4 跨对象稳定结论

- `note ID` 是内容身份，不是服务端 cursor。
- `xsec_token/xsec_source` 是访问材料，不是账号登录凭据。
- profile、Cookie、storage state 与当前用户 ID 分属会话材料和主体证明，不能互相替代。
- 数据库已有 note 行，不证明媒体完整；文件存在也不证明长度、MIME、hash 或来源版本正确。
- stdout/JSON response、浏览器 IndexedDB、远端 Notion 和普通本地文件是四种不同目标。
- fixed endpoint、selector、`__INITIAL_STATE__` 与 `window.mnsv2` 只能称样本/源码使用的实现路径，不能称当前稳定平台契约。

## 5. 14 个参考项目逐项分析

### 5.1 XHS-Downloader

固定 revision：`56c912e0df7920ad0fbf5cd9d911628587b9c7e6`。

1. **导出对象与能力范围。** `[源码事实]` 用户脚本能从推荐、目标 profile 的发布/收藏/点赞、搜索和 board 页面已加载状态生成帖子 URL；Python、HTTP、MCP 和 WebSocket 路径则处理单帖。用户脚本也可直接下载当前帖媒体。Python 的 `UserPosted.run()` 没有实现且没有调用方，因此不能写成服务端批量列表 API。
2. **先决条件与账号主体。** Python 主输入是完整帖子 URL 或短链，通常不是裸 note ID；URL path 含 ID，页面生成 URL 还可含 `xsec_token`。页面 discovery 的目标主体是当前 profile/board/search，访问权限主体是当前浏览器 session。`[项目声明]` Cookie 可空、可“无需登录”；但 profile 路径会提示登录，匿名能力与可见范围均为 `[未知]`。
3. **获取方式与调用路径。** `discovery → detail → media → store` 为：userscript 读 `__INITIAL_STATE__`/滚动并复制 URL → Python GET 页面 HTML、解析 `window.__INITIAL_STATE__` → 选择图片、视频和 Live Photo URL → HTTP 下载及可选 SQLite。本地 `POST /xhs/detail`、MCP tools 和 `ws://127.0.0.1:5558` 都只是本机入口，不是平台 endpoint。
4. **保存目标与结构。** `local`。Python 默认逻辑根为 `Volume/`：`Temp/` 保存断点临时文件；`Download/` 保存媒体及可选的 `ExploreData.db` 详情库；根下可选 `ExploreID.db` 保存完成 note ID、`MappingData.db` 保存作者映射。userscript 另写浏览器单文件或 ZIP；列表发现只到系统剪贴板。没有本地帖子 JSON/Markdown 投影。
5. **checkpoint、去重与部分失败。** `ExploreID.db` 只按 note ID skip；非空下载任务全部成功才写 ID，但只选部分图片成功也可能把整帖记完成。Range 续传未核对 206/Content-Range、最终长度或 hash；详情 DB 可在媒体失败时写入。无列表 cursor、滚动位置或发现队列 checkpoint。
6. **缺失、未知与证据。** 不提供服务端发布/收藏/点赞/专辑分页、账号 scope、逐资产状态、评论正文、OCR/转写/AI。当前页面字段、token、媒体 host、可见范围和全量滚动均为 `[未知]`。证据见[专项审查](../projects/xhs-downloader/review.md)与[固定用户脚本](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/static/XHS-Downloader.js#L809-L918)。

### 5.2 OpenCLI

固定 revision：`a86d64705c526dc710f790e66cfcabf6ecf786b9`。

1. **导出对象与能力范围。** `[源码事实]` 固定 XHS adapter 包含 search、feed、user public posts、saved、liked、note、comments 和 download 命令。前述发现/读取命令只返回各自的一次性结果；`note` 读取一条 signed URL 的 DOM 详情，`download` 下载一条 signed URL/短链的媒体，各命令互不编排。收藏专辑不在固定 adapter 中。
2. **先决条件与账号主体。** 需要 Chrome、Browser Bridge 扩展、本地 daemon 与目标站登录会话。认证主体是所选 Chrome profile/context；显式目标 user 与登录 session 是不同主体。`note` 必须有含 `xsec_token` 的完整 URL；`download` 另接受短链。saved/liked 的显式目标 user 在固定源码中注册为 `--id`，与文档位置参数示例冲突。
3. **获取方式与调用路径。** `discovery → detail → media → store` 并非单一链。search/feed/user/comments 是各自独立的读取命令；`saved/liked` 经本机 `POST /command`、daemon/extension 导航收藏/点赞页，被动匹配 `note/collect/page` 或 `note/like/page`；`note` 另行导航 signed URL 读 DOM；`download` 另行从 state/script/DOM 找媒体并 direct HTTP。无服务端 cursor，saved/liked 最多滚动 4 次。
4. **保存目标与结构。** `saved/liked/note` 为 `none`：只交给 stdout renderer，可显示 table/plain/json/yaml/md/csv。`download` 为 `local`：默认 `./xiaohongshu-downloads/<noteId>/<noteId>_<index>.jpg|mp4`，每项先写 `.tmp` 再 rename；目录内无详情、manifest 或批次 summary。
5. **checkpoint、去重与部分失败。** 列表单次调用按 note ID 去重；媒体逐项失败隔离并保留其他成功项。daemon command journal 只处理浏览器命令重放，生命周期是浏览器 session，不能表示列表 cursor 或资产完成。无 Range、hash、skip-complete 和跨进程恢复。
6. **缺失、未知与证据。** 缺少 `saved/liked → note → download` loop、全量边界、详情/媒体统一 package、逐资产状态和本地 metadata。完整被观察 endpoint/method/参数、四次滚动覆盖率、token/媒体当前兼容性均为 `[未知]`。证据见[专项审查](../projects/opencli/review.md)与[固定 collection helper](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/clis/xiaohongshu/collection-helpers.js#L239-L282)。

### 5.3 xhs-cli-export

固定 revision：`6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83`。

1. **导出对象与能力范围。** `[源码事实]` 支持当前 provider 登录主体的 favorites、likes 与 keyword search，逐帖生成 Markdown，另存 raw/detail JSON 和图片。没有 posted、album、视频、Live Photo、评论、OCR、转写或 AI 分类。
2. **先决条件与账号主体。** 需要 Python、requests 和可发现的外部 `xhs` executable；项目文档称其为 `xhs-cli-headless`。登录、Cookie、签名、列表/详情协议均由该外部 provider 拥有，版本与 schema 未固定。search 需 keyword；详情通常使用列表返回的 note ID 和可选 token。
3. **获取方式与调用路径。** `discovery → detail → media → store` 为：调用 `xhs favorites|likes --stream --no-detail` 或 `xhs search ... --page N` → `xhs read <id> [--xsec-token]` → requests 下载图片 → 写 run 文件。favorites/likes 可重复 provider 最多 6 轮，search 自增页码；真实平台 endpoint/cursor 为 `[未知]`。
4. **保存目标与结构。** `local`。根目录有 `xhs_state.json` 与 `<source>_stream.jsonl`；每次 run 为 `<source>-<timestamp>/`，含编号 Markdown、`<source>_raw.json`、`details/<id>.json`、`images/<id>/image-NN.ext` 和 `_xhs_export_index.md`。raw/detail/JSONL 可能原样含访问 URL，应按敏感派生物处理。
5. **checkpoint、去重与部分失败。** `[项目声明]` JSONL 用于 crash recovery；`[源码事实]` 每次启动先 truncate，且没有回读路径，所以只能算当次 partial evidence。详情失败仍可写带错误的 Markdown，图片失败写入正文；note ID 可能在详情/媒体/Markdown 完整前进入 seen。state 直接覆盖且损坏时静默当空。
6. **缺失、未知与证据。** `--no-fetch-details` 在 search 路径仍无条件调用 `read`；README 搜索示例的 `--type` 与 parser 的 `--search-type` 漂移。provider schema、登录、分页末尾、媒体 URL 和 Obsidian link 行为均为 `[未知]`。证据见[专项审查](../projects/xhs-cli-export/review.md)与[固定 exporter](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/src/xhs_export.py#L1191-L1312)。

### 5.4 Playwright

固定 revision：`bcb3563aa73d7ac71ac8cb877433201b1b97b7da`。

1. **导出对象与能力范围。** `[源码事实]` Playwright 是通用 Web 自动化/测试框架，不包含小红书发布、收藏、点赞、搜索、详情或媒体业务实现。它不能单独导出帖子。
2. **先决条件与账号主体。** 只定义通用 runtime/browser 前提。调用方必须自行提供目标 URL、selector、endpoint、登录方式和账号绑定。persistent profile 或 storage state 可以承载会话，但没有 `expectedAccountId`，不能证明当前 session 属于预期账号。
3. **获取方式与调用路径。** `discovery → detail → media → store` 四段均“不提供 XHS 业务实现”。`Page.goto`、DOM/evaluate、network、Download 等只是可供上层组合的原语；没有固定页面 path、method、cursor 或 DTO。
4. **保存目标与结构。** 帖子目标为 `none`。persistent `userDataDir`、`storageState(path)`、临时 Download、HAR 和 Trace 是浏览器会话、传输或诊断制品。Playwright 没有 note JSON/Markdown、媒体目录、数据库、索引或 canonical state。
5. **checkpoint、去重与部分失败。** timeout、AbortController、download failure/cancel 与 Context close 只描述通用生命周期，不是 durable business checkpoint。没有 note/asset key、cursor、水位、逐资产 receipt、跨进程恢复或业务幂等。
6. **缺失、未知与证据。** 缺失全部 XHS decoder、账号主体绑定、分页与停止门。fixed commit 未在目标 OS/browser 运行；profile lock、下载、crash/close 与当前站点行为为 `[未知]`。证据见[专项审查](../projects/playwright/review.md)和[固定 README](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/README.md#L7-L18)。

### 5.5 xiaohongshu-cli

固定 revision：`4d63f3c0c85ccd9054fa8e96d7f761aaf2507449`。

1. **导出对象与能力范围。** `[源码事实]` 该项目是读取型 CLI：能搜索、读 feed、列用户发布/收藏/点赞、读单帖和评论，但结果主要输出到 stdout。没有收藏专辑和图片/视频下载命令，不是本地帖子/媒体 exporter。
2. **先决条件与账号主体。** 常规 command 需要当前 Cookie；实现以 Cookie 集中存在 `a1` 作为最低可用标志。省略 favorites/likes 的 user ID 时先由 `user/me` 取得当前 Cookie 主体；显式 user ID 则是目标用户。详情输入为 note ID、URL 或最近列表短索引，token/source 可由 URL、参数或 cache 取得。
3. **获取方式与调用路径。** `discovery → detail → media → store` 为：签名调用 `search/notes`、`homefeed`、`user_posted`、`note/collect/page`、`note/like/page` → 详情优先 POST `feed`，无 token/失败时解析 `/explore/{id}` HTML → media：不提供 → store：不提供，仅输出 stdout。发布/收藏/点赞只处理调用者给的一页 cursor，不自动全量。
4. **保存目标与结构。** 帖子目标为 `none`。JSON/YAML envelope 是 `ok/schema_version/data` 的 stdout；内部 `data` 仍是未版本化上游 shape。本地 `~/.xiaohongshu-cli/` 只保存 `cookies.json`、`token_cache.json`、`index_cache.json`、`search_sessions.json`，均为会话/访问/导航 cache。
5. **checkpoint、去重与部分失败。** raw cursor 由调用者读取后再传入；search session 只短期复用 search ID。没有跨页/跨运行 note ID 去重、页级 commit、逐媒体状态或完成证明。session 过期重放和 transport retry 是请求级机制，不是导出恢复。
6. **缺失、未知与证据。** HTML exact ID 缺失时可能取 map 第一项，且 API/HTML详情 shape 未归一。当前 endpoint、显式目标可见范围、cursor/token语义和自动浏览器 Cookie选择主体均为 `[未知]`。证据见[专项审查](../projects/xiaohongshu-cli/review.md)与[固定 client mixins](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/client_mixins.py#L258-L383)。

### 5.6 MediaCrawler

固定 revision：`5665a271ef15e0ec82b1f48a951b66760e054db9`。

1. **导出对象与能力范围。** `[源码事实]` XHS adapter 覆盖 keyword search、单帖详情、指定 creator 发布和独立评论抓取；不提供当前账号收藏/点赞/专辑 discovery。它是“浏览器会话 + HTTP client + extractor + 多 Store”采集器。
2. **先决条件与账号主体。** 需要可用登录 session/Cookie 与请求 signer。固定源码实际以 Playwright/CDP 建立登录并取 Cookie，HTTP client 使用 `xhshow` signer；这与 README 的浏览器 JS 签名描述有漂移。search 需 keyword，creator 需 user ID，详情需 `note_id+xsec_token+xsec_source`。
3. **获取方式与调用路径。** `discovery → detail → media → store` 为：POST `search/notes` 或 GET `user_posted` → POST `feed`，条件性 HTML fallback → 从 detail dict 取图片/视频 URL → 写选定 Store。search 用 page，creator 用进程内 cursor；没有 durable commit。
4. **保存目标与结构。** `local` 或配置的 DB backend。默认根 `data/xhs`；文件格式有 CSV、JSON、JSONL、XLSX，SQLite 为 `database/sqlite_tables.db`，表 `xhs_note`、`xhs_note_comment`，另可 MySQL/PostgreSQL/MongoDB。媒体在 `data/xhs/images/<noteId>/` 与 `videos/<noteId>/`。精确日期文件名未复核，保持 `[未知]`。
5. **checkpoint、去重与部分失败。** note 先落 Store、媒体后下载，comment 另写，因此 note 行不证明资产/评论完整。媒体按成功数量命名，前项失败会压缩后续 ordinal；直接写最终文件，无 hash/receipt。开源 fixed tree 没有 durable resume，`START_PAGE` 只是人工跳页。
6. **缺失、未知与证据。** 缺失收藏/点赞 membership、逐页 checkpoint、逐资产身份与原子完成。search 在处理 items 前检查 `has_more`，可能条件性漏终页；详情 API 取首项未复核 note ID。接口、signer、终页 shape 与线上兼容性均为 `[未知]`。证据见[专项审查](../projects/mediacrawler/review.md)与[固定 core](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/xhs/core.py#L134-L188)。

### 5.7 xiaohongshu-mcp

固定 revision：`da9ba0365e176bc0eb11885f1941271d895feb73`。

1. **导出对象与能力范围。** `[源码事实]` 同一 Go 服务提供 REST 与 MCP 读取：首页、搜索、指定/当前用户的 post/fav/liked tab、单帖详情和当前页面已加载评论。没有收藏专辑；媒体只作为 descriptor/URL 返回。服务另有平台写面，但不属于导出链。
2. **先决条件与账号主体。** 服务需本地 Go 进程和内置浏览器；单一 `cookies.json` 代表当前 session。`/user/me` 的主体是当前 Cookie账号，指定 user profile 仍由该 session 访问目标用户。详情需 `feed_id+xsec_token`，指定 profile 需 `user_id+xsec_token`，search 需 keyword。
3. **获取方式与调用路径。** `discovery → detail → media → store` 为：REST `/api/v1/...` 或 MCP `/mcp` → 浏览器导航首页、`/search_result`、`/user/profile/{id}` → 详情导航 `/explore/{id}` 并严格取 `noteDetailMap[id]` → media：不提供下载，仅返回 descriptor → store：不提供，仅返回 response。列表/主页只读当前数组，不滚动、不分页。
4. **保存目标与结构。** 帖子目标为 `none`。REST 返回 JSON envelope，多数 MCP handler 把 pretty JSON 填入 `TextContent`；不会创建 JSON/Markdown/媒体目录或数据库。`cookies.json` 的 `{version,seed,saved_at,cookies}` 是敏感会话状态；`xiaohongshu_images` 临时目录只服务发布输入 staging。
5. **checkpoint、去重与部分失败。** 无跨运行去重、列表 cursor、水位或逐资产状态。评论 response 虽带 cursor/hasMore，route/tool 没有续页参数。评论加载或 search filter 超时可降级返回当前/旧 state，仅有日志 warning、没有 completeness flag。
6. **缺失、未知与证据。** tool 文案称默认 10 条评论，但固定控制流未明确截断，本文只称“当前 state 已加载评论”。页面 URL、selector、state shape、token/source、权限与当前兼容性为 `[未知]`。证据见[专项审查](../projects/xiaohongshu-mcp/review.md)与[固定 routes](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/routes.go#L23-L65)。

### 5.8 ReaJason/xhs

固定 revision：`f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0`。

1. **导出对象与能力范围。** `[源码事实]` Python SDK 能搜索、读 feed、用户发布、收藏/点赞单页、详情和评论。只有用户发布有 `get_user_all_notes` 内存 all-wrapper；主要结果是 raw dict 或 `list[Note]`。唯一单帖媒体保存 helper 在固定版本不可用。
2. **先决条件与账号主体。** 普通 API 需要调用方传入 Cookie/session 和 external signer；目标 user ID 与 session 主体不同。API/HTML详情都强制 `note_id+xsec_token`，source 默认 `pc_feed`；token/source 的来源约束为 `[未知]`。
3. **获取方式与调用路径。** `discovery → detail → media → store` 为：`user_posted pages → (note_id,xsec_token) → feed detail → media：只重建随机 CDN URL，不提供可达下载 → store：不提供，结果留在内存`；收藏/点赞只到单页 raw dict。HTML详情是调用方显式选用的 `/explore/{id}` 方法，不是 API fallback。
4. **保存目标与结构。** fixed 可达帖子目标为 `none`。`save_files_from_note_id(note_id, dir)` 意图写 `<dir>/<title>/<title>.mp4` 或 `<title>0.png...`，但它少传已变为强制参数的 `xsec_token`，会在网络和建目录前抛 TypeError；该布局只能称“不可达源码意图”。
5. **checkpoint、去重与部分失败。** all-wrapper 的 cursor/result 仅在内存，特定详情错误被静默跳过，其他错误中断并丢失累积结果。无跨页去重、账号/scope provenance、failure ledger 或逐资产 receipt。即使修复 helper，直接 `wb` 最终文件也无原子/完整性闭环。
6. **缺失、未知与证据。** 收藏/点赞未接 all/detail/media/store；没有 JSON/Markdown/DB、Live Photo、稳定 asset identity。endpoint、signer、cursor、token/source 和媒体 shape 当前行为均为 `[未知]`。证据见[专项审查](../projects/xhs/review.md)与[固定失配 helper](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/core.py#L309-L336)。

### 5.9 Playwright MCP

固定 revision：`7e0457a7cbf88823bf0146d12c46ae12c6818247`。

1. **导出对象与能力范围。** `[项目声明]` 它把 Playwright 通用浏览器能力暴露给 MCP client；fixed root 没有 XHS discovery、详情、媒体或帖子 store。snapshot/evaluate/network 工具可辅助人工探索，但不是平台 adapter。
2. **先决条件与账号主体。** 需要 Node、MCP client 与本地/extension/CDP/remote browser。登录、账号 owner、目标 URL、selector 和 decoder 全由上层提供。root package 声明 Node `>=18`，locked core 声明 `>=20`，实际组合为 `[未知]`。
3. **获取方式与调用路径。** `discovery → detail → media → store` 四段均不提供 XHS 实现。stdio 或 HTTP `/mcp` 接收调用；`browser_navigate` 接任意 URL，snapshot/evaluate/network 观察当前页面，download 只是页面通用 artifact。
4. **保存目标与结构。** 帖子目标为 `none`。`outputDir` 可含 snapshot Markdown、evaluate/network output、screenshot、storage-state、trace、video、PDF、download 或 session transcript；persistent profile 另在浏览器 cache。它们都是诊断/会话制品，没有 per-note layout。
5. **checkpoint、去重与部分失败。** MCP transport session、browser profile、storage state 和 saveSession 都不等于业务 checkpoint。无 note/asset key、cursor、水位、逐资产 receipt、业务幂等或 crash recovery。
6. **缺失、未知与证据。** fixed root 把核心工具实现委托给精确 `playwright-core` alpha，但本地没有闭合该 alpha 的源码/制品对应；download/session/trace 精确路径和生命周期均为 `[未知]`。证据见[专项审查](../projects/playwright-mcp/review.md)与[固定 wrapper](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/index.js#L18-L19)。

### 5.10 xiaohongshu-importer

固定 revision：`b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37`。

1. **导出对象与能力范围。** `[源码事实]` 这是人工触发的单帖 Obsidian importer：用户粘贴 share text、选择分类和是否下载媒体，插件创建一篇 Markdown。没有 search、发布/收藏/点赞/专辑列表、批量调度或账号 scope。
2. **先决条件与账号主体。** 需要可加载插件的 Obsidian、当前 Vault、含认可 URL 的 share text 与 category；不接受裸 note ID。源码没有 Cookie/token/profile 输入，只调用 Obsidian `requestUrl` 和 global fetch；宿主是否携带 ambient credentials 为 `[未知]`，不能写成“无需登录”。
3. **获取方式与调用路径。** `discovery → detail → media → store` 为：discovery 不提供，用户自行取得 URL → `requestUrl(URL)` 读取 HTML，解析 title/desc/`__INITIAL_STATE__` 第一项 → 可选 fetch `urlDefault` 图片或首个 H.264/H.265 视频 → Vault media + Markdown。
4. **保存目标与结构。** `local`。默认 `<Vault>/XHS Notes/<category>/<safeTitle>.md`；共享媒体目录 `XHS Notes/media/`，图片名 `<title>-<zero-index>-<Date.now()>.jpg`，视频 `<title>-<Date.now()>.mp4`。不开下载或单项失败时 Markdown 保留远端 URL；不保存 raw HTML/JSON/DB。
5. **checkpoint、去重与部分失败。** 文件名只用截断标题，不含 stable note ID；同名时直接 `vault.create`，无 update/no-op。媒体先写、Markdown 后建，重跑或 note create 失败可留 timestamp orphan。没有 manifest、cursor、逐资产状态、retry 或恢复。
6. **缺失、未知与证据。** parser 不核对请求 URL ID，直接取 `noteDetailMap` 第一项；多个 parse error 会降级为空/占位后仍可能成功写笔记。当前 URL regex、redirect、页面 state、Obsidian adapter 路径/覆盖语义与发布制品一致性均为 `[未知]`。证据见[专项审查](../projects/xiaohongshu-importer/review.md)与[固定实现](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/main.ts#L120-L248)。

### 5.11 Spider_XHS

固定 revision：`2030f5d4454e556ad7a9caa83b3ec532d4df20c7`。

1. **导出对象与能力范围。** `[源码事实]` 高层 `Data_Spider` 已接线三条本地导出：显式 note URL 列表、某用户发布、关键词搜索。底层虽有用户喜欢、收藏和评论方法，但没有高层调用、详情展开或 writer，不能算现成 liked/collected/comment exporter。
2. **先决条件与账号主体。** 需要 `XHSPcAuth` 登录主体，可来自 Cookie、QR 或 phone；bootstrap 用 `user/me` 得到实际 session user ID，但不比对 expected account。显式路径需 URL list，用户路径需 user URL，search 需 query/数量/filters；detail URL 可含 token/source。
3. **获取方式与调用路径。** `discovery → detail → media → store` 为：调用方 URL，或 GET `user_posted`，或 POST search v2 → 逐条 POST `feed` → 选择图片 `info_list[1]` 或首个 H.264/video key → requests 写媒体并保存扁平详情。高层重建用户帖子 URL 时丢弃 item source，详情默认回落 `pc_search`。
4. **保存目标与结构。** `local`。`datas/media_datas/<nickname>_<userId>/<title-or-无标题>_<noteId>/` 下写 `info.json`、`detail.txt`、`image_0.jpg...` 或 `cover.jpg/video.mp4`；`datas/excel_datas/<name>.xlsx` 是 19 列扁平表。JSON/TXT 会保存媒体 URL，输入 URL 的访问 query 也可能被持久化。
5. **checkpoint、去重与部分失败。** 发布/喜欢/收藏的 cursor 只在内存，缺 cursor 时可能在 append 当前页前 break；无重复 cursor、ID 去重或页数预算。详情失败被跳过，媒体缺失可静默降级；整 note 最多三次 retry、直写最终文件，不能恢复或证明完整。
6. **缺失、未知与证据。** 不提供高层 liked/collected/comment export、stable asset slot、Live Photo、hash/receipt、失败缺口表或原子批次。当前 endpoint、登录、签名、列表可见范围、排序、token/source 与媒体 variant 均为 `[未知]`。证据见[专项审查](../projects/Spider_XHS/review.md)与[固定高层入口](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/spider/spider.py#L14-L103)。

### 5.12 XHS_ALL_IN_ONE

固定 revision：`63b85de2b15b3f79134b08fa675381505f45d4db`。

1. **导出对象与能力范围。** `[源码事实]` 已接线 search、note URLs 和 user notes 进入本地内容库，再按内部 `note_ids` 导出 JSON/CSV。底层 like/collect 未接应用导出；SSE `/crawl/data` 只把结果放在帧/进程内列表，不调用保存函数。
2. **先决条件与账号主体。** 必须区分本地系统用户与该用户拥有的平台账号。采集需要系统用户、平台账号记录和加密 Cookie；三入口分别需要 keyword、URL 或目标 user。`POST /api/notes/export` 需要内容库内部 IDs，不是平台 note ID 直出接口。
3. **获取方式与调用路径。** `discovery → detail → media → store → export` 为：应用 crawl route → adapter/平台请求与规范化 → 保存 Note 时同步下载 NoteAsset → SQLite/media → `POST /api/notes/export(note_ids,json|csv)`。SSE 路径在 store 前终止，不能进入该链。
4. **保存目标与结构。** `local`。SQLite `./data/spider_xhs.db`，主要表 `notes`、`note_assets`；媒体 `backend/app/storage/media/xhs-asset-u<userId>-<uuid>.<ext>`；导出文件 `exports/xhs-notes-u<userId>-<timestamp>-<8hex>.json|csv`。JSON 顶层含 `platform/format/exported_at/total/items`。
5. **checkpoint、去重与部分失败。** 没有 durable cursor/page/item receipt。保存按 `(user_id,note_id)` 查找却忽略 platform/account，唯一约束与 provenance不足；asset sort order 不可靠。媒体直写最终文件且不受 DB transaction 控制，可留空 local path 或孤儿。URL batch partial 仍可能把 Task 标 completed。
6. **缺失、未知与证据。** 不提供已接线 liked/collected export、SSE persistence、逐资产完整性、原子媒体 commit 或故障 reconcile。当前 endpoint、签名、Cookie、分页、风控与真实导出成功率为 `[未知]`。证据见[专项审查](../projects/XHS_ALL_IN_ONE/review.md)与[固定 crawl route](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/api/platforms/xhs/crawl.py#L226-L335)。

### 5.13 xhs_web_crawler

固定 revision：`8a7d1b6ec90d9c3d25f3d731cd83a15f8ab08c50`。

1. **导出对象与能力范围。** `[源码事实]` fixed 实证范围是 keyword search 页面卡片；收藏、点赞、发布、专辑和评论均未证明。唯一闭环是用户手工保存 HAR with content，再由 Python 抽取 `data.items[].note_card`；不下载媒体。
2. **先决条件与账号主体。** 需要 Chrome、Python、unpacked MV3 extension、当前 tab 中的人工登录、网页 keyword search、用户手工保存的 HAR 以及 HAR path。登录主体是 active tab session，但工具不记录账号 ID。不需要用户预先提供 note ID/token。
3. **获取方式与调用路径。** `discovery → detail → media → store` 为：content script 按 `.note-item[data-index]` 点击/关闭/滚动 → detail：不提供；点击只可能触发流量，代码不解析详情且 parser 不按 endpoint/请求绑定 note → media：不提供 → store：解析 HAR `response.content.text`，直接或 base64 decode JSON并收集 note cards。
4. **保存目标与结构。** `local`。人工 HAR 是敏感中间输入；默认终产物为当前工作目录 `<HAR-basename>_content.json`，内容是未版本化、未去重的 `note_card[]` 裸数组。没有 run/account/source/cursor envelope、媒体目录或 manifest。
5. **checkpoint、去重与部分失败。** content script 只以内存 `Set(data-index)` 去重，刷新即丢；点击前就标已处理。parser 单条失败只警告并跳过，仍写 partial，无失败清单或 completeness flag。没有持久 pause/resume、note-ID 去重或增量落盘。
6. **缺失、未知与证据。** manifest 未注册 background service worker/debugger/webRequest/downloads，消息名和 parser shape 也不匹配；content CDP export 未调用。因此自动 HAR 候选未接线。selector、响应 schema、搜索/收藏/点赞兼容和点击对应 endpoint 均为 `[未知]`。证据见[专项审查](../projects/xhs-web-crawler/review.md)与[固定 parser](https://github.com/leafiy/xhs_web_crawler/blob/8a7d1b6ec90d9c3d25f3d731cd83a15f8ab08c50/extract-content.py#L40-L203)。

### 5.14 RedCaChe

固定 revision：`b3526e66ed1d5b78e35a390edf1b7f29e1399ee9`。以下两套实现不互通，不能取能力并集。

1. **导出对象与能力范围。** `[源码事实]` 两套都只发现当前账号 saved/favorites；liked、album 与媒体下载不提供。扩展默认只抓 card metadata，可选逐帖补标题。旧服务器可达详情也只有补标题；丰富 `enrich_posts()` 无 router，测试要求对应 endpoint 404。
2. **先决条件与账号主体。** 纯扩展需要同一 Chrome/Chromium 中已登录自己的站点账号，以及自动检测或手填的收藏页 URL；旧服务器需要本地 Python/Node/FastAPI/React/Playwright 和持久 profile 中的人工登录。批量 discovery 均不需预先给 note ID。
3. **获取方式与调用路径。** 扩展：`discovery（favorites DOM 滚动）→ detail（仅可选标题补全）→ media：不提供 → store（IndexedDB）`。旧服务器：`discovery（POST /crawler/import-visible-favorites → Playwright DOM）→ detail（仅标题补全）→ media：不提供 → store（SQLite → POST /export/obsidian/{daily,evergreen}）`。两者没有平台 JSON API cursor。
4. **保存目标与结构。** 扩展为 `browser`：IndexedDB `redcache` v1，stores `posts/config/windows`；固定源码无 JSON/CSV/Markdown 文件 export。旧服务器为 `local`：默认 `backend/data/xhs_curator.db`，含 `posts/import_runs/app_config/review_windows`，再写 `exports/obsidian/xhs-daily-review-YYYY-MM-DD.md` 或 `xhs-evergreen-YYYY-MM-DD.md`。
5. **checkpoint、去重与部分失败。** 扩展有 unique note ID/URL 合并，但全量 DOM scan 后才逐条 put；`windows` 无调用，失败只计数。旧 ImportRun 持久化 completed/stopped/failed 和计数，但不保存 page cursor/batch offset，不能 resume；同日 Markdown 直接覆盖。两套数据不互通。
6. **缺失、未知与证据。** `[项目声明]` 扩展 README 称改为浏览器下载；`[源码事实]` dashboard/handlers 没有 download UI/调用，也无 `chrome.downloads`/Blob link，因此裁决为未接线。页面 selector、登录识别、全量扫描和当前兼容性为 `[未知]`。证据见[专项审查](../projects/redcache/review.md)与[固定扩展 ingest](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/extension/content-script.js#L21-L82)。

## 6. 两份历史客户端逆向结果

### 6.1 Rednote2Notion 1.0.6

固定身份：Chrome MV3 unpacked extension；来源 URL 与 revision 未知。工件由 manifest `cf75c9ed560b95e91fee31904336d378f1866b79174c8ee5bdecf598ee4dcfda`、background bundle `31aac68e5e6a473eb2ba7962a112cad7cdd87d809fb92bda3df1d0b136d6ecf7`、content script `b08c18c0d7173278715a143ef963b5454c69c7b8681529360e1a725c0d540c83` 三个 SHA-256 锁定，详见[逆向报告](../reverse/targets/rednote2notion/report.md)。

1. **导出对象与能力范围。** `[逆向报告事实]` 客户端支持当前账号的个人发布、普通收藏、点赞和可选收藏专辑。三普通目标共享同步算法；album 是 bookmark 的历史分支。它不导出评论、OCR 或转写；可选 AI 只做文本分类。

   - 普通 batch 为 5；固定 alarm 间隔为 10 分钟。
   - album batch 为 3；board discovery 只取第一页最多 50 个。
   - 输出目标是远端 Notion，不是本地帖子文件。

2. **先决条件与账号主体。** `[逆向报告事实]` 需要已安装扩展、Chrome 中已登录的 XHS/RedNote session、可用站点页面和 MAIN-world 签名环境。XHS 分支以 `user/me` 取得当前 user ID；RedNote 的同等账号切换链不完整。

   - 列表返回 note ID 与 `xsec_token`，detail 不要求用户预先逐个输入它们。
   - album 的 board ID 由 `board/user` 发现。
   - 目的端需要 Notion integration secret、目标 Page 与预先存在且 schema 兼容的中文 child databases。
   - 当前商业 UI 还依赖作者授权码/到期状态；这不是 Core 数据模型要求。

3. **获取方式与调用路径。** `discovery → detail → media → store` 为：Side Panel 开启目标 → background alarm → `user/me` → `user_posted`、collect/like page 或 `board/user → board/note` → POST `feed` → 图片 fetch/Notion upload，视频取 external URL → 创建远端 Notion page。

   - XHS API origin 为样本中的 Edith host，RedNote 为样本中的 Web API host。
   - 列表/详情在真实 tab MAIN world 调 `window.mnsv2` 生成签名头；`user/me` 另走 legacy signer。
   - 这些只是样本调用的站点 Web endpoint，不是当前稳定/公开 API 承诺。

4. **保存目标与结构。** 业务目标为 `remote`；本地为 `browser(state-only)`。

   ```text
   Notion Page
     ├─ 帖子 database      # 主目标
     ├─ 笔记 database      # 当前主路径未使用
     ├─ 分类 database      # relation
     └─ 标签 database      # relation
   ```

   帖子 properties 包含 `resourceId`、标题、类型、分类、标签、作者、URL、帖子创建/修改时间和客户端创建/修改时间。page body 先 append 正文 paragraph；图片以 Notion file upload 写入；视频只建 external embed。扩展不创建数据库 schema。

   本地 `chrome.storage.local` 只保存 cursor、all-sync、去重 cache、账号快照、host/sync 状态、Notion/AI 设置和明文凭据，没有帖子 JSON/Markdown/media/SQLite。

5. **checkpoint、去重与部分失败。** `[逆向报告事实]` 三目标分别保存 cursor 与 note-ID cache；Notion page create 中途失败时可保存批内成功 IDs。客户端会用最新 Notion `resourceId` 或最后成功 note ID恢复 cursor，这混淆内容身份与服务端 cursor。

   - paragraph append 与图片 upload helper 可吞错，page properties 已建后仍可能把 note 记入同步 cache。
   - POST/LIKE 空页、少量全重复页和 album 的 3/5 判断错位会造成停滞。
   - album cursor 把 board ID 与 cursor 用下划线拼接；专辑只发现首批 50 boards。
   - 去重/config 不完全按账号隔离，RedNote账号切换行为为 `[未知]`。

6. **缺失、未知与证据。** 没有本地帖子导出、评论、OCR、转写、业务级 retry/backoff 或图片/page 原子完成。7 个 endpoint、`window.mnsv2`、cursor 是否接受 note ID、board ID/cursor 字符集、Notion API 限制与当前兼容性均为 `[未知]`。完整证据见[Rednote2Notion 静态逆向报告](../reverse/targets/rednote2notion/report.md)。

### 6.2 Rednote2Obsidian 1.2.3

固定身份：桌面 Obsidian plugin snapshot。记录 HEAD 为 `e8dc0678aacc451a4ffa6d7942f795ea85860ba1`，但工件来自脏 working tree，必须结合 main.js `5ce6a362f4cbd0542caecb1e37ab0c1c20f27b9164890da1c80f8a682cb194b7`、manifest `acac98903a226351bd3780a10106b50ae5550e6ef96d4851a15f952e45ba6dd0`、styles `88722426c4944bf95b37ba67da31f1dfb700930bd6236565fd982b8c4f3d7669` 三个 SHA-256 锁定，详见[逆向报告](../reverse/targets/rednote2obsidian/report.md)。

1. **导出对象与能力范围。** `[逆向报告事实]` 支持当前登录账号的 post、bookmark、like 和收藏专辑；三普通目标一次只同步 active target。每个 list item 逐条取详情；可选抓热门评论首屏、AI 分类、图片 OCR 和视频转写。

   - 评论只有顶层最多 10 条、每条最多 3 条 sub-comments，不分页。
   - 图片默认下载；视频默认不下载，可保留远端 video/link。
   - Obsidian ≥1.9 时可生成 Base；低版本仍写 Markdown/media。

2. **先决条件与账号主体。** `[逆向报告事实]` 需要 Obsidian desktop、Vault/rootFolder、选定 host/target，以及 Electron `persist:rednote` webview 中用户建立的有效站点 session。业务请求使用 webview Cookie/localStorage 与 `credentials: include`，不是简单拼设置里的 Cookie 字符串。

   - `user/me` 取得 user ID/nickname并排除 guest。
   - 当前实现把关系所属、列表和详情 session 简化为同一账号。
   - detail/comment 依赖列表产出的 note ID 与 `xsec_token`；album 依赖 board ID/cursor。
   - AI/OCR/ASR 另需用户配置 provider/model/credential，并会产生第三方数据流。

3. **获取方式与调用路径。** `discovery → detail → media → store` 为：命令/ribbon/timer → hidden Explore webview → `user/me` → 一页 `user_posted`、collect、like，或 `board/user → board/note` → POST `feed`，可选 GET comment page → 下载图片/可选视频并调用可选增强服务 → Vault writer → Base writer。

   样本共恢复 8 个站点 Web endpoint：

   1. `GET /api/sns/web/v2/user/me`；
   2. `GET /api/sns/web/v1/user_posted`；
   3. `GET /api/sns/web/v2/note/collect/page`；
   4. `GET /api/sns/web/v1/note/like/page`；
   5. `POST /api/sns/web/v1/feed`；
   6. `GET /api/sns/web/v2/comment/page`；
   7. `GET /api/sns/web/v1/board/user`；
   8. `GET /api/sns/web/v1/board/note`。

   每个业务请求在页面上下文调用 `window.mnsv2`，读取页面 Cookie/localStorage 后生成签名头。所有 endpoint、字段和签名当前是否可用均为 `[未知]`。

4. **保存目标与结构。** `local`，典型 Vault 布局为：

   ```text
   <rootFolder>/
     Posts/[category]/<title60>-<noteId>.md
     Bookmarks/[category]/<title60>-<noteId>.md
     Likes/[category]/<title60>-<noteId>.md
     Media/<noteId>/image-<n>.<ext>
     Media/<noteId>/video-<n>.<ext>
     📕 小红书.base
   ```

   frontmatter 包含 resourceId、type、author、URL、metrics、tags、category、帖子时间和 syncedAt；正文按原文、图片、视频/远端 fallback、OCR、转写、评论 callout 排列。Markdown 同路径整体 modify；已存在二进制媒体不覆盖。tokenized URL 可能进入 frontmatter，是与研究当时 Core secret 边界的重要差异。

5. **checkpoint、去重与部分失败。** 普通目标在插件设置保存 response cursor、成功 `syncedIds` 和 all-synced；note 写 Markdown 成功后才登记 ID。但只要一页至少成功一条，cursor 就可能推进并越过同页失败项，没有 durable failure queue。

   - 图片失败仍生成假定本地 jpg embed，可能断链。
   - 视频未下载/失败时回退远端 URL，因此不保证全媒体离线。
   - album 用 `boardId_cursor` 复合字符串和逐 board完成标记；poll-last-ID 未纳入 per-account 快照。
   - `perAccountState[userId]` 只交换六类状态，且交换发生在登录成功路径，不是每次普通同步天然绑定。

6. **缺失、未知与证据。** 不提供评论全量、严格页内失败恢复、事务型 canonical DB、逐资产 receipt 或完整本地视频保证。列表排序、删除/置顶、空页/cursor、限流阈值、Retry-After、不同账号/地区和当前 endpoint/签名兼容性均为 `[未知]`。完整证据见[Rednote2Obsidian 静态逆向报告](../reverse/targets/rednote2obsidian/report.md)。

## 7. 两份逆向客户端能力到 Core 的覆盖矩阵（2026-08-19 历史快照）

> Core 比较基线为 2026-08-19 的历史实现快照。本文保留当时的能力矩阵与保存结构，不追踪后续重构；背景契约见[重构前规格](../../projects/docs/history/sync-core-before-2026-09-12.md)，现行行为见[当前 Core 契约](../../projects/docs/sync-core.md)。

### 7.1 解释口径

本节比较的 Core 基线是[历史实施 Stage 3](../../docs/history/implementation-stages.md)完成的严格离线 Core。它只接受 fixture/import envelope，不连接浏览器或平台。

Core 状态列只使用以下五个值：

- `已提炼并实现`；
- `已抽象但仅支持离线输入`；
- `有意未移植`；
- `留待在线采集阶段`；
- `不属于 Core 职责`。

其中“留待在线采集阶段”只描述当时的覆盖缺口，沿用历史实施边界，不是当前产品路线的新决定。“有意未移植”与“不属于 Core 职责”也只解释当时交付边界，不构成永久产品禁令。

### 7.2 覆盖矩阵（恰好 10 项）

| # | 能力 | Rednote2Obsidian 1.2.3 | Rednote2Notion 1.0.6 | Core 状态 | 精确限定 |
|---:|---|---|---|---|---|
| 01 | 发布、收藏、点赞和收藏专辑统一模型 | post/bookmark/like；album 为 bookmark 分支，统一写 Vault note | POST/BOOKMARK/LIKE 共享对象；album 用专辑名分类 | 已提炼并实现 | Core 定义 `posted/collected/liked/collected_album` 和普通/album discriminated scope |
| 02 | 单账号状态分区与账号切换 | 六项 per-account swap，登录成功路径才交换；poll state遗漏 | 有 snapshot/restore，但 cache/host/sync 未完全分区；RedNote链未知 | 已抽象但仅支持离线输入 | account+host+target+board 分区已实现；真实浏览器 identify/切换未实现，Core仍采用单 account 简化 |
| 03 | 列表 cursor、去重和失败恢复 | response cursor + synced IDs；partial 页可推进，无 failure queue | cursor/cache；误用 resourceId/note ID作 cursor，存在末页停滞 | 已提炼并实现 | `ServerCursor` 与 `NoteId` 分离；SQLite progress/task/failure/run 及 retry/skip/ack 已实现，但只处理离线输入 |
| 04 | 详情与媒体数据模型 | feed→正文、时间、tags、metrics、图片/视频；视频可外链 | feed→正文、时间、tags、图片/视频；图片上传、视频 embed | 已抽象但仅支持离线输入 | `ListItem/Note/Media/MediaSlot/TransientNote/MediaStore` 已实现；真实 detail/media source 未实现 |
| 05 | SQLite canonical state 和内容寻址对象存储 | 无；进度在插件设置，内容是可覆盖 Vault 文件 | 无；本地 chrome.storage，帖子在远端 Notion | 已提炼并实现 | `state/rednote-sync.sqlite` 与 hash-verified immutable `objects/sha256` 是唯一事实源 |
| 06 | JSON、Markdown、媒体与索引投影 | 有客户端专用 Markdown/media/Base，无 Core JSON/index/failure/run布局 | 无本地帖子投影 | 已提炼并实现 | Core 可从 DB/object 重建 notes/assets/index/failures/runs；媒体 bytes 当前仍来自离线输入 |
| 07 | 浏览器登录、Cookie/session 与页面签名 | Electron `persist:rednote`、页面 Cookie/localStorage、`window.mnsv2` | Chrome Cookie jar、真实 tab MAIN-world `window.mnsv2`，另有 legacy signer | 留待在线采集阶段 | Core 不读取真实会话、不启动 browser SessionAdapter、不实现签名 |
| 08 | 真实列表、详情和媒体在线获取 | 样本静态可见 8 个 endpoint，媒体 downloader 可达 | 样本静态可见 7 个 endpoint，图片 fetch、视频外链 | 留待在线采集阶段 | Core client 只有 fixture/import；origin、endpoint、字段、cursor、token、限流与 codec 全待验证 |
| 09 | Obsidian Vault 与 Notion 数据库写入 | Vault Posts/Bookmarks/Likes/Media、Markdown、Base | 远端 Notion page/relation/file upload/embed | 不属于 Core 职责 | Core 保证自己的本地知识库/通用派生视图，不复刻客户端 UI/布局；历史实施 Stage 3另明确不接 Notion API |
| 10 | 评论、OCR、转写和 AI 分类 | 评论首屏、AI、OCR、四类转写可选 | 仅可选 AI；无评论/OCR/转写 | 有意未移植 | 历史实施 Stage 3 非目标明确列出 AI、OCR、转写、评论全量；Core 只有评论计数 |

### 7.3 Core 当时的保存结构

`[源码事实]` 本节历史 Core 基线的 canonical 与 derived layout 是：

```text
rednote-knowledge/
  state/rednote-sync.sqlite
  objects/sha256/<prefix>/<sha256>
  control/<scopeDigest>.pause
  accounts/<accountDigest>/
    account.json
    notes/<noteKeyDigest>.md
    assets/<noteKeyDigest>/<kind>-<ordinal>.<ext>
    data/notes/<noteKeyDigest>.json
    data/index.json
    data/index.csv
    data/failures.json
    logs/export-runs.jsonl
    .views/<projectorId>.generation.json
```

SQLite/object store 是唯一事实源；notes/assets/index/failures/runs 是可重建 view。Core 对媒体 bytes 能做 magic MIME、长度/hash、不可覆盖 object publish 和逐 slot failure；但它不会自行从真实远端 URL取得这些 bytes。

### 7.4 对“是否已经实现两项目逆向后的能力”的直接回答

**针对 2026-08-19 基线：没有完整实现。** 当时已实现的是两份逆向结果经 clean-room/独立设计提炼出的离线下游能力；尚未实现两个客户端的在线上游和目的端专用能力。以下清单不代表后续重构后的当前状态。

已经实现：

- 四目标统一模型与严格 scope；
- account/host/target/board 状态分区；
- 独立 server cursor、任务/失败账本、幂等与恢复；
- 详情/媒体规范类型和离线输入 decoder；
- SQLite canonical state、内容寻址对象存储；
- JSON、Markdown、media、index、failures、runs 派生视图。

尚未实现：

- 真实账号登录、Cookie/session、页面环境和签名；
- 真实发布/收藏/点赞/专辑列表、详情和媒体在线获取；
- Rednote2Obsidian 的客户端 UI、Vault 专用目录/frontmatter/callout/Base；
- Rednote2Notion 的数据库发现、page/relation、图片上传和视频 embed；
- 评论正文、OCR、转写和 AI 分类。

历史契约依据见 [Core 重构前规格](../../projects/docs/history/sync-core-before-2026-09-12.md)；现行行为以[当前 Core 契约](../../projects/docs/sync-core.md)为准。

## 8. Evidence 汇总

### 8.1 固定证据索引

- `EV-XD`：XHS-Downloader [`56c912e…` 专项审查](../projects/xhs-downloader/review.md)，支持页面发现、单帖 HTML/media、SQLite 与 Range 边界。
- `EV-OC`：OpenCLI [`a86d647…` 专项审查](../projects/opencli/review.md)，支持 Browser Bridge、互不编排的 `saved/liked` 列表、`note`、`download` 三段，以及 stdout 与媒体目录。
- `EV-XE`：xhs-cli-export [`6c9bcbd…` 专项审查](../projects/xhs-cli-export/review.md)，支持 provider 边界、run layout、JSONL/state 漂移。
- `EV-PW`：Playwright [`bcb3563…` 专项审查](../projects/playwright/review.md)，支持基础设施分类及会话/诊断制品边界。
- `EV-XC`：xiaohongshu-cli [`4d63f3c…` 专项审查](../projects/xiaohongshu-cli/review.md)，支持读取 endpoint、stdout、access caches 与 cursor 透传。
- `EV-MC`：MediaCrawler [`5665a27…` 专项审查](../projects/mediacrawler/review.md)，支持 search/creator/detail、多 Store 与媒体 partial。
- `EV-XM`：xiaohongshu-mcp [`da9ba03…` 专项审查](../projects/xiaohongshu-mcp/review.md)，支持页面 state、REST/MCP response 与 Cookie/staging 排除。
- `EV-RX`：ReaJason/xhs [`f4b62d9…` 专项审查](../projects/xhs/review.md)，支持 SDK/内存分类与 broken helper 裁决。
- `EV-PM`：Playwright MCP [`7e0457a…` 专项审查](../projects/playwright-mcp/review.md)，支持通用工具边界及 exact alpha provenance 缺口。
- `EV-XI`：xiaohongshu-importer [`b1d3e3b…` 专项审查](../projects/xiaohongshu-importer/review.md)，支持单帖 HTML→Vault 链、命名与孤儿语义。
- `EV-SX`：Spider_XHS [`2030f5d…` 专项审查](../projects/Spider_XHS/review.md)，支持三个高层入口、19 字段输出与低层未接线能力。
- `EV-AI`：XHS_ALL_IN_ONE [`63b85de…` 专项审查](../projects/XHS_ALL_IN_ONE/review.md)，支持内容库、media、内部 ID export 与 SSE 边界。
- `EV-WC`：xhs_web_crawler [`8a7d1b6…` 专项审查](../projects/xhs-web-crawler/review.md)，支持人工 HAR 唯一闭环与自动候选未接线。
- `EV-RC`：RedCaChe [`b3526e6…` 专项审查](../projects/redcache/review.md)，支持两套实现、IndexedDB/SQLite/Markdown 不互通边界。
- `EV-RN`：[Rednote2Notion 1.0.6 逆向报告](../reverse/targets/rednote2notion/report.md)，支持 7 endpoint、Notion store、storage progress 与 partial。
- `EV-RO`：[Rednote2Obsidian 1.2.3 逆向报告](../reverse/targets/rednote2obsidian/report.md)，支持 8 endpoint、Vault/media/Base、设置 progress 与可选增强。
- `EV-CORE`：[Core 重构前规格](../../projects/docs/history/sync-core-before-2026-09-12.md)，支持研究当时的离线边界、类型、状态机、SQLite/object 与 derived views；当前实现另见[现行契约](../../projects/docs/sync-core.md)。
- `EV-HIST`：[历史实施 Stage 1–4](../../docs/history/implementation-stages.md)，支持逆向→Core→在线采集未完成的历史序列。

### 8.2 Findings：Evidence → Finding → Path

| Finding ID | Finding | Evidence IDs | Confidence | Status | Path |
|---|---|---|---|---|---|
| F-01 | 16 个对象至少分 local/browser/remote/none 与基础设施，不能统一叫本地导出器 | EV-PW, EV-PM, EV-RC, EV-RN | 高 | 已证实 | P-01/P-02/P-03 |
| F-02 | 能落盘不等于可恢复同步；多数项目没有 discovery cursor 与逐资产 receipt 的共同 commit | EV-XE, EV-MC, EV-SX, EV-AI | 高 | 已证实 | P-01 |
| F-03 | XHS-Downloader 的页面 discovery 与 Python 单帖下载必须拆开，服务端列表骨架未接线 | EV-XD | 高 | 冲突已裁决 | P-01 |
| F-04 | OpenCLI 的 `saved/liked` 列表、`note`、`download` 三段没有逐帖 orchestration，列表 stdout 与单帖 media store不能拼成现成批量 exporter | EV-OC | 高 | 冲突已裁决 | P-01/P-02 |
| F-05 | xiaohongshu-cli、xiaohongshu-mcp、ReaJason/xhs 的主要可达结果不是项目管理的帖子文件 | EV-XC, EV-XM, EV-RX | 高 | 已证实 | P-02 |
| F-06 | Playwright 与 Playwright MCP 的 profile/storage/download/trace 等均不是帖子 Schema 或业务 checkpoint | EV-PW, EV-PM | 高 | 已证实 | P-02 |
| F-07 | RedCaChe 扩展与旧服务器不互通；扩展只写 IndexedDB，旧服才写 SQLite/Markdown | EV-RC | 高 | 冲突已裁决 | P-01 |
| F-08 | Rednote2Notion 将内容写远端 Notion，本地 storage 只存状态/凭据 | EV-RN | 高 | 已证实 | P-03 |
| F-09 | Rednote2Obsidian 有真实本地 Vault 链，但不保证视频离线、图片成功或页内失败可恢复 | EV-RO | 高 | 已证实 | P-01 |
| F-10 | 2026-08-19 Core 基线只实现从安全离线输入开始的下游，不含两客户端完整在线/目的端能力 | EV-CORE, EV-HIST, EV-RN, EV-RO | 高 | 已证实 | P-03 |
| F-11 | note ID、xsec access material、session账号和目标 user 是不同概念，不能互相替代 | EV-OC, EV-XC, EV-MC, EV-RN, EV-RO | 高 | 已证实 | P-01/P-02 |
| F-12 | note ID 或最新目的端 resourceId 不能冒充服务端 cursor；Core 已明确分离两种类型 | EV-RN, EV-RO, EV-CORE | 高 | 已证实 | P-03 |
| F-13 | note 行、文件存在或 HTTP success 都不能单独证明媒体 bytes 完整 | EV-XD, EV-MC, EV-AI, EV-RO | 高 | 已证实 | P-01 |
| F-14 | 所有 fixed endpoint、页面 state、selector、签名和账号可见范围的当前在线行为仍未知 | EV-XD、EV-OC、EV-XE、EV-PW、EV-XC、EV-MC、EV-XM、EV-RX、EV-PM、EV-XI、EV-SX、EV-AI、EV-WC、EV-RC、EV-RN、EV-RO | 高 | 未知保留 | 所有在线 Path |

### 8.3 证据充分性边界

- 14 个第三方项目均有 fixed revision；两个逆向对象均有 artifact identity。
- Rednote2Obsidian 的 HEAD 只作取得背景，不能替代脏 snapshot 的三哈希。
- Rednote2Notion 没有 commit/source URL，不能构造 fixed commit permalink。
- XHS_ALL_IN_ONE 的本专题 packet 主要复用既有审查与 fixed permalink，不构成第二份独立源码审查。
- Playwright MCP 精确 alpha runtime 不在 fixed root；download/session/trace 的 exact implementation 继续标 `[未知]`。
- 项目 README 中“无需登录”“全部”“无水印”“不会触发反爬”“断点恢复”等表述都没有被提升为动态事实。

## 9. Timeline 摘要

| 日期/历史实施阶段 | 证据事件 | 对本专题的意义 |
|---|---|---|
| 2026-08-11 | 14 个候选研究目录的初始调研日期 | 建立第三方项目比较基线；评级只是研究判断 |
| 2026-08-12 | Core 规格记录历史实施 Stage 3 已完成 | 离线模型、状态机、SQLite/object 与投影成为已实现契约 |
| 2026-08-13 | 候选补充核查；Rednote2Notion provenance 记录 | 补充固定版本与第二份客户端逆向证据 |
| 2026-08-17 | xhs_web_crawler 评级复核、RedCaChe 新增专项 | 补入浏览器点击 fallback 与两代资料库实现边界 |
| 2026-08-19 | 本专题离线综合 | 统一回答先决条件、获取链、保存结构和 Core 覆盖 |

历史实施序列必须这样理解：

1. **历史实施 Stage 1**：逆向 Rednote2Obsidian；
2. **历史实施 Stage 2**：逆向 Rednote2Notion；
3. **历史实施 Stage 3**：根据证据独立实现离线 Core；
4. **历史实施 Stage 4**：只形成在线采集研究与探索，没有完成真实在线实现。

该序列不是当前产品三个功能阶段；当前进度仍以[路线图](../../docs/design/roadmap.md)为准。研究日期和候选状态见[研究目录](../catalog.md)。

## 10. 跨项目未知项

以下问题在本次固定版本静态研究中不能回答：

- 所有站点 Web endpoint、API host、页面 selector、`__INITIAL_STATE__` shape 与 `window.mnsv2` 在 2026-08-19 是否仍兼容；
- 匿名、登录、不同 session账号与目标 user 组合下，发布/收藏/点赞/专辑的真实可见范围；
- 服务端 cursor 的排序、终止、重复、删除、置顶、空页和跨运行稳定性；
- `xsec_token/xsec_source` 的来源绑定、生命周期、撤销、host/页面复用规则；
- 图片、视频、Live Photo、codec/variant、CDN URL 的集合完整性和实际有效期；
- 平台错误码、验证码、429、安全限制、Retry-After 和账号恢复语义；
- Playwright MCP exact alpha 的 download/session/trace 细节；
- xiaohongshu-importer 的 Obsidian `requestUrl` ambient credential/redirect 语义；
- RedNote host 下两个逆向客户端的账号切换与签名差异；
- 任何项目的长期账号安全、合规授权和批量稳定性。

这些未知不能用延迟、真实浏览器、CDP、滚动次数、项目 Star、README 声明或一次有限运行记录补齐。

## 11. 最终判定

对“这些项目怎么导出”的最短回答是：

- 有些项目从浏览器页面或站点 Web endpoint发现 ID/token，再抓详情和媒体，写本地文件/数据库；
- 有些只返回 stdout、REST/MCP 或内存对象，根本没有帖子 store；
- 有些只提供浏览器自动化原语；
- RedCaChe 扩展只写浏览器 IndexedDB；
- Rednote2Notion 写远端 Notion；
- Rednote2Obsidian 写本地 Vault，但媒体和恢复仍可能 partial。

对“Core 是否已经实现两份逆向后的能力”的最短回答是：**Core 已实现由两份逆向证据提炼出的离线下游核心，但没有实现两个客户端的完整能力。** 任何浏览器登录、签名、真实接口或目的端专用 writer，都不能从现有 Core 契约中推导为已经完成。
