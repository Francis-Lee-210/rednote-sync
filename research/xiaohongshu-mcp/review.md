# xiaohongshu-mcp 专项源码审查

状态：专项静态审查完成；独立复审通过  
审查日期：2026-08-13  
固定 revision：[`da9ba0365e176bc0eb11885f1941271d895feb73`](https://github.com/xpzouying/xiaohongshu-mcp/tree/da9ba0365e176bc0eb11885f1941271d895feb73)

> 本报告只描述固定 revision 的 tracked 静态实现，不证明当前在线兼容性、平台许可、运行可靠性或账号安全。未安装依赖，未执行项目、测试、浏览器、MCP、REST、Skill 或平台请求，也未读取用户 Cookie、token、profile、日志、媒体或个人数据。tracked 源码中的示例配置和访问材料只登记存在性，不复制其值。

## 1. 范围、来源与方法

- 来源、revision、tree 和清点结果见 [`provenance.json`](provenance.json)，中断恢复状态见 [`checkpoint.json`](checkpoint.json)。
- 只读审查 149 个 tracked paths；README/文档声明、源码/配置事实、测试意图（未运行）、静态推断和未知项分别标记。
- tracked `skills/post-to-xhs` 是独立 Python Agent add-on，只作为不可信能力面审查；它没有进入 Docker 最终层，也不应与 Go 服务混为一谈。
- 不研究或迁移验证码求解、stealth、指纹伪装、签名绕过、代理/账号轮换；所谓“人性化”输入只登记实现和风险，不能作为反风控证明。
- 评级表示对 Rednote Sync 的参考优先级，不表示代码质量、合法性或账号安全。

## 2. 结论摘要

### 核心结论：

- **最终建议 B：只参考局部数据契约、状态确认和 MCP capability 分类，不直接集成。** 项目是浏览器自动化服务，不是同步器；没有持久 cursor、水位、checkpoint、逐资产状态或恢复协议。[架构](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/service.go#L368-L467)
- 最值得独立实现的行为是：`feed_id + xsec_token` 配对、详情返回前精确核对 ID、过滤非笔记卡片、保留视频多编码元数据，以及写操作后的 desired-state 确认与 `skipped/filtered` 结果。[详情校验](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/xiaohongshu/feed_detail.go#L944-L1000) [非笔记过滤](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/xiaohongshu/types.go#L31-L48) [视频类型](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/xiaohongshu/types.go#L175-L230) [desired state](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/xiaohongshu/like_favorite.go#L69-L108) [skipped](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/xiaohongshu/notification_like.go#L43-L91) [filtered](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/xiaohongshu/notification.go#L80-L87)
- 首页、搜索和用户页只读取当前页面状态的一批结果；评论虽返回 cursor/hasMore，却没有续页输入，通知也不返回完整性状态。README 的“所有公开笔记”和“完整详情”不能由源码支持。[搜索](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/xiaohongshu/search.go#L96-L200) [用户页](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/xiaohongshu/user_profile.go#L52-L137) [评论 cursor](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/xiaohongshu/types.go#L249-L268) [通知加载](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/xiaohongshu/notification.go#L143-L225) [README 详情声明](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/README.md#L167-L181)
- Live Photo 只有布尔标志，没有伴生视频资产；发布图片 downloader 无 Range、长度/hash 或逐资产恢复。多数数据读取工具把 JSON 序列化后放入 TextContent，而不是带版本的 structured output；二维码和部分动作返回图片或自然语言文本，不能概括为全部 JSON。[媒体模型](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/xiaohongshu/types.go#L131-L247) [读取 handler](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/mcp_handlers.go#L260-L291) [MCP 输出边界](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/mcp_server.go#L554-L582)
- **生产复用的最大阻断项是能力边界。** 服务默认绑定 `:18060`，使用未配置 TLS 的普通 HTTP；REST/MCP 未见认证，CORS 为 `*`。可达调用者既能读取当前账号资料、通知、关联用户和 xsec access material，也能删除 Cookie、替换扫码会话、发布、评论、点赞、收藏、上传本地文件和触发任意 HTTP(S) 图片下载。跨源网页能否访问仍取决于浏览器 Private Network Access 等客户端策略。[路由](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/routes.go#L23-L65) [通知数据](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/xiaohongshu/notification.go#L47-L87) [CORS](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/middleware.go#L10-L23) [HTTP server](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/app_server.go#L36-L49)
- 任意图片 URL 路径缺少 host/private-IP 和逐跳重定向校验，且 `io.ReadAll` 无字节上限；本地图片/视频路径也没有 allowed-root。静态数据流形成条件性 blind SSRF、内存/磁盘耗尽，以及将调用者指定、浏览器可读且最终被页面接受的本地文件提交给平台的风险；未做动态利用验证。[下载器](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/pkg/downloader/images.go#L24-L103) [发布路径](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/xiaohongshu/publish.go#L239-L267)
- Cookie 与 fingerprint seed 同存于普通 JSON，代码以 `0644` 请求创建、目录为 `0755`，没有加密、原子替换或锁；默认相对当前目录选择 `cookies.json`，还可能复用旧 `/tmp/cookies.json`，未见 canonical path、allowed-root 或 symlink 防护。进程只有一个 Cookie 路径，也没有 `expectedAccountId`、profile lease 或平台操作互斥。[cookies.go](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/cookies/cookies.go#L79-L147)
- 非容器二进制首次启动采用 self-hosted CDN 的同源哈希，缓存命中不复验；Docker 则在 image build 时预置该浏览器。tar/zip 解压没有 root containment，macOS 还移除 quarantine。该链只能检测部分传输损坏，不能建立可信制品来源。[下载与校验](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/browser/browser_download.go#L24-L187) [解压](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/browser/browser_download.go#L208-L330) [Docker 预置](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/Dockerfile#L85-L107)
- 根许可证是 Apache-2.0；固定 tracked inventory 未见 NOTICE/第三方许可证清单，浏览器二进制、10 个 direct + 39 个 indirect Go requirements 和 Python add-on 依赖仍需独立核对。当前优先 clean-room 重写少量行为，不复制浏览器、Skill、部署或平台写代码。[LICENSE](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/LICENSE#L66-L128) [go.mod](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/go.mod#L1-L57)
- 阶段三继续完全离线。未来阶段四若获明确授权，只能另建默认只读 Provider、强本地认证、专用 profile/账号绑定、URL/路径 allowlist、SecretRef 和全局停止闸；CDP、指纹 seed、固定延迟或“人性化”操作均不是反风控证明。

## 3. 架构与数据流

```text
HTTP / MCP
  → Gin route 或 MCP tool
  → AppServer handler
  → XiaohongshuService
  → 每次调用创建 Browser + Page
  → 页面导航 / DOM 操作 / __INITIAL_STATE__
  → Go struct
  → HTTP JSON 或 MCP TextContent
```

- `[源码事实]` `AppServer` 聚合具体 service、Gin 和 MCP SDK，没有 Provider/Adapter 接口；同一进程暴露 `/mcp` 和 `/api/v1/*`。[app_server.go](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/app_server.go#L16-L43) [routes.go](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/routes.go#L23-L65)
- `[源码事实]` 列表、搜索、详情和用户页等 service 方法按调用创建并关闭 Browser/Page；Action 直接读取页面 `__INITIAL_STATE__`。[service.go](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/service.go#L368-L467) [feeds.go](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/xiaohongshu/feeds.go#L27-L65)
- `[适配判断]` 可借鉴 transport/service/action/model 分层，但当前 action 与浏览器、账号、DOM 和页面私有状态紧耦合，不能充当 Stage 3 Core Provider。

## 4. 发现、详情、评论、通知与媒体

### 4.1 发现和详情

- 首页最多轮询 8 秒后读取当前 `feed.feeds`，仅保留 `modelType == "note"`；`Feed` 保存 ID 和 `xsecToken`，但没有 `xsec_source`、规范 URL、批次或分页信息。[feeds.go](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/xiaohongshu/feeds.go#L17-L65) [types.go](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/xiaohongshu/types.go#L22-L29)
- 搜索有筛选值 allowlist，但筛选通过 DOM 点击完成；等待结果变化超时后可能返回筛选前数据，响应没有降级标志。[search.go](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/xiaohongshu/search.go#L24-L84) [search.go](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/xiaohongshu/search.go#L183-L200)
- 详情用 `feedID + xsecToken` 构造 URL，并按请求 ID 精确索引 `noteDetailMap`；这个 fail-closed 核对值得借鉴。但源码固定生成 `xsec_source=pc_feed`，不同发现来源是否一致未知。[feed_detail.go](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/xiaohongshu/feed_detail.go#L944-L1005)
- 用户页校验请求 tab 后只读当前 `notes[index]`，没有滚动或分页；README 所称“所有公开笔记”属于未被源码支持的项目声明。[user_profile.go](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/xiaohongshu/user_profile.go#L52-L137) [README](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/README.md#L212-L234)

### 4.2 评论和通知完整性

- 评论零值归一化为最多 20 条一级评论、回复阈值 10；到达最大加载轮数仍可返回 `nil`，上层加载错误也只记 warning 后返回部分结果。[feed_detail.go](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/xiaohongshu/feed_detail.go#L39-L81) [加载器](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/xiaohongshu/feed_detail.go#L178-L228)
- 响应包含评论 cursor/hasMore，但 API/MCP 没有可消费该 cursor 的续页输入；`load_all_comments=false` 时也没有源码级“前 10 条”截断保证。[types.go](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/xiaohongshu/types.go#L249-L268) [MCP 参数](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/mcp_server.go#L287-L329)
- 通知保留关联 Feed ID、token 和 `filtered` 数量，是较好的关联/损失可见性设计；但内部最多滚动 20 轮，响应没有 cursor、hasMore 或 completeness。[notification.go](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/xiaohongshu/notification.go#L47-L87) [加载](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/xiaohongshu/notification.go#L143-L225)
- `list_notifications` 被标为 `ReadOnlyHint: true`，但工具描述明确称访问会清除未读标记；annotations 与业务副作用冲突。[mcp_server.go](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/mcp_server.go#L503-L516)

### 4.3 媒体模型

- 图文详情保留有序 image list、宽高和 `livePhoto` 布尔值；没有同 ordinal 的 motion 资产、资产 ID、内容 hash 或下载状态。[types.go](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/xiaohongshu/types.go#L240-L247)
- 视频按编码动态分桶，并保留候选 URL、格式、尺寸、时长、字节数、FPS、编码、码率、MD5 和字幕，是有价值的字段清单；签名 URL 仍只能视为短期 access material。[types.go](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/xiaohongshu/types.go#L131-L238)
- 发布图片 downloader 一次性读完整 body，最终直接写 `0644` 文件；无稳定 slot、Range、长度/hash、临时文件原子提交或批次回滚。[images.go](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/pkg/downloader/images.go#L41-L157) [processor.go](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/pkg/downloader/processor.go#L21-L48)

## 5. 状态、分页、幂等与失败恢复

| 审查面 | 固定源码事实 | 结论 |
|---|---|---|
| 列表/搜索/用户页 | 当前页面一批结果，无 page/cursor/watermark | 不能做增量发现源 |
| 评论 | 返回 cursor/hasMore，但无续页输入；加载失败可降级为部分结果 | 需另建 completeness 与 cursor provenance |
| 通知 | 单次调用内部滚动，响应不返回进度 | 不能恢复 |
| 详情 | 精确按 feed ID 核对 | 可借鉴读取正确性，不等于任务幂等 |
| Feed 赞/收藏 | desired-state 预检；状态读取失败时仍可能点击 | 仅局部幂等 |
| 通知点赞 | 目标状态确认并返回 `skipped` | 可借鉴结果契约 |
| 发布/评论/回复 | 无 operation ID、去重或新对象 receipt | unknown outcome 无法对账 |
| 媒体 | 无逐资产 ledger、续传和完整性 checkpoint | 排除 |

读取中的短重试只是单次调用内行为，不是跨进程恢复。[feed_detail.go](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/xiaohongshu/feed_detail.go#L108-L125) 发布响应只有标题、正文、图片数和状态，不返回新 note ID 或规范 URL。[service.go](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/service.go#L57-L63)

Rednote Sync 必须继续由 Core 独占 cursor/checkpoint/canonical state；未来 Provider 只返回带来源和完整性状态的 transient page/detail/media descriptors。

## 6. Browser、登录、Cookie、身份与风控停止边界

| ID | 严重性 | 固定证据与静态判断 | Rednote 边界 |
|---|---|---|---|
| SESSION-01 | 高 | 单个进程共用一个 Cookie 路径和 fingerprint seed；按请求创建浏览器，但没有 `expectedAccountId`、profile lease、账号级互斥或 session owner。登录状态可在无法读取当前用户信息时仍判定已登录。[cookies.go](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/cookies/cookies.go#L127-L147) [登录检查](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/service.go#L104-L133) [按请求建浏览器](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/service.go#L368-L467) | 专用 profile；`SessionBinding(expectedAccountId, profileId)`；每轮和恢复后身份校验；不确定即停止 |
| SESSION-02 | 高 | session JSON 同存完整 Cookie 与 seed，以目录 `0755`、文件 `0644` 直接覆盖；无加密、原子替换或锁。实际权限可能被 umask 收紧，但不能依赖。默认相对 cwd，旧 `/tmp/cookies.json` 存在时会复用，且未见 canonical path/allowed-root/symlink 防护；删除接口还回显实际路径。在共享 cwd、多用户主机或受污染路径前提下形成条件性会话混淆、文件覆盖/读取与路径泄露面。[写入](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/cookies/cookies.go#L79-L116) [路径选择](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/cookies/cookies.go#L127-L147) [路径响应](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/handlers_api.go#L65-L78) | SecretRef；固定私有根并拒绝 symlink；目录/文件 `0700/0600`；原子替换、锁、生命周期和日志禁出 |
| SESSION-03 | 高 | QR 登录在进程内只保留一个等待会话，新的会取消旧的；这是资源治理，但不是调用者所有权。`get_login_qrcode` 被标为 read-only，却会启动/替换后台登录会话，扫码成功后写 Cookie。无鉴权调用者还可先删 Cookie，再让自己的账号扫码，条件性重绑定共享服务；删除不会取消 pending login，sequence 只保护 finish，保存前未复核它仍是当前会话，因而可能出现延迟写回。[MCP 注册](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/mcp_server.go#L196-L209) [登录写入](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/service.go#L136-L201) [会话序号](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/login_session.go#L16-L41) [删除](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/cookies/cookies.go#L118-L124) | QR/login 必须是显式高风险 capability，绑定 caller/account/profile/run owner；删除会话先取消 pending login，保存前复核 sequence；不向通用 Agent 注册 |
| SECRET-01 | 中高 | 详情、点赞/收藏等路径会把含 xsec access material 的完整 URL 写日志；响应也可把 token 返回客户端。代理 URL 正常路径有掩码，但解析失败时可能回显原字符串。[feed_detail.go](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/xiaohongshu/feed_detail.go#L98-L105) [like_favorite.go](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/xiaohongshu/like_favorite.go#L46-L53) [browser.go](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/browser/browser.go#L36-L47) | token/signed URL/proxy credential 不进普通日志或 Agent；结构化字段 allowlist 与失败路径脱敏 |
| RISK-01 | 高 | 未见验证码、429、登录墙或安全限制的类型化全局 circuit breaker；“人性化”输入、指纹 seed、真实浏览器或延迟均未提供账号安全证明。 | 类型化 `AUTH/VERIFICATION/RATE_LIMIT/SECURITY_BLOCK/SCHEMA_DRIFT`；立即暂停并人工恢复，不切代理/账号、不隐藏自动化 |

本报告不把作者 README 的稳定性、频率或“降低风险”经验陈述当作平台规则或实证。任何真实账号实验都需要未来 Stage 4 的单独授权、最小请求预算和立即停止条件。

核心错误包只定义“无 Feed/无详情”，详情可访问性检查也只覆盖删除、私密或不可见；未见登录失效、验证码、账号限制或 rate limit 的统一类型。[errors.go](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/errors/errors.go#L1-L6) [访问检查](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/xiaohongshu/feed_detail.go#L891-L940)

## 7. MCP、REST、Agent 与本地/平台写能力

### 7.1 网络服务和资源边界

- `[高]` 默认端口是 `:18060`，Go 的空 host 表示监听所有本地接口；route tree 未见认证 middleware，CORS 允许 `*`。Docker Compose 又发布 `18060:18060`。[main.go](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/main.go#L12-L22) [middleware.go](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/middleware.go#L10-L23) [compose](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/docker/docker-compose.yml#L1-L18)
- `[高]` 同一无鉴权服务可读取当前账号资料、个人主页、通知内容、评论关联用户和 xsec access material。默认 `ListenAndServe` 没有 TLS 配置，故非 loopback 且无外部 TLS 终止时，传输也不受保护；跨源网页利用仍受浏览器 Private Network Access 等环境策略影响。[账号路由](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/routes.go#L42-L65) [通知数据](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/xiaohongshu/notification.go#L47-L87) [server](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/app_server.go#L36-L49)
- `[中高]` `http.Server` 只设置 Addr/Handler，未配置 header/read/write/idle timeout 或 body-size gate；Gin JSON handlers 和 stateless MCP 也未见统一请求体/并发/任务预算。[app_server.go](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/app_server.go#L36-L61)
- `[中高]` 除扫码流程外，每个并发请求都可新建浏览器；评论上限接受任意正数，最大尝试次数随其放大。部分回复流程还脱离外部 request context，客户端断开后可能继续占用资源。[评论预算](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/xiaohongshu/feed_detail.go#L62-L81) [detached context](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/xiaohongshu/comment_feed.go#L113-L124)
- `[中]` panic recovery 将 recovered 值返回给调用方并记录错误；这可能暴露内部对象或敏感上下文，具体内容取决于触发点，未动态验证。[middleware.go](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/middleware.go#L25-L33)
- `[中]` 普通 REST 错误也会把 `err.Error()` 原样写入 `details`，MCP 返回底层错误；下载错误可含完整 URL，本地文件错误可含绝对路径，Cookie 删除成功还回显实际路径。Python CDP Skill 另会打印完整 debugger WebSocket URL。应改为稳定外部错误码、服务端受控诊断并统一清洗 query/path/CDP endpoint。[REST details](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/handlers_api.go#L14-L24) [下载 URL 错误](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/pkg/downloader/images.go#L62-L71) [Cookie 路径](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/handlers_api.go#L65-L78) [CDP URL](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/skills/post-to-xhs/scripts/cdp_publish.py#L164-L172)

### 7.2 URL、本地文件与平台写面

- MCP 注册 18 个工具。9 个写/本地破坏工具设 `DestructiveHint=true`，这套分类意图值得借鉴；但 annotation 只是客户端提示，服务端没有 approval token、工具 allowlist、身份绑定或逐能力授权。`get_login_qrcode` 具有源码确认的会话写副作用；`list_notifications` 的工具描述明确警告会清除未读，但实际平台行为未运行验证，证明不能仅按 annotation 授权。[mcp_server.go](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/mcp_server.go#L178-L551)
- 任意 HTTP(S) 图片 URL 只校验 scheme/host；默认客户端可重定向，未见每跳 host/private-IP/loopback/link-local 校验，且 `io.ReadAll` 无大小上限。若未鉴权接口被不可信调用，这是条件性 blind SSRF 与内存耗尽面；成功文件又进入固定临时目录，未见请求结束清理、失败回滚或全局磁盘配额，可持续占用磁盘。本报告未执行 PoC。[images.go](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/pkg/downloader/images.go#L24-L103) [临时目录](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/configs/image.go#L8-L14)
- 本地图片和视频路径没有 allowed-root/realpath policy，随后交给浏览器文件输入；因此调用者可探测路径存在/可访问性，并条件性提交其指定、浏览器可读且最终被页面/平台接受的文件。不能由静态源码推断任意非媒体文件必然外传。[processor.go](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/pkg/downloader/processor.go#L21-L48) [视频检查](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/service.go#L289-L302) [图片上传 sink](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/xiaohongshu/publish.go#L239-L267) [视频上传 sink](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/xiaohongshu/publish_video.go#L73-L99)
- 平台写面包括 Cookie 删除、图文/视频发布、评论/回复、点赞/收藏、通知回复/点赞；`list_notifications` 则存在 read-only annotation 与“会清未读”的项目描述冲突，实际平台行为未验证。生产读取型 Provider 必须默认不注册这些能力。

### 7.3 tracked Python Skill 与 examples

- `post-to-xhs` 是没有 manifest lock/CI/test 的独立 Python add-on。Skill prompt 的用户确认只是提示词级 gate；脚本 `--auto-publish` 和 CDP CLI 可直接点击发布，没有服务端一次性批准令牌。[SKILL](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/skills/post-to-xhs/SKILL.md#L97-L118) [pipeline](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/skills/post-to-xhs/scripts/publish_pipeline.py#L217-L227)
- launcher 发现 9222 端口已占用时直接复用，未核对请求账号；未知 account name 还会静默回退 default profile。publisher 只按 URL 查找 tab，没有稳定账号身份 gate，存在条件性写错当前账号风险。[chrome_launcher.py](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/skills/post-to-xhs/scripts/chrome_launcher.py#L78-L109) [account fallback](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/skills/post-to-xhs/scripts/account_manager.py#L69-L96) [cdp_publish.py](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/skills/post-to-xhs/scripts/cdp_publish.py#L123-L172)
- account name/profile path 没有 base containment；`remove --delete-profile` 对配置中的路径执行递归删除。只有本地调用者或受污染配置满足前提时，才形成条件性任意目录删除能力。[account_manager.py](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/skills/post-to-xhs/scripts/account_manager.py#L138-L199)
- Python 图片下载器同样接受任意 URL、默认重定向、无 host/private-IP/总字节限制并记录完整 URL；全部排除复用。[image_downloader.py](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/skills/post-to-xhs/scripts/image_downloader.py#L57-L106)
- CDP 发布器把正文拼为 HTML 后赋给页面 `innerHTML`，长文图片路径也存在直接脚本插值；来自网页或模型的内容可能在已登录创作页被解释。该 Skill 的整个页面注入路径按 D 排除，而不是转化为实现建议。[正文注入](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/skills/post-to-xhs/scripts/cdp_publish.py#L394-L419) [图片路径](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/skills/post-to-xhs/scripts/cdp_publish.py#L718-L733)
- n8n/AnythingLLM 示例把 Agent、本地文件读取和平台写组合在一起；导出的 n8n JSON 还含应在发布前 scrub 的部署/credential-reference 元数据（未发现实际 API secret，本报告不复制具体值）。它们是文档路线，不是核心 Go 依赖，也不进入 Rednote Sync。[n8n 工作流](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/examples/n8n/%E8%87%AA%E5%8A%A8%E5%8F%91%E5%B8%83%E7%AC%94%E8%AE%B0%E5%88%B0%E5%B0%8F%E7%BA%A2%E4%B9%A6.json#L21-L69) [n8n 文档](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/examples/n8n/README.md#L138-L176) [AnythingLLM](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/examples/anythingLLM/readme.md#L96-L122)

## 8. 依赖、测试、CI、制品与许可证

### 8.1 依赖与测试信号

- `go.mod` 要求 Go 1.24.0，固定 10 个 direct/39 个 indirect requirements；`go.sum` 有 139 行，56 个 module path 有 artifact checksum。固定版本和 checksum 是正面完整性信号，但未做 SCA/许可证/可达性分析。[go.mod](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/go.mod#L1-L57)
- 固定树有 19 个 `*_test.go`、57 个 Test 函数，其中 4 个文件带 integration build tag。CI build/vet/unit test，并只编译、不执行浏览器 integration tests；本审查没有运行这些任务。[test workflow](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/.github/workflows/test.yml#L1-L42)
- Python Skill 声明需要 requests/websockets，但没有 requirements/pyproject/lock 或测试，必须视为独立未冻结供应链。[publish workflow](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/skills/post-to-xhs/references/publish-workflow.md#L5-L10)

### 8.2 CI/CD 与浏览器制品

- 5 个 workflow 共 13 个外部 `uses`，没有一个固定到完整 commit SHA。具写权限的 star/browser-update workflow 仍执行 mutable-tag Action，后者脚本会尝试直接 push main；能否成功取决于未知的 branch protection/ruleset。这扩大供应链权限，不表示已经发生篡改。[star workflow](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/.github/workflows/star-history.yml#L13-L25) [browser update](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/.github/workflows/update-browser.yml#L12-L78)
- release 上传 6 个 binary，未见 checksum/signature/SBOM/provenance/attestation 步骤；Docker 同时推 version 与 mutable `latest`。实际 release 页面材料是否另含这些内容未核验。[tag release](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/.github/workflows/tag-release.yml#L109-L169) [docker release](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/.github/workflows/docker-release.yml#L16-L68)
- 两个 `workflow_dispatch` 的 version 进入 shell；tag 流程在使用后才验证，Docker 流程未见验证。只有具 workflow dispatch 权限者可提供该输入，因此记为条件性 CI shell-injection/标签边界，不扩大为公众漏洞。[tag workflow](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/.github/workflows/tag-release.yml#L33-L59) [docker workflow](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/.github/workflows/docker-release.yml#L26-L34)
- 首次启动从 self-hosted CDN 下载浏览器；期望哈希也来自同一 CDN，缓存命中只按文件名复用。tar/zip member 未做 containment，tar 还创建 archive 指定 symlink；恶意/受控 archive 前提成立时可写出缓存根并影响后续执行。macOS 移除 quarantine，未见 codesign/notarization 校验。[browser_download.go](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/browser/browser_download.go#L69-L187) [解压](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/browser/browser_download.go#L208-L330)
- Docker base 仅 tag、无 digest，apt 未 pin；GOPROXY/GOSUMDB 指向额外镜像边界，运行容器默认 root、数据/图片目录 `777`。[Dockerfile](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/Dockerfile#L1-L17) [runtime](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/Dockerfile#L85-L120)

### 8.3 许可证与复用边界

- 根 LICENSE 和 README 声明 Apache-2.0；复制/分发源码需保留许可证与归属、标记修改，并在上游提供 NOTICE 时履行相应义务。本报告不是法律意见。[LICENSE](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/LICENSE#L66-L128) [README](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/README.md#L1087-L1093)
- 固定树没有 NOTICE 或第三方 license inventory。根许可证不能自动证明 Go modules、Python add-on、Docker 基础镜像或下载浏览器的权利和兼容性。
- binary release/Docker workflow 没有显式打包根 LICENSE 的步骤；实际发布页或镜像是否另含许可材料未知，不作违规结论。
- Go `main.version` 默认 `dev`、发布时 ldflags 注入，MCP Implementation 又硬编码 `2.0.0`，存在两套版本口径；运行输出不能单独证明对应固定源码。[main.go](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/main.go#L12-L24) [mcp_server.go](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/mcp_server.go#L127-L143)

## 9. 对 Rednote Sync 的具体参考价值

### 9.1 可独立实现的行为

1. discovery 结果把稳定 note ID 与短期 access material 一对一配对；token 不进入 canonical state。
2. 详情返回前精确核对请求 ID，拒绝 map 中其他 preload note。
3. 保留视频多编码候选和页面提供的尺寸、长度、时长、codec、bitrate、MD5 等来源证据。
4. 数据结果显式记录 `filtered`、`skipped`、completeness、source layer 与停止原因。
5. Agent 工具元数据同时描述远端读写、本地文件、secret、网络和副作用；`sideEffectingRead` 不可标成 read-only。
6. 写操作若未来另立产品范围，应采用 desired-state 预检、提交后确认、operation ID 和 ambiguous outcome 对账；当前 Rednote Sync 不注册平台写能力。

### 9.2 必须由 Rednote 自己实现的边界

- Stage 4 Provider 只输出版本化、安全 DTO；MCP TextContent/raw `any` 不能直接进入 Core。
- `StateStore` 独占 cursor、水位、checkpoint 和 canonical state；Provider 内部滚动和短重试不能冒充恢复。
- `MediaStore` 以 `(kind, ordinal, role)` 保存逐资产状态、长度、magic MIME、hash、receipt；Live Photo 是同 ordinal 的 still/motion 两个物理资产。网络写入还需单资产/单请求/任务总字节、资产数、并发和临时文件生命周期预算。
- 服务默认 loopback + 高熵本地认证；只注册读取 allowlist。平台写、本地文件、任意 URL、诊断和 Cookie 操作分成独立 capability。
- 使用专用 profile 和 `SessionBinding(hostId, expectedAccountId, profileId, owner)`；不连接日常浏览器，不按端口猜账号。
- Cookie/token/signed URL/CDP endpoint 只存在 SecretRef/短期隔离区，不进入日志、Agent、Markdown 或普通 checkpoint。
- CAPTCHA、登录变化、429、安全限制、身份不匹配或 Schema drift 触发全局停止；保存 checkpoint 后等待人工显式恢复。

### 9.3 阶段边界

- **Stage 3：不改变。** 继续完全离线；本仓库、浏览器、Cookie、token、MCP/REST 和在线 Action 均不进入 Core。
- **未来 Stage 4：另立授权门。** 即使采用 Playwright/Rod，也必须先完成平台授权、只读 API 规格、profile/account ownership、secret handling、停止/恢复和运行验收；浏览器“人性化”行为不改变合规结论。

## 10. 采用分级与排除项

| 等级 | 对象 | 结论 |
|---|---|---|
| A | 无端到端组件 | 当前没有可直接采用组件 |
| B | ID/access-material 配对、精确详情 ID 校验、非笔记过滤、视频多流字段、`filtered/skipped`、desired-state 确认、MCP capability taxonomy | 只借鉴行为和数据契约，clean-room 独立实现 |
| C | transport/service/action 分层、评论加载预算、通知关联、部分测试/CI 组织 | 背景设计资料 |
| D | 当前浏览器 Action、无鉴权 REST/MCP、全部平台写工具、任意 URL/本地路径、媒体 downloader、Cookie 文件默认、self-hosted browser 下载/解压/执行、Python Skill、多账号/CDP/profile 管理、Agent examples、Docker 部署 | 排除直接复用或集成 |

总体评级：**B（局部设计参考）；生产集成与现成部署 D。** Apache-2.0 本身不阻止依条款复用，但阶段目标、安全边界和第三方制品未知使 clean-room 重写更合适。

## 11. 未知项、证据索引与独立复审

### 11.1 未知项

- 未运行程序、测试、浏览器或平台；当前 selector、页面 state、账号成功率、验证码率和风控效果均未知。
- no-tags 快照没有核验 commit 与 tag/release asset 的对应关系；GitHub branch protection、environment approval 和组织 Actions policy 未知。
- self-hosted 浏览器 CDN 的所有者控制、构建来源、许可证、签名和实际制品 hash 未由 tracked repo 证明。
- Go/Python 第三方依赖的 CVE、许可证兼容、可达性和发布制品 SBOM 未核验。
- Live Photo motion 字段可能存在于当前未建模的页面结构中；不能从布尔标志推定完整支持。
- 通知读取何时清未读、评论 cursor 的真实续页语义、签名 URL 有效期和 `pc_feed` 对不同来源的适用性均需未来授权后的动态验证。
- URL/file/CDN finding 是固定源码数据流的条件性风险，未执行 PoC，也不声称已经发生攻击或泄露。

### 11.2 证据等级

- `[源码/配置事实]`：固定 commit 的 tracked Go/Python/JSON/YAML/Dockerfile。
- `[测试意图]`：tracked test 或 workflow，但本次未执行。
- `[项目声明]`：README、API 文档和 Skill 文案，不提升为运行证明。
- `[静态推断]`：由数据流和信任边界推导的条件性风险，明确保留触发前提。
- `[未知]`：需要运行、平台、发布制品、仓库外设置或法律判断才能确认。

### 11.3 独立复审

- 事实、链接与元数据复审：**PASS**；所有固定链接、revision/tree、计数、JSON、本地链接和证据分级通过，P0–P3 为 0。
- API、会话与安全复审：**PASS**；无鉴权读取/写入、QR 会话重绑定、URL/文件/secret/资源预算和停止边界全部闭环，P0–P2 为 0。
- 依赖、CI、许可证与适配复审：**PASS**；Go/Python/Actions/release/Docker/CDN/解压/Apache-2.0 及 B/D 阶段边界全部通过，P0–P3 为 0。
- 完成门：固定源码仍为 detached HEAD，revision/tree 与来源一致，tracked clean；无凭据或真实平台请求记录。
