# Rednote2Notion 浏览器客户端静态逆向（阶段二）

## 1. 结论摘要

当前发布包足以支撑“独立同步核心”的协议设计，而不需要复刻浏览器插件 UI。可直接恢复的核心包括：小红书/RedNote 双 host、7 个业务接口、页面环境签名、三类同步任务、普通与专辑游标、Notion 数据库发现与页面写入、图片上传、视频嵌入、文本 AI 分类以及部分多账号状态迁移。

最重要的边界结论：

- 当前列表/详情主路径走已登录站点标签页中的 `window.mnsv2`，通过 `chrome.scripting.executeScript({ world: "MAIN" })` 注入；`user/me` 仍走本地 legacy `signXs()`。两条当前路径都没有调用作者的远端签名服务。**D**
- `https://memohub-api.notionify.net/sign/xhs` 存在于配置常量，但当前 background 和已核对 UI 调用图中没有调用点，应视为未使用/遗留能力，而不是当前数据流。**D（当前样本调用图）**
- 小红书正文直接从官方 API 进入扩展；正文、属性和图片直接写入 `api.notion.com`。没有发现正文经作者 Supabase 或 `notionify.net` 转发。**D（当前客户端调用图）**
- 作者 Supabase 用于授权码查询和绑定。绑定载荷包含从 Notion 工作区查询出的用户 id、邮箱和用户名；该 `update` 载荷不包含原始 `notionSecret`。**D**
- `web_session` 会被复制到明文 `rednote-auth-token`；`authCode`、`notionSecret` 和 AI API key 也都明文保存在 `chrome.storage.local`，且 `databaseDictCredsSig` 会再次以 `${notionSecret}::${pageId}` 保存完整 Secret。**D**
- 同步对象的 URL 含 `xsec_token`，会写入 Notion `Url` property；AI 分类不接收该 URL/token。当前 console 还会暴露 Cookie、完整 API 响应、Supabase auth record 和持 Notion token 的 client 对象。**D**
- 客户端不创建 Notion 数据库 schema；它递归发现页面下已有的“帖子/笔记/分类/标签”子数据库，只创建帖子页面及缺失的分类/标签关系页面。**D**

本报告只做离线静态分析。没有加载或执行任何扩展 bundle，没有发起网络请求，没有读取 `prototypes/test-cookie.txt` 或 `prototypes/xsec_token.txt`，也没有尝试绕过授权或许可证。

证据等级沿用阶段一：

- **D（直接证据）**：当前哈希锁定样本的 manifest、常量、可达调用点或控制流直接支持。
- **I（推断）**：由多处直接证据组合推导，但未经运行时流量验证。
- **U（未知）**：静态样本无法确认，或需要自己的账号动态验证。

## 2. 样本身份与取证边界

当前 manifest：

| 属性 | 值 | 证据 |
|---|---|---|
| name | `Rednote2Notion` | D |
| version | `1.0.6` | D |
| author | `ewing` | D |
| manifest | Chrome MV3 | D |
| background | `static/background/index.js` service worker | D |
| framework | Parcel 打包的 Plasmo 扩展 | D |
| Notion SDK | `@notionhq/client` `3.1.2` | D（bundle 内 package metadata） |

当前工作区关键工件：

| 文件 | bytes | SHA-256 | 证据 |
|---|---:|---|---|
| `manifest.json` | 1,433 | `cf75c9ed560b95e91fee31904336d378f1866b79174c8ee5bdecf598ee4dcfda` | D |
| `static/background/index.js` | 765,831 | `31aac68e5e6a473eb2ba7962a112cad7cdd87d809fb92bda3df1d0b136d6ecf7` | D |
| `content-script.965f3134.js` | 31,003 | `b08c18c0d7173278715a143ef963b5454c69c7b8681529360e1a725c0d540c83` | D |
| `sidepanel.b7741352.js` | 5,653,404 | `7a4d4c84068bb65f2a34036d4220c6db9ba3602b56a9ccb65655f1811e1c721e` | D |
| `options.95eda3f3.js` | 334,886 | `963d7ac7d9474bcc8b471dd6b5c4fce8791ab2c4e8ad2c2942421147a52addf7` | D |
| `popup.100f6462.js` | 346,597 | `02e97e2623a5c20747d40cdfae74ba32264b91349221ca7b3a0f182d5dd46029` | D |
| `openai.1a4755c2.js` | 377,374 | `64931418c7f38d4d37e47d26e3c30cab8cbbbbf1a228ed9fd9ad7c2d4e4fa7d9` | D |
| `browser.4ceded9e.js` | 2,778 | `38fbdfb3dbf5d3106758d0bfdcca16086a4b482dfee859c321042f334b783ae4` | D |
| `rules.6316ad31.json` | 1,002 | `07fb7dce2f1f1de31facb241a8f09f43e4e7d790c5d52c8279f0830adb741bcc` | D |

`background` 基本未做业务级混淆；`content-script` 主要是属性名与字符串拼接混淆；5.65 MB 的 `sidepanel` 同时包含 React/UI、供应商 SDK和重复业务模块，混淆较重。本阶段只核对与独立同步核心有关的入口、设置、授权边界和数据流，没有尝试完整还原 UI。**D（分析范围）**

## 3. 静态提取方法

新增：

```text
research/reverse/tools/extract_notion_background.mjs
research/reverse/tools/extract_notion_background.test.mjs
```

提取器只把 background 当 UTF-8 文本处理：

1. 在读入后校验 SHA-256 必须精确等于本报告锁定值。
2. 用 Parcel 模块记录的文本边界建立 module id、byte offset 与依赖标签索引。
3. 不 `import`、`require`、`eval`、`vm` 或执行 bundle，也不把 bundle 当可执行模块加载。
4. 拒绝 source、index output、module dump 之间的 resolved path、真实路径或 inode 碰撞；在 Darwin/Windows 还用 Unicode NFC + lower-case 的保守身份拒绝仅大小写或规范化形式不同的路径。
5. 先写同目录独占临时文件，再原子 rename。

当前样本识别出 199 个 Parcel module record。工具是当前哈希的取证辅助，不声称适用于其他发布包。**D（工具边界）**

`node:test` 精确断言当前样本有 199 个 index rows 和 199 个 module dump records，并覆盖正常提取、source/output 同路径、hard link、symlink、两个输出碰撞、错误哈希，以及仅在临时目录实际大小写不敏感时运行的未存在大小写变体输出测试；当前环境为 5/5 通过。**D**

## 4. MV3 / Plasmo 架构与职责

```text
小红书 / RedNote 标签页
  ├─ content script：识别 host、检查 user/me、更新身份、通知后台
  └─ MAIN world 注入：调用 window.mnsv2 生成签名
                 │
                 ▼
background service worker
  ├─ Plasmo message router
  ├─ 三个 chrome.alarms 任务
  ├─ RednoteAPI / 游标 / 去重 / 多账号
  └─ Notion SDK / AI provider
                 ▲
                 │ chrome.storage.local + runtime messaging
side panel：登录、同步开关、Notion/AI/专辑/游标设置
```

### 4.1 Background service worker

职责：

- 注册 `account-switch`、`clear-cache`、`get-cookie`、`stop-all-sync`、`sync-to-notion` 五个消息处理器。
- 读取三个同步开关并恢复 alarm。
- 调度个人帖子、收藏、点赞。
- 读取 Cookie jar、调用 XHS/RedNote、生成签名、做游标和去重。
- 直接调用 Notion SDK 和用户配置的 OpenAI 兼容 API。
- 设置 `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` 并启动 Plasmo pub-sub hub。**D**

### 4.2 Content script

manifest 将它注入：

```text
https://www.xiaohongshu.com/*
https://www.rednote.com/*
```

在 xiaohongshu.com：

1. 直接以 `credentials: include` 调用 `/api/sns/web/v2/user/me`。
2. guest/无 user id 时清除身份键并发送 `stop-all-sync`。
3. 检测 `rednote_last_user_id` 变化后发送 `account-switch`。
4. 更新 active host、user id、nickname，再发送 `get-cookie`。**D**

在 rednote.com：content script 只设置 active host 并委托 background 做 `get-cookie`；当前分支不调用 `user/me`，也不执行账号切换检测。RedNote 域账号切换状态是否会被正确迁移为 **U**，静态代码显示它与 XHS 分支不对称。**D/U**

### 4.3 Side Panel

这是主要功能 UI：

- Notion/授权初始化；
- 三个同步开关；
- 当前小红书账号与错误提示；
- `syncTags`、`syncAlbums`；
- AI base URL、model、API key、测试和启用开关；
- 三个普通同步 cursor 的手工查看/编辑；
- Notion Secret、目标 Page 与授权码的保存。**D**

sidepanel bundle 带有重复的 API/同步模块，但 MV3 后台任务和 alarm 的权威实现位于 background。重复模块在 UI 运行时是否存在额外可达业务调用，本阶段没有穷尽，按 **U** 处理；独立同步核心不应复制这种打包重复。 

### 4.4 Options 与 Popup

两者当前仍是 Plasmo starter 示例页面：Options 显示 “This is the Option UI page”，Popup 显示 “Welcome to your Plasmo Extension” 和文档链接，没有业务同步职责。**D**

manifest 同时声明 `action.default_popup`，background 又要求 action click 打开 Side Panel；实际 Chrome 版本对两者冲突时的最终 UI 行为需要动态确认。**U**

### 4.5 消息表

| message | 发起方 | background 行为 | 返回/错误 | 证据 |
|---|---|---|---|---|
| `account-switch` | content script | snapshot old、restore new | `{success,error?}` | D |
| `clear-cache` | UI | 发起删除三个目标的 `nextPos/allSync` 和遗留 Flomo/Keep 键，但删除 Promise 未 await | `{success,error?}` 会先返回 | D |
| `get-cookie` | content script/UI | 从两个 web host 查询 `web_session` 并写 `rednote-auth-token` | 无显式 send | D |
| `stop-all-sync` | content script | 清三 alarm 并关闭三个 sync status | `{success,error?}` | D |
| `sync-to-notion` | sidepanel | 根据 value 启停单个目标 alarm | handler 无显式 send | D |

`onMessageExternal` 监听器当前只读取 `message.name` 并返回 true，没有业务处理或响应。**D**

## 5. 权限、Host、Cookie 与签名

### 5.1 权限

manifest 权限：`storage`、`sidePanel`、`cookies`、`tabs`、`alarms`、`scripting`、`declarativeNetRequest`、`declarativeNetRequestWithHostAccess`。host permissions 覆盖：

- `https://*.xiaohongshu.com/*`
- `https://*.rednote.com/*`
- `https://api.notion.com/*`
- `https://*.notionify.net/*`

`rules.6316ad31.json` 对 XHR 设置：

- `edith.xiaohongshu.com` → `Origin: https://www.xiaohongshu.com`
- `webapi.rednote.com` → `Origin: https://www.rednote.com` **D**

### 5.2 双 host

| id | web / signOrigin | API | 登录 URL | 额外业务头 | 证据 |
|---|---|---|---|---|---|
| `xhs` | `https://www.xiaohongshu.com` | `https://edith.xiaohongshu.com` | `/login` | 无 | D |
| `rednote` | `https://www.rednote.com` | `https://webapi.rednote.com` | 仍配置为 XHS `/login` | `xy-common-params: mlanguage=en_us` | D |

active host 存在 `rednote_active_host`；不是精确 `rednote` 时回退 XHS。**D**

### 5.3 Cookie 与登录态

- 业务 `fetch` 统一设置 `credentials: "include"`，因此真正请求登录态来自 Chrome 对目标 API host 的 Cookie jar。**D**
- background 的 `get-cookie` 会分别查询两个 web host 的 `web_session`，把找到的值写入同一 `rednote-auth-token`。两个异步 callback 无顺序保证，双 host 同时存在时最终值可能由最后回调覆盖。**D/I**
- `rednote-auth-token` 主要作为 UI 授权状态；业务 API 没有把它拼成显式 Cookie header。**D**
- legacy signer 会用 cookies API 读取当前 web host 的 `a1`。当前列表和详情主路径则由页面注入器直接读取 `document.cookie` 的 `a1`。**D**

### 5.4 当前签名主路径

`signViaInject(pathOrPathWithQuery, optionalBody, signOrigin)`：

1. 查找 `${signOrigin}/*` 标签页；没有就创建 inactive `${signOrigin}/explore`。
2. 等待加载 complete，再额外等 2 秒；创建的标签页不会被关闭。
3. 在 MAIN world 执行签名函数。
4. GET 签名输入为 path + query；POST 为 path + `JSON.stringify(body)`。
5. 调用页面的 `window.mnsv2(urlString, md5(urlString), md5(bodyString))`。
6. 读取 `a1` Cookie、localStorage 的 `b1`、`b1b1`、`dsllt` 和页面 `_dsl`。
7. 返回 `x-s`、`x-t`、`x-s-common`、随机 `x-b3-traceid`。**D**

详情和列表使用上述四个头；`user/me` 的 `getUserId()` / `verifyLoggedIn()` 仍使用 bundle 内 legacy `signXs()`，只附 `x-s`。**D**

bundle 还保留：

- legacy MD5 + AES-CBC `XYW_...` signer；
- 本地 `rednote-sign-v4` 的 `XYS_...` 实现；
- `MEMO_XHS_SIGN_URL=https://memohub-api.notionify.net/sign/xhs`。

但当前 RednoteAPI 的列表/详情调用点选择 `signViaInject`；远端 sign URL 仅从配置模块导出，在当前 bundle 调用图中没有引用；v4 signer 只有定义，没有发现内部调用。**D**

## 6. 小红书 / RedNote API

| 方法 | 路径 | 主要输入 | 用途 | 证据 |
|---|---|---|---|---|
| GET | `/api/sns/web/v2/user/me` | 无 | 登录验证、user id | D |
| GET | `/api/sns/web/v1/user_posted` | `num,cursor,user_id,image_formats,xsec_*` | 个人帖子 | D |
| GET | `/api/sns/web/v2/note/collect/page` | 同普通列表 | 收藏 | D |
| GET | `/api/sns/web/v1/note/like/page` | 同普通列表 | 点赞 | D |
| POST | `/api/sns/web/v1/feed` | `source_note_id,image_formats,extra.need_body_topic,xsec_source,xsec_token` | 详情 | D |
| GET | `/api/sns/web/v1/board/user` | `user_id,page,num,image_formats,xsec_*` | 收藏专辑 | D |
| GET | `/api/sns/web/v1/board/note` | `board_id,num,cursor,image_formats` | 专辑笔记 | D |

普通列表默认模型：

```text
num=30                 // 同步调用覆盖为 5
cursor=""
user_id=""
image_formats="jpg,webp,avif"
xsec_token=""
xsec_source=""
```

详情 body：

```json
{
  "source_note_id": "...",
  "image_formats": ["jpg", "webp", "avif"],
  "extra": { "need_body_topic": "1" },
  "xsec_source": "pc_user",
  "xsec_token": "..."
}
```

Notion 版没有评论 endpoint，也没有阶段一 Obsidian 版的热门评论同步。**D**

## 7. 调度、批次和并发

固定配置：

| 项 | 值 | 证据 |
|---|---:|---|
| 普通 interval | 10 分钟 | D |
| 普通 batch | 5 | D |
| 专辑 batch | 3 | D |
| keep-alive read | 每 15 秒读取 `chrome.storage.local.keepAlive` | D |

三个目标各有一个独立 alarm：

```text
sync-rednote-post-to-notion
sync-rednote-bookmark-to-notion
sync-rednote-like-to-notion
```

`startSyncAlarm()` 仅在 alarm 不存在时创建，并立即执行一次 callback；已存在时不会立即执行。service worker 初始化会读取三个 sync status，并尝试恢复 alarm。**D**

alarm 触发时先读取 `expiredAt`；存在且已过期则直接返回。首次创建 alarm 的立即 callback 直接进入同步 wrapper，不经过 `handleAlarmEvent()` 的到期检查；UI 在开关路径另做授权码/到期校验。新实现不应复制这种分散校验。**D（控制流边界）**

每个目标有自己的 `isSyncInProgress`，只阻止同一目标重入；background 没有跨目标全局 mutex。三个 alarm 理论上可以并发访问同一 Notion DB 和同一 XHS 会话。**D/I**

没有业务级自动重试、退避、jitter 或速率预算。OpenAI SDK 自身默认最多重试 2 次，但这不等于同步任务重试。**D**

每个同步 wrapper 在 `await` 核心任务之前创建 keepAlive interval，但 `clearInterval()` 位于正常完成路径，不在 `finally`。若核心任务在到达该语句前向 wrapper 抛出异常，外层虽然会记录错误并在 `finally` 重置 `isSyncInProgress`，interval 仍可能继续存活。**D（资源泄漏边界）**

## 8. 普通同步：游标、去重与恢复

个人帖子、普通收藏、点赞共享同一算法：

1. 创建 `SyncNotion`，发现数据库并初始化 AI。
2. 从 `insertPosts_{POST|BOOKMARK|LIKE}` 读取本地去重 id JSON 字符串。
3. `verifyLoggedIn()`。
4. 读取目标 `nextPos`；为空且 `allSync` 未置位时，从 Notion 恢复 cursor。
5. 请求一页，batch=5。
6. 跳过已存在 id；其他条目逐条取详情、组装统一对象、可选 AI。
7. 逐条创建 Notion 页面；全部成功后更新去重 cache。
8. 只在“至少成功插入一条”或“本页重复数 >= batch”时推进 API cursor；`has_more=false` 时设置 `allSync=1` 并清 cursor。**D**

空页处理并不一致：个人帖子和点赞在 `notes.length===0` 时直接 return，即使响应同时给出 `has_more=false`，也不会设置 `allSync` 或清 cursor；普通收藏没有这个提前 return，会继续执行 `has_more=false` 的收尾。**D**

去重 cache 为空时，客户端会查询 Notion“帖子”库中该类型的全部页面，提取 `properties.resourceId.rich_text[0].plain_text`，再回写本地 cache。**D**

cursor 恢复不是读取一个专门 cursor 字段：它查询该类型按 Notion `创建时间` 降序的最新页面，返回其 `resourceId`。客户端隐含假设列表 cursor 可以接受已同步 note id；是否对当前服务端始终成立为 **U**。**D/U**

如果一页少于 batch 且全部都是重复项，`duplicates.length >= batch` 不成立，代码不会推进 cursor，也不会执行 `has_more=false` 的收尾，可能在末页反复停留。**D（边界缺陷）**

Notion 创建中途失败时，`syncToNotion()` 会把目标 `nextPos` 写成“本批最后成功插入的 entryId”，并持久化已成功 id 后重新抛错。外层普通同步捕获并记录；下一轮从这个 id 恢复。**D**

## 9. 收藏专辑

当 `syncAlbums=true` 且 `cate_sync_all_bookmark` 未置位时进入专辑历史模式：

- 主路径只调用一次 `getUserBoards(1, 50)`，因此只取得首批最多 50 个 board；没有 whitelist，也没有 board 列表翻页。
- 每次调用只处理第一个未完成专辑的一页，然后 `break`。
- batch 固定 3。
- cursor 保存为 `${boardId}_${cursor}`。
- 每专辑完成键为 `rednote_bookmark_all_sync_${boardId}`。
- 首批返回的专辑全部完成时设置 `cate_sync_all_bookmark=1`。
- 专辑名直接作为 category；此路径不调用 AI 分类。**D**

专辑请求 batch 是 3，但“本页是否全重复”的推进条件误用了普通同步 batch 5。若一页正好返回 3 条且三条都已去重，`duplicates.length >= 5` 不成立，cursor 不推进，可能反复停在该页。**D（边界缺陷）**

复合 cursor 通过 `split("_")` 取前两段，未转义；board id 或 cursor 含下划线时可能解析错误。**D/I**

专辑模式完成后，下一轮走普通收藏列表。当前 Notion 版没有阶段一 Obsidian 版的 whitelist 专辑轮询与 `syncAllBookmarksAfterAlbums` 分支。**D**

`getUserBoards()` 会把 STOP cause 包装成普通 `Error`；专辑页外层 catch 又吞掉 `getBoardNotes()` 和详情错误。因此专辑路径遇到 461/406/-100 时可能只记录错误而不关闭同步开关。**D**

## 10. 多账号和缓存清理

账号切换状态根为 `rednote_per_account_state`。静态键：

```text
rednote_post_next_cursor
rednote_post_prev_cursor
rednote_post_all_sync
rednote_bookmark_next_cursor
rednote_bookmark_prev_cursor
rednote_bookmark_all_sync
rednote_bookmark_cate_next_cursor
cate_sync_all_bookmark
rednote_like_next_cursor
rednote_like_prev_cursor
rednote_like_all_sync
```

另动态保存所有 `rednote_bookmark_all_sync_*`，但排除普通 `rednote_bookmark_all_sync`。**D**

切换时先 snapshot old，再清当前键和 `rednote_error_notice`，然后 restore new。成功 restore 后会删除 `perAccountState[newUserId]` 中的快照，因此快照是一次性取出，不是永久镜像。**D**

下列状态不按账号 snapshot：

- `insertPosts_POST/BOOKMARK/LIKE` 去重 cache；
- `rednote_active_host`、Notion/AI 配置；
- sync status；
- `rednote_last_user_id`。**D**

`clear-cache` 只清普通 `nextPos/allSync` 和遗留的 Flomo/Keep 键；它不清 `prevPos`、专辑复合 cursor、逐专辑完成键或 `insertPosts_*` 去重 cache。**D**

这些 `storage.remove()` 调用没有被 `await`；handler 会先发送 `success:true`，外层 `try/catch` 也捕获不到随后发生的异步删除失败。因此“成功”只表示删除已发起，不证明所有键已删除。**D**

## 11. 统一笔记模型与媒体

同步对象：

```text
entryId       <- list.note_id
title         <- list.display_title（Notion insert 时空值改“无标题”）
fullText      <- detail.note_card.desc
url           <- {activeWeb}/explore/{id}?xsec_token=...&xsec_source=pc_collect
author        <- list.user.nickname；专辑路径用 nick_name
createdAt     <- note_card.time -> ISO
updatedAt     <- note_card.last_update_time -> ISO
media         <- images + videos
hashtags      <- tag_list[].name（受 syncTags 控制）
category      <- AI 结果 / 专辑名 / null
```

没有互动计数、评论、OCR 或视频转写字段。**D**

这里的 `url` 明文包含列表返回的 `xsec_token`。它会作为 Notion 页面的 `Url` property 发送到 `api.notion.com` 并持久化；AI 分类只接收正文、tags 和分类标题，不接收该 URL 或 `xsec_token`。**D**

标签会去空、去重、按长度升序并去掉已有短标签的前缀扩展，最终保留 3 个。**D**

图片使用 `image_list[].url_default`。视频从 `stream` 中按 `av1 → h264 → h265 → h266` 选第一个非空 codec 组，并把组内每个 stream 的 `backup_urls[0]` 都加入 media；没有码率排序。**D**

## 12. Notion 数据库、页面、块与媒体

### 12.1 数据库发现而非创建

初始化从 `notionPage` 提取 32 位或 UUID page id，递归调用 `blocks.children.list`，收集 `child_database.title → id`：

| 中文标题 | 内部键 | 当前用途 |
|---|---|---|
| 帖子 | `post` | 所有三类笔记页面 |
| 笔记 | `note` | 当前同步主路径未用 |
| 分类 | `category` | category relation |
| 标签 | `tag` | tag relation |

没有 `databases.create` 调用。数据库不存在时不会自动补 schema。递归发现对每个 block id 只调用一次 `blocks.children.list`，没有消费 `has_more` / `next_cursor`；任一层级超过单次响应容量时，后续 child database 会被漏掉。**D**

数据库字典缓存在 `databaseDict`；credential signature 是 `${notionSecret}::${pageId}`。凭据变化时清缓存并重新发现。**D**

### 12.2 页面 properties

“帖子”数据库页面属性：

| 属性 | Notion 类型/来源 | 证据 |
|---|---|---|
| `resourceId` | rich_text / note id | D |
| `标题` | title | D |
| `类型` | select：个人帖子/收藏/点赞 | D |
| `分类` | relation 到分类 DB | D |
| `标签` | relations 到标签 DB | D |
| `作者` | multi_select；逗号替换为空格 | D |
| `Url` | url | D |
| `帖子创建时间` | date, Asia/Shanghai | D |
| `帖子修改时间` | date, Asia/Shanghai | D |
| `创建时间` | 客户端当前时间 | D |
| `修改时间` | 客户端当前时间 | D |

创建前会 retrieve database schema，并删除不存在的 property，降低模板差异导致的错误。分类/标签 relation 项不存在时会在对应数据库创建新页面。**D**

### 12.3 正文和媒体

1. 创建帖子 page，使用固定小红书远端 PNG 作为外部 icon。
2. append 一个 paragraph，内容为完整 `fullText`。
3. 每张图片：浏览器先 fetch 远端 URL → Blob，再走 Notion `fileUploads.create` + `fileUploads.send`，最后 append `file_upload` image block。
4. 每个视频：append external embed block，不上传视频。**D**

`getBlockParagraph()` 没有使用同模块的 1024 截断常量；长正文能否满足当前 Notion rich text 限制需动态验证。**D/U**

`appendBlocks()`、`createFileUpload()`、`sendFileUpload()` 捕获错误后返回 `undefined`，调用者多数不检查。因此页面 properties 创建成功后，即使正文或媒体失败，该 note 仍可能进入已同步 cache。**D（数据完整性风险）**

## 13. AI 分类

配置键：`openaiApiKey`、`openaiBaseUrl`、`openaiModel`、`enableAiClassify`。SDK 设置 `dangerouslyAllowBrowser: true`，直接从扩展发请求。**D**

分类输入：

- 完整 `fullText`；
- 处理前的当前 tags；
- 从 Notion“分类”数据库读取的全部标题；
- 中文 system prompt 和选择规则。**D**

请求为 OpenAI 兼容 `chat.completions.create`，`max_tokens=100`、`temperature=0.3`。配置测试发送固定英文测试消息，`max_tokens=10`、`temperature=0.1`。**D**

模型返回会依次尝试：大小写精确匹配、互相包含、去符号后匹配；仍失败则取第一个分类。分类调用内部失败时也取第一个分类，但上层 `SyncNotion.aiClassify()` 的异常 fallback 实际返回空字符串。**D**

## 14. 网络目标、凭据与正文流向

| 目标 | 直接调用方 | 发送内容/凭据 | 正文是否可能到达 | 证据 |
|---|---|---|---|---|
| XHS / RedNote 官方 API | content/background | Cookie jar、签名头、cursor/note id | 来源端 | D |
| `api.notion.com` | background/sidepanel helper | `notionSecret` Bearer、properties、正文、图片 bytes | 是 | D |
| 用户配置 AI base URL | background/sidepanel test | AI API key、正文、tags、分类列表 | 启用 AI 时是 | D |
| 作者 Supabase | sidepanel | auth code；绑定时 Notion user id/email/name | 当前绑定 payload 否 | D |
| `memohub-api.notionify.net` | 无当前调用点 | 配置中有 auth/sign URL | 未见 | D（当前调用图） |
| `auth.notionedu.com` | 浏览器 OAuth 链接 redirect | OAuth code 流具体回传未还原 | 未见正文 | D/U |
| `notes2notion.notionify.net` / `rednote.2notion.com` | UI 导航 | 打开主页/帮助 | 否 | D |

授权绑定的直接控制流：

1. 用户输入 Notion Secret、Page、授权码。
2. `AuthCode.saveAndBindAuthCode(secret, code)` 用 Secret 直接调用 Notion `users.list`。
3. 取第一个 person user 的 id、email、name。
4. Supabase `auth_code` 表按 `code` 查询；未绑定则 update `user_id,email,user_name`。
5. 本地保存 `authCode`、`notionSecret`、`notionPage` 和 `expiredAt`。**D**

### 14.1 本地明文持久化

| 本地键/值 | 内容 | 边界 | 证据 |
|---|---|---|---|
| `rednote-auth-token` | 从 web host Cookie 读取后复制的 `web_session` | 明文 `chrome.storage.local`；两个 host 共用一个键 | D |
| `authCode` | 作者服务授权码 | 明文 `chrome.storage.local` | D |
| `notionSecret` | Notion integration secret | 明文 `chrome.storage.local` | D |
| `databaseDictCredsSig` | `${notionSecret}::${pageId}` | 再次包含完整 Notion secret | D |
| `openaiApiKey` | 用户 AI provider key | 明文 `chrome.storage.local` | D |

同步对象 URL 中的 `xsec_token` 也会进入 Notion `Url` property，因此它不仅存在于扩展内存，还会发送并持久化到用户的 Notion 工作区。**D**

### 14.2 本地 console 暴露面

当前 bundle 的调试日志会输出敏感或高信息量对象，包括：Cookie 查询结果中的 `web_session` / `a1`、完整 `user/me` 响应、带查询参数的列表 URL、完整 note detail（含正文和媒体）、Supabase `auth_code` 查询记录，以及内部持有 Notion token 的 NotionDb/client 对象。它们没有构成报告中已确认的远端转发，但会出现在扩展 service worker 或 Side Panel 的本地开发者工具日志中。**D**

报告不复述 bundle 内固定的 Supabase public/anon credential 字面值；它不改变上述请求与数据流边界。

静态样本不能证明远端日志、RLS、代理、DNS 或服务端内部处理。**U**

## 15. 错误传播与降级

| 位置/错误 | 行为 | 证据 |
|---|---|---|
| HTTP 461 / 406 | 设置限频提示，抛 `cause=STOP_SYNC` | D |
| body `code=-100, success=false` | 设置登录过期提示，抛 STOP | D |
| `verifyLoggedIn()` guest/无 id | 清身份键，抛 STOP | D |
| 普通 list 请求 | STOP 继续冒泡 | D |
| `getNoteDetail()` | STOP 重抛；其他错误记录后返回 undefined | D |
| 普通三目标顶层 | STOP 清 alarm 并关闭对应 sync status；其他错误只记录 | D |
| `getUserBoards()` | 包装所有错误，丢失 STOP cause | D |
| 专辑 page/详情 | 外层 catch 记录并吞掉，包括 STOP | D |
| Notion page create | 抛错；保存批内成功进度后由目标顶层记录 | D |
| Notion append/upload | helper 吞错，可能形成不完整但已去重页面 | D |
| AI 失败 | 分类 fallback，不中断同步 | D |

当前 Notion 版没有检查阶段一 Obsidian 版处理的 body code `300013`，也没有处理 `-101`。是否由当前服务器改为 HTTP 461/406 表达这些状态，需要动态验证。**D/U**

## 16. 与 Obsidian 阶段一的 delta

| 维度 | Obsidian v1.2.3 | Notion v1.0.6 | 证据 |
|---|---|---|---|
| 宿主 | Electron/Obsidian 桌面插件 | Chrome MV3/Plasmo | D |
| 会话容器 | 持久 hidden webview partition | 真实 Chrome tab + Cookie jar | D |
| 当前签名 | webview 页面 `window.mnsv2` | 列表/详情 MAIN-world tab 注入 `window.mnsv2`；`user/me` 用 local legacy `signXs` | D |
| 双 host | XHS + RedNote | 相同 API/web/额外语言头 | D |
| 业务 endpoints | 8 个，含评论 | 7 个，无评论 | D |
| 普通 batch | 用户设置，默认 5 | 固定 5 | D |
| 调度 | 单 active target timer | 三个独立 10 分钟 alarm | D |
| 去重 | `syncedIds[target]` 数组 | `insertPosts_TYPE` + Notion 全库恢复 | D |
| cursor 恢复 | 本地按账号状态 | 本地；缺失时用 Notion 最新 resourceId | D |
| 专辑 | whitelist、历史、增量轮询 | 首批最多 50 个 board 的历史，无 board 翻页；完成后普通收藏 | D |
| 多账号 | 6 个核心状态快照 | 11 个静态键 + 动态专辑键；去重 cache 不分账号 | D |
| 输出 | Markdown/YAML/本地媒体/Base | Notion properties/blocks/file upload/embed | D |
| 互动/评论 | 计数 + 评论首屏 | 不写入 | D |
| 视频选择 | 选一个候选流 | 首个非空 codec 组的所有流 | D |
| AI | 分类 + OCR + 多供应商转写 | 文本分类 | D |
| 限流 | 300013/461/406 等分层传播 | 461/406 和 -100；专辑会吞 STOP | D |
| 作者服务 | Supabase 授权/设备绑定 | Supabase 授权/Notion identity 绑定；远端 sign URL 仅导出、未引用 | D |

## 17. 独立同步核心的实现取舍

从两个客户端共同证据看，推荐保留：

- 浏览器辅助会话与页面环境签名；
- XHS/RedNote host adapter；
- 统一 API、模型、cursor、去重和媒体层；
- exporter 接口，而不是把 Notion/Obsidian 逻辑混进 sync engine。**I（设计建议）**

明确不要照搬：

- 远端授权与 `notionify.net` 常量；
- 明文凭据 signature cache；
- `${boardId}_${cursor}` 复合字符串；
- 分目标独立但无全局速率预算的调度；
- append/upload 吞错后仍标记已同步；
- 少于 batch 的全重复末页停滞条件；
- 用 UI 状态键代表真实 Cookie 会话。**D/I**

建议数据库状态至少拆为：

```text
accounts(account_id, host, last_seen_at)
sync_state(account_id, target, cursor, reached_end, updated_at)
album_state(account_id, board_id, cursor, reached_end)
notes(note_id, target, account_id, status, content_hash, synced_at)
media(note_id, url, kind, status, destination_ref)
```

## 18. 未解决问题

- 当前 7 个 endpoint 和 `window.mnsv2` 是否仍可用于自己的账号。**U**
- RedNote content-script 分支不验证 user id 时，多账号切换如何实际表现。**U**
- 服务端 cursor 是否始终接受 note id，从 Notion `resourceId` 恢复是否稳定。**U**
- 专辑 id/cursor 是否可能包含下划线。**U**
- 用户拥有超过 50 个 board 时，被首批之外的专辑不会被当前主路径发现。**D（已知限制）**
- 三个 alarm 同时开启时的实际限流与写入竞争。**U**
- Notion 长正文 paragraph、图片 file upload 在当前 API 版本的限制。**U**
- Notion 页面任一层级的 child blocks 超过一次 `blocks.children.list` 响应容量时，数据库发现会漏项。**D（已知限制）**
- OAuth callback 如何把状态返回扩展，以及是否仍在产品主流程中。**U**
- sidepanel 中重复业务模块是否有 background 之外的额外可达调用。**U（对独立核心不构成阻塞）**
- 无 source map，原始 TypeScript 类型、注释和目录结构无法完整恢复。**U/不可恢复**

## 19. 阶段二验收清单

- [x] 锁定 manifest v1.0.6 与关键 bundle/rules SHA-256。
- [x] 只做离线静态分析；未加载或执行 bundle。
- [x] 未读取 `prototypes/test-cookie.txt` 或 `prototypes/xsec_token.txt`。
- [x] 未联网、未登录、未调用小红书、Notion、AI、Supabase 或作者服务。
- [x] 未绕过或修改授权/许可证逻辑。
- [x] 还原 MV3/Plasmo 的 background/content/sidepanel/options/popup 职责。
- [x] 列出消息流、双 host、DNR、Cookie 与签名边界。
- [x] 列出 7 个业务 endpoint，并确认远端 sign URL 当前无调用点。
- [x] 还原 alarm、batch、普通 cursor、去重、专辑和多账号状态。
- [x] 还原错误产生、STOP 传播、专辑吞错和 Notion 降级边界。
- [x] 还原 Notion 数据库发现、页面 properties、blocks、图片和视频策略。
- [x] 还原 AI 分类必要数据流。
- [x] 区分官方 API、用户 AI、作者 Supabase、作者 web/backend 与凭据/正文流向。
- [x] 与阶段一 Obsidian 报告建立 D/I/U delta。
- [x] 提供哈希锁定、跨平台保守 case-fold/真实路径/inode 碰撞保护、原子输出和 `node:test` 的只读提取器。
- [ ] 未做动态协议验证；留待用户明确授权的后续阶段。

复核命令：

```bash
node --check research/reverse/tools/extract_notion_background.mjs
node --check research/reverse/tools/extract_notion_background.test.mjs
node --test research/reverse/tools/extract_notion_background.test.mjs
node research/reverse/tools/extract_notion_background.mjs \
  research/reverse/targets/rednote2notion/samples/static/background/index.js \
  /tmp/notion-background-modules.tsv \
  /tmp/notion-background-modules.txt
shasum -a 256 \
  research/reverse/targets/rednote2notion/samples/manifest.json \
  research/reverse/targets/rednote2notion/samples/static/background/index.js \
  research/reverse/targets/rednote2notion/samples/content-script.965f3134.js \
  research/reverse/targets/rednote2notion/samples/sidepanel.b7741352.js \
  research/reverse/targets/rednote2notion/samples/options.95eda3f3.js \
  research/reverse/targets/rednote2notion/samples/popup.100f6462.js \
  research/reverse/targets/rednote2notion/samples/openai.1a4755c2.js \
  research/reverse/targets/rednote2notion/samples/browser.4ceded9e.js \
  research/reverse/targets/rednote2notion/samples/rules.6316ad31.json
```
