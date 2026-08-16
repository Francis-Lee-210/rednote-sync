# OpenCLI 专项源码审查

状态：专项静态审查完成，独立复审通过  
审查日期：2026-08-13  
固定 revision：[`a86d64705c526dc710f790e66cfcabf6ecf786b9`](https://github.com/jackwener/OpenCLI/tree/a86d64705c526dc710f790e66cfcabf6ecf786b9)

> 本报告只描述固定 revision 的 tracked 源码与配置，不证明当前在线兼容性、运行可靠性、账号安全或平台授权。

## 1. 范围、来源与方法

- 来源和快照状态见 [`provenance.json`](provenance.json)，中断恢复状态见 [`checkpoint.json`](checkpoint.json)。
- 审查输入只限固定 commit 的 tracked paths；按相关性阅读 XHS adapter、Browser Bridge、daemon、下载器、测试、workflow、manifest、lock 和许可证。
- 不安装依赖、不构建、不执行 daemon、扩展、CLI 或测试；不启动浏览器，不读取 profile、Cookie 或个人数据，不访问小红书。
- 证据分为 `[文档声明]`、`[源码证据]`、`[配置证据]`、`[测试证据（未运行）]`、`[推断]` 和 `[未知]`。
- 当前环境没有可用的 Semgrep、OSV-Scanner、Trivy、Syft 或 Gitleaks；没有把“未运行扫描器”写成“没有漏洞”。

## 2. 结论摘要

OpenCLI 最值得 Rednote Sync 借鉴的不是整个 Browser Bridge，而是四个较窄的设计：发现结果将稳定 note ID 与临时 signed access material 配对；网络响应、hydrated state 与 DOM 的分层获取；显式 profile 路由和 session/target lease；同 operation ID 的 journal 与“结果未知时不盲目重放”。这些都需要在未来阶段四独立实现，并由 Rednote Sync 自己拥有 Schema、checkpoint、账号绑定和权限边界。

当前实现不能直接作为生产同步器。它没有服务端 cursor、水位或逐资产 checkpoint；XHS family 同时包含发布、删除、关注等写操作；扩展具有 `<all_urls>`、Cookie、debugger 和下载权限；所谓 isolated window 并不是独立 Cookie profile；本地 daemon 没有不可猜的客户端凭据；隐私声明与 Cookie 结果 journal 存储存在冲突；XHS 下载还可能在首跳把平台 Cookie 发给缺少严格 host allowlist 的媒体 URL。默认 stealth 注入只说明存在隐藏自动化痕迹的代码，不能证明账号安全，也不进入 Rednote Sync 路线。

### 核心结论：

- 最终维持 **A（专项设计参考）**，但只针对 access-material 配对、分层获取、会话租约和 unknown-outcome 语义；整体生产复用为 **D**。
- `saved`/`liked` 先拦截站内响应并校验 note ID + `xsec_token`，无结果才退 DOM；它有次数上限和 shape validation，但没有可持续分页 cursor。
- `note` 只返回 DOM 提取的 field/value 行；`download` 是独立链路，普通图片/视频只有 `type + url`，没有 Live Photo、逐资产身份或完整性契约。
- 下载有临时文件后 rename，但没有 Range 续传、长度或 hash 闭环；`access:'read'` 仍会产生本地文件副作用。
- XHS adapter family 含 publish/delete/follow/unfollow 等平台写能力，生产适配器必须使用独立精确只读 allowlist。
- Browser Bridge 复用日常 Chrome profile 的 Cookie；owned window 只隔离窗口与 tab，不是专用 profile。
- daemon 的 loopback、Origin 检查和固定 `X-OpenCLI` header 是局部 CSRF 防护，不是本地客户端鉴权。
- 隐私声明称不存个人数据，但 Cookie 命令结果可进入 `chrome.storage.session` journal；network capture 还会保存未统一脱敏的响应体。
- XHS 下载首跳缺少严格媒体 host 与 IP 边界，存在把平台 Cookie 发送到页面可控 HTTP(S) 目标，以及由 Node 侧发起条件性 blind SSRF/内网请求的风险；没有观察真实事件。
- stealth、随机等待、真实 Chrome 和 CDP 都不是反风控证明；阶段三保持离线，所有相关能力继续停留在未来阶段四授权门之后。

## 3. 架构与 XHS 数据流

### 3.1 Browser Bridge 主链

`[源码证据]` 主链是 CLI 通过 loopback HTTP 把命令交给 daemon，再通过 WebSocket 发往 Chrome 扩展；扩展执行 Chrome API/CDP 并返回结果。协议能力包括任意页面 JavaScript `exec`、导航、tab、Cookie、截图、文件输入、网络捕获和受限 CDP passthrough，因此它是通用浏览器控制面，不是领域只读 Adapter。[protocol.ts L1-L23](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/extension/src/protocol.ts#L1-L23) [background.ts L1300-L1352](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/extension/src/background.ts#L1300-L1352) [background.ts L1667-L1686](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/extension/src/background.ts#L1667-L1686)

`[配置证据]` 扩展申请 `debugger`、`tabs`、`cookies`、`activeTab`、`alarms`、`storage`、`tabGroups`、`downloads` 和 `<all_urls>`。PRIVACY 权限表只解释了其中一部分。[manifest L5-L18](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/extension/manifest.json#L5-L18) [PRIVACY L17-L25](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/PRIVACY.md#L17-L25)

### 3.2 收藏与点赞发现

- `[源码证据]` `saved` 和 `liked` 均注册为浏览器 Cookie 读取命令，分别进入收藏与点赞 profile tab，并监听 `note/collect/page`、`note/like/page` 响应。[saved.js L4-L28](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/clis/xiaohongshu/saved.js#L4-L28) [liked.js L4-L28](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/clis/xiaohongshu/liked.js#L4-L28)
- `[源码证据]` 响应行必须同时含稳定 note ID 与 `xsec_token`，否则 fail closed；跨响应按 ID 去重。access material 被拼入下钻 URL，因此未来 Adapter 必须拆成安全 ID 与不可持久化 secret，而不是保存完整 URL。[collection-helpers.js L51-L112](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/clis/xiaohongshu/collection-helpers.js#L51-L112)
- `[源码证据]` 初始捕获最多轮询 16 次，随后最多滚动 4 次，增长停滞即结束；网络层无结果才读取 DOM，最后裁到 limit 1–100。页面登录墙和最终 profile path 也会校验。[collection-helpers.js L33-L42](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/clis/xiaohongshu/collection-helpers.js#L33-L42) [collection-helpers.js L114-L201](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/clis/xiaohongshu/collection-helpers.js#L114-L201) [collection-helpers.js L239-L282](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/clis/xiaohongshu/collection-helpers.js#L239-L282)
- `[风险]` 返回的是本次滚动得到的一次性内存数组，没有 `requestCursor`、`nextCursor`、`hasMore`、水位或稳定全量边界。硬次数上限是资源保护，不是完整分页契约。

### 3.3 其他发现路径

`[源码证据]` search 使用 DOM 和滚动 plateau；其 `published_at` 是从 24 位 hex ID 推算时间，不是平台返回字段。feed 从 hydrated store 读取首屏并要求 ID/token，但也没有分页 cursor。这些实现适合作为来源层级和“推断字段必须标来源”的反例，不进入 canonical Schema。[search.js L1-L57](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/clis/xiaohongshu/search.js#L1-L57) [search.js L183-L327](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/clis/xiaohongshu/search.js#L183-L327) [feed.js L103-L147](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/clis/xiaohongshu/feed.js#L103-L147)

## 4. 详情、媒体、状态与失败恢复

### 4.1 详情契约

`[源码证据]` `note` 只从 DOM 提取 title、author、content、likes、collects、comments、tags，输出 `[{field,value}]`；没有版本号、作者稳定 ID、发布时间、note type 或媒体列表。登录墙、内容不存在、安全限制、页面空壳分别映射到不同错误，计数占位文本归一为字符串 `0`。[note.js L17-L103](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/clis/xiaohongshu/note.js#L17-L103)

`[源码证据]` note/comments 需要受支持 host/path 且含 `xsec_token` 的完整 URL；download 额外接受短链接，裸 note ID 会在导航前拒绝。[note-helpers.js L5-L68](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/clis/xiaohongshu/note-helpers.js#L5-L68)

### 4.2 媒体与本地写

- `[源码证据]` 图片优先从当前 note keyed `__INITIAL_STATE__.note.noteDetailMap[id].note.imageList` 按数组顺序读取，完全缺失才退 DOM；视频依次尝试 state、inline script 与非 blob DOM video。输出只有 `{type,url}`，视频排在图片前。[download.js L21-L203](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/clis/xiaohongshu/download.js#L21-L203)
- `[tracked-wide 静态检索]` XHS 相关实现没有 Live Photo still/motion 配对、原始 ordinal、variant、MIME、期望长度、hash 或来源版本字段。普通 video 逻辑不能被解释为 Live Photo 支持。
- `[源码证据]` 下载写入 `<output>/<noteId>/` 并逐项返回 success/failed；底层使用 `.tmp` 后 rename，最多处理 10 次 redirect，跨 host redirect 时移除 Cookie。[download.js L205-L248](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/clis/xiaohongshu/download.js#L205-L248) [media-download.ts L74-L181](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/src/download/media-download.ts#L74-L181) [download index L102-L197](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/src/download/index.ts#L102-L197)
- `[风险]` 下载只接受 200，没有 Range/206、Content-Range、续传、最终长度或 hash 校验。临时文件机制值得借鉴，但不是完整性闭环。
- `[能力边界]` `download` 标为 `access:'read'`，却创建目录和文件；远端平台 read/write 标签不能替代独立的本地文件 capability。[download.js L205-L247](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/clis/xiaohongshu/download.js#L205-L247) [media-download.ts L93-L145](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/src/download/media-download.ts#L93-L145)

### 4.3 checkpoint 与错误

`[源码证据]` saved/liked/search/user 和 media download 都是有上限的一次性内存循环；未见业务 cursor、水位、逐资产持久状态或进程恢复协议。类型化 argument/auth/empty/malformed/security-block 是可借鉴点，但 security block 只有提示，没有机器可读 retry time、账号级 circuit breaker 或人工恢复 checkpoint。[collection-helpers.js L239-L282](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/clis/xiaohongshu/collection-helpers.js#L239-L282) [note.js L68-L90](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/clis/xiaohongshu/note.js#L68-L90)

## 5. 浏览器会话、身份与 Agent 边界

### 5.1 profile 与会话所有权

- `[文档表述/源码边界]` PRIVACY 称扩展在与日常浏览分离的 isolated windows 中运行；源码明确 BrowserContext 使用用户默认 Chrome profile，隔离的是 session 对 owned window/tab 的租约。即文档中的 isolated 只能解释为窗口隔离，不能据此推定独立 profile 或 Cookie jar。[PRIVACY L5-L8](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/PRIVACY.md#L5-L8) [background.ts L923-L930](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/extension/src/background.ts#L923-L930) [background.ts L994-L1004](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/extension/src/background.ts#L994-L1004)
- `[源码证据]` session/tab lease 存在 `chrome.storage.session`，浏览器重启或扩展更新后不会恢复；extension `contextId` 另存 `storage.local`，CLI profile alias/default 存本地 JSON。它们标识 extension/profile 实例，不是平台账号。[background.ts L37-L52](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/extension/src/background.ts#L37-L52) [background.ts L335-L346](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/extension/src/background.ts#L335-L346) [profile.ts L50-L54](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/src/browser/profile.ts#L50-L54)
- `[源码证据]` 显式 `--profile` 是 hard requirement；preferred default 失联时可退到唯一在线 profile。Rednote Sync 必须采用显式绑定并 fail closed，不能对 account-bound job 使用该 fallback。[profile.ts L56-L90](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/src/browser/profile.ts#L56-L90)
- `[源码证据]` XHS auth 只检查 creator 域 `web_session` 并返回 username/followers，没有稳定 account ID、expected account 断言或每轮身份复核。[auth.js L4-L37](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/clis/xiaohongshu/auth.js#L4-L37)

### 5.2 Agent 与写能力面

`[源码证据]` `browser bind` 能接管当前焦点用户 tab；虽禁止 bound session 新建/切换/关闭 tab，仍可执行脚本、导航、点击、输入和上传。因此它不是只读借用或安全沙箱。[background.ts L1800-L1809](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/extension/src/background.ts#L1800-L1809) [background.ts L2205-L2243](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/extension/src/background.ts#L2205-L2243)

`[源码证据]` XHS family 含 publish、delete、follow、unfollow、draft clear/delete 和 ask 等 `access:'write'` 命令；部分删除有 dry-run，但 follow/unfollow 没有，publish 默认执行发布。未来 provider 不能按 site 加载整套 registry，只能显式注册 `saved`、`liked`、`note` 等确定性领域方法。[XHS docs L7-L27](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/docs/adapters/browser/xiaohongshu.md#L7-L27) [publish.js L1265-L1405](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/clis/xiaohongshu/publish.js#L1265-L1405) [delete-note.js L190-L228](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/clis/xiaohongshu/delete-note.js#L190-L228)

`[tracked-wide 静态检索]` 当前源码是 Agent-oriented CLI，没有现行 MCP server 实现；旧计划提到的路径不能当作当前能力。它适合受监督探索，不是现成的 MCP 生产适配器。

## 6. daemon、扩展权限与安全边界

| ID | 严重性 | 静态结论 |
|---|---|---|
| SEC-01 | 高（本地同用户进程/恶意扩展边界） | daemon 虽绑定 loopback，但没有不可猜 secret 或 OS peer identity；HTTP 固定 header 和宽松 extension Origin 只提供局部 CSRF 防护 |
| SEC-02 | 高 | Cookie、network headers/body 和任意页面执行处在同一高权限控制面；extension result/journal 与磁盘 body cache 没有统一持久化前脱敏 |
| SEC-03 | 高（条件性） | XHS download 可能在首跳把平台 Cookie 发给页面可控媒体目标，并由 Node 请求缺少 host/IP allowlist 的 URL，形成 blind SSRF/内网请求面 |
| SEC-04 | 中（隐私/secret handling） | PRIVACY 称不存个人数据，但 Cookie command result 可写入会随浏览器退出清除的 session journal |
| SEC-05 | 中高 | network response body 写入本地缓存，TTL 检查不等于删除，且缓存前未见统一 redaction |
| SEC-06 | 中 | `access:'read'` 不表达本地文件写；通用 browser 命令也不受 XHS registry 的只读 allowlist 约束 |
| SEC-07 | 中 | stealth 默认注入，目标包含隐藏 webdriver/automation/CDP 痕迹；不能作为账号安全证据，也不进入 Rednote 路线 |

### 6.1 daemon 信任边界

`[源码证据]` HTTP 请求检查非扩展 Origin，并要求固定 `X-OpenCLI` header；body 有 1 MiB 上限，服务监听 `127.0.0.1`。这些可降低普通网页 CSRF 与无界 body 风险，但固定 header 不是客户端身份凭据；本地进程可以生成，无 Origin 或任意 `chrome-extension://` 前缀的 WS 也不能绑定到唯一官方扩展身份。[daemon.ts L247-L289](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/src/daemon.ts#L247-L289) [daemon.ts L349-L475](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/src/daemon.ts#L349-L475) [daemon.ts L592-L594](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/src/daemon.ts#L592-L594)

### 6.2 secret、缓存与下载

- `[文档声明/源码冲突]` PRIVACY 声称扩展不存个人数据；所有 WS command 却经过 journal，Cookie action 返回 name/value，JSON 字符串长度不超过 `64×1024` 的完整结果最多 64 条写入 `chrome.storage.session`，未见按 Cookie action 排除或脱敏。实现把该长度命名为 bytes，但实际使用 `JSON.stringify(result).length`，不是严格字节计数。[PRIVACY L9-L16](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/PRIVACY.md#L9-L16) [background.ts L1903-L1920](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/extension/src/background.ts#L1903-L1920) [journal.ts L12-L23](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/extension/src/journal.ts#L12-L23) [journal.ts L80-L128](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/extension/src/journal.ts#L80-L128)
- `[源码证据]` extension capture result 可包含 request/response headers 和 body，完整小结果可能进入 session journal；磁盘 `~/.opencli/cache/browser-network/<session>.json` 只保存 URL/status/body，权限 0600。load 时会判 TTL，但过期文件未在该路径删除；各路径写入前都未统一调用 observation redactor。另一个 trace redactor 的存在不能证明 raw capture/journal/cache 安全。[CDP capture L22-L38](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/extension/src/cdp.ts#L22-L38) [journal.ts L80-L128](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/extension/src/journal.ts#L80-L128) [network-cache.ts L19-L117](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/src/browser/network-cache.ts#L19-L117) [redaction.ts L1-L90](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/src/observation/redaction.ts#L1-L90)
- `[源码证据/推断]` XHS downloader 把 `.xiaohongshu.com` Cookie 手工交给首个媒体请求；图片只有字符串 `includes` 筛选，视频 fallback 接受任意 HTTP/非 blob URL。Node fetch 未见 CDN hostname allowlist、私网/loopback/link-local 拒绝或逐跳 DNS/IP 重验；redirect 只在 host 改变时移除 Cookie。因此它同时形成条件性 Cookie 外送与 blind SSRF/内网请求面；这不代表已观察到真实事件。[download.js L34-L40](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/clis/xiaohongshu/download.js#L34-L40) [download.js L179-L193](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/clis/xiaohongshu/download.js#L179-L193) [download.js L236-L247](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/clis/xiaohongshu/download.js#L236-L247) [download index L102-L158](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/src/download/index.ts#L102-L158) [node-network.ts L194-L203](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/src/node-network.ts#L194-L203)

### 6.3 可借鉴的可靠性语义

`[源码证据]` daemon 合并同 ID 的在途请求；extension journal 能回放已完成结果，并把 worker 丢失和 result evicted 区分；transport 在中途断连时返回 unknown outcome 而不是盲重放。persistent write session 还有 runId/heartbeat 互斥。这些语义适合未来阶段四独立实现，但 journal 不能保存 secret 结果。[daemon.ts L67-L113](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/src/daemon.ts#L67-L113) [journal.ts L73-L137](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/extension/src/journal.ts#L73-L137) [daemon-client.ts L303-L474](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/src/browser/daemon-client.ts#L303-L474) [execution.ts L359-L457](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/src/execution.ts#L359-L457)

`[源码证据]` 页面对象默认注入 stealth，明确尝试隐藏 webdriver、automation 与部分 CDP 痕迹。该实现只作为风险记录；真实 Chrome、随机 delay 或 stealth 均不是平台许可、可靠性或账号安全证明。[page.ts L91-L149](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/src/browser/page.ts#L91-L149) [stealth.ts L1-L47](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/src/browser/stealth.ts#L1-L47)

## 7. 依赖、CI、测试与许可证

### 7.1 安装与插件执行面

- `[配置/源码证据]` root package 声明 `postinstall`、`prepare` 和 `preuninstall`。全局安装/npm link 且非 CI 时，postinstall 会向用户 shell completion 目录写文件并创建 Spotify 环境模板；adapter 同步脚本只在全局安装、显式 `OPENCLI_FETCH=1` 或 first-run 路径清理本地 override/旧 shim/tmp 并写 manifest。因此这些特定安装/首次运行路径有工作目录以外的副作用，不应扩张为所有 npm install 都会写入。[package.json L42-L56](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/package.json#L42-L56) [postinstall.js L76-L169](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/scripts/postinstall.js#L76-L169) [fetch-adapters.js L101-L274](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/scripts/fetch-adapters.js#L101-L274) [fetch-adapters.js L281-L290](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/scripts/fetch-adapters.js#L281-L290)
- `[源码证据]` 插件安装会 shallow-clone 当前远端 HEAD，以 `--ignore-scripts` 安装生产依赖，再转译并在启动时动态 import 插件 JavaScript；lock 记录安装后的 commit，但没有签名、源码审核或能力沙箱门。`--ignore-scripts` 和原子替换是正面边界，插件本体仍是任意 Node 代码。[plugin.ts L227-L250](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/src/plugin.ts#L227-L250) [plugin.ts L562-L619](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/src/plugin.ts#L562-L619) [discovery.ts L201-L250](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/src/discovery.ts#L201-L250)
- `[采用边界]` Rednote Sync 不自动安装或加载第三方插件；探索工具和生产 Adapter 分离。任何未来扩展都需要显式批准、固定 commit、来源/许可证清单和精确 capability。

### 7.2 lock、CI、测试与发布

- `[配置证据]` root 与 extension 都使用 npm lockfileVersion 3，静态计数显示 338/68 个非 root package entry 带 integrity；CI 采用 `npm ci`。Security workflow 在 push、PR 和每周任务运行 production `npm audit --audit-level=high`；npm 发布启用 OIDC 权限及 `npm publish --provenance`。[root lock L1-L40](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/package-lock.json#L1-L40) [CI L25-L39](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/.github/workflows/ci.yml#L25-L39) [security workflow L1-L33](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/.github/workflows/security.yml#L1-L33) [release L8-L68](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/.github/workflows/release.yml#L8-L68)
- `[配置漂移]` tracked `bun.lock` 是第二套锁文件，但其根依赖与当前 `package.json` 已偏离：仍含已移除的 `chalk`，缺少当前若干依赖，并有不同版本范围。CI 的 Bun job 先 `npm ci` 再用 Bun 跑测试，未验证 `bun.lock`；项目安装文档也优先推荐 npm。这不影响上述 npm lock 事实，但说明不能把它扩张成全部包管理器均已锁定。[bun.lock L1-L25](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/bun.lock#L1-L25) [package.json L81-L101](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/package.json#L81-L101) [CI L92-L111](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/.github/workflows/ci.yml#L92-L111)
- `[配置风险]` 第三方 Actions 使用可变 major/version tag 而非完整 commit SHA；extension build workflow 整体授予 `contents:write`。GitHub extension ZIP 没有 tracked checksum、签名、attestation 或 SBOM 步骤；npm package 只有 provenance。tracked tree 未见 SECURITY.md、Dependabot/Renovate 或 SBOM 配置。[build-extension L3-L18](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/.github/workflows/build-extension.yml#L3-L18) [build-extension L45-L66](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/.github/workflows/build-extension.yml#L45-L66)
- `[配置漂移/未知]` extension package/manifest 是 1.0.22，而 extension lock root 是 1.0.21。是否导致当前 `npm ci` 失败未执行验证，不能凭静态差异直接断言。[extension package L1-L7](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/extension/package.json#L1-L7) [extension lock L1-L14](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/extension/package-lock.json#L1-L14)
- `[测试证据（未运行）]` Vitest 分 unit、extension、adapter、fixed-port E2E、普通 E2E 和 smoke；普通 PR 主要跑 typecheck/build/unit，adapter、真实 daemon transport 和 headed 浏览器测试在其他触发上。测试文件覆盖同 ID 不重复 dispatch、deadline、断连 unknown outcome、journal replay/lost/evicted；这证明设计意图和已有回归样本，不证明当前全部 CI 通过或在线 XHS 行为。[vitest config L6-L67](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/vitest.config.ts#L6-L67) [daemon transport test L181-L320](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/tests/e2e/daemon-transport.test.ts#L181-L320) [journal test L20-L120](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/extension/src/journal.test.ts#L20-L120)

### 7.3 许可证与复用边界

`[许可证证据]` 根 LICENSE 是 Apache License 2.0，package 元数据与 CONTRIBUTING 声明一致；仓库没有 NOTICE。Apache-2.0 的复制/分发需要保留许可证和适用归属、标记修改，若上游未来提供 NOTICE 还需相应处理，并注意专利终止条款。本报告不是法律意见。[LICENSE L1-L4](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/LICENSE#L1-L4) [LICENSE L66-L80](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/LICENSE#L66-L80) [package.json L75-L80](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/package.json#L75-L80)

许可证比上一候选清晰，但高权限实现并不因许可证许可而适合复用。当前仍优先独立实现少量行为；若未来复制源码，必须维护 third-party notices、修改记录和依赖许可证清单。

## 8. 对 Rednote Sync 的参考价值

对照 [`sync-core.md`](../../projects/rednote-sync-core/docs/sync-core.md)：

| 方面 | 当前判断 | 采用边界 |
|---|---|---|
| 发现与访问材料 | A 级设计参考 | stable ID 与私有 access material 一对一配对；完整 signed URL 不进入 SQLite/日志 |
| 分层获取 | A 级设计参考 | network response → hydrated state → DOM，每层做版本化 shape 校验和 sourceLayer 记录 |
| 详情 Schema | 仅反例/补充 | field/value DOM 行不能替代版本化 `TransientNote` |
| 媒体顺序 | 可借鉴 current-note keyed state 优先 | 自行补齐 Live Photo、ordinal、variant、MIME、长度、hash 和逐资产状态 |
| checkpoint/分页 | 不采用 | 没有服务端 cursor、水位、durable partial 或进程恢复 |
| 会话所有权 | 借鉴显式 profile、target lease 和 unknown outcome | 必须增加 `SessionBinding(hostId, accountId, profileId)`，禁止 preferred fallback |
| Agent/CLI | 只限受监督探索 | 生产链只允许确定性领域方法，不开放任意 eval/navigation/input/upload |
| secret | 高风险反例 | Cookie、signed URL、network body、trace 不得对 Agent/日志/持久层暴露 |
| 本地写 | 独立 capability | download 默认禁用，受输出根、配额、host allowlist 和完整性门约束 |
| 阶段边界 | 不改变阶段三 | 全部浏览器、网络、Cookie 和平台事实只属于未来阶段四授权与审查门 |

## 9. 采用分级

| 分类 | 结论 |
|---|---|
| 可直接参考的行为 | stable ID/access material 配对、分层 shape validation、current-note media order、同 ID journal、unknown-outcome、target lease |
| 必须独立实现 | Browser/Session Adapter、账号身份绑定、分页/checkpoint、版本化详情/media Schema、secret envelope、媒体完整性、精确 capability |
| 仅作背景或测试样本 | XHS selector、Pinia 路径、内部 endpoint、network exploration、typed security/login errors |
| 当前排除 | 整体 Browser Bridge、`<all_urls>`、任意 eval、绑定日常 tab、平台写命令、Cookie journal/跨域转发、无 host/IP 边界的 Node 下载、stealth、把 scroll limit 当 cursor |

**最终建议等级：A（专项设计参考），但整体生产复用与高权限/stealth/平台写路径为 D。** 该等级不证明在线兼容、账号安全或可绕过平台限制。

## 10. 未知项

- 未运行项目或测试，也未访问平台；当前 selector、hydrated store、endpoint、signed URL 有效期和账号安全全部未知。
- saved/liked 的完整分页、排序、删除/置顶语义和 token 生命周期没有服务端契约证据。
- network cache、journal、daemon 与 extension 的实际运行时上限及浏览器版本兼容性未动态验证。
- 没有联网 SCA，依赖 CVE、可达性和传递许可证仍未知。
- extension lock 版本漂移对 `npm ci` 的实际影响、已发布扩展与该 commit 的一致性、分支保护和当前 CI 结果未知。
- `bun.lock` 漂移的运行时影响未知；package 要求 Node `>=20`，安装指南却写 Node `>=21` 或 Bun `>=1.0`，支持口径也存在文档漂移。[package.json L8-L10](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/package.json#L8-L10) [installation L3-L6](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/docs/guide/installation.md#L3-L6)
- 没有官方证据证明 stealth、随机等待或真实 Chrome 能降低风控风险。

## 11. 证据索引与独立复审

### 11.1 审查分工

- XHS 发现、详情、媒体和平台写能力：领域 Subagent，fixed commit tracked-only。
- Browser Bridge、profile/session、Agent 和隐私：领域 Subagent，fixed commit tracked-only。
- daemon、安全、依赖、CI 与许可证：领域 Subagent，fixed commit tracked-only。
- `sync-core.md` 映射和报告写入：主 Agent。

### 11.2 独立复审

- **证据与链接复审：PASS。** 固定 revision/tree、detached/clean 状态、全部固定 commit 链接、本地链接和证据等级已核对；isolated window、contextId、journal 长度语义及安装脚本证据返修后准确。
- **安全复审：PASS。** daemon 鉴权边界、extension 权限、Cookie/journal/cache、条件性 Cookie 外送与 blind SSRF、平台写面和 stealth 边界均闭环；建议只包含隔离、allowlist、停止和 secret 防护，没有规避措施。
- **供应链、许可证与项目适配复审：PASS。** npm/Bun/extension lock 边界、CI/Actions、postinstall/plugins、Apache-2.0 复用要求以及 A/D 分级均有证据；阶段三继续完全离线。
- 首轮 reviewer findings 已全部修正并完成末读；无剩余 P0～P3 阻断项。
