# xiaohongshu-cli 专项源码审查

状态：专项静态审查完成，三类独立复审通过  
审查日期：2026-08-13  
固定 revision：[`4d63f3c0c85ccd9054fa8e96d7f761aaf2507449`](https://github.com/jackwener/xiaohongshu-cli/tree/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449)  
上游快照版本：`0.6.4`

> 本报告只描述固定 revision 的 tracked 静态实现，不证明当前在线兼容性、平台许可、运行可靠性或账号安全。未执行逆向签名、Cookie 扫描、QR 登录、浏览器、测试、平台请求或写操作。

## 1. 范围、来源与方法

- 来源与固定快照见 [`provenance.json`](provenance.json)，恢复状态见 [`checkpoint.json`](checkpoint.json)。
- 只读审查 51 个 tracked paths，覆盖 README、SCHEMA、SKILL、manifest/lock、CLI、client/mixins、Cookie/token、登录、签名、测试和 CI。
- 证据区分 `[README/SKILL 声明]`、`[源码证据]`、`[配置证据]`、`[测试证据（未运行）]`、`[推断]` 和 `[未知]`。
- 不安装、不构建、不运行项目或测试，不读取浏览器/profile/Cookie/token/个人数据，不访问小红书。

## 2. 结论摘要

xiaohongshu-cli 最值得参考的是命令层、领域 mixin 与 transport 的分层，`note_id + xsec_token + xsec_source` 的短期访问材料配对，以及类型化认证/风控错误和外层 success/error envelope。搜索 `search_id` 按 query scope 短期复用、部分列表显式透传 cursor，也能帮助定义未来阶段四 Provider 的会话内接口。

它不能直接作为 Rednote Sync Provider、同步状态层或 Agent 工具。`schema_version: "1"` 只版本化最外层 envelope，内部 `data` 仍是未验证的上游对象；Feed API 与 HTML fallback 甚至返回不同 shape。项目没有 durable checkpoint、水位、逐笔记/逐资产状态、媒体下载或完整性闭环。`comments --all` 最多读 20 页后仍无条件返回完成。验证码、IP 限制、签名或会话错误在部分路径会被捕获后继续访问，统一 retry 又会重放评论、点赞和发布等非幂等写操作。

安全上，认证缺少可用或未过期的已保存 Cookie时，默认 `auto` 会扫描多个本地浏览器并选首个含 `a1` 的 Cookie，未绑定预期账号/profile；QR 和请求日志可泄露会话材料；自带 Skill 暴露平台写能力；发布命令还能读取并上传任意本地路径。许可证只出现在 metadata/README，固定树没有 LICENSE/NOTICE，因此当前排除源码复制、链接或派生。

### 核心结论：

- 最终建议为 **B（局部设计参考）**；现成网络客户端、签名、Camoufox、“anti-detection”、Agent Skill 和平台写能力均为 **D（直接复用排除）**。
- 可独立实现：短期 `AccessHandle(noteId, token, source)`、类型化错误、只读命令/transport 分层、纯 HTTP QR 流程内部的 user-ID 一致性检查，以及仅针对 Cookie 名称的 allowlist。
- 外层 envelope 不是稳定领域 Schema；原始 `data`、Rich normalizer 和 HTML fallback 都不能定义 canonical Note/List/Media。
- 搜索 session、token cache、短索引和 response cursor 只是交互材料，没有 checkpoint、水位、事务、账号/scope provenance 或完成证明。
- 没有正式媒体/Live Photo/下载模型；原始 response 偶然含媒体字段不等于支持媒体同步。
- 验证码、IP 限制、签名拒绝和身份变化必须在 Rednote Sync 中成为全局硬停止；当前实现的 fallback/刷新后继续请求不应采用。
- 所有方法共用 retry，可能重复非幂等 POST；平台写能力必须从同步器 capability 集合中彻底移除。
- 缺少已保存 Cookie、Cookie 过期、显式登录或会话过期刷新时，默认 auto 模式会扫描多个浏览器并可能选错账号；未来阶段四必须使用专用 profile、`SessionBinding`、单账号互斥及每轮身份校验。
- QR、Cookie、xsec token、请求 URL和原始响应均按 secret 处理，不得进入普通日志、Agent 上下文、Trace、Markdown或长期 state。
- 高斯抖动、固定 Header/指纹、真实浏览器和 Camoufox 只能证明实现存在，不能证明合规、账号安全或降低风控概率。
- fixed tree 没有许可证正文；在上游澄清和发布制品专项核对前，只借鉴行为，不复制或链接源码。
- 阶段三继续完全离线；任何 Cookie、签名、浏览器和平台网络能力只属于未来阶段四的独立授权与规格门。

## 3. 架构、数据流与 Schema

### 3.1 架构和能力面

`[源码证据]` 主链为 Click CLI → command helper → `XhsClient` → 六个 endpoint mixin → signing/HTTP transport → 原始上游 `data` → JSON/YAML envelope 或 Rich renderer。命令层同时注册读取、互动、社交、发布和删除能力。[CLI 注册](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/cli.py#L49-L116) [Client 组合](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/client.py#L40-L48) [公共 helper](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/commands/_common.py#L30-L71)

这套 command/domain/transport 分层值得借鉴，但读写必须在 capability 注册层拆开。平台写 endpoint 覆盖点赞、收藏、评论、回复、关注、上传、发布和删除。[互动 endpoint](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/client_mixins.py#L484-L518) [上传/发布](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/client_mixins.py#L538-L608) [社交 endpoint](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/client_mixins.py#L631-L652)

### 3.2 Envelope 不是领域 Schema

`[README/文档声明]` README 和 SCHEMA 定义 `ok/schema_version/data/error` 的稳定外层 envelope。[README](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/README.md#L18-L33) [SCHEMA](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/SCHEMA.md#L1-L30)

`[源码证据]` formatter 只给上游对象包一层 `schema_version: "1"`；client 仅检查 `success` 后直接返回 `data`，没有按命令进行字段解码、运行时校验或 payload schema version。[Envelope](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/formatter_utils.py#L68-L109) [Response handling](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/client.py#L111-L151)

`[边界]` Rednote Sync 只能借鉴 success/error envelope 和稳定错误代码思想。未来 Provider 必须把 provider-native response 解码为独立版本化的 ListItem、Detail 和 Media DTO，再进入 Core；字符串 `"1"` 也不能直接冒充 core 的 `schemaVersion`。

`[推断]` 公共 `handle_command` 只捕获 `XhsApiError` 与 `NoCookieError`；本地文件异常等其他错误可能绕开结构化 error envelope。[异常边界](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/commands/_common.py#L53-L71)

## 4. 发现、详情、分页、媒体与状态

### 4.1 发现材料与分层详情

`[源码证据]` 搜索、Feed 和热门列表会从条目提取 note ID/token，把 token 与来源配对缓存并写入最近一次列表 index；详情命令可从 ID、完整 URL 或短索引解析这些材料。[搜索材料](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/commands/reading.py#L24-L79) [Feed](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/commands/reading.py#L193-L211) [热门列表](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/commands/reading.py#L260-L297) [引用解析](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/note_refs.py#L11-L27) [Token cache](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/cookies.py#L186-L233)

`[采用]` 这种 `{stable ID, exact access material, source}` 配对值得映射为阶段四内存态 `AccessHandle`；token/source 不得进入 canonical Note、公开 URL、日志、Markdown 或长期 cursor state。

`[源码证据]` 详情有 token 时先请求 Feed API，失败后回退 HTML；无 token 直接 HTML。HTML parser 返回 `noteDetailMap[note_id].note`，若精确 ID 不存在还会取第一条；Rich detail normalizer却要求 `data.items[0].note_card`。[详情分层](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/client_mixins.py#L344-L368) [HTML 提取](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/html_parser.py#L46-L73) [Normalizer](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/formatter_normalizers.py#L40-L60)

`[风险]` 两条获取路径返回 shape 不一致；精确 ID 缺失后选第一条还可能混入错误笔记。测试用伪造的 Feed shape 代替真实 HTML parser 结果，不能闭合这一契约。[Fallback 测试（未运行）](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/tests/test_client.py#L259-L278)

### 4.2 Cursor、搜索 session 与不完整结果

- `[源码证据]` 搜索按 `(keyword, sort, note_type)` 缓存 `search_id` 10 分钟、最多 128 条，可跨进程复用；它不记录已完成 page、items、水位或结果 receipt，因此不是 checkpoint。[Search session](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/client_mixins.py#L29-L40) [获取/保存](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/client_mixins.py#L112-L168)
- `[源码证据]` 用户笔记、收藏、点赞和通知接受 cursor，并把原始 cursor 透传给调用方；没有 request/next cursor 配对、页级事务、账号/scope provenance 或 durable progress。[用户笔记](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/client_mixins.py#L260-L272) [收藏/点赞](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/client_mixins.py#L640-L674)
- `[源码证据]` `comments --all` 默认最多 20 页，没有重复 cursor 检测或 durable partial；无论是服务端真正结束还是达到上限，最终都返回 `has_more: false` 与空 cursor。[All comments](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/client_mixins.py#L430-L467)
- `[源码证据]` `index_cache.json` 只保存最近一次列表的 tokenized rows，下一列表整体覆盖；缺少 schema、账号、host、scope、cursor、生成时间和 digest。写入非原子，多个 CLI 进程可互相覆盖。[Index cache](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/cookies.py#L248-L293)

### 4.3 媒体和恢复缺口

`[源码证据]` 仓库没有媒体下载器或正式 Asset contract；详情显示层只报告图片数量，搜索粗分 image/video，自带 Skill 也明确不支持下载图片/视频。[Normalizers](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/formatter_normalizers.py#L40-L83) [Skill 限制](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/SKILL.md#L230-L237)

`[边界]` 原始 payload 偶然包含图片/视频字段不等于媒体支持。没有 Live Photo 配对、完整集合标志、稳定 ordinal、逐资产状态、Range、长度/hash、MIME 或落盘 receipt。

`[源码证据/推断]` 现有恢复只有短期 cache、transport retry、Cookie 刷新后重新执行整个 action 和详情 fallback。写操作没有 operation ID/idempotency key，发布 action 刷新登录后还可能重新上传、查询话题并再次发布。[Command retry](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/commands/_common.py#L34-L50) [发布 action](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/commands/creator.py#L47-L76)

## 5. Cookie、token、会话与身份

| ID | 严重性 | 静态结论 |
|---|---|---|
| AUTH-01 | 高 | 缺少/过期 Cookie、显式登录或会话刷新触发 `cookie-source=auto` 时，并发扫描多个浏览器并选首个含 `a1` 的结果；保存状态不含 expected account、profile 或 owner，可能切换账号 |
| AUTH-02 | 高 | QR/HTTP 调试日志和异常可包含 session、QR ID/code、验证挑战 `verify_uuid`、完成响应和 xsec token URL |
| AUTH-03 | 中 | Cookie/token/index 最终 `0600` 是正面边界，但目录非显式 `0700`、创建先写后 chmod、无 no-follow/跨进程锁；logout 只删 Cookie 文件 |
| AUTH-04 | 中 | xsec token 可进入 argv、Rich hyperlink、原始 JSON/YAML、token cache 与 index；24 小时 TTL 是本地策略，不是平台有效期证明 |
| AUTH-05 | 中 | 限速、验证码计数和请求预算只存在单个 client；每次 CLI/Agent 调用重置，不能形成账号级调度和冷却 |

`[源码证据]` 普通命令统一调用 `get_cookies`，它优先使用未过期的已保存 Cookie；缺失/过期、显式登录或会话过期强制刷新时，auto 模式才枚举 browser-cookie3 loader并以最多四线程执行，选择首个含 `a1` 的结果。浏览器 Cookie 登录路径会检查当次用户，但后续任务没有 `expectedAccountId` 持续断言。[公共认证](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/commands/_common.py#L30-L50) [保存 Cookie 优先级](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/cookies.py#L481-L526) [浏览器扫描](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/cookies.py#L319-L347) [并发选择](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/cookies.py#L430-L478) [登录检查](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/commands/auth.py#L101-L123)

`[源码证据]` QR 路径会把 `web_session`、完成数据、guest session、QR ID/code 和轮询 payload 写入 debug/异常；`NeedVerifyError` 还把 `verify_uuid` 放入普通异常消息。GET debug 日志记录完整 URL，而评论 token 位于 query。非 verbose 的 retry warning 也记录 URL 前 80 字符。[QR secrets](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/qr_login.py#L200-L253) [QR polling](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/qr_login.py#L446-L502) [验证挑战异常](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/exceptions.py#L13-L19) [GET/logging](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/client.py#L160-L201)

`[正面/不足]` Cookie、token cache 和 index 写后 chmod `0600`，测试也检查 Cookie/index 最终模式；但不是原子安全创建，配置目录未显式 `0700`，logout 不清 token/index/search cache，也不撤销服务端或浏览器会话。[Cookie storage](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/cookies.py#L67-L81) [Caches](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/cookies.py#L130-L180) [权限测试（未运行）](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/tests/test_cookies.py#L36-L52) [Index 权限测试（未运行）](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/tests/test_cookies.py#L140-L181) [Logout](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/commands/auth.py#L148-L155)

`[有限正面]` Browser-assisted QR 仅导出 allowlist Cookie 名称；纯 HTTP 路径在保存前比较流程内部的 confirmed/completion/self user ID。它没有与用户预先指定的 expected account 比较，不能等同完整 `SessionBinding`。Cookie domain 过滤又使用字符串包含判断，故只可借鉴“名称最小化”意图，独立实现时必须使用解析后的严格 host/suffix 边界。[Cookie 名称 allowlist](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/qr_login.py#L40-L53) [Domain 判断](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/qr_login.py#L103-L117) [HTTP 流程内部一致性](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/qr_login.py#L183-L253)

`[关键缺口]` 默认 browser-assisted QR 只观察一次 post-login `user/me`；若返回 `guest=true` 仅写 debug并继续保存 Cookie，login command 随后仍可输出 `authenticated: true`。它没有 expected account 绑定，属于身份 fail-open，不能作为正面 SessionBinding 模板。[Browser settle](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/qr_login.py#L157-L180) [Browser QR completion](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/qr_login.py#L340-L443) [Login 输出](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/commands/auth.py#L64-L94)

## 6. 网络、重试、签名与风控边界

### 6.1 类型化错误没有形成可靠硬停止

`[源码证据]` transport 将 461/471、IP 封禁、签名错误和会话过期映射为类型化异常；错误码模型进一步输出 `verification_required/ip_blocked/signature_error/not_authenticated` 等值。[Response errors](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/client.py#L111-L151) [Error codes](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/error_codes.py#L16-L39)

`[关键缺口]` 搜索 prewarm/recommend 捕获所有 `XhsApiError` 后继续；详情捕获包含验证码/IP/签名/会话在内的异常后继续 HTML；缓存 token 的评论路径在同类异常后刷新 token 再请求。HTML response 又不经过 `_handle_response` 的类型化错误判断。[搜索继续](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/client_mixins.py#L274-L316) [详情 fallback](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/client_mixins.py#L344-L368) [评论重试](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/client_mixins.py#L388-L428) [HTML fetch](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/client_mixins.py#L200-L220)

`[Rednote 边界]` 验证码、身份变化、IP 限制、签名拒绝和安全限制必须触发账号级 circuit breaker，原子保存 progress 后停止所有获取层；不得切换通道、刷新 token 或自动继续。

`[项目恢复建议/排除]` 项目的 `IpBlockedError` 文案建议更换网络，Skill 进一步建议 hotspot/VPN。Rednote Sync 只借鉴 `ip_blocked` 错误代码，不复用该恢复消息或行为；IP 限制必须停止并转人工审查，不自动切换网络、代理或账号。[异常文案](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/exceptions.py#L29-L34) [Skill 建议](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/SKILL.md#L64-L69)

### 6.2 Retry 与网络边界

`[源码证据/推断]` `_request_with_retry` 对所有 method 统一重试 429、5xx 和网络异常，忽略 `Retry-After`，没有幂等键、提交回执或写后核验；默认 `range(3)` 是最多三次总尝试，不是“首次 + 三次重试”。评论、点赞、关注、上传和发布均经过该层，响应丢失时可能重复或反转写操作。[Retry](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/client.py#L160-L189) [写 endpoint](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/client_mixins.py#L484-L518)

`[源码证据]` 初始业务 host 来自固定 HTTPS 常量，未发现公共路径把用户绝对 URL直接交给 client，也未见 `verify=False`；因此不能声称存在直接用户 URL SSRF或关闭 TLS。[Host constants](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/constants.py#L3-L14)

`[未知]` httpx client 使用 `follow_redirects=True`，代码没有显式 redirect host allowlist。跨域时 header/Cookie 如何处理依赖 httpx 版本行为，本次未执行，既不确认泄漏也不确认安全。[Client config](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/client.py#L50-L59)

### 6.3 “Anti-detection”与签名

`[README 声明]` 项目将高斯延迟、随机长暂停、指纹一致性和验证码渐进冷却描述为 anti-detection。[README](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/README.md#L177-L197)

`[源码事实]` client 确有实例内 jitter、请求和验证码计数，461/471 后等待 5→30 秒并提高实例 delay；新 CLI/client 会把这些字段重置。测试只核静态 Header、签名键和初始计数，没有真实验证码/账号/风控结果。[Rate state](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/client.py#L50-L120) [测试（未运行）](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/tests/test_anti_detection.py#L9-L104)

`[源码/配置事实]` 主 API 签名是 `xhshow` 薄适配，Creator 签名包含固定参数；Camoufox 是 mandatory dependency，但浏览器 runtime 需另行 `camoufox fetch`，不受本仓库 lock 覆盖。[主签名适配](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/signing.py#L15-L75) [Creator signing](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/creator_signing.py#L15-L70) [Camoufox 路径](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/qr_login.py#L313-L359)

`[边界]` 本报告只登记实现与依赖，不解释或迁移签名算法。stealth、固定指纹、真实浏览器和延迟不进入 Rednote Sync，也不能作为合规或账号安全证明。

## 7. CLI/Agent 权限、平台写操作与本地文件

| ID | 严重性 | 静态结论 |
|---|---|---|
| CAP-01 | 高 | 自带 Skill 声明支持全部操作，并向 Agent 示范自动 like/follow/comment/favorite/post；没有生产只读 allowlist或逐次写确认门 |
| CAP-02 | 高 | CLI 注册完整平台写面；除删除笔记/评论外，多数写操作直接执行，不能整体暴露给同步器 |
| CAP-03 | 高（Agent 可控路径） | `post --images` 可读取任意本地路径，整文件载入内存并上传固定平台 host，形成 prompt-induced 本地数据外传能力 |
| CAP-04 | 中 | 平台 read/write、secret read、本地 file read/write 没有独立 capability 维度；结构化输出标签不能替代权限边界 |

`[SKILL 声明]` Skill 声明处理“ALL”操作，并给出搜索后点赞、读取用户后关注等自动化流程；安全段虽写不并发、验证码人工处理和保护 Cookie，仍没有强制授权机制。[Skill scope](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/SKILL.md#L1-L19) [自动写流程](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/SKILL.md#L102-L159) [安全说明](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/SKILL.md#L239-L252)

`[源码证据]` 多数点赞、收藏、评论、关注和发布命令立即执行，只有删除动作要求确认。[互动命令](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/commands/interactions.py#L18-L120) [社交命令](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/commands/social.py#L51-L78) [发布命令](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/commands/creator.py#L28-L84)

`[源码证据/推断]` `--images` 接受任意路径，`upload_file` 直接读取全部 bytes，并以推断 MIME 或 octet-stream 上传固定 host。对手不能选择网络目的地，但能诱导 Agent 读取并外传其进程可读文件。[Image argument](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/commands/creator.py#L28-L52) [Upload](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/client_mixins.py#L538-L571)

`[排除]` 不安装或加载该 Skill，不把整个 CLI 放入 Agent 工具箱。阶段四生产 Provider 必须是独立只读进程，仅允许命名空间化的 discovery/detail 能力；不包含任意本地文件读取、平台互动或发布。

## 8. 依赖、测试、CI 与许可证

### 8.1 依赖和供应链

- `[配置证据]` `pyproject` 以 lower bound 声明 `httpx/click/rich/browser-cookie3/pycryptodome/xhshow/PyYAML/qrcode/camoufox`；`uv.lock` 固定 61 个 package 节点，其中 60 个 registry 节点带制品 URL/hash，`xhshow=0.1.9`。[Manifest](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/pyproject.toml#L1-L35) [Lock](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/uv.lock)
- `[适用范围]` lock 只能证明固定仓库开发/CI 快照有一张可解析的依赖图；发布包仍以 lower bound 声明依赖，普通安装不会受仓库 lock 约束，因此不能据此声称发布安装可复现。CI 的 `uv sync` 又未显式使用 `--locked/--frozen`；Camoufox 浏览器制品另需 fetch，不在 lock；本轮未运行 SCA，不能据静态 lock 推断没有 CVE。
- `[配置证据]` 外部 Actions 使用 `actions/checkout@v4`、`setup-python@v5`、`setup-uv@v6` 和 PyPI action tag，未固定 commit SHA。[CI](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/.github/workflows/ci.yml#L10-L57) [Publish](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/.github/workflows/publish.yml#L9-L34)
- `[正面/缺口]` PyPI 发布使用 environment 与 OIDC `id-token:write`，未配置长期 PyPI token；但未设版本边界的 `hatchling` 是构建后端，verify 与 publish 分别重新运行 `uv build`，没有传递同一已验证制品或显式构建约束，也未见 SBOM、SCA、secret scan、CodeQL、制品签名或 attestation/provenance。[构建后端](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/pyproject.toml#L1-L3) [CI build](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/.github/workflows/ci.yml#L38-L57)
- `[发布控制未知]` workflow 支持从非 tag ref 手动触发；`pypi` environment 是否配置人工审批或 branch/tag policy 属仓库外设置，本次无法核对。[Publish triggers](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/.github/workflows/publish.yml#L3-L34)

### 8.2 测试信号和运行风险

`[配置/测试证据（未运行）]` CI 在 Python 3.10/3.12/3.13 跑 Ruff和 `pytest --ignore=tests/test_integration.py`，再构建分发包；mypy虽配置但 CI 未执行。现有测试覆盖 envelope、token/index cache和 search session等意图，不证明当前在线契约。[CI](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/.github/workflows/ci.yml#L10-L57)

`[高风险测试边界]` pytest 默认只排除 `smoke`，而 `tests/test_integration.py` 未标 smoke；模块收集会尝试读取项目保存的本地 Cookie，缺失或过期时还可能回退 Chrome Cookie 提取，且文件包含点赞、收藏、评论等真实写测试。固定 revision 又把 `get_cookies()` 返回的 tuple 直接交给 `XhsClient`，该缺陷会在映射操作前失败并被 catch，使当前文件跳过；因此没有证据表明本快照默认 pytest 能实际触发写测试。但一旦该缺陷被修正，默认配置就可能执行它们，故本审查仍禁止运行，并要求以后先隔离成合成 fixture。[Pytest config](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/pyproject.toml#L56-L62) [Integration collection](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/tests/test_integration.py#L20-L47) [Cookie priority/return shape](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/cookies.py#L481-L526) [写测试](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/tests/test_integration.py#L276-L340)

### 8.3 许可证

`[配置/README 声明]` `pyproject.toml` 和 README 声明 Apache-2.0。[Manifest](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/pyproject.toml#L5-L20) [README](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/README.md#L476-L478)

`[固定树事实]` 51 个 tracked paths 中没有 LICENSE、NOTICE 或 COPYING，无法从本快照核对完整许可证正文、版权归属与通知要求。当前只允许借鉴行为；复制、链接、派生或分发源码均等待上游澄清及固定发布制品的独立许可证审查。此处不是法律意见。

## 9. 对 Rednote Sync 的参考价值

| 候选行为 | Rednote Sync 落点 | 采用边界 |
|---|---|---|
| `note_id + token + source` | 阶段四内存态 `AccessHandle` | Secret 不进入 Core、日志、Markdown或长期 state |
| API → HTML 分层 | Provider acquisition layer | 风控/身份错误不得 fallback；所有结果归一到同一 runtime-validated DTO |
| search_id / raw cursor | 会话内分页上下文和动态验证候选 | 不能冒充 checkpoint、水位、完成证明或账号级 state |
| 类型化错误码 | `AUTH_REQUIRED/VERIFICATION_REQUIRED/IP_BLOCKED/SIGNATURE_REJECTED/SCHEMA_DRIFT` | 验证码、身份和安全限制必须硬停止，而非继续请求 |
| success/error envelope | Adapter 诊断格式 | 不代替 List/Detail/Media Schema |
| 纯 HTTP QR 内部 user-ID 比较 | `SessionBinding` 的一个校验步骤 | 不是 expected-account 绑定；browser-assisted 路径还是 fail-open，需专用 profile、单账号 lease和每轮复核 |
| Cookie 名称 allowlist | 登录材料最小化 | 仅借鉴名称 allowlist；另做严格 domain 校验，不扫描日常浏览器，不向 Agent 返回原值 |
| command/mixin/transport 分层 | Provider 内部模块边界 | 生产只读 allowlist；平台写、本地文件、secret capability分开 |

阶段三继续遵循 [`sync-core.md`](../../projects/rednote-sync-core/docs/sync-core.md) 的完全离线边界。本项目所有运行能力都依赖网络、Cookie、签名或浏览器，只属于未来阶段四，且不能覆盖 Core 对 canonical state、cursor、checkpoint 和 media receipt 的所有权。

## 10. 采用分级与排除项

- **整体：B — 局部设计参考。** 不直接作为生产 Provider或 Agent 工具。
- **B — 独立实现参考：** 类型化错误代码（不含换网络恢复文案）、外层 envelope、AccessHandle 配对、Cookie 名称 allowlist、纯 HTTP QR 内部 user-ID 比较、command/domain/transport 分层。
- **C — 背景/探索：** DOM/HTML state 路径、raw cursor、short index、Rich normalizer、上游字段 heuristics。
- **D — 明确排除：** 自带 Agent Skill、完整 CLI capability、所有平台写、任意本地路径上传、自动浏览器扫描、网络 client统一 retry、签名/stealth/Camoufox、raw secret 日志、缓存/index作为同步状态。
- **许可证隔离：** 固定树无许可证正文，所有源码复制/链接/派生均排除；如未来需要采用，只能先对固定发布 tag/tarball重新核对 LICENSE/NOTICE/依赖归属。

## 11. 未知项、证据索引与独立复审

### 11.1 未知项

- 当前真实搜索、收藏、点赞、详情、HTML state和 cursor shape 是否仍与代码假设一致。
- token/source 的真实绑定、过期和撤销规则；24 小时 TTL 只是项目本地策略。
- 原始详情中的图片、视频、Live Photo字段及完整度。
- httpx 在固定依赖版本下跨域 redirect 对 Cookie/自定义 header 的精确处理。
- 服务端是否存在代码未使用的写操作幂等机制。
- 已发布 PyPI 包/浏览器制品是否与 fixed commit 一致，以及其完整许可证、provenance和当前 CVE 状态。
- `pypi` GitHub environment 是否对手动非 tag 发布配置了审批或 ref 保护。
- README 所称 anti-detection 的真实效果、当前账号风险和平台许可均未验证。

### 11.2 证据等级与复审状态

- 固定 tracked 源码、配置和测试文件为一手静态证据；README/SCHEMA/SKILL 只作项目声明或冲突依据。
- 测试只读未运行，不能作为当前 pass、在线兼容或账号安全证明。
- 风险利用性与失败后果明确标为静态推断，没有 PoC或真实事件证据。
- 已由未参与初始研究的 Subagent 分别复审：证据/链接与 revision、会话/secret/Agent 安全、供应链/许可证与 Rednote 适配；三类复审均 PASS。

### 11.3 审查 finding

- `EVIDENCE-ROUND-1`：修正 pytest 文件计数、权限测试证据和 Feed/hot 固定链接范围；末读 PASS，无未关闭 finding。
- `SECURITY-ROUND-1`：收紧 QR 身份校验、auto 浏览器扫描触发条件、`verify_uuid`、IP 限制恢复和 integration 测试可达性；末读 PASS。
- `SUPPLY-FIT-ROUND-1`：收紧 lock 适用范围、构建/发布来源控制、非 tag dispatch 与 integration Cookie 描述；末读 PASS。
- 未关闭 P0/P1/P2/P3：`0/0/0/0`。
