# `ValerieTse/RedCaChe` 专项源码审查

> 状态：**研究证据**。本文只对记录的固定 revision 和审查范围负责；评级、排除项、历史实施阶段边界和账号限制不自动成为当前产品决策。

研究日期：2026-08-17（Pacific/Auckland）
官方仓库：<https://github.com/ValerieTse/RedCaChe>
固定 revision：[`b3526e66ed1d5b78e35a390edf1b7f29e1399ee9`](https://github.com/ValerieTse/RedCaChe/tree/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9)
Git tree：`709de5bf7d62d845ed60268ac1225ceb6468f12b`
审查方式：官方仓库 detached HEAD、tracked-only 静态审查；未安装、构建、运行或访问平台。

状态：专项静态审查完成；独立复审通过
来源与快照记录：[`provenance.json`](provenance.json)
中断恢复状态：[`checkpoint.json`](checkpoint.json)

## 核心结论

**建议等级：A-（值得专项研究），采用等级：B（只借鉴产品分层与扩展边界，不能直接采用当前同步实现）。** RedCaChe 与 Rednote Sync 的问题域高度接近：它把“已收藏条目发现”“本地资料库”“人工 review”“受控取消收藏”“知识库导出”放在同一产品里；最新提交还展示了从 Playwright 本地服务迁移到 Manifest V3 纯 Chrome 扩展的最小切面。因此，它不应再被当作 D 级背景资料。

真正有价值的设计是：把站点会话留在浏览器，把页面读取放在 content script，把编排放在 service worker，把用户的长期整理状态放在本地数据库；平台写操作必须与“仅标记为待移除”分离。对 Rednote Sync 而言，这能直接启发历史实施 Stage 4 适配器和 userscript 升级为 Chrome 扩展时的职责划分。

但当前代码不能当作可靠同步核心：纯扩展在一次内存任务中滚动完才入库，没有 run/checkpoint、恢复游标、扫描完整性证明、删除/取消收藏对账或冲突策略；后台还保留一个未接 UI 的取消收藏消息处理器，它缺少备份、冻结的确认清单和操作日志。其 inner-scroll 停止位置计算错误，也可能过早结束扫描。README 宣称扩展可浏览器下载导出、可在“移除复查”逐条取消收藏，但源码没有对应 UI 或下载实现。旧服务器版则存在文档与代码边界漂移：安全文档禁止隐藏浏览器自动化并称取消收藏仍不在范围内，实际代码已经支持 headless 定时抓取和 headless 取消收藏，并使用 `--disable-blink-features=AutomationControlled`。独立复审还确认，无鉴权 login/check 路由可导航任意 URL 并回传诊断信息；浏览器锁不覆盖页面导航和操作，多个任务复用同一 page 时可能串页，平台写存在条件性错帖风险。

所以推荐：参考架构形状、人工状态机、受限域名 content script、query-bearing 打开链接与 canonical source URL 分离；重新设计稳定 ID、逐页/逐批 checkpoint、扫描完成证明、逐来源关系、内容版本与资产表、删除语义、写操作审批和恢复日志。不要移植它的 FNV-1a 32 位回退 ID、全量内存导入、固定滚动次数、原样保存会话型 query 参数、隐藏取消收藏路径、无鉴权本地控制 API或 stealth 启动参数。

## 1. 来源、版本与审查边界

- 官方仓库：<https://github.com/ValerieTse/RedCaChe>
- 固定 revision：`b3526e66ed1d5b78e35a390edf1b7f29e1399ee9`
- tree：`709de5bf7d62d845ed60268ac1225ceb6468f12b`
- 提交时间：`2026-07-10T15:12:11-07:00`
- 提交主题：`Add pure Chrome extension (no server): capture + IndexedDB + classifier + dashboard`
- 获取方式：官方 Git 仓库，detached HEAD；没有初始化 submodule 或 Git LFS。
- 审查方式：只读取 `git ls-files` 返回的 tracked 文件；没有安装依赖、构建、运行程序或测试，没有启动浏览器、访问小红书/RedNote、读取账号数据或执行第三方脚本。
- 证据范围：README、LICENSE、manifest、扩展源码、旧后端/前端相关源码、测试和 GitHub Actions。未使用 Star 评价质量，未把真实浏览器或“更像真人”的说法当作可靠性/反风控证据。

所有 GitHub 源码链接均固定到上述 commit。本文把 README/设计文档称为“声明”，把实现称为“源码证据”，把由两者推导出的影响明确标为“判断”。没有引用 Issue 用户报告。

## 2. 两套实现必须分开理解

### 2.1 旧服务器版

根 README 描述 Python/FastAPI + Playwright + SQLite + React 的本地服务：收藏导入、本地分类和 review、Markdown/Obsidian 导出以及明确确认后的取消收藏（`source/README.md:15-32, 150-168`；[固定源码](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/README.md#L15-L32)）。后端默认 SQLite、可配置 Obsidian 输出和备份目录、按站点分开的 Playwright profile（`source/backend/app/config.py:59-89, 122-146`；[固定源码](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/backend/app/config.py#L59-L89)）。

### 2.2 最新纯扩展版

最新提交新增 MV3 扩展，README 声明采集、IndexedDB、分类和资料库 UI 都在扩展内，不需要本地服务器，也不索取密码（`source/extension/README.md:1-5`；[固定源码](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/extension/README.md#L1-L5)）。其实际组件是：

- popup：站点模式、登录检查、收藏页 URL、导入和标题补全；
- background service worker：开/关标签页、导航、抓取编排、IndexedDB 入库；
- content script：从登录态站点 DOM 读卡片和标题，并包含取消收藏按钮点击逻辑；
- dashboard：分类筛选和人工 review 状态；
- IndexedDB：帖子、配置和一个目前未接线的 `windows` store。

扩展 README 明确说服务器版与扩展版数据不互通（`source/extension/README.md:47-49`；[固定源码](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/extension/README.md#L47-L49)）。因此，不能用服务器版的 ImportRun、备份或 Obsidian 能力来弥补扩展版的缺口。

## 3. 收藏发现与详情获取

### 3.1 获取的是 saved/favorites，不是通用“点赞 + 收藏”同步

两版自动检测都构造个人页 `?tab=fav`；RedNote 额外加 `subTab=note`（扩展 `source/extension/content-script.js:171-188`；[固定源码](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/extension/content-script.js#L171-L188)，服务器 `source/backend/app/crawler/importer.py:118-195`；[固定源码](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/backend/app/crawler/importer.py#L118-L195)）。源码没有独立的“点赞关系”类型或点赞列表发现流程。测试里的 `?tab=likes` 只是对调用方传入 URL 的桩值，不证明产品会同时同步点赞。

这给 Rednote Sync 的直接提醒是：`saved`、`liked`、收藏夹/board 归属必须成为显式 source relation，不能用一个 `xhs_favorite_status` 或 `import_source` 替代关系模型。

### 3.2 扩展的列表抓取

content script 扫描所有 `a[href]`，按官方域名和路径 hint 过滤，再从最近 card 容器抽取 URL、标题、作者、可见文字和一个缩略图 URL；它没有读取网络响应、HAR、内部 API、图片列表、视频或 Live Photo（`source/extension/content-script.js:21-82`；[固定源码](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/extension/content-script.js#L21-L82)）。manifest 也没有 `webRequest`、`debugger` 或 `cookies` 权限（`source/extension/manifest.json:1-18`；[固定源码](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/extension/manifest.json#L1-L18)）。

导入时 background 打开收藏页并发一条 `scrapeFavorites(maxScrolls: 100)` 消息，等待 content script 把全部 payload 一次返回，然后才调用 ingest（`source/extension/background.js:61-77`；[固定源码](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/extension/background.js#L61-L77)）。content script 在内存 Map 中累计记录，每次等待 1 秒，最多滚动 100 次，位置连续 6 次不变便停止（`source/extension/content-script.js:103-120`；[固定源码](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/extension/content-script.js#L103-L120)）。

**实现缺陷：inner-scroll 可能被误判为停止。** `scrollOnce()` 会选择滚动范围最大的内层元素，但返回值始终是 `window.scrollY`/document scrollTop，而不是被实际滚动元素的 scrollTop；如果收藏网格在内层容器，返回位置可连续不变，6 次后提前结束（`source/extension/content-script.js:84-101`；[固定源码](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/extension/content-script.js#L84-L101)）。旧服务器实现返回 target、before、after、targetHeight，并把“位置不变且本轮没有新增”组合成 idle 条件，概念更完整（`source/backend/app/crawler/importer.py:1266-1337`；[固定源码](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/backend/app/crawler/importer.py#L1266-L1337)）。

不过即使服务器版修正了这个局部 bug，两版仍只有“固定上限 + idle”启发式，没有服务端 cursor、已知总量、明确 end marker 或扫描完成证明。对大收藏量，它只能说明“本轮没再看到新卡片”，不能证明“全量已经同步”。

### 3.3 详情补全是逐帖串行打开

扩展只给缺标题记录做 backfill，默认最多 500 篇；它复用一个隐藏标签页，逐篇导航、等待页面、提取标题，失败只计数，没有 durable progress（`source/extension/background.js:97-127`；[固定源码](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/extension/background.js#L97-L127)）。popup 也明确提示“逐篇打开原帖，较慢”（`source/extension/popup.js:87-97`；[固定源码](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/extension/popup.js#L87-L97)）。所以总量大时，等待时间近似 `O(N × 页面加载/稳定等待)`；当前每篇至少包含导航、最长 20 秒 load wait 和固定 1.2 秒 settle。

服务器版有一个更丰富但未接入公开 router 的 `enrich_posts()`：仍逐帖打开页面，只抽标题、作者、正文候选、hashtags 和图片 alt 文本（`source/backend/app/crawler/importer.py:299-408, 1513-1665`；[编排](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/backend/app/crawler/importer.py#L299-L408)，[详情抽取](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/backend/app/crawler/importer.py#L1513-L1665)）。公开 crawler router 没有 enrich 端点（`source/backend/app/routers/crawler.py:29-127`；[固定源码](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/backend/app/routers/crawler.py#L29-L127)），所以应标为内部/未接线能力。

## 4. 稳定 ID、幂等、checkpoint、冲突与删除语义

### 4.1 可以借鉴的部分

扩展把不带 query 的 canonical `source_url` 与可含 query 的 `open_url` 分开；从常见路径提取 note ID，同一页内同时按 `note_id` 和 canonical URL 去重，并优先保留带 query 的可打开 URL（`source/extension/src/lib/extraction.js:5-43, 88-168`；[固定源码](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/extension/src/lib/extraction.js#L5-L43)）。`posts.note_id` 在 IndexedDB 是 unique index（`source/extension/src/lib/db.js:5-25`；[固定源码](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/extension/src/lib/db.js#L5-L25)）。重复导入会刷新 `last_seen_at`，并在出现带 query 版本时刷新 `open_url`（`source/extension/src/lib/ingest.js:21-43`；[固定源码](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/extension/src/lib/ingest.js#L21-L43)）。

“稳定实体 URL”和“短期可打开 URL”分列是有用的设计，但 Rednote Sync 还应把观测到的 URL 变体和敏感/短期 query 分开治理，不能默认长期保留 token。

### 4.2 ID 回退不够稳健

若 URL 中提取不到 ID，扩展用 FNV-1a 32 位值生成 `url_XXXXXXXX`（`source/extension/src/lib/extraction.js:45-54`；[固定源码](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/extension/src/lib/extraction.js#L45-L54)）。这是有限 32 位空间，可能碰撞；一旦命中 unique index，当前 ingest 只把异常吞成 `failed_count`，不保留失败原因（`source/extension/src/lib/ingest.js:80-92`；[固定源码](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/extension/src/lib/ingest.js#L80-L92)）。建议只接受平台稳定 ID；必要回退时使用带 namespace 的规范化 URL 加强哈希，并保存 identity provenance 与 collision handling。

### 4.3 没有真正 checkpoint 或可恢复任务

扩展 IndexedDB 只有 `posts/config/windows`；`windows` 只有读写函数且全仓没有调用，未形成 import run、page cursor、batch offset、scan boundary 或 action journal（`source/extension/src/lib/db.js:5-25, 103-112`；[固定源码](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/extension/src/lib/db.js#L5-L25)）。采集完成前不写入；采集完成后才逐条 `putPost`。如果 service worker、标签页或消息通道中断，抓取阶段全部重做；入库中断后只有已写条目残留，没有说明本次扫描是否完整。

Chrome 官方文档说明 MV3 service worker 会在空闲约 30 秒或单个请求超过 5 分钟等条件下终止，并要求任务对意外终止有恢复能力、把状态持久化，而不是只依赖全局/内存状态（[Chrome：service worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)）。500 篇串行 backfill 或取消收藏尤其可能跨越该边界。

旧服务器有 `ImportRun` 的 started/finished/status/count/reason 字段（`source/backend/app/models.py:135-149`；[固定源码](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/backend/app/models.py#L135-L149)），但它也把所有卡片收集到内存后才保存；进程若在保存前中止，run 可永久留在 `running`，也没有 resume cursor（`source/backend/app/crawler/importer.py:556-652`；[固定源码](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/backend/app/crawler/importer.py#L556-L652)）。

### 4.4 初次导入与并发存在状态风险

扩展以“当前不存在非 mock post”判断 initial import，再逐条独立写入（`source/extension/src/lib/ingest.js:21-24, 45-80`；[固定源码](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/extension/src/lib/ingest.js#L21-L24)）。若第一次导入只写入一部分后中断，重试会把剩余条目当作 later import，改变 Daily Review 归属。`updatePost()` 也是先只读事务取值、再另开写事务覆盖；dashboard 和 import 并发时可能发生 lost update（`source/extension/src/lib/db.js:69-75`；[固定源码](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/extension/src/lib/db.js#L69-L75)）。

### 4.5 没有冲突和删除/取消收藏对账

重复条目只刷新 open URL、last_seen 和部分 review 状态，不刷新标题、作者、缩略图、可见文本或 raw payload；没有内容版本、ETag/hash、field provenance 或 merge policy（`source/extension/src/lib/ingest.js:31-43`）。扫描中缺失的旧条目不会变成 tombstone，也不会被标为“平台端已取消收藏”；`last_seen_at` 只记录正向出现。没有“仅当本次 scan 被证明完整时，才对缺失关系作删除判断”的门。

Rednote Sync 应采用 `sync_run + page/batch checkpoint + observation + source_relation + entity_version + asset_state`，并把“未观测到”与“确认删除/取消收藏”分开。

## 5. 媒体、知识库与 Obsidian

纯扩展只保存卡片缩略图的远程 URL；没有图片列表、视频、Live Photo 双资产、媒体下载、内容长度/hash、临时文件落盘或逐资产状态。服务器详情抽取也只读取正文和图片 alt，不下载媒体。因此该项目不适合作为 Rednote Sync 资产模型或可靠下载器的参考。

扩展 dashboard 的本地资料库支持 `unreviewed/keep/remove_from_xhs/evergreen/archived` 五种人工状态和分类筛选（`source/extension/dashboard.js:4-16, 69-133`；[固定源码](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/extension/dashboard.js#L4-L16)）。这套“平台关系状态”和“用户整理决策”分离不彻底，但人工 review 视图本身值得参考。

旧服务器 Obsidian exporter 把 title/category/source、可选 summary/key points/my notes 写为每日或 evergreen Markdown（`source/backend/app/services/obsidian_exporter.py:12-85`；[固定源码](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/backend/app/services/obsidian_exporter.py#L12-L85)），API 会写入配置的本地目录（`source/backend/app/routers/export_obsidian.py:12-50`；[固定源码](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/backend/app/routers/export_obsidian.py#L12-L50)）。这适合作为 projection/exporter 概念参考，不适合作为同步源或主数据库。

扩展 README 称“导出改为浏览器下载”，但扩展 JS/HTML 没有 Blob、下载或导出调用，dashboard 也只有导入按钮（`source/extension/dashboard.html:47-59`；[固定源码](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/extension/dashboard.html#L47-L59)）。Manifest 没有 `downloads` 权限只是当前权限清点；Blob/锚点下载并不必然需要该权限，不能单凭权限缺失判断功能不存在。这里的声明—实现不一致以“仓库未见任何导出 UI/调用”为依据。

## 6. 会话、secret、浏览器和网络权限

### 6.1 纯扩展权限边界

manifest 请求 `tabs`、`storage`、`unlimitedStorage`，host/content-script 范围仅为 `*.xiaohongshu.com` 与 `*.rednote.com`（`source/extension/manifest.json:1-18`）。没有 `<all_urls>`、cookies、webRequest、debugger、nativeMessaging、file scheme 或 externally_connectable。

这是一个相对清晰的起点，但仍可收紧：Chrome 官方权限表说明 `tabs` 可读 privileged Tab 字段并会显示“读取浏览历史”警告，且通常调用 tabs API本身不需要声明该权限；`unlimitedStorage` 会为 IndexedDB 等提供无限配额（[Chrome：permissions list](https://developer.chrome.com/docs/extensions/reference/permissions-list)）。Rednote Sync 插件应验证是否能删除 `tabs` 权限，并评估是否真的需要无限存储，而不是把媒体长期塞进扩展 origin。

content script 使用现有网页登录态，不读取 cookie API，也不存密码；但它保存完整 `open_url` 和 `observed_url_variants`，并优先保留/使用含 `xsec_token` 的 URL（`source/extension/src/lib/extraction.js:102-124, 136-145`；`source/extension/dashboard.js:30-34`）。这些 query 可能是短期会话型或访问上下文参数。建议默认从长期记录中剥离、加敏感字段分类与 TTL，需要打开时再从当前页面重新发现。

background 的消息 handler 不检查 sender，只按 `msg.type` 调度，包括平台写操作 `unfavorite`（`source/extension/background.js:171-185`）。普通网页因 manifest 没有 externally_connectable 不能直接调用该 listener；这里应记录为纵深防御缺口，而不是已证明的网页直达漏洞。Chrome 官方安全指南仍要求把 content script 数据视为低信任、校验输入，并缩小可由消息触发的 privileged action（[Chrome：messaging security considerations](https://developer.chrome.com/docs/extensions/develop/concepts/messaging#security-considerations)）。

### 6.2 旧服务器会话与本地控制面

Playwright 服务器使用持久 profile，包含 cookie/localStorage 等浏览器状态；debug API返回 profile 绝对路径、大小和常见 cookie/storage 文件是否存在（`source/backend/app/crawler/browser.py:139-174`；[固定源码](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/backend/app/crawler/browser.py#L139-L174)）。登录检查还会返回页面可见文本前 1000 字、cookie 数、本地存储键数和截图路径（`source/backend/app/crawler/importer.py:861-904`；[固定源码](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/backend/app/crawler/importer.py#L861-L904)）。调试页可保存 HTML、文本和截图。这些虽是本地文件，仍可能包含账号/个人内容，应由显式诊断模式、最短保留期和访问控制保护。

FastAPI router 没有应用层鉴权；它可以读写帖子、写配置目录、启动浏览器、生成 debug artifact、导出文件并触发平台取消收藏（`source/backend/app/main.py:42-62`；[固定源码](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/backend/app/main.py#L42-L62)）。默认前端连接 `127.0.0.1:8000`，README 的 uvicorn 命令也没有显式公网 bind，因此不能说它默认公网暴露；但安全依赖“保持 loopback 且无本机恶意调用方”，应显式 bind loopback、使用启动期随机 bearer/CSRF 防护，并把写平台端点拆成另一个审批面。

`/crawler/open-login` 与 `/crawler/check-login` 还接受调用方提供的任意 URL，Schema 没有限定协议或官方域名，service 随后直接交给 `page.goto()`；check-login 可回传页面标题、正文样本和截图路径（`source/backend/app/routers/crawler.py:54-76`、`source/backend/app/schemas.py:106-107,145-146`；[router](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/backend/app/routers/crawler.py#L54-L76)，[open-login schema](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/backend/app/schemas.py#L106-L107)，[check-login schema](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/backend/app/schemas.py#L145-L146)，[navigation](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/backend/app/crawler/importer.py#L53-L66)，[diagnostic result](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/backend/app/crawler/importer.py#L861-L904)）。在无鉴权本地控制面被不可信调用方触及时，这是 browser-SSRF/任意导航与响应信息外带面；`file:` 等本地读取是否可达取决于 Playwright/浏览器策略，本轮未动态验证。未来 adapter 应只接受预定义动作而不是任意 URL，强制 HTTPS + 官方 host/path allowlist、逐跳复核最终 URL，并默认不返回正文或截图。

浏览器管理器的锁只覆盖 context 的取得/创建；`open_page()` 在锁外复用 `context.pages[0]` 并导航（`source/backend/app/crawler/browser.py:33-72,109-115`；[context lock](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/backend/app/crawler/browser.py#L33-L72)，[page reuse](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/backend/app/crawler/browser.py#L109-L115)）。定时抓取、手工导入、登录检查、backfill 与 unfavorite 若并发使用同一 context/page，可能互相串页；平台写路径存在条件性的错帖点击风险。Rednote Sync 应实行全局浏览器任务串行、写操作独占，并在每次点击前重新校验 expected note ID、最终 URL 与当前收藏状态。

### 6.3 Agent/本地文件能力

仓库没有 MCP、Agent、native host 或通用本地文件代理。所谓 AI 目前是确定性的本地关键词分类；后端 `MockAIProvider` 不发网络请求，也不做保留/删除决策（`source/backend/app/services/ai_base.py:8-22`、`source/backend/app/services/ai_mock.py:7-30`；[固定源码](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/backend/app/services/ai_mock.py#L7-L30)）。扩展无任意文件访问；旧服务器只能按配置路径写 SQLite、备份、debug artifact 和 Markdown，但路径来自环境配置，能力仍应视为本地文件写入边界。

## 7. 平台写操作、备份与恢复

### 7.1 扩展存在未接 UI 的高风险写路径

extension background 注册 `unfavorite` handler。若 `postIds` 为空，它会选择所有 `review_status=remove_from_xhs` 的记录；然后在隐藏标签页逐篇导航，调用 content script 点击 `.collect-wrapper`，成功后直接标记 archived/unfavorited/restorable（`source/extension/background.js:129-176`；[固定源码](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/extension/background.js#L129-L176)）。content script 会验证 SVG `<use>` 从 `#collected` 变为 `#collect`（`source/extension/content-script.js:136-159`；[固定源码](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/extension/content-script.js#L136-L159)）。

但 popup/dashboard 没有发送 `unfavorite` 消息的按钮；dashboard 的“移除”只改本地 review 状态（`source/extension/dashboard.js:122-133`），README 却说可在“移除复查”逐条取消收藏（`source/extension/README.md:20-22`）。更重要的是，handler 没有本地备份、冻结 exact list、二次确认、逐操作日志、幂等 action key 或恢复动作。`restore_status=restorable` 只是标签，不对应任何 restore handler。这个路径不应进入 Rednote Sync。

### 7.2 服务器版边界比扩展完整，但仍不足

旧服务器 `/remove-check/confirm-unfavorite` 拒绝空列表，要求 `confirm=true`（`source/backend/app/routers/remove_check.py:97-105`；[固定源码](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/backend/app/routers/remove_check.py#L97-L105)）；每篇先写 JSON 备份，再 headless 打开帖子执行取消收藏并记录结果（`source/backend/app/crawler/importer.py:653-798`；[固定源码](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/backend/app/crawler/importer.py#L653-L798)）。但备份只包含数据库已有字段，没有网页快照或媒体（`source/backend/app/services/backup_service.py:10-40`；[固定源码](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/backend/app/services/backup_service.py#L10-L40)），因此“restorable”不能等同于可自动恢复平台收藏。

前端确认弹窗只显示数量，未呈现不可变的 exact-list 摘要或 action digest（`source/frontend/src/pages/RemoveCheck.jsx:102-125`；[固定源码](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/frontend/src/pages/RemoveCheck.jsx#L102-L125)）。通用取消收藏 fallback 只要按钮文字命中便点击，等待 1.2 秒后直接报告成功，没有复核状态；只有 RedNote 专用 `.collect-wrapper` fallback 做了状态反转验证（`source/backend/app/crawler/importer.py:1122-1201`；[固定源码](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/backend/app/crawler/importer.py#L1122-L1201)）。

### 7.3 设计文档与实现漂移

安全文档说不允许 hidden browser automation、V2 不能点击取消收藏，产品规格也说 unfavorite automation 仍 out of scope（`source/docs/SAFETY_AND_COMPLIANCE.md:3-18`；[固定源码](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/docs/SAFETY_AND_COMPLIANCE.md#L3-L18)，`source/docs/PRODUCT_SPEC.md:42-48`；[固定源码](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/docs/PRODUCT_SPEC.md#L42-L48)）。实际 daily fetch 以 `headless=True` 运行，取消收藏也 headless；浏览器参数还包含 `--disable-blink-features=AutomationControlled`（`source/backend/app/services/daily_fetch.py:35-68`；[固定源码](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/backend/app/services/daily_fetch.py#L35-L68)，`source/backend/app/crawler/browser.py:74-107`；[固定源码](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/backend/app/crawler/browser.py#L74-L107)）。Rednote Sync 不应采用 stealth/隐藏自动化参数；规格、权限 manifest 与可执行写操作必须由同一 CI policy 校验。

## 8. 依赖、测试、CI、维护与许可

### 8.1 依赖与供应链

- 纯扩展没有第三方运行时依赖或构建步骤，这是降低供应链面的优点。
- 旧 Python 后端只给依赖下限，没有 lockfile；`setuptools>=68`、FastAPI、uvicorn、SQLAlchemy、Pydantic、Playwright 等会随安装时间漂移（`source/backend/pyproject.toml:1-22`；[固定源码](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/backend/pyproject.toml#L1-L22)）。
- React/Vite 前端有 `package-lock.json`，但 CI 执行 `npm install` 而非 `npm ci`（`source/.github/workflows/ci.yml:23-38`；[固定源码](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/.github/workflows/ci.yml#L23-L38)）。
- GitHub Actions 使用浮动 major tag `actions/checkout@v4`、`setup-python@v5`、`setup-node@v4`，未固定 commit SHA；没有 SBOM、依赖审计、provenance 或发布签名门。

### 8.2 测试覆盖

扩展测试只有 53 行纯逻辑测试，覆盖分类、URL 解析、canonicalization 和页内去重；没有 content script 滚动、manifest 权限、IndexedDB 事务、service worker 中断恢复、长任务、消息 sender、取消收藏审批、导出或 UI 测试（`source/extension/tests/lib.test.mjs:1-53`；[固定源码](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/extension/tests/lib.test.mjs#L1-L53)）。CI 只跑 backend pytest 与 frontend link test/build，完全没运行这份扩展测试（`source/.github/workflows/ci.yml:8-38`）。README 声称入库管线和 UI 已在真实浏览器验证，但同时承认真实站点采集仍需用户实测；没有可复现的一手测试产物支持可靠性结论（`source/extension/README.md:39-45`）。

旧服务器对 schema、URL/token 刷新、备份、explicit confirmation、RedNote 收藏按钮状态反转和定时计算有单元测试（例如 `source/backend/tests/test_import_open_url_refresh.py:58-122`、`source/backend/tests/test_remove_check.py:37-94`、`source/backend/tests/test_unfavorite_collect.py:50-85`）。这些测试能证明局部函数意图，不能证明真实站点兼容、全量扫描完成、并发恢复或端到端安全。

### 8.3 许可

仓库根 LICENSE 是标准 MIT，版权为 `2026 RedCache contributors`，允许使用、修改和再分发，但复制或 substantial portions 必须保留版权与许可声明（`source/LICENSE:1-20`；[固定源码](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/LICENSE#L1-L20)）。未发现仓库内 NOTICE 或相冲突的附加条款。直接复用仍需逐文件/依赖核查与 attribution；当前建议以行为和设计借鉴为主，不复制实现。

## 9. 对 Rednote Sync 的具体参考价值

### 9.1 可直接参考的行为与边界

1. **浏览器会话归浏览器，离线核心不持有账号凭据。** 历史实施 Stage 4 插件只输出经过校验的 observation/event；历史实施 Stage 3 Core 继续完全离线。
2. **content/background/UI/DB 四层分离。** content script 只负责页面局部读取；service worker 编排；dashboard 只改用户决策；核心数据库负责长期事实。
3. **稳定 source URL 与可打开 URL 分离。** 但短期 query/token 必须单独分类、TTL 化或不持久化。
4. **人工 review 状态与平台写操作分离。** “标记待移除”不是“立即取消收藏”；真正写平台必须冻结 exact list、显示 diff、二次授权并生成审计记录。
5. **只给两个官方域名 host 权限。** 未来插件继续按 adapter/domain 最小化，避免 `<all_urls>`、cookies、webRequest、debugger 等非必要权限。
6. **初始资料库与后续增量 review 分视图。** 这个产品概念可以保留，但要用成功完成的 baseline run 标记，而非“数据库当前为空”。

### 9.2 仅设计借鉴、必须重写

- 发现循环应每页/每批持久化：`run_id, source_relation, page_seq/cursor, observed_ids, boundary evidence, pending detail queue`。
- 完整扫描必须有证据等级：平台 cursor/end marker > 已知 total 对齐 > 多信号 idle；固定滚动次数只能标 `partial`。
- 逐帖详情任务应有 durable queue、限速、暂停/人工恢复、attempt 状态和断点；不能把 500 篇循环绑在单个 service-worker message 上。
- 实体 ID 使用平台 ID；回退 ID需 namespace + 强哈希 + provenance，并处理碰撞。
- 每次观测产生 source relation，不把 `import_source` 当“收藏关系”。只有 complete scan 才允许把缺失关系推进为 suspected_removed，再经确认成为 removed/tombstone。
- 内容和用户字段分别版本化，避免重新导入覆盖人工分类/笔记，避免并发 lost update。
- 媒体需独立 `Asset`/`AssetAttempt`：图片、视频和 Live Photo 成对资产，逐资产状态、临时文件、长度/hash、原子提交。
- 写操作使用 action intent → frozen preview/digest → approval → per-item execution → verification → audit/compensation；空 ID 不允许代表 all。
- Obsidian/Markdown 是可重建 projection，不是 source of truth；输出要做 YAML/Markdown escaping、稳定文件名、原子替换和删除策略。

### 9.3 对现有 userscript 与未来 Chrome 插件的启发

现有 userscript 若只做页面内滚动/采集，可先借鉴 RedCaChe 的 URL/domain 校验、card observation 结构和“导入到本地资料库”的用户流程。但 userscript 不应复制它的一次性全量 Map：应把每批 observation 通过明确协议交给核心，并让核心 ack 后再推进 checkpoint。

升级为 Chrome 扩展时，推荐：

- content script 只做 DOM 观察和页面内滚动，不直接写平台；
- service worker 只编排短步骤，状态全进 durable job store；
- 用长连接/批量 ack 或 alarms/offscreen 需另做规格，不假设单次 `sendMessage` 永不终止；
- popup 只展示摘要，长任务在可重开的 dashboard/side panel 展示进度；
- 平台写操作放到独立、默认禁用、显式授权的 capability，必要时要求当前可见 active tab；
- manifest 生成和 CI 静态检查禁止意外增加 host/API 权限；
- 不在扩展 IndexedDB 保存媒体主副本或长期 secret；离线 Core 保存规范化实体与资产。

### 9.4 不应采用的部分

- `--disable-blink-features=AutomationControlled` 或任何以隐藏自动化为目的的参数；
- “像真人/当前登录会话”作为可靠性或低风险证明；
- 固定 100 次滚动和 6 次 idle 作为全量完成门；
- FNV-1a 32 位 fallback ID；
- 把所有 payload 收齐后才首次落盘；
- 无原因的 catch-and-count；
- 原样长期保留 `xsec_token` URL；
- 无 checkpoint 的逐帖隐藏标签页循环；
- 未接 UI 但可被消息触发的 destructive handler；
- 只写数据库 JSON却宣称“restorable”；
- 无鉴权本地 API直接触发浏览器、文件和平台写；
- 将 README 中未实现的导出/取消收藏能力计入选型。

## 10. 主要发现清单

| ID | 级别 | 发现 | 对 Rednote Sync 的处理 |
|---|---|---|---|
| RC-01 | 高 | 扩展导入、backfill、unfavorite 都没有 durable run/checkpoint；长任务可能随 MV3 worker 终止 | 历史实施 Stage 4 必须持久化 job/batch/attempt，重启可恢复 |
| RC-02 | 高 | inner scroll 实际滚动内层元素却返回 window 位置，可能 6 次后提前结束 | 滚动 adapter 返回真实 target position + card-growth + completeness evidence |
| RC-03 | 高 | 扩展 latent `unfavorite`：空 IDs 表示全部待移除，无备份/冻结清单/确认/日志/恢复 | 不复用；写能力默认不存在，另行规格和审批 |
| RC-04 | 高 | 扩展 README 的浏览器下载/移除复查操作未在 UI/下载源码实现 | 报告以源码为准，规格—manifest—测试三方一致性纳入 CI |
| RC-05 | 高 | 服务器安全文档禁止 hidden automation/称 unfavorite out of scope，源码已有 headless schedule/unfavorite 和 stealth 参数 | 不采用；历史实施 Stage 4 权限矩阵必须生成式校验 |
| RC-06 | 中 | 只有 saved/fav，没有 liked/board/source relation，也没有 complete-scan 删除语义 | 建模 `source_relation` 与 tombstone 状态机 |
| RC-07 | 中 | FNV-1a 32 位 fallback、失败仅计数；重复记录只刷新少数字段 | 平台 ID优先、强哈希/碰撞处理、逐条错误证据 |
| RC-08 | 中 | query-bearing open URL/variants 长期入库并优先使用 | token/query 分类、最小持久化、TTL/重新发现 |
| RC-09 | 中 | 服务器 debug API/文件会保留可见文本、截图、HTML、profile 元数据 | 诊断模式显式授权、redaction、短保留期 |
| RC-10 | 中 | 扩展测试不进 CI；CI Actions 未固定 SHA，Python 无完整 lock | 添加扩展静态/单元/恢复测试、锁依赖、固定 Actions |
| RC-11 | 中 | 纯扩展无媒体资产模型，旧 exporter 只是文本 projection | 资产管线和 projection 独立设计 |
| RC-12 | 低 | MIT 许可清晰 | 设计借鉴无障碍；代码复制仍保留声明并核查依赖 |
| RC-13 | 高 | 无鉴权 login/check 路由可导航任意 URL，诊断结果还可回传正文样本/截图路径 | 生产 adapter 不接受任意 URL；固定 HTTPS host/path allowlist，重定向后复核且诊断默认最小化 |
| RC-14 | 高 | context 锁不覆盖 page 导航/操作，多个浏览器任务复用首个 page，存在串页和条件性错帖写风险 | 全局任务串行、平台写独占，动作前复核 expected note ID、final URL 与 desired state |

## 11. 未知项与需要未来动态验证的内容

以下不能由本次严格静态审查证明：

- 2026 年站点真实 DOM 是否匹配这些 selector、个人页 fav URL 是否在所有账号/地区成立；
- 真实收藏总量大时的加载速度、虚拟列表行为、限速/挑战触发情况；
- `xsec_token` 的实际敏感等级、生命周期和脱敏要求；
- Chrome 在不同版本对长 message/backfill 的具体终止表现；
- 扩展卸载、浏览器数据清理、浏览器 profile 损坏时的实际恢复体验；
- 仓库维护者所称“真实浏览器中通过”的测试环境和证据；
- 平台服务条款对具体使用模式的最新要求。

这些未知项不应通过直接访问真实账号补齐，除非历史实施 Stage 4 有单独规格、授权、测试账号、数据最小化和验收门。

## 12. 独立复审结果

独立 reviewer 最终确认主体结论、研究 A-/采用 B 的评级以及 历史实施 Stage 3/历史实施 Stage 4 边界合理。复审提出的两项阻断发现——任意 URL 浏览器导航/诊断外带，以及缺少任务级页面互斥——已在第 6.2 节和 RC-13/RC-14 中闭环；当前未关闭 finding 为 0。

- 所有功能结论都区分纯扩展与旧服务器，未把两者能力拼成一个产品能力集。
- “saved only”由构造的 `tab=fav` 与数据模型证明；没有把测试桩里的 `tab=likes` 扩大为点赞同步。
- “inner-scroll 过早停止”是源码直接可推导的实现缺陷，不是否定扩展架构概念。
- 未把 content script/真实 Chrome/“更像真人”当作反风控或可靠性证明。
- 平台写路径只登记能力、权限和风险，没有转化为 stealth、验证码、签名或规避实现方案。
- 许可结论只覆盖仓库 MIT；第三方依赖仍需各自核查。
- 本文没有包含账号数据、cookie、HAR、token 值、个人 profile 或真实平台请求记录。
