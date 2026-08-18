# xiaohongshu-importer 专项源码审查

> 状态：**研究证据**。本文只对记录的固定 revision 和审查范围负责；评级、排除项、历史实施阶段边界和账号限制不自动成为当前产品决策。

状态：专项静态审查完成；独立复审通过
审查日期：2026-08-13
固定 revision：[`b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37`](https://github.com/bnchiang96/xiaohongshu-importer/tree/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37)

> 本报告只描述固定 revision 的 tracked 静态证据，不证明发布 ZIP、Obsidian Community Plugins 制品、当前平台兼容性、运行可靠性或账号安全。未安装依赖，未执行项目、构建、测试、Obsidian、浏览器或平台请求，也未读取用户 Cookie、token、vault、profile、日志或个人数据。

## 1. 项目定位、版本和审查范围

- 来源、revision、tree 与静态清点见 [`provenance.json`](provenance.json)，中断恢复状态见 [`checkpoint.json`](checkpoint.json)。
- 只通过 `git ls-files` 审查 16 个 tracked 文件；范围是 TypeScript 插件实现、README、manifest/package/lock、构建配置、版本脚本和 MIT 许可证。
- 仓库定位是一次导入一篇公开分享链接的 Obsidian 插件；它不是列表发现器、增量同步器、媒体归档服务或账号会话适配器。[README](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/README.md#L13-L23)
- 本轮不运行插件，也不核验发布 ZIP、Obsidian 市场条目、上游页面结构或媒体 URL；README、源码/配置、静态推断和未知项分开记录。

## 2. 结论摘要

### 核心结论：

- **最终建议维持 B：仅作为 Obsidian 知识库输出、分类交互和“远端嵌入/本地媒体”策略的设计参考；现成采集、解析、下载、状态和生产同步接入均为 D。** 它是单篇、人工触发的 UI importer，不是列表发现器、增量同步器或可靠媒体归档器。[入口与主流程](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/main.ts#L20-L55) [主流程](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/main.ts#L120-L248)
- 最值得 clean-room 借鉴的是：导入时显式选择分类和媒体策略、集中媒体目录，以及导入完成后打开笔记的交互；候选源码本身没有独立 writer，而是把获取、解析、下载和 vault 写入耦合在同一个主流程。Rednote 应只借鉴 Obsidian 输出 UX，再重构为只消费安全 canonical Note/Media manifest 的独立 writer/projector。[耦合主流程](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/main.ts#L120-L248)
- `window.__INITIAL_STATE__` 被四个解析函数用正则分别抽取并重复解析；代码会全局把 `undefined` 字符串替换为 `null`，再取 `noteDetailMap` 的第一个 key，既不确认请求 note ID，也没有版本化 schema。解析异常分别降级为空图片、空视频、非视频或占位正文，主流程仍可能创建笔记并显示导入成功。[图片](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/main.ts#L257-L275) [视频](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/main.ts#L277-L303) [正文与类型](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/main.ts#L305-L351)
- 输出字段不足以定义 canonical Note：没有稳定 note ID、作者、发布时间、版本或媒体元数据；`date` 是导入 UTC 日期而非发布时间，`Imported At` 又依赖本地 locale。标题、来源 URL 与分类未经 YAML serializer 直接进入 frontmatter，正文、图片 URL 和视频 URL 也未经面向目标格式的结构化转义直接进入 Markdown/HTML。[输出拼接](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/main.ts#L133-L159) [媒体和正文](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/main.ts#L169-L233)
- 媒体模型只保留图片 `urlDefault` 或第一条 H.264/H.265 `masterUrl`；没有 Live Photo 配对、稳定 slot、MIME、长度或 hash。下载把整个 blob 载入内存后直接写最终 `.jpg/.mp4`，没有字节预算、类型/magic、完整性、临时文件、原子提交或续传。[媒体解析](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/main.ts#L257-L303) [下载](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/main.ts#L103-L118)
- 没有 stable ID、幂等、checkpoint、逐资产状态或事务边界。媒体先写、Markdown 后写；单资产失败会退回远端 URL并继续，笔记创建失败会留下孤儿媒体，设置保存失败又可能把已经创建的笔记报告为整体失败。重跑采用新的 `Date.now()` 媒体名，却仍尝试创建同名 Markdown。[落盘顺序](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/main.ts#L161-L248)
- 网络和路径边界不能直接采用：短链只接受明文 HTTP，重定向目标没有二次验证；页面提取的媒体 URL直接进入 `fetch`，缺少精确 HTTPS host/port、每跳重验和私网边界。`defaultFolder` 与 category 只做 `trim()` 就参与 vault 路径，未见规范化、固定子树或碰撞策略。以上是带运行前提的静态风险，不等于已经观察到 SSRF 或 vault 逃逸。[URL](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/main.ts#L76-L124) [路径](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/main.ts#L145-L167)
- 供应链快照不能称为可复现：`yarn.lock` 的 102 个节点全部带 registry URL 与 integrity，但当前 manifest 的 `@types/node ^18`、`esbuild ^0.17`、`tslib ^2.4`、`typescript ^5` 四个 selector 均不在 lock；只有 `obsidian@latest` 对应。仓库没有 tracked 测试或 CI，package/manifest/README 是 1.1.3，但构建 banner 仍是 1.1.2，`versions.json` 也没有 1.1.2/1.1.3。[package](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/package.json#L1-L23) [banner](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/esbuild.config.mjs#L5-L10) [versions](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/versions.json#L1-L3)
- 根 LICENSE 与 package 均为 MIT，但第三方依赖许可证清单、编译后的 `main.js`、release ZIP、checksum/SBOM/provenance 和 Obsidian 市场制品都不在固定快照内。直接复制 substantial portions 需保留 MIT copyright/permission notice；工程上仍优先独立实现窄化 exporter。[LICENSE](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/LICENSE#L1-L21)
- 历史实施 Stage 3 继续完全离线，本插件的 `requestUrl`、`fetch` 和 vault 写入不能进入 Core。未来更合理的落点是独立 Obsidian projector/exporter：只消费已经校验、内容寻址并具逐资产 receipt 的 canonical 数据；在线 Provider 与知识库写入不得耦合在同一函数。

## 3. 架构与数据流

```text
Obsidian 用户分享文本
  → 固定 XHS URL 正则
  → Obsidian requestUrl 获取 HTML
  → title / DOM desc / window.__INITIAL_STATE__ 正则与 JSON.parse
  → title、content、tag、image URL、video URL
  → 可选 fetch 媒体并直接写入 vault
  → 拼接 YAML frontmatter + Markdown/HTML
  → vault.create 单篇笔记并打开
```

- 插件只注册 ribbon 与 command，两条入口均打开同一个 modal，然后调用 `importXHSNote`。[入口](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/main.ts#L17-L73)
- 分享文本先由固定正则提取移动短链或网页 note URL；`explore` 被字符串替换为 `discovery/item`。[URL 提取](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/main.ts#L76-L92)
- 主流程一次获取 HTML，分别调用五个解析函数，再创建目录、可选下载媒体、拼接 Markdown，最后用 `vault.create` 写入并打开文件。[主流程](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/main.ts#L120-L248)

## 4. 发现、详情与媒体能力

### 4.1 URL 输入与详情获取

- URL 正则只接受 `http://xhslink.com/...` 与 `https://www.xiaohongshu.com/discovery/item|explore/...`；移动短链不接受 HTTPS，且 `a?o?` 的路径表达比注释更宽。`explore` 只做字符串替换，没有保留“原始 URL/规范 URL/最终重定向 URL”三者的 provenance。[URL 提取](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/main.ts#L76-L92)
- 页面由 Obsidian `requestUrl` 整体读入字符串。固定源码没有列表发现、cursor、account、身份或访问材料 pairing；也没有确认返回页面对应请求的 note ID。[获取](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/main.ts#L120-L131)
- 标题只取第一个 `<title>` 并删除固定后缀；正文先尝试固定属性顺序的 HTML 正则，再退到 state 中 `desc`。HTML 去标签使用 `<[^>]+>`，不是结构化 parser，也不解码实体。[标题与正文](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/main.ts#L251-L255) [正文](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/main.ts#L305-L333)

### 4.2 `__INITIAL_STATE__` 与字段契约

- 四个 parser 都用 `/window\.__INITIAL_STATE__=(.*?)<\/script>/s` 抽取，再全局替换 `undefined` 并 `JSON.parse`；同一 HTML最多重复解析四次。替换也可能改写 JSON 字符串值中的普通文本。[图片](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/main.ts#L257-L275) [视频](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/main.ts#L277-L303) [正文/类型](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/main.ts#L305-L351)
- 深层结构无 runtime schema；`Object.keys(noteDetailMap)[0]` 没有和请求 URL 的 ID 比对。解析失败都被吞并为占位值，不能区分页面不存在、登录/验证墙、schema 漂移或合法空内容。
- 输出没有 author、note ID、publishedAt、updatedAt、统计量、canonical type 或字段级 provenance。它只适合说明历史字段路径，不能充当 Rednote DTO。

### 4.3 图片、视频与 Live Photo

- 图片保留 `imageList` 顺序，但只取每项 `urlDefault`；没有 image ID、尺寸、格式、variant 或 source evidence。[图片](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/main.ts#L257-L275)
- 视频先取第一条 H.264 `masterUrl`，否则取第一条 H.265；没有质量/码率/尺寸/时长/备用 URL 选择或显式 codec 契约。[视频](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/main.ts#L277-L303)
- 没有 Live Photo 识别或同序号 still/motion 配对。图片强制 `.jpg`、视频强制 `.mp4`，不校验真实格式。
- 非视频笔记先把第一张图片作为 cover，之后再次输出包含第一张在内的全部图片，首图会重复。[Markdown 媒体](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/main.ts#L199-L233)

### 4.4 Markdown、frontmatter 与目录

- frontmatter 包含 title、source、导入日期、locale-dependent `Imported At` 和 category；没有 schema version、stable ID、author、原发布时间、content hash 或 media receipt。[frontmatter](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/main.ts#L133-L159)
- 标签从正文以 `/#\S+/` 提取后写入 fenced code block，不会形成规范的 frontmatter tags；清理正文的两个 regex 也可能删除非标签文本。[正文与标签](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/main.ts#L189-L227)
- 笔记名由截断标题生成，没有 note ID 后缀；同分类同标题发生碰撞。媒体名由截断标题、数组 index 与 `Date.now()` 组成，重跑不稳定。[路径与命名](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/main.ts#L145-L159) [媒体命名](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/main.ts#L169-L210)
- Markdown 总是以 `../media/` 引用本地媒体，这只适用于笔记位于媒体目录的一级同级 category；category 含嵌套路径时层级错误。`defaultFolder=""` 又产生字面 `/media`，具体 Obsidian adapter 行为未知。

## 5. 状态、checkpoint、幂等及失败恢复

- 固定源码没有 stable note ID、scope、cursor、水位、幂等键、manifest、checkpoint、run ledger 或逐资产状态。
- 解析失败会降级并继续；单个媒体下载失败返回原始 URL 作为字符串 sentinel，调用方靠 `startsWith("http")` 区分本地/远端。这个返回类型不能表达 `complete/partial/failed`、原因、attempt 或 retry time。[下载返回](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/main.ts#L103-L118)
- 该 sentinel 还有实质歧义：合法标题经媒体文件名清洗后仍可能以 `http` 开头，此时成功下载返回的本地 filename 会被调用者误判为远端 URL，生成错误引用。[命名与判别](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/main.ts#L94-L118) [调用](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/main.ts#L169-L210)
- 媒体逐项直接写最终路径，全部完成后才创建 Markdown；任一步中断都没有回读恢复或清理协议。`vault.create` 的同名冲突也没有 update/no-op/rename策略。[写入顺序](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/main.ts#L161-L248)
- `writeBinary` 前没有 no-clobber/目标存在检查；adapter实际会覆盖、拒绝还是在失败时留下部分文件属于未验证的Obsidian运行时语义。
- 笔记创建后才更新设置；若 `saveSettings` 失败，总 catch 报“导入失败”，但已经写入的笔记不会回滚。这证明 UI outcome、笔记 outcome 和媒体 outcome 需要分开。
- 没有 retry/backoff、timeout、AbortSignal、Range/206、长度/hash、临时文件或 atomic rename。当前行为不能映射成 Core 的 durable progress。

对 Rednote Sync：只借鉴“媒体失败仍可显示远端引用”的产品意图，不借鉴完成语义。Core 继续以 `(kind, ordinal)` MediaSlotState、failure、receipt 与 stable note key为真相；知识库视图只能从 canonical DB/object重建。

## 6. 会话、凭据、网络和文件写入

### 6.1 安全 finding

| ID | 严重性 | 固定证据与前提 | Rednote 边界 |
|---|---|---|---|
| XHI-SEC-01 | 中（条件性） | 明文短链直接交 `requestUrl`；媒体 URL 仅粗略检查后进入 `fetch`。重定向行为和作者对媒体 URL 的控制程度未动态验证，因此只能写成内容篡改/SSRF 条件风险。[URL](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/main.ts#L76-L124) [媒体](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/main.ts#L257-L303) | 历史实施 Stage 4 只接受 HTTPS；解析 scheme/host/port，每跳重验并阻断 loopback/private/link-local；页面与媒体分别窄 allowlist |
| XHI-SEC-02 | 中 | HTML和媒体均整份进内存；媒体只有 `response.ok`，无 timeout、字节预算、Content-Type/magic、长度或 hash。下载由用户主动开启且默认关闭，主要是可用性/完整性风险。[下载](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/main.ts#L103-L131) | 每响应/资产/run预算；流式 `.part`、magic、长度/hash、fsync+rename、逐资产 receipt |
| XHI-SEC-03 | 中（脚本执行未知） | 远端 title/desc/media URL、用户输入后提取的 source URL与本地category直接进入 YAML、Markdown或 raw HTML attribute。可确认格式破坏和内容注入；是否脚本执行取决于 Obsidian sanitizer，未知。[输出](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/main.ts#L133-L232) | serializer生成YAML；文本与URL按目标格式编码；不生成远端可控raw HTML，不自动加载未知远端资源 |
| XHI-SEC-04 | 中（本地/Agent可控设置） | `defaultFolder`/category只trim后参与路径；无normalize、绝对/`..`拒绝或allowed subtree。主要入口是本地设置，能否越出vault依adapter而未知。[设置](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/main.ts#L375-L418) [路径](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/main.ts#L145-L167) | 固定输出根；组件编码、realpath/containment/no-follow、保留目录拒绝与确定性碰撞策略 |
| XHI-SEC-05 | 中 | media/note/settings不是事务；partial媒体会回退URL并最终显示整体成功，后续失败又可能留下孤儿文件或假失败。[主流程](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/main.ts#L161-L248) | 远端获取、canonical提交、知识库projection分层；显式complete/partial/failed与可重建view |
| XHI-SEC-06 | 低中（条件性隐私） | 完整来源/媒体URL进入console、frontmatter和Markdown；没有证据URL必含secret，但query/短链追踪或signed URL可能被vault同步/备份长期保留。默认不下载会保留远端资源，随后立即`openFile`；若当前Obsidian渲染模式加载它们，还会产生额外请求和IP/访问时序泄露，实际加载行为未知。[日志](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/main.ts#L103-L117) [持久化与打开](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/main.ts#L133-L238) | public URL由HostAdapter重建并删query；signed URL只在内存SecretRef；日志字段allowlist；派生视图默认不自动加载远端资源 |
| XHI-SEC-07 | 中（条件性完整性） | 主流程不核expected note ID、响应页面类型或login/challenge/security状态。若受限/错误页仍以200返回，parser会降级为空/占位并继续创建笔记、显示成功。[主流程](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/main.ts#L120-L248) [parser降级](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/main.ts#L257-L351) | login/challenge/429/security/schema mismatch必须类型化fail closed并暂停；核对expected note ID，人工恢复前不得产出成功或canonical partial |

### 6.2 正向事实与边界

- `downloadMedia` 默认关闭；初始 URL正则不是通用任意URL输入。[默认设置](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/main.ts#L10-L15)
- UI分类使用 `createEl({text})`，未见 `innerHTML`；源码无 `eval`、Function、子进程、shell、任意 vault 文件读取或平台写 API。
- 源码没有 Cookie/token/profile、代理、stealth、验证码求解或签名代码，也没有任何账号安全证明。人工单笔入口不等于限速、互斥或风控状态机；未来遇登录、429、challenge或安全限制必须类型化暂停并人工恢复。

## 7. CLI/API/MCP 权限与平台写操作

- 固定源码没有 CLI、API server 或 MCP server，也没有平台发布、点赞、评论、关注或删除命令。
- 插件具网络读取、远端媒体获取、vault 目录/二进制/Markdown 写入、设置持久化和打开文件能力；“只导入公开笔记”不等于本地只读。

## 8. 依赖、测试、CI 和维护风险

### 8.1 依赖与锁文件

- `package.json` 有 1 个 runtime条目和5个dev条目，`obsidian` 在两区重复且都使用可变 `latest`；其余 selector也都是range。[package](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/package.json#L14-L23)
- Yarn v1 lock有102个解析节点，102个均有 `resolved` 与 integrity，且resolved全部来自 `registry.yarnpkg.com`。这是内容完整性的正面静态信号，但不弥合manifest漂移。[静态清点](provenance.json) [lock示例](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/yarn.lock#L595-L601)
- 当前manifest中的 `@types/node@^18.0.0`、`esbuild@^0.17.0`、`tslib@^2.4.0`、`typescript@^5.0.0` selector均不在lock；lock仍是旧的 `@types/node@^16.11.6`、`esbuild@0.17.3`、`tslib@2.4.0`与`typescript@4.7.4`，并保留当前manifest没有的ESLint图。[lock Node](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/yarn.lock#L153-L156) [ESLint图](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/yarn.lock#L167-L245) [esbuild](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/yarn.lock#L346-L372) [Obsidian](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/yarn.lock#L595-L601) [tslib/TypeScript](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/yarn.lock#L657-L677)
- 根 scripts没有 install lifecycle，但lock不记录每个传递包的scripts；未安装和未做SCA，传递hook、CVE、可达性和依赖许可证未知。

### 8.2 测试、CI、构建和版本

- 固定树有0个test/spec和0个workflow；package只有dev/build/version，没有test/lint/typecheck。README所谓test只是把built files复制到Obsidian后手工验证。[静态清点](provenance.json) [scripts](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/package.json#L6-L10) [README](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/README.md#L133-L155)
- `.eslintrc` 存在，但当前manifest没有eslint/parser/plugin依赖，也没有lint脚本；build仅运行esbuild，未见tsc质量门。[ESLint配置](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/.eslintrc#L1-L23) [package](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/package.json#L6-L23) [esbuild](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/esbuild.config.mjs#L13-L50)
- package/manifest/README均为1.1.3，banner仍写1.1.2，`versions.json`只有1.0.1/1.1.1。版本脚本有同步意图，但固定提交结果没有保持一致。[package](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/package.json#L1-L4) [manifest](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/manifest.json#L1-L10) [README版本](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/README.md#L168-L173) [banner](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/esbuild.config.mjs#L5-L10) [versions](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/versions.json#L1-L3) [版本脚本](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/version-bump.mjs#L1-L14)
- README声明release ZIP含`main.js/manifest/styles`；`main.js`被gitignore且不在快照。固定清点为0个workflow，也未见checksum、签名、SBOM、attestation或provenance，无法把发布JS与源码固定对应。[静态清点](provenance.json) [release声明](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/README.md#L40-L52) [.gitignore](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/.gitignore#L11-L19)
- manifest声明`isDesktopOnly:false`，但没有移动测试证据。README声称Community Plugins可用只是项目声明；本轮未联网核验官方registry。[manifest](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/manifest.json#L1-L10)

## 9. 许可证与源码复用边界

- 根 `LICENSE` 与 `package.json` 均声明 MIT；复制 substantial portions 时需保留版权和许可文本。[LICENSE](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/LICENSE#L1-L21) [package.json](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/package.json#L1-L23)
- LICENSE copyright写Rocher Lee，README author写bnchiang96；仅登记身份表述差异，不推断许可证冲突。
- 根 MIT 不能自动证明锁文件内全部第三方依赖、发布 ZIP 或 Obsidian 分发制品的许可证材料完整；仓库无NOTICE/THIRD_PARTY_NOTICES，lock也不含license字段。若复制上游源码需保留MIT notice；若分发构建物还需独立生成依赖清单并核验第三方条款。

## 10. 对 Rednote Sync 的具体参考价值

### 10.1 A–D 采用建议

| 等级 | 对象与边界 |
|---|---|
| A | 无。没有可以直接进入生产同步链路的完整组件。 |
| B | clean-room借鉴分类/媒体策略交互、媒体集中目录、导入完成后打开笔记，以及partial时可展示远端引用的产品意图；在Rednote中把这些输出行为重构为独立Obsidian writer/projector。 |
| C | `noteDetailMap → imageList/desc/type/video.media.stream`只作历史schema/fixture线索；README的Community Plugins/mobile/release说明只作项目声明。 |
| D | 排除正则解析state、全局`undefined`替换、首key选择、YAML/Markdown字符串拼接、用户路径直拼、`Date.now()`命名、字符串sentinel下载结果、整体import完成语义、现成网络与媒体下载以及生产直接集成。 |

### 10.2 与 `sync-core.md` 的映射

- 对照基线是本地 [`sync-core.md`](../../../projects/rednote-sync-core/docs/sync-core.md)；候选插件不改变其中历史实施 Stage 3 已完成、历史实施 Stage 4 前暂停的边界。
- **canonical：不采用。** 插件输出缺稳定ID、版本化schema、字段provenance、媒体slot与hash，不能成为source of truth。Core的SQLite/object store继续独占canonical状态。
- **derived knowledge-base view：可借鉴意图。** category folder、frontmatter、媒体相对引用和导入后打开笔记是projector UX输入；必须由安全canonical Note和已验证object生成，并以receipt/稳定key处理碰撞。
- **checkpoint/恢复：缺失。** 网络、解析、媒体、Markdown和设置写入必须拆分；远端预取在历史实施 Stage 4 事务外执行，短事务重新校验expected account/revision/object refs，知识库projection失败不改变canonical正确性。
- **媒体：缺失生产契约。** 映射到Core `(kind, ordinal)` MediaSlotState，记录attempt/status/bytes/hash/MIME/failure/retry；Live Photo仍需still/motion配对，不能从此项目推定。
- **secret与URL：现有持久化排除。** query、短链、signed URL与媒体访问材料不得进入frontmatter、Markdown、console或路径；公开source URL由HostAdapter从host/note ID重建。
- **阶段边界：** 历史实施 Stage 3 完全离线，不引入`requestUrl`、`fetch`或Obsidian runtime。未来即使采用Obsidian exporter，也应与历史实施 Stage 4 Provider分离，不让在线HTML直接写知识库。

## 11. 未知项、证据索引和独立复审

### 11.1 当前未知项

- 未运行插件、测试、Obsidian、页面或媒体下载，当前 URL、selector、`__INITIAL_STATE__` shape、移动端兼容和发布制品行为未知。
- no-tags partial checkout 未核验 tag、GitHub release ZIP 或 Obsidian Community Plugins 制品与固定源码的一致性。
- Obsidian `requestUrl`/global fetch的redirect、Cookie、TLS、DNS、timeout与大小语义，以及vault adapter对绝对路径、`..`、symlink和覆盖的具体约束未知。
- Obsidian Markdown/raw HTML/YAML sanitizer与parser对候选输出的实际行为未知；报告不把格式注入扩大成已证实XSS。
- 作者对image/video URL和title/desc字段的真实控制程度、媒体URL有效期/签名/真实格式及当前页面schema未知。
- 依赖漏洞、许可证、install hooks、真实可达性和运行时安全属性尚未做动态验证；本地安全技能tool-index缺失，因此未猜测扫描器路径或运行SAST/SCA。

### 11.2 证据等级

1. **A级：** 固定 commit 的 tracked 源码、配置、lock、LICENSE。
2. **B级：** 固定 README 与未运行的开发/使用说明。
3. **C级：** 静态数据流和部署条件推断；保留前提，不声称已发生事件。
4. **未知：** 运行时平台/Obsidian/发布制品/账号安全属性。

### 11.3 独立复审

- **安全复审：PASS。** 网络、内容注入、路径/no-clobber、partial状态、敏感URL、远端资源隐私和账号风险停止条件均已闭环，P0–P3未关闭finding为0。
- **供应链、许可证与适配复审：PASS。** lock/manifest漂移、版本/制品、测试/CI、MIT与第三方边界及B/D分级均已复核，P0–P3未关闭finding为0。
- **证据与链接复审：PASS。** revision、tree、tracked清单、依赖与lock计数、固定源码链接、本地Markdown链接和敏感值检查均已复核，P0–P3未关闭finding为0。
