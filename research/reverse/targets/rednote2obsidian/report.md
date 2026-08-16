# RedNote Sync Obsidian 客户端静态逆向（阶段一）

## 1. 结论摘要

本阶段已经足以支撑后续的“独立同步核心”设计：样本中的小红书/RedNote 双域名、8 个业务接口、浏览器会话签名方式、普通列表与专辑列表的增量状态、统一笔记模型、媒体落盘路径以及 Markdown/YAML 生成规则都能从客户端代码中直接恢复。

本报告只做离线静态分析。没有加载或执行插件 `main.js`，没有发起网络请求，没有读取 `prototypes/test-cookie.txt` 或 `prototypes/xsec_token.txt`，也没有尝试绕过授权或许可证。

证据等级：

- **D（直接证据）**：当前样本的可达代码、常量或 manifest/CSS 明文直接支持。
- **I（推断）**：由多处直接证据组合推导，但未经运行时流量验证。
- **U（未知）**：静态样本无法确定，或必须动态验证。

## 2. 样本身份与取证边界

分析输入仅限：

- `research/reverse/targets/rednote2obsidian/samples/main.js`
- `research/reverse/targets/rednote2obsidian/samples/manifest.json`
- `research/reverse/targets/rednote2obsidian/samples/styles.css`

当前工作区样本哈希：

| 文件 | SHA-256 | 证据 |
|---|---|---|
| `main.js` | `5ce6a362f4cbd0542caecb1e37ab0c1c20f27b9164890da1c80f8a682cb194b7` | D |
| `manifest.json` | `acac98903a226351bd3780a10106b50ae5550e6ef96d4851a15f952e45ba6dd0` | D |
| `styles.css` | `88722426c4944bf95b37ba67da31f1dfb700930bd6236565fd982b8c4f3d7669` | D |

当前 `manifest.json` 直接声明：

| 属性 | 值 | 证据 |
|---|---|---|
| id | `rednote2obsidian` | D |
| name | `RedNote Sync` | D |
| version | `1.2.3` | D |
| minAppVersion | `0.15.0` | D |
| isDesktopOnly | `true` | D |
| description | 同步个人帖子、收藏、点赞到 Vault | D |

注意：此前会话曾出现过 `1.1.6` 的版本描述，但本次取证时的实际 manifest 是 `1.2.3`，且上述哈希可复核。仅凭当前三个输入无法确认旧版本描述来自另一份样本、旧副本还是样本更新；报告不把两者合并，也不把 `main.js` 中其他协议常量当成插件版本。**U**

`styles.css` 只定义登录弹窗：800×600、内容区纵向 flex、webview 填满剩余空间、底部按钮栏。**D**

## 3. 静态提取方法

`main.js` 是单行 bundle，包含字符串数组轮转、变体 Base64 字母表、属性名混淆和死代码注入。为了避免执行不可信代码，新增了：

```text
research/reverse/tools/extract_obsidian_strings.mjs
```

该工具是**哈希锁定的单样本工具**：运行前先验证输入 `main.js` 的 SHA-256 必须是
`5ce6a362f4cbd0542caecb1e37ab0c1c20f27b9164890da1c80f8a682cb194b7`，其他哈希一律拒绝，且在校验通过前不创建输出。它只把这个 `main.js` 当文本处理：

1. 扫描并解析字符串字面量数组，不使用 `eval`/`vm`。
2. 复现数组轮转校验和，不调用 bundle 中的函数。
3. 使用 bundle 的小写字母优先 Base64 字母表做纯数据解码。
4. 静态替换数值常量与直接 decoder 调用，可选生成临时可读副本。

提取逻辑明确耦合当前样本的函数名 `_0xa56a`（字符串表）与 `_0x5555`（decoder）、索引偏移 `0xc4`、轮转校验目标 `790822`，以及针对数值对象成员、decoder 别名与直接调用的正则替换。这些函数名、常量、offset、target 和正则只对上述精确哈希负责，不声称能通用于其他版本或重新打包的 bundle。**D（工具适用边界）**

工具在读入前拒绝 source、strings output、deobfuscated output 之间的 resolved-path、符号链接真实路径或现有 inode 碰撞；在 Darwin/Windows 上，canonical identity 还会先做 Unicode NFC 规范化和小写保守 case-fold，防止大小写不敏感文件系统中两个尚不存在、仅大小写不同的输出相撞。所有输出先写到目标目录的独占临时文件，再用原子 rename 提交。对应 `node:test` 只在系统临时目录内验证同路径、相同输出、硬链接、符号链接、实际大小写不敏感卷上的大小写变体、正常写入与错误哈希，不在工作区样本上做破坏性实验。**D（工具安全边界）**

本样本提取结果：1436 个字符串，数组轮转 186 次；静态识别 1762 个数值成员、399 个 decoder 别名，并替换 4282 个直接 decoder 调用。**D**

生成的 `/tmp/obsidian-strings.tsv` 和 `/tmp/obsidian-deobfuscated.js` 是可重建的临时分析物，不是恢复后的原始源码。

静态常量替换是辅助阅读手段，不做完整 JavaScript 作用域求值；报告中的关键结论均另外回看了调用点和控制流，没有把单独出现的字符串或死代码片段直接当成可达行为。**D（分析方法）**

## 4. 客户端模块与入口

| 模块/类 | 职责 | 证据 |
|---|---|---|
| `src/hosts.ts` / `REDNOTE_HOSTS` | 小红书与 RedNote host 配置 | D（原模块名保留） |
| `src/sign/sign-manager.ts` / `SignManager` | 隐藏 webview、页面内签名、带登录态发请求 | D（原模块名保留） |
| `RednoteAPI` | 用户、列表、详情、评论、专辑 API 封装 | D |
| `SyncEngine` | 同步编排、游标、去重、专辑模式、AI/媒体调用 | D |
| `AIClassifier` | OpenAI 兼容的文本分类 | D |
| Vision OCR 代码 | 最多 10 张图片的多模态 OCR | D |
| Transcriber 系列 | DashScope、火山、腾讯云、OpenAI 兼容转写 | D |
| `VaultWriter` | 建目录、写 Markdown 和二进制媒体 | D |
| `BaseWriter` | 创建/重建 Obsidian `.base` 画廊视图 | D |
| `LoginModal` | 内嵌登录页并使用持久 Electron partition | D |
| `RedNoteSyncSettingTab` | 设置 UI | D |
| `RedNoteSyncPlugin` | 生命周期、命令、Ribbon、定时器 | D |

插件注册三个命令：

- `login-rednote`：登录小红书。
- `sync-now`：立即同步。
- `rebuild-gallery-base`：重建 `📕 小红书.base`。

Ribbon 图标也会触发 `syncNow()`。插件加载时会按设置启动定时器。**D**

## 5. Host、会话与签名

### 5.1 Host 配置

| host id | Web | Explore/Webview | API | 额外请求头 | 证据 |
|---|---|---|---|---|---|
| `xhs` | `https://www.xiaohongshu.com` | `https://www.xiaohongshu.com/explore` | `https://edith.xiaohongshu.com` | 无 | D |
| `rednote` | `https://www.rednote.com` | `https://www.rednote.com/explore` | `https://webapi.rednote.com` | `xy-common-params: mlanguage=en_us` | D |

`activeHost` 决定实际目标；无法识别时回退到 `xhs`。**D**

### 5.2 会话模型

`SignManager` 创建不可见 Electron `<webview>`：

- partition 为 `persist:rednote`；
- URL 为当前 host 的 Explore 页面；
- 固定 Chrome 120/macOS User-Agent；
- 加载超时 30 秒，`did-finish-load` 后再等待 2 秒；
- 所有业务请求在 webview 内 `fetch(..., credentials: "include")`。

因此有效登录态的真正载体是持久 webview partition；设置中的 `cookies`/`a1Cookie` 也存在，但业务请求不是简单地从字符串拼 `Cookie` 请求头。**D**

### 5.3 签名与请求头

请求前在页面上下文执行注入脚本：

- 使用页面的 `window.mnsv2`；
- 读取 `a1` Cookie及 localStorage 的 `b1`、`b1b1`、`dsllt`；
- 计算 `x-s`、`x-t`、`x-s-common`、`x-b3-traceid`；
- GET 的签名输入为路径加 query；POST 的签名输入为路径加 JSON body；
- 业务请求还带 `Origin`、`Referer` 和 `Content-Type: application/json`。

签名实现明确依赖页面环境与站点状态。独立实现更适合复用“浏览器辅助签名”，而不是把当前算法硬编码为永久协议。**I**

页面函数、localStorage 字段及签名结构在网站更新后是否仍有效，必须动态验证。**U**

## 6. 小红书/RedNote API 表

下表是 bundle 的直接调用协议，不代表服务端在未来仍保持兼容。

| 方法 | 路径 | 主要请求字段 | 主要响应字段 | 用途 | 证据 |
|---|---|---|---|---|---|
| GET | `/api/sns/web/v2/user/me` | 无 | `data.user_id`, `data.nickname`, `data.guest` | 验证登录、识别账号 | D |
| GET | `/api/sns/web/v1/user_posted` | `num`, `user_id`, `image_formats`, 可选 `cursor`，空 `xsec_token/xsec_source` | `data.notes`, `data.cursor`, `data.has_more` | 个人帖子 | D |
| GET | `/api/sns/web/v2/note/collect/page` | 同上 | 同上 | 收藏 | D |
| GET | `/api/sns/web/v1/note/like/page` | 同上 | 同上 | 点赞 | D |
| POST | `/api/sns/web/v1/feed` | `source_note_id`, `image_formats:[jpg,webp,avif]`, `extra.need_body_topic:"1"`, `xsec_source:"pc_user"`, `xsec_token` | `data.items[0].note_card` | 笔记详情 | D |
| GET | `/api/sns/web/v2/comment/page` | `note_id`, 空 `cursor`, 空 `top_comment_id`, `image_formats`, `xsec_token` | `data.comments` | 热门评论首屏 | D |
| GET | `/api/sns/web/v1/board/user` | `user_id`, `page`, `num`, `image_formats`, 空 `xsec_*` | `data.boards` | 收藏专辑列表 | D |
| GET | `/api/sns/web/v1/board/note` | `board_id`, `num`, `cursor`, `image_formats` | `data.notes`, `data.cursor`, `data.has_more` | 专辑笔记 | D |

通用列表 `getPosts()` 把 `image_formats` 设为字符串 `jpg,webp,avif`；专辑和评论请求也使用该字符串。`getUserBoards()` 默认 page=1、num=50；`getBoardNotes()` 默认 num=30，但同步时传入 `syncBatchSize`。**D**

评论没有继续翻页：客户端仅保留顶层前 10 条，每条只保留前 3 条 `sub_comments`。**D**

## 7. 设置键

设置通过 Obsidian `loadData()`/`saveData()` 持久化，并与 `DEFAULT_SETTINGS` 做浅合并。**D**

### 7.1 同步与存储

| 键 | 默认值 | 含义 | 证据 |
|---|---:|---|---|
| `rootFolder` | `RedNote` | Vault 根目录 | D |
| `activeSyncTarget` | `bookmark` | `post` / `bookmark` / `like`，每次只运行一个目标 | D |
| `autoSyncEnabled` | `true` | 自动同步 | D |
| `syncIntervalMinutes` | `10` | 定时周期（分钟） | D |
| `syncBatchSize` | `5` | 每次列表批量大小 | D |
| `syncTags` | `true` | 写入处理后的标签 | D |
| `syncAlbums` | `false` | 启用收藏专辑模式 | D |
| `albumWhitelist` | `[]` | 专辑 id 白名单 | D |
| `syncAllBookmarksAfterAlbums` | `null` | 专辑完成后是否继续普通收藏同步 | D |
| `downloadVideos` | `false` | 下载视频；否则正文用远端链接 | D |
| `syncComments` | `false` | 同步热门评论首屏 | D |
| `lastSyncAt` | `0` | 最近成功完成时间戳 | D |

### 7.2 AI 与转写

| 键 | 默认值 | 证据 |
|---|---:|---|
| `enableAiClassify` | `false` | D |
| `openaiApiKey`, `openaiBaseUrl`, `openaiModel` | 空字符串 | D |
| `categories` | `[]` | D |
| `enableImageOcr`, `visionModel` | `false`, 空字符串 | D |
| `enableVideoTranscript` | `false` | D |
| `transcriptProvider` | `dashscope` | D |
| `dashscopeApiKey`, `transcriptModel` | 空字符串 | D |
| `volcAppId`, `volcAccessToken` | 空字符串 | D |
| `tencentSecretId`, `tencentSecretKey` | 空字符串 | D |
| `refineTranscript` | `true` | D |

### 7.3 会话与进度

| 键 | 默认值 | 含义 | 证据 |
|---|---:|---|---|
| `cookies`, `a1Cookie` | 空字符串 | 登录状态的客户端标志/缓存 | D |
| `activeHost` | `xhs` | 当前站点 | D |
| `userId`, `userName` | 空字符串 | 当前账号 | D |
| `syncCursors` | `{}` | 按目标保存列表 cursor | D |
| `syncedIds` | `{}` | 按目标保存已同步 note id 数组 | D |
| `allSynced` | `{}` | 按目标标记历史数据已到底 | D |
| `bookmarkCateNextCursor` | `null` | `${boardId}_${cursor}` 形式的专辑恢复点 | D |
| `cateSyncAllBookmark` | `false` | 所选专辑的初始历史同步是否完成 | D |
| `bookmarkCateAllSync` | `{}` | 每个 board id 是否已到底 | D |
| `bookmarkAlbumPollLastId` | `null` | 白名单专辑增量轮询位置 | D |
| `perAccountState` | `{}` | 按 user id 保存六个状态字段，见 8.5 | D |

`authCode`、`expiredAt`、`_qc`、运行时 `_qcSig` 也存在，但属于授权/免费额度逻辑。本阶段仅记录它们是设置键，不分析绕过方式。**D**

## 8. 同步算法、分页与游标

### 8.1 普通 post/bookmark/like

每次 `syncAll()` 只同步 `activeSyncTarget`。流程：

1. 阻止并发重入（`isSyncing`）。
2. 建立 webview 并调用 `/user/me` 验证账号。
3. 从 `syncCursors[target]` 取 cursor；从 `syncedIds[target]` 取去重集合。
4. 只请求一页，数量为 `syncBatchSize`。
5. 对未同步的列表项逐条请求 `/feed` 详情、可选评论、媒体和 AI。
6. 笔记成功写入后才把 `note_id` 放入 `syncedIds[target]`。
7. 只要本页至少成功一条，或整页都已同步，就保存新 cursor。
8. 当 `has_more === false` 时设置 `allSynced[target]=true` 并清空 cursor。

首次到底后，下一次从空 cursor 请求最新一页，依靠 `syncedIds` 跳过旧项，形成增量同步。**D**

如果详情或写入失败且本页没有任何成功项，也不是“整页已同步”，cursor 不推进，下一次会重试同一页。**D**

`syncedIds` 是持续增长的数组，没有看到压缩、上限或迁移到索引结构。长期使用时可能带来设置文件膨胀和线性 `includes()` 成本。**I**

### 8.2 专辑初次历史同步

收藏目标且 `syncAlbums=true`、`cateSyncAllBookmark=false` 时进入专辑历史模式：

- 获取 board 列表并应用 `albumWhitelist`；空结果会结束专辑阶段或回退普通收藏。
- 每次执行实际只处理一个尚未完成的专辑页。
- 恢复点保存在 `bookmarkCateNextCursor = boardId + "_" + cursor`。
- 每个专辑的完成状态写入 `bookmarkCateAllSync[boardId]`。
- 笔记统一写为“收藏”，category 设为专辑名，文件也进入该分类子目录。
- 所选专辑全部到底后设置 `cateSyncAllBookmark=true`。

`bookmarkCateNextCursor` 用下划线拼接后再 `split("_")`，没有转义。如果未来 board id 或 cursor 自身包含下划线，恢复点可能解析错误；当前服务端值是否会包含下划线未知。**I/U**

### 8.3 专辑完成后的模式

若白名单专辑已完成：

- `syncAllBookmarksAfterAlbums=true` 时继续走普通 bookmark 列表；
- 为 `false` 时进入白名单专辑增量轮询；
- 该设置为 `null` 时，代码按“白名单是否为空”决定：白名单非空偏向专辑增量，白名单为空偏向普通收藏。

这是直接控制流的语义化还原。**D**

### 8.4 白名单专辑增量轮询

- 通过 `bookmarkAlbumPollLastId` 在白名单专辑间轮转，每次选一个专辑。
- 最多请求 50 页，每页 `syncBatchSize`。
- 遇到已存在的 `note_id`、`has_more=false` 或空 cursor 时停止向旧数据扫描。
- 收集新项后只取最后 `syncBatchSize` 条并反转，意图按较旧到较新顺序逐批清理积压。
- 有剩余积压时调整轮询位置，使下个周期继续当前专辑。

“意图”部分由切片、反转和轮询位置组合推导；服务端列表实际排序仍需动态确认。**I**

### 8.5 多账号

账号状态交换只发生在登录成功后的 `fetchAndSaveUserName()`：检测到新 `user_id` 与现有 `settings.userId` 不同时，先把旧账号的六个实际字段保存到 `perAccountState[oldUserId]`，再恢复新账号状态；没有记录则用默认空状态初始化。六个字段精确为：`syncCursors`、`syncedIds`、`allSynced`、`bookmarkCateNextCursor`、`cateSyncAllBookmark`、`bookmarkCateAllSync`。`bookmarkAlbumPollLastId` 不属于这份按账号快照。普通同步入口调用的 `RednoteAPI.fetchUserId()` 只读取/缓存当前用户，不执行 `perAccountState` 的保存或恢复。**D**

## 9. 数据模型

### 9.1 列表项最低依赖

```text
note_id
display_title
xsec_token
user.nickname / user.nick_name
```

**D**

### 9.2 详情解析

`extractPost()` 从 `item.note_card` 读取：

| 输出字段 | 来源/规则 | 证据 |
|---|---|---|
| `entryId` | 列表项 `note_id` | D |
| `title` | `display_title`，空时“无标题” | D |
| `fullText` | `note_card.desc` | D |
| `url` | `{web}/explore/{note_id}?xsec_token=...&xsec_source=pc_collect` | D |
| `author` | `user.nickname`，回退 `user.nick_name` | D |
| `createdAt` | `new Date(note_card.time).toISOString()` | D |
| `updatedAt` | `last_update_time` 转 ISO | D |
| `hashtags` | `tag_list[].name` | D |
| 互动计数 | `interact_info.*_count` 经 `parseCount()` | D |
| 图片 | `image_list[].url_default` | D |
| 视频 | `video.media.stream` 选择一路 URL | D |

视频优先检查 `av1/h264/h265/h266` 流组，优先选择包含 H.264 的组，否则取第一个可用组；组内按平均码率降序并取最高项，URL 依次回退 `backup_urls[0]`、`backupUrls[0]`、`master_url`、`masterUrl`。**D**

`parseCount()` 接受 number 或字符串，并把 `万`、`亿` 分别换算为 10,000 和 100,000,000 后四舍五入。**D**

标签处理会去空、去重、按长度升序，删除已有短标签的前缀扩展，最后只保留 3 个。**D**

### 9.3 评论模型

```text
Comment {
  author: user_info.nickname || "匿名"
  content: trimmed content
  likeCount: string
  createdAt: YYYY-MM-DD
  subComments: Array<{ author, content, likeCount }>
}
```

**D**

## 10. 媒体规则

### 10.1 下载器

- 把 `http://` 自动升级为 `https://`。
- 图片超时 30 秒，视频超时 120 秒。
- 最多跟随 5 次 3xx redirect。
- 只接受 HTTP 200；失败返回 `null`，没有重试或指数退避。
- 支持 gzip、deflate、brotli 解压。
- 图片扩展名支持 jpg/jpeg/png/gif/webp/svg；视频支持 mp4/mov/webm/m4v（m4v 归一为 mp4）。

**D**

### 10.2 Vault 路径

```text
{rootFolder}/Media/{noteId}/image-{1-based-index}.{ext}
{rootFolder}/Media/{noteId}/video-{1-based-index}.{ext}
```

二进制文件已存在时不会覆盖。**D**

视频下载失败时 `videoExts` 记空字符串，Markdown 回退到远端 `<video controls>` 和普通链接。**D**

图片下载失败时却把扩展名占位为 `jpg`，随后正文仍生成本地 embed；因为文件没有创建，这会产生失效图片链接。建议独立重写时修复。**D（代码缺陷）**

## 11. Markdown、YAML 与目录规则

### 11.1 笔记路径

```text
普通：{root}/{Posts|Bookmarks|Likes}/{title[0:60]}-{noteId}.md
有分类：{root}/{Posts|Bookmarks|Likes}/{category}/{title[0:60]}-{noteId}.md
```

类型映射：个人帖子→`Posts`，收藏→`Bookmarks`，点赞→`Likes`。**D**

文件名会把 `/ \\ : * ? " < > | # [ ]` 替换为 `_`，压缩空白、移除开头的点并 trim。分类名也做同样处理。**D**

同一路径已存在时使用 `vault.modify()` 整体覆盖，否则 `vault.create()`。**D**

### 11.2 Frontmatter

固定或条件字段：

```yaml
---
resourceId: "..."
type: "个人帖子|收藏|点赞"
author: "..."
url: "..."
likedCount: 0
collectedCount: 0
commentCount: 0
shareCount: 0
tags:
  - "..."
category: "..."
postCreatedAt: 2026-01-01T00:00:00.000Z
postUpdatedAt: 2026-01-01T00:00:00.000Z
syncedAt: 2026-01-01T00:00:00.000Z
---
```

计数只在解析结果是 number 时写入；tags/category/发布时间按存在性写入。YAML 转义不是统一应用：`author`、每个 `tags` 元素和 `category` 会经过 `escapeYaml()`，该函数只把 `"` 变成 `\"` 并把 LF（`\n`）替换为空格，不处理反斜杠本身或 CR（`\r`）；`resourceId` 和 `url` 虽然放在双引号内，却没有调用 `escapeYaml()`。`type` 来自固定映射。**D**

### 11.3 正文顺序

1. `# title`
2. 原始 `fullText`
3. 本地图片 wikilink `![[...]]`
4. 本地视频 wikilink，或失败/未下载时的远端 HTML video＋链接
5. `📷 图片文字` 折叠 callout
6. `🎬 视频逐字稿` 折叠 callout
7. `💬 热门评论` quote callout

**D**

图片 OCR 最多发送 10 张图片。当前同步控制流只在帖子没有视频时执行图片 OCR；包含视频的帖子会跳过图片 OCR。**D**

### 11.4 Obsidian Bases

Obsidian 版本至少 1.9.0 时，插件会创建 `{rootFolder}/📕 小红书.base`，包含全部、最近 7 天、普通画廊、分类画廊和按点赞排序的爆款画廊视图。manifest 的最低应用版本仍是 0.15.0；低于 1.9.0 时只是跳过自动创建 Base。**D**

## 12. AI/转写的外部数据流

这些不是作者同步后端，但启用时会把内容发送到用户配置或第三方服务：

| 功能 | 目标 | 发送内容 | 证据 |
|---|---|---|---|
| 分类 | `{openaiBaseUrl}/chat/completions` | `fullText` 正文前 500 个 JavaScript UTF-16 code units、标签、分类列表 | D |
| 图片 OCR | `{openaiBaseUrl}/chat/completions` | 最多 10 张图片的 base64 data URL | D |
| 转写润色 | `{openaiBaseUrl}/chat/completions` | 原始逐字稿 | D |
| OpenAI 兼容转写 | `{openaiBaseUrl}/audio/transcriptions` | 本地视频/音频数据，UI 提示 ≤25MB | D |
| DashScope ASR | `dashscope.aliyuncs.com` | 媒体 URL/任务请求 | D |
| 火山 ASR | `openspeech.bytedance.com` | 媒体 URL/任务请求 | D |
| 腾讯云 ASR | `asr.tencentcloudapi.com` | URL 直传请求 | D |

代码中还存在作者 Supabase 授权服务和设备绑定流程。本阶段按边界不展开、不复刻且不提供绕过方法；业务同步正文的主要路径是小红书 API→本地 Vault，未看到把正文发送给该授权服务的可达调用。**D（当前客户端调用图）**

是否存在服务端日志、代理或 DNS 层面的额外采集无法由该客户端静态样本证明。**U**

## 13. 错误、限流与定时行为

### 13.1 错误产生与传播边界

| 位置/情况 | 本层行为 | 证据 |
|---|---|---|
| Webview 30 秒未加载 | 抛错并重置 webview 引用/ready 状态 | D |
| `SignManager.signedGet()` / `signedPost()` 收到 HTTP 461 或 406 | 抛出带相同 `cause` 的限流错误 | D |
| `RednoteAPI.handleResponse()` 收到 body `code=300013` 且 `success=false` | 抛出 `cause=300013` 的频率限制错误 | D |
| `RednoteAPI.handleResponse()` 收到 body `code=-100/-101` | 抛出相应登录失效错误 | D |
| 普通 `getPosts()` 列表请求 | 没有局部 catch；上述 cause 会向调用者传播 | D |
| `getNoteDetail()` / `getComments()` | catch 所有错误；只重新抛出 `300013`，461、406、-100、-101 和普通错误均记录后返回 `null` | D |
| 媒体/AI 普通错误 | 记录日志并降级，不中止整批同步 | D |
| 同步重入 | Notice“同步正在进行中...”，不启动第二次 | D |

专辑两条分支的吞错范围不同：

- `syncBookmarkAlbums()` 的初始 `getUserBoards()` 位于逐专辑 try/catch 之外，错误会向上冒泡；逐专辑处理（包括 `getBoardNotes()`）位于 catch 内，该 catch 只重新抛出 `300013`，会记录并吞掉 461、406、-100、-101 和普通错误后终止该轮专辑循环。其详情/评论仍遵循上表，只让 `300013` 逃出 helper。**D**
- `syncWhitelistAlbumsIncremental()` 没有包住 `getUserBoards()`、`getBoardNotes()` 和 `writeAlbumNote()` 的同类外层 catch，因此 board 列表/笔记列表错误的全部 cause 都会继续冒泡；进入 `writeAlbumNote()` 后，详情/评论仍只会重新抛出 `300013`。**D**

只有错误实际一路冒泡到 `syncAll()`，才触发顶层全局副作用：`300013`、461、406 会关闭自动同步；-100、-101 会在顶层清空 `cookies`、`a1Cookie`、`userName`，保存设置并关闭自动同步。另一个更早的特例是 `fetchUserId()` 识别 guest 时会自行清空 `cookies`、`a1Cookie`、`userId`、`userName` 并抛出 -100。被上述详情、评论或专辑 catch 吞掉的错误不会触发 `syncAll()` 的关闭自动同步/清登录逻辑。**D**

没有发现业务 API 的自动重试、退避或 jitter。到达 `syncAll()` 的限流会关闭自动同步，而不是等待后继续；局部吞掉的限流则只记录/降级。**D**

定时器周期是 `syncIntervalMinutes * 60 * 1000`。启动时，如果距 `lastSyncAt` 已超过一个周期，会用 0ms timeout 立即触发一次。**D**

`syncAll()` 的成功尾序精确为：先 `await syncType(...)` 完成目标同步；再设置 `lastSyncAt=Date.now()` 并 `saveSettings()`；随后调用 `BaseWriter.ensureBase().catch(...)`，Base 失败只记录、不会回滚已保存时间；最后显示“同步完成”提示。**D**

## 14. 已识别的重写风险

1. **签名耦合页面环境**：`window.mnsv2` 和若干 storage/cookie 字段可随站点发布变化。**D/I**
2. **`syncedIds` 无界增长**：应在新实现中考虑 SQLite/索引表，而不是把所有 id 存设置 JSON。**I**
3. **图片失败仍生成本地链接**：应改为远端图片回退或明确失败状态。**D**
4. **专辑复合 cursor 未转义**：应把 board id 和 cursor 分字段持久化。**D/I**
5. **评论只取首屏**：若目标是完整备份，需要另写评论分页。**D**
6. **无退避策略**：独立实现需要集中处理 300013/461/406，并加入可中断退避和速率预算。**D/I**
7. **外部 AI 数据流**：新实现必须让用户明确选择供应商并说明正文、图片或媒体会被发送。**D/I**

## 15. 未解决问题

- 各接口在当前日期是否仍可用、字段是否完整兼容。**U（需要自己的账号动态验证）**
- `window.mnsv2` 在两种域名、不同地区账号下的可用性和更新频率。**U**
- 服务端排序是否始终是新→旧，尤其是专辑增量的 `slice(-batch).reverse()` 假设。**U**
- `has_more`、cursor 在空页、删除笔记、置顶笔记时的边界语义。**U**
- API 的实际安全速率、封禁阈值与恢复时间。**U**
- 无 source map，原始变量名、注释、TypeScript 类型和源文件拆分无法完全恢复。**U/不可恢复**

## 16. 阶段一验收清单

- [x] 只分析指定的 `main.js`、`manifest.json`、`styles.css`。
- [x] 未读取 `prototypes/test-cookie.txt`、`prototypes/xsec_token.txt`。
- [x] 未联网、未动态登录、未调用小红书或作者服务。
- [x] 未 import/require/eval/执行插件 bundle。
- [x] 识别客户端入口与主要模块。
- [x] 列出全部默认设置键和增量状态键。
- [x] 列出双 host 与 8 个小红书业务 endpoint。
- [x] 还原普通列表、专辑历史、专辑增量与多账号状态流。
- [x] 还原详情/评论统一数据模型。
- [x] 还原媒体下载、文件路径、Markdown/YAML/Base 规则。
- [x] 还原限流、登录失效、超时与降级行为。
- [x] 对结论标注 D/I/U 证据等级。
- [x] 提供精确哈希锁定、路径碰撞保护和原子输出的安全静态提取工具。
- [x] `node:test` 在临时目录覆盖 source=output、两个输出相同、hardlink/symlink 碰撞、实际大小写不敏感卷上的大小写变体、正常写入和错误哈希。
- [ ] 未做动态协议验证；留待经用户授权的后续阶段。

复核命令：

```bash
node --check research/reverse/tools/extract_obsidian_strings.mjs
node --check research/reverse/tools/extract_obsidian_strings.test.mjs
node --test research/reverse/tools/extract_obsidian_strings.test.mjs
node research/reverse/tools/extract_obsidian_strings.mjs \
  research/reverse/targets/rednote2obsidian/samples/main.js \
  /tmp/obsidian-strings.tsv \
  /tmp/obsidian-deobfuscated.js
shasum -a 256 \
  research/reverse/targets/rednote2obsidian/samples/main.js \
  research/reverse/targets/rednote2obsidian/samples/manifest.json \
  research/reverse/targets/rednote2obsidian/samples/styles.css
```
