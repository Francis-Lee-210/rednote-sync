# 早期产品设计

状态：**历史**
原始日期：2026-07-08
归档日期：2026-08-18

> 本文原样保留 Core 实现前后形成的路线、数据结构、研究映射和互相竞争的设想，其中包括截至 2026-08-17 尚未完成对齐的表述。它不是当前产品设计；当前权威见[产品设计](../design/product-design.md)。

## 文档状态

这份文档形成于正式 Core 实现之前，保留了早期产品路线和验收设想。截至 2026-08-17，历史实施 Stage 3 离线同步核心已经完成，14 个候选仓库和 1 个 Playwright 路线专题的静态研究也已结束，但真实小红书接入、通用输入转换和 AI 分类流水线仍未完成。2026-08-16 用户提出的“三阶段构想与三条路线”仍作为需求草案保留；`xhs_web_crawler` 与 RedCaChe 的后续研究已经补充了浏览器扩展、长任务恢复和本地整理方面的设计证据，但没有验证账号路线风险或真实网站兼容性。

已落地的数据、状态机、输出和安全契约以 [Core 实现规格](../../projects/rednote-sync-core/docs/sync-core.md) 为准。浏览器侧候选结构现归档为[浏览器扩展采集探索](../explorations/browser-extension-acquisition.md)。

## 背景

用户在小红书上通过点赞和收藏标记了大量高价值帖子，但信息流产品形态容易分散注意力，导致这些内容很难被后续认真阅读、查询和复用。

本项目的目标不是做一个“爬虫工具”，而是把用户已经主动标记过的内容，从小红书信息流里解放出来，沉淀成一个本地优先、可检索、可接入 AI Agent 的个人知识库。

第一版面向用户本人自用，采用低频、半自动、可暂停的方式运行，优先保证数据可用、风险可控、实现简单。

## 项目目标

短期目标：

- 导出用户自己的点赞和收藏帖子。
- 尽量保存完整内容：标题、正文、标签、作者、发布时间、互动数据、图片和视频。
- 将结果保存为本地 Markdown 文件、媒体文件和结构化索引。
- 输出结构兼容 Obsidian，同时也能被 LLM Wiki、RAG 工具或后续 AI Agent 读取。
- 采用慢速、半自动、可检查、可暂停的处理方式。

长期目标：

- 逐步演进成面向更多用户的本地知识库同步方案。
- 支持本地优先的知识库管理和增量同步。
- 加入 AI 摘要、自动分类、关键点提取、实体提取和语义搜索。
- Notion 只作为可选导出目标，不作为主存储路线。

## 非目标

第一版不做以下事情：

- 不做高频批量爬取。
- 不做代理池、Cookie 池、账号池或自动换号。
- 不破解签名、不伪装设备指纹、不绕过平台风控。
- 不购买或使用第三方出售的账号 Cookie。
- 不把带 `xsec_token` 的完整 URL 当作长期稳定 ID。
- 不把 Cookie 或完整 `xsec_token` URL 写进公开文档。
- 不把 Notion 作为主数据库。

## 早期推荐产品路线

最初推荐的候选路线是：

```text
Userscript 元数据采集器 + 本地处理器 + Markdown/Obsidian 知识库
```

当时的原因：

- 现有 userscript 已经能抓到点赞和收藏列表里的元数据。
- `XHS-Downloader` 初步验证可以补全帖子详情并下载媒体。
- 自定义转换层可以把下载器产物转换成适合知识库使用的 Markdown 和索引。
- 这个路线比直接做完整浏览器插件更小、更适合第一版验证。

这条路线现在只保留为一种可选输入链，不再是已经确定的当前方案。专项审查认为 XHS-Downloader 适合做行为和数据契约参考，但不建议直接嵌入其源码；现有 Core 也已经独立实现了本地状态、对象存储和知识库投影。

2026-08-17 的静态研究进一步收敛了采集方向：列表响应观察仍应是批量发现主路径；逐篇点击只用于新增、变化或字段不足的详情补缺。Chrome 扩展可以提供 popup、service worker、durable job store 和 content script 的职责边界，但不应另建一套 canonical 数据库。

## 三阶段构想与三条路线设计（2026-08-16 用户构思草案）

归档时状态：`[想法]`，当时未经动态验证，也尚未整理为当前权威。本节保留 2026-08-16 至 2026-08-17 的混合草稿；现行表述见[当前产品设计](../design/product-design.md)。

### 项目目的与 MVP

- 初步目的不变：先服务自己；个人目标达成后再考虑面向其他用户的产品化。
- 核心需求：导出 2000 多条点赞/收藏帖子记录 → 整理归纳 → 建立可搜索、可查找、可后续取用的本地资料库。

### 第一阶段：帖子列表导出

- 目标：导出点赞、收藏过的帖子列表。
- 实现基础：继续使用现有油猴脚本/未来 MAIN-world bridge 观察点赞、收藏列表响应，并统一导出版本化 JSON。
- `xhs_web_crawler` 调整为 B 级局部参考：借鉴原生扩展的点击—关闭—滚动状态机，但只用于详情缺口 fallback；它不是 Playwright，也不是收藏/点赞专项实现。
- RedCaChe 提供 `content script → service worker → IndexedDB → dashboard` 的产品分层参考，但当前一次性内存扫描没有 durable checkpoint，不能直接采用。
- 研究判断：已有列表导出基础，但“2000 多条全量完成、稳定重复获取和中断恢复”仍未验证，不能把技术难度标为已经解决。

### 第二阶段：帖子内容下载与导出（当前最大阻碍）

- 目标：按第一阶段列表获取每篇帖子具体内容并下载/导出到本地；尽量隔离主账号使用环境，降低主账号受影响风险。
- 三条可选路线（用户可自行决定使用哪条）：

| 路线 | 默认方案 | 可选项 | 用户最初假设（风险 / 效率，未验证） |
|---|---|---|---|
| 路线一：用户主账号 | 低风险模式 | 高风险模式（开启前提供明确风险提示） | 风险中等 / 效率较低 |
| 路线二：用户小号 | 低风险模式 | 高风险模式（开启前提供明确风险提示） | 风险较低 / 效率较低 |
| 路线三：其他账号的 Cookie（其他账号或可废弃账号） | — | — | 风险较低 / 效率较高 / 可能产生额外成本 |

- 待调研问题（用户原文）：如何稳定获取内容；如何隔离主账号环境；如何尽可能保证主账号安全；三种账号路线分别能达到怎样的效率；不同获取方式实际存在怎样的账号风险；哪种方案适合个人 MVP、哪种适合未来产品化。

现有 14 个仓库的静态研究都不能证明上述账号路线的风险高低。真实浏览器、CDP、延迟、persistent profile、小号或其他账号 Cookie 都不是账号安全保证；任何动态比较仍需单独授权、测试账号、硬预算和首个限制信号停止。

### 第三阶段：本地整理、归纳与后续操作

- 3.1 本地整理与归纳：参考 RedCaChe 的人工 review 视图，但把 `review_status`、平台 `source_relation` 和未来 `action_intent` 分开；Markdown/Obsidian 继续是可重建 projection，不是事实源。
- 3.2 与小红书状态相关的操作（写回）：取消点赞、重新点赞、取消收藏、重新收藏、创建新的收藏夹、将帖子移动到指定收藏夹。它仍是远期构想，不进入近期读取扩展；未来必须采用冻结清单、明确授权、逐项执行、desired-state 验证和 unknown-outcome 人工对账。

### 当前整体状态（用户整理）

| 阶段 | 核心内容 | 当前状态 | 难度判断 |
|---|---|---|---|
| 第一阶段 | 点赞、收藏帖子列表导出 | 已有脚本基础；完整性和恢复未验证 | 可先做离线桥接与插件壳层 |
| 第二阶段 | 帖子具体内容下载与导出 | 需要大量调研和实验 | 当前最大阻碍 |
| 第三阶段 | 本地整理、归纳及平台操作 | 本地 review 有参考设计；平台写仍未授权 | 本地整理可离线验证，写回另立规格 |

整体构想：列表导出 → 内容下载 → 本地整理与后续操作；当前重点仍是个人 MVP。

### 说明与冲突标注（仓库事实，本轮补充）

- 本节与旧文档的关系：`docs/design/roadmap.md` 旧“两条探索路线”保留原文；本文件“非目标”第 2 条与 `docs/mission.md` “Out of scope for now” 的“平台写操作”排除项保留原文，仅在此标注“用户构思待修订”，未删除未改写。
- 写回操作触碰平台协议 3.4/4.1（`research/topics/xsec-link-structure.md` §4）；写操作比读操作风险更高，其可行性（接口、签名、风控表现）尚未研究。
- `xhs_web_crawler` 已由 D 调整为 B，详见[专项审查](../../research/projects/xhs-web-crawler/review.md)。评级变化只表示点击/滚动和扩展分层值得研究；当前 background/CDP/HAR 接线、全量效率和许可证仍不通过直接采用门。
- RedCaChe 的研究价值为 A、采用参考为 B，详见[专项审查](../../research/projects/redcache/review.md)。它验证了本地人工 review 和纯扩展分层的参考价值，也暴露了无 checkpoint、latent 平台写、无鉴权任意导航和共享 page 串页风险。
- 三条账号路线的“风险较低/效率较高”仍是用户假设，不是研究结论。路线三还与本文件“非目标”中的第三方账号 Cookie 排除项冲突；在独立决策修订前，不进入实施路线。
- 证据基础：路线一/二对应小号标题重发现 `[本地验证]` 5/5（`xsec-link-structure.md` §6.2）；路线三尚无任何动态验证。
- 写回能力属于 历史实施 Stage 4 在线范围；历史实施 Stage 3（`sync-core.md`）的离线边界与禁止项不变。

## 研究后的推荐产品分层

详细职责、任务状态、权限和验收门见[浏览器扩展采集探索](../explorations/browser-extension-acquisition.md)。以下顺序只代表归档时的研究建议：

1. 统一点赞/收藏 userscript 的版本化 JSON，并桥接到 `offline-input-v1`。
2. 用合成页面实现 MV3 壳层和 durable job/checkpoint，不访问真实平台。
3. 用现有离线 Core 数据实现本地 review、搜索和 Obsidian projection。
4. 单独授权 历史实施 Stage 4 后，再小样本验证列表发现、详情 fallback、身份绑定和停止条件。
5. 平台写继续保持独立、默认禁用，不随读取扩展一起实现。

## 风控与安全原则

运行原则：

- 只处理用户自己提供的点赞、收藏或发布帖子链接。
- 优先使用用户正常浏览时刚获取到的新鲜链接。
- 慢速处理，不做隐藏式批量任务。
- 支持失败停止、暂停、继续和人工检查。
- 不尝试用 Cookie 生成或转换 `xsec_token`。
- 不把“规避风控”作为产品能力。

敏感数据处理：

- Cookie 是登录凭证，必须视为敏感信息。
- 带 `xsec_token` 的完整 URL 也应视为敏感信息。
- Markdown 文件默认只保存不带 `xsec_token` 的公开帖子链接。
- 私有 raw 数据中如需保留完整 URL，只能用于本地重试，不应公开或提交。
- 长期稳定主键使用 `note_id`。

## 初始测试结论

已克隆并安装 `JoeanAmier/XHS-Downloader`：

```text
research/projects/xhs-downloader/source
```

本机系统 Python 是 `3.9.6`，该项目要求 Python `>=3.12`。通过 `uv` 已成功创建项目内 Python `3.12.13` 虚拟环境。

命令行启动验证成功：

```text
XHS-Downloader V2.8 Beta
```

测试结果：

- 第一条旧链接或上下文不匹配链接失败，失败点在详情获取阶段。
- 第二条较新的链接成功，无 Cookie 情况下下载到图文帖子图片。
- 成功记录写入 SQLite：`Volume/TrialDownload2/ExploreData.db`。
- 帖子正文保存在 `作品描述` 字段。
- 标签保存在 `作品标签` 字段。
- 作者、发布时间、互动数据、作品链接和下载地址也被保存。

这次测试只能证明当时的一个图文小样本可用，不能证明当前版本、其他账号、视频、Live Photo 或批量同步稳定。XHS-Downloader 仍可作为详情和媒体行为的参考或外部候选输入，但是否进入实际产品链路尚未决定。完整专项结论见 [XHS-Downloader 审查](../../research/projects/xhs-downloader/review.md)。

## 早期候选数据流

```text
小红书网页
  -> Userscript 捕获点赞/收藏列表元数据
  -> 导出 JSON/CSV/XLSX
  -> 本地处理器读取帖子 URL 队列
  -> XHS-Downloader 获取详情并下载媒体
  -> 转换器读取 SQLite 和媒体文件
  -> 生成 Markdown、assets、index.json、index.csv
  -> 用户用 Obsidian 或 LLM/RAG 工具读取本地知识库
```

## 组件设计

### 1. Userscript 元数据采集器

现有脚本：

- `prototypes/tampermonkey/xiaohongshu-like-export.user.js`
- `prototypes/tampermonkey/xiaohongshu-like-export-json.user.js`
- `prototypes/tampermonkey/xiaohongshu-collection-export.user.js`

当前职责：

- 在用户正常登录和浏览小红书时运行。
- 捕获点赞和收藏列表接口返回。
- 记录 `note_id`、`xsec_token`、标题、作者、封面、互动数据等元数据。
- 点赞和收藏脚本支持导出 Excel；点赞另有 JSON 原型。

后续建议：

- 先统一点赞和收藏的版本化 JSON 契约；是否合并成同一脚本可以后置。
- 为收藏补充 JSON 导出，并统一版本化输出格式。
- 每条记录标记来源：`liked`、`collected`、`posted`。
- 稳定实体和短期访问材料分离：长期记录使用 `note_id` 和不带 query 的 canonical URL；完整 token URL 只进入短生命周期的私有 envelope，不写普通 JSON、日志或知识库。
- 每批输出带 `run_id`、source、schema version、批次序号和完整性状态，由 Core ack 后才能推进 checkpoint。

### 1A. Chrome 扩展采集壳层

扩展不是历史实施 Stage 3 的一部分，而是历史实施 Stage 4 的候选交互和编排层。其职责是：

- popup/dashboard 展示控制、进度、暂停原因和人工 review；不自己拥有事实状态；
- service worker 编排短步骤，并把任务状态写入 durable store；
- content script 识别 DOM 状态、滚动列表，只对详情缺口执行少量点击 fallback；
- MAIN-world bridge 观察精确 allowlist 的列表响应，并把版本化 observation 交给离线桥接；
- 不保存媒体主副本，不注册平台写能力，不把扩展 IndexedDB 变成第二套 canonical state。

完整候选设计和验收条件见[浏览器扩展采集探索](../explorations/browser-extension-acquisition.md)。

### 2. 详情与媒体下载器

早期方案假设第一版使用 `XHS-Downloader`。这不是当前已经采用的决定；后续可以讨论继续把它当作外部输入、独立实现在线适配器，或先只做离线桥接。

职责：

- 读取新鲜小红书帖子链接。
- 获取帖子详情数据。
- 下载图文帖子图片。
- 尽量下载视频帖子视频。
- 将详情写入 SQLite。
- 将媒体保存到本地文件夹。

已有证据：

- `[本地验证]` 一个较新的图文小样本取得了标题、正文、标签、作者、时间、互动数据和图片，并写入 SQLite。
- `[静态证据]` 固定 revision 审查确认项目包含图片、视频、Live Photo、SQLite、命令行、API 与 MCP 等实现面；这不等于这些能力已由本项目动态验证。

待验证能力：

- 视频帖子下载稳定性。
- 多图帖子下载完整性。
- 使用 Cookie 与不使用 Cookie 的差异。

限制：

- 旧链接、过期 `xsec_token` 或上下文不匹配时可能失败。
- 不直接生成 Markdown。
- 不自动做 AI 摘要、分类、OCR、视频转录或评论抓取。

### 3. 知识库转换器

早期方案设想直接读取 `ExploreData.db` 并生成知识库。现在 Rednote Sync Core 已经实现 canonical SQLite/object store，以及 Markdown、JSON、CSV、媒体、失败和运行记录投影；尚缺的是把 userscript 或 XHS-Downloader 等外部数据安全转换成 `offline-input-v1` 的输入桥接。

如果继续走 XHS-Downloader 输入路线，桥接层的职责是：

- 读取 `XHS-Downloader` 的 `ExploreData.db`。
- 找到对应的图片和视频文件。
- 将外部字段、来源关系、详情结果和媒体映射为版本化的 `offline-input-v1`。
- 区分原始输入、短期访问材料、公开 URL、真实缺失和处理失败。
- 让现有 Core 负责幂等同步、失败记录、对象存储和派生视图，不另建一套平行状态机。

是否优先实现这层桥接，需要与在线适配器和 AI 分类原型一起讨论。

## 本地知识库目录结构

下面是早期建议结构，用于表达产品希望提供的可读文件。当前 Core 的实际路径使用 account/note digest，并以 SQLite 与不可变对象为事实源，详见 [Core README](../../projects/rednote-sync-core/README.md#理解输出)。

```text
rednote-knowledge/
  notes/
    691ef665000000000d00cb93.md
  assets/
    images/
      691ef665000000000d00cb93/
        001.jpeg
    videos/
      691ef665000000000d00cb93/
        001.mp4
    covers/
      691ef665000000000d00cb93.jpeg
  data/
    raw/
      xhs-downloader/
    index.json
    index.csv
    failures.json
  logs/
    export-runs.jsonl
```

说明：

- `notes/` 是主要知识库内容。
- `assets/` 存图片、视频、封面。
- `data/index.json` 给程序和 AI Agent 使用。
- `data/index.csv` 给表格工具和人工检查使用。
- `data/failures.json` 保存失败原因和后续处理建议。
- `logs/` 保存每次运行记录。

## Markdown 格式

每篇帖子生成一个 `.md` 文件，采用 Obsidian 兼容的 YAML frontmatter。

示例：

```markdown
---
source: rednote
note_id: "691ef665000000000d00cb93"
type: "图文"
title: ""
author_name: "一个暴躁的搬砖的"
author_id: "609b212c0000000001003153"
published_at: "2025-11-21 00:07:17"
collected: true
liked: false
tags:
  - 奥克兰it
  - 奥克兰it求职
  - 奥克兰IT就业
original_url: "https://www.xiaohongshu.com/explore/691ef665000000000d00cb93"
media_status: "downloaded"
ai_status: "not_started"
---

# 一个暴躁的搬砖的 - 2025-11-21

原文链接: https://www.xiaohongshu.com/explore/691ef665000000000d00cb93

## 正文

本着以回馈社会为己任，给自己攒功德的目的，...

## 媒体

![[../assets/images/691ef665000000000d00cb93/001.jpeg]]

## AI 摘要

第一版不生成。后续 AI 流程可写入这里。

## 关键点

第一版不生成。后续 AI 流程可写入这里。
```

注意：

- Markdown 里的 `original_url` 默认不包含 `xsec_token`。
- `note_id` 是本地知识库的稳定 ID。
- 标题为空时，可以用作者名、日期或正文前若干字生成文件标题。

## 核心数据字段

每条帖子至少保留：

- `note_id`
- `source_url_private`
- `original_url_without_xsec`
- `source_list`
- `title`
- `description`
- `type`
- `tags`
- `author_name`
- `author_id`
- `author_url`
- `published_at`
- `updated_at`
- `liked_count`
- `collected_count`
- `comment_count`
- `share_count`
- `image_paths`
- `video_paths`
- `cover_path`
- `download_status`
- `download_error`
- `captured_at`
- `processed_at`

AI 预留字段：

- `summary`
- `key_points`
- `topics`
- `entities`
- `ai_tags`
- `embedding_status`
- `ai_model`
- `ai_processed_at`

## 任务状态模型

每篇帖子需要一个处理状态：

- `pending`：已收集，未处理。
- `downloading`：处理中。
- `done`：详情和可用媒体已保存。
- `partial`：正文已保存，但部分媒体失败。
- `failed`：详情获取失败。
- `skipped`：用户主动跳过。

失败记录至少包含：

- `note_id`
- `url_used`
- `stage`
- `error_message`
- `attempt_count`
- `last_attempt_at`
- `next_action`

早期曾考虑用 JSON 保存任务状态。当前 Core 已采用 SQLite 保存规范状态，JSON 只作为可重建派生视图，不应再新增平行的 JSON 状态源。

## AI Agent 集成方向

AI 不进入第一版关键路径。第一版先保证可导出、可打开、可查询。

后续 AI 流程可以做：

- 自动摘要。
- 关键点提取。
- 主题分类。
- 实体提取。
- 图片 OCR。
- 视频字幕或语音转录。
- 向量化和语义搜索。
- 基于本地知识库的问答。

AI 流程应读取本地 canonical 内容包或派生输入，并把结果写入独立 sidecar JSON。

Markdown 可以展示经过选择的 AI 结果，但不作为分类事实的唯一存储。sidecar 需要记录 provider、model、prompt、taxonomy 和内容包版本，具体候选方案见 [AI 分类探索](../explorations/ai-classification.md)。

## 早期第一版验收设想

这些标准仍能帮助讨论产品价值，但尚未作为当前阶段的正式验收门：

- 能从现有 userscript 导出点赞和收藏元数据。
- 导出结果具有 schema version、来源关系、批次信息和 `complete/partial` 状态。
- 中断、刷新或扩展 worker 终止后，任务能够从已被 Core ack 的批次恢复。
- 能把一小批新鲜帖子 URL 交给 `XHS-Downloader` 处理。
- 图文帖子能生成包含正文和本地图片引用的 Markdown。
- 失败链接会记录到 `failures.json`。
- 输出文件夹可以直接用 Obsidian 打开。
- 生成 `index.json` 和 `index.csv`。
- Markdown 默认不暴露 Cookie 或完整 `xsec_token` URL。

视频支持单独验收：

- 至少用一条视频帖子做真实测试。
- 如果视频下载成功，Markdown 引用本地视频文件。
- 如果视频下载失败，Markdown 仍保留正文、封面、元数据和失败原因。

## 早期默认决策及当前状态

这些决定形成于 历史实施 Stage 3 实现之前，目前状态如下：

- 点赞已有 JSON 原型，收藏仍只有 Excel；是否统一 userscript 需要继续讨论。
- 直接读取 XHS-Downloader SQLite 的转换器尚未实现，也不再视为唯一下一步。
- Core 已采用私有同步 root、account digest 路径、SQLite/object canonical state 和可重建派生视图，不再使用早期固定的 `rednote-knowledge/` 结构作为规范。
- AI 摘要与分类仍未实现；当前设计要求写入独立派生 sidecar，而不是污染原始归档。
- Markdown、CSV 和日志不得保存 Cookie 或完整 token URL；私有访问材料未来也必须进入明确的 secret 边界，不能仅以“raw 数据”名义长期保留。

## 下一步讨论

研究结果给出了推荐顺序，但仍需用户确认最小实现切片：

1. 统一 userscript JSON 并桥接到 `offline-input-v1`，先闭合无需真实账号的新数据入口。
2. 用合成页面实现 Chrome 扩展壳层、durable job/checkpoint 和 Core batch ack，不访问真实平台。
3. 用离线内容实现本地人工 review、搜索和 Obsidian projection，验证 RedCaChe 所代表的产品价值。
4. 使用合成或脱敏内容包实现 AI 分类原型。
5. 单独授权后，再小范围验证 历史实施 Stage 4 在线列表、详情 fallback、媒体、身份绑定和停止条件。

平台写操作不在上述读取链路内；它必须等待单独决策、权限模型和审计规格。
