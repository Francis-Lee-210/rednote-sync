# 小红书本地知识库导出工具设计文档

日期：2026-07-08

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

## 推荐产品路线

当前推荐路线是：

```text
Userscript 元数据采集器 + 本地处理器 + Markdown/Obsidian 知识库
```

原因：

- 现有 userscript 已经能抓到点赞和收藏列表里的元数据。
- `XHS-Downloader` 初步验证可以补全帖子详情并下载媒体。
- 自定义转换层可以把下载器产物转换成适合知识库使用的 Markdown 和索引。
- 这个路线比直接做完整浏览器插件更小、更适合第一版验证。

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
research/xhs-downloader/source
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

结论：

`XHS-Downloader` 可以作为第一版的“详情补全 + 图片/视频下载组件”，但它不是最终知识库生成器。项目还需要一个自定义转换层。

## 第一版数据流

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
- `prototypes/tampermonkey/xiaohongshu-collection-export.user.js`

当前职责：

- 在用户正常登录和浏览小红书时运行。
- 捕获点赞和收藏列表接口返回。
- 记录 `note_id`、`xsec_token`、标题、作者、封面、互动数据等元数据。
- 支持导出 Excel。

后续建议：

- 将点赞和收藏脚本合并成一个统一脚本。
- 增加 JSON 导出。
- 每条记录标记来源：`liked`、`collected`、`posted`。
- 导出时保留完整 token URL 作为私有处理输入，但知识库输出时去掉 `xsec_token`。

### 2. 详情与媒体下载器

第一版使用 `XHS-Downloader`。

职责：

- 读取新鲜小红书帖子链接。
- 获取帖子详情数据。
- 下载图文帖子图片。
- 尽量下载视频帖子视频。
- 将详情写入 SQLite。
- 将媒体保存到本地文件夹。

已验证能力：

- 能获取标题、正文、标签、作者、发布时间、互动数据。
- 能下载图文帖子图片。
- 支持命令行、API 和 MCP 模式。

待验证能力：

- 视频帖子下载稳定性。
- 多图帖子下载完整性。
- 使用 Cookie 与不使用 Cookie 的差异。

限制：

- 旧链接、过期 `xsec_token` 或上下文不匹配时可能失败。
- 不直接生成 Markdown。
- 不自动做 AI 摘要、分类、OCR、视频转录或评论抓取。

### 3. 知识库转换器

这是第一版需要自定义实现的核心组件。

职责：

- 读取 `XHS-Downloader` 的 `ExploreData.db`。
- 找到对应的图片和视频文件。
- 每篇帖子生成一个 Markdown 文件。
- 生成本地媒体引用。
- 生成 `index.json` 和 `index.csv`。
- 记录失败任务，避免静默丢失。
- 支持重复运行，同一 `note_id` 不重复生成。

第一版建议先做命令行转换器，不做 GUI。

## 本地知识库目录结构

建议输出结构：

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

第一版可以用 JSON 文件保存任务状态，不需要先做复杂数据库。

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

AI 流程应读取本地 Markdown/JSON，并将结果写回 Markdown 或 sidecar JSON。

默认建议：

- 第一阶段 AI 结果写回 Markdown，方便人读。
- 后续如果接 RAG，再额外维护 JSON/向量索引。

## 第一版验收标准

第一版完成标准：

- 能从现有 userscript 导出点赞和收藏元数据。
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

## 默认决策

为避免第一版范围发散，采用以下默认决策：

- Userscript 下一步优先增加 JSON 导出，同时保留 Excel。
- 转换器第一版直接读取 `XHS-Downloader` SQLite，不先接 API 模式。
- 最终知识库默认输出到项目内 `rednote-knowledge/`，后续再允许配置到 Obsidian Vault。
- AI 摘要第一版不生成，只预留字段和章节。
- 私有 raw 数据可以保留完整 token URL 用于本地重试，但 Markdown 和 CSV 默认去除 token。

## 推荐下一步

下一步实现目标应收敛为：

```text
ExploreData.db + 已下载媒体文件夹 -> Markdown notes + assets + index.json + index.csv
```

这一步能最快把已经验证成功的 `XHS-Downloader` 输出变成真正可用的本地知识库，也避免在第一版中过早重写下载器或开发完整插件。
