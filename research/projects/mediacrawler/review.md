# MediaCrawler 专项源码审查

> 状态：**研究证据**。本文只对记录的固定 revision 和审查范围负责；评级、排除项、历史实施阶段边界和账号限制不自动成为当前产品决策。

状态：专项静态审查完成，独立复审通过
审查日期：2026-08-13
固定 revision：[`5665a271ef15e0ec82b1f48a951b66760e054db9`](https://github.com/NanmiCoder/MediaCrawler/tree/5665a271ef15e0ec82b1f48a951b66760e054db9)
上游快照版本：`0.1.0`

> 本报告只描述固定 revision 的 tracked 静态实现，不证明当前在线兼容性、平台许可、运行可靠性或账号安全。未安装依赖，未执行项目、测试、浏览器、API、WebUI、代理、签名或平台请求，也未读取任何用户或本地运行时 Cookie、token、profile、日志、数据库、媒体或个人数据；tracked公开源码中的示例访问材料只登记存在性，不复制其值。

## 1. 范围、来源与方法

- 来源和固定快照见 [`provenance.json`](provenance.json)，中断恢复状态见 [`checkpoint.json`](checkpoint.json)。
- 只读审查 329 个 tracked paths，覆盖 README、两份许可证、manifest/lock、XHS core/client/extractor/login/store、CDP、API/WebUI、测试和 CI。
- 证据区分 `[README/文档声明]`、`[源码证据]`、`[配置证据]`、`[测试证据（未运行）]`、`[推断]` 与 `[未知]`。
- 本报告不解释或迁移签名算法，不把代理、stealth、CDP、真实浏览器、可见窗口或固定延迟转化为规避方案。

## 2. 结论摘要

MediaCrawler 最值得参考的是 Browser 登录态、HTTP API、HTML Extractor 与 Store 的分层，以及搜索结果中 `note_id + xsec_token + xsec_source` 必须成组传递的访问材料契约。它对 401/403/429 和业务安全码已有局部类型化，也提供多种文件/数据库后端；这些可以帮助 Rednote Sync 定义历史实施 Stage 4 Adapter 的内部边界和失败分类。

但它不适合作为历史实施 Stage 3 核心或历史实施 Stage 4 生产 Provider 直接采用。开源版没有真正 checkpoint；搜索可能在处理终页 items 前停止，创作者/评论分页没有 partial/completeness 状态；笔记先持久化再下载媒体，图片/视频按“成功次数”而非源序号命名，且没有逐资产状态、临时文件、长度或哈希闭环。访问材料会被写入 URL、数据和日志；Store丢弃实际`xsec_source`，仅在生成`note_url`时把query硬编码成`pc_search`。

浏览器与风控处置是更大的阻断项：默认 CDP 复用用户现有浏览器的第一个 context，没有预期账号、profile lease 或会话 owner；自启 CDP 使用全接口调试地址并关闭浏览器 sandbox。已识别的访问限制会被详情/创作者层吞掉并继续；461/471 验证码作为普通异常自动重试，详情随后还可能转 HTML。API/WebUI 没有认证，Cookie 被放入子进程 argv 和启动日志，日志又能由 HTTP/WebSocket 读取；模块入口还默认监听所有接口。

### 核心结论：

- 最终建议为 **B（局部架构、错误类型与反例参考）**；现成XHS Provider、签名、CDP/stealth/代理、WebUI控制面、媒体下载和checkpoint语义均为 **D（直接复用排除）**。[根许可证](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/LICENSE#L1-L28)
- 可独立实现：Browser Session → HTTP Client → API/HTML Extractor分层、`DiscoveredNoteRef + AccessMaterial`配对、对访问限制的类型化、稳定外部ID和显式分页完整性状态。[Crawler分层](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/xhs/core.py#L70-L128)
- 固定快照的签名实际调用`xhshow`纯算法，传入XHS client的Playwright page没有参与签名；这与README的浏览器JS签名描述存在漂移。[README声明](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/README.md#L54-L58) [签名适配](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/xhs/playwright_sign.py#L19-L71)
- API详情先取`items[0]`且不复核返回ID；HTML extractor则按请求ID精确索引。Provider返回前必须统一Schema并重新验证stable ID。[API详情](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/xhs/client.py#L354-L389) [HTML extractor](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/xhs/extractor.py#L31-L50)
- 搜索先判断`has_more`再处理items，终页非空时存在条件性遗漏；`START_PAGE`只是手工跳页，不是cursor、checkpoint或水位。[搜索循环](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/xhs/core.py#L134-L175)
- 开源版没有断点续爬；README将该能力明确列为Pro版差异。文件追加、数据库upsert或部分JSONL都不能代替durable checkpoint。[Pro对比](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/README.md#L74-L85)
- 笔记记录存在不等于媒体或评论完成；成功序号压缩、直接`wb`最终文件、整文件入内存和无完整性校验使当前媒体实现不能采用。[媒体流程](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/xhs/core.py#L483-L542) [媒体请求](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/xhs/client.py#L249-L270) [媒体落盘](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/store/xhs/xhs_store_media.py#L34-L133)
- 当前快照无显式Live Photo配对模型；图片/视频/tag被压成逗号字符串，不能定义Rednote Sync的canonical Schema。[Store映射](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/store/xhs/__init__.py#L88-L131)
- 访问限制和验证码必须成为账号级全局硬停止；当前“跳过继续”、验证码通用重试、HTML fallback和换IP提示均不采用。[限制后继续](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/xhs/core.py#L286-L344) [验证码重试](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/xhs/client.py#L127-L165)
- 默认连接日常浏览器首个context、无expected account、CDP失败自动换后端、全接口调试地址与`--no-sandbox`均不满足生产会话边界。[CDP context](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/tools/cdp_browser.py#L360-L398) [CDP fallback](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/xhs/core.py#L444-L471) [Launcher](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/tools/browser_launcher.py#L119-L161)
- 完整CDP WebSocket endpoint和调试端口会进入普通日志；通过WebUI启动时，这些日志又进入未鉴权HTTP/WS读取面。它与全接口调试配置组合成条件性控制句柄泄漏风险，但本次未验证远程可达或接管。[CDP日志](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/tools/cdp_browser.py#L288-L345) [日志采集](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/api/services/crawler_manager.py#L241-L268)
- WebUI/API是未鉴权的进程与数据控制面；Cookie经argv/日志传播，不能直接开放或交给Agent。[API入口](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/api/main.py#L40-L66) [Crawler routes](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/api/routers/crawler.py#L24-L63) [Manager](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/api/services/crawler_manager.py#L93-L151)
- XHS二维码helper存在“DOM URL → 跟随重定向HTTP请求”的条件性SSRF/秘密日志面；另有仅接入抖音登录的自动滑块实现，明确排除在Rednote Sync之外。[QR helper](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/tools/crawler_util.py#L43-L63) [Douyin滑块调用](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/douyin/login.py#L150-L242)
- CSV/Excel直接写入上游字符串，缺少公式前缀中和；现有派生导出器也不能直接采用。[CSV](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/tools/async_file_writer.py#L46-L55) [Excel](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/store/excel_store_base.py#L206-L227)
- 根许可证仅允许非商业学习/研究并限制大规模抓取；`webui/LICENSE`另含GPLv3，适用边界仍需上游澄清。当前只借鉴行为，不复制、链接或分发源码。[根LICENSE](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/LICENSE#L1-L28) [WebUI LICENSE](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/webui/LICENSE#L1-L20)
- 历史实施 Stage 3 继续完全离线；任何浏览器、Cookie、签名、API、媒体网络或账号能力只属于历史实施 Stage 4 的独立授权、规格和验收门。对照[`sync-core.md`](../../../projects/rednote-sync-core/docs/sync-core.md)。

## 3. 架构、获取分层与数据流

### 3.1 实际数据流

```text
Playwright / CDP 浏览器
  → 登录并取得 Cookie
  → XiaoHongShuClient
  → xhshow 签名
  → 固定 host 的 httpx API / HTML 请求
  → 未版本化 Dict
  → XHS 扁平化 Store
  → 文件、SQL、Mongo、Excel 与媒体目录
```

`[源码证据]` Browser 负责导航、登录和 Cookie 获取；之后建立独立 `XiaoHongShuClient` 执行搜索、详情、评论和创作者请求。[Crawler 启动](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/xhs/core.py#L70-L128) [Client 创建](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/xhs/core.py#L381-L412)

`[README/源码冲突]` README 称通过浏览器执行 JS 获取签名；固定源码实际调用 `xhshow` 纯算法，且传给 Client 的 `playwright_page` 没有参与 `_pre_headers`。[README 声明](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/README.md#L54-L58) [签名适配](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/xhs/playwright_sign.py#L19-L71) [Client 签名调用](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/xhs/client.py#L90-L125)

`[边界]` BrowserSession、Signer、API、HTML Extractor 与 Store 的模块分层可参考；签名实现和私有 endpoint 不复制、不解释，也不进入历史实施 Stage 3。

### 3.2 发现材料与详情 fallback

`[源码证据]` 搜索条目的 `id`、`xsec_source` 和 `xsec_token` 被成组传给详情任务；详情 API 也同时发送三者。[搜索材料](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/xhs/core.py#L152-L175) [详情请求](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/xhs/client.py#L354-L389)

`[风险]` API 详情直接取 `items[0].note_card`，没有核对返回 note ID；HTML extractor 按请求 ID 精确索引 `noteDetailMap`，两条路径的身份校验并不一致。[API 详情](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/xhs/client.py#L354-L389) [HTML extractor](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/xhs/extractor.py#L31-L50)

`[源码证据]` API 重试耗尽或返回空时才走 HTML；NoteNotFound、IPBlock 与 PlatformAccess 会在外层被捕获，当前单条任务不会转 HTML，但随后会被跳过并让批次继续。[详情编排](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/xhs/core.py#L286-L344)

`[采用]` Rednote Sync 应以白名单化 typed error 决定 fallback，且任一获取层返回后都校验 `{provider, requestedNoteId, actualNoteId, schemaVersion}`。验证码、身份变化、安全限制和签名拒绝不允许 fallback。

## 4. 发现、详情、媒体、存储与恢复

### 4.1 分页和完整性

`[条件性风险]` 搜索在处理 `items` 前检查 `has_more`；如果终页仍带有效 items，会整页遗漏。静态代码不能证明线上终页必然非空，只能认定该契约未经验证。[搜索循环](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/xhs/core.py#L134-L188)

同一循环还把小于 20 的任务上限强制抬到 20，并以完整页公式控制数量，不能精确表达任意上限。[搜索预算](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/xhs/core.py#L134-L150)

`[源码证据]` 创作者 cursor、一级评论 cursor 与二级评论 cursor 都只存在进程内。回调能逐页写数据，但返回值没有 `complete/capped/partial/blocked`、最后已提交 cursor 或失败页；二级评论失败会跳过当前线程并继续。[创作者分页](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/xhs/client.py#L637-L697) [一级评论](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/xhs/client.py#L449-L496) [二级评论](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/xhs/client.py#L498-L579)

`[Rednote 契约]` Provider 的分页结果至少应包含 `items/nextCursor/hasMore/terminalReason/completeness/retryFrom`；达到本地上限必须返回 `capped`，不能伪装为服务端完成。

### 4.2 字段与访问材料持久化

`[源码证据]` Store 将详情拍平为 note、时间、伪名化 creator、互动数、逗号拼接媒体和 tag，并把 `xsec_token` 写进 `note_url`、单独字段和完整日志。生成 URL 时 `xsec_source` 被硬编码为 `pc_search`，可能破坏实际来源配对。[XHS 映射](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/store/xhs/__init__.py#L88-L131)

`[源码证据]` SQL model 也保存 `xsec_token`，没有 source、有效期、secret reference 或 access-material version。[数据库模型](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/database/models.py#L191-L214)

`[正面/不足]` 用户 ID 被哈希、昵称被遮蔽，XHS creator store 还是 no-op；但正文、评论、媒体 URL、token 和访问 URL仍是敏感数据，不能据此称完整脱敏。[XHS Store](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/store/xhs/__init__.py#L109-L192)

`[条件性国际版缺陷]` Client/core在`XHS_INTERNATIONAL=True`时会切换到Rednote host，但Store仍生成`xiaohongshu.com/explore/...`并把source固定为`pc_search`；因此国际版输出URL和访问材料来源可能错误。静态审查未访问国际版验证，只把它作为不复用当前Store契约的条件性证据。[Host切换](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/xhs/client.py#L56-L77) [Store URL](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/store/xhs/__init__.py#L116-L131)

`[边界]` token 与 exact source 只能进入历史实施 Stage 4 内存态 `AccessMaterial` 或受保护 SecretRef；canonical note、Markdown、普通日志、共享文件和可分享 URL均不得包含它们。

### 4.3 媒体模型、部分完成与安全

`[源码证据]` 先保存笔记，再下载图片/视频，最后抓评论；因此 note 行存在不能证明其媒体或评论完成。[搜索处理顺序](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/xhs/core.py#L175-L188)

图片和视频都按“已成功数量”命名。下载失败不推进计数，后续资产会占用前一个 slot；重跑成功集合变化时可能覆盖成不同来源资产。[图片流程](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/xhs/core.py#L483-L518) [视频流程](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/xhs/core.py#L520-L542)

`[源码证据/推断]` 媒体 URL来自上游 Dict并直接交给 httpx；首跳没有 HTTPS/host/private-network allowlist，完整响应一次性读入内存，URL和异常会被日志记录。当前 helper 没有显式开启 redirect，不能把跨域 redirect 描述为已存在；但首跳本身形成条件性 blind SSRF/本地请求与资源耗尽面。[媒体请求](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/xhs/client.py#L249-L270)

`[源码证据]` 媒体直接以 `wb` 写最终文件，路径拼接未经稳定 ID 编码或 root containment；没有 `.part`、原子 rename、Range、期望长度、hash、magic-byte MIME、逐资产 retry 或 receipt。[媒体落盘](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/store/xhs/xhs_store_media.py#L34-L133)

`[模型缺口]` 固定快照的 XHS core/store/model/test 未见 Live Photo 专用类型、still/motion 配对键或 asset group。视频候选也被压成普通 URL数组/逗号字符串。[视频选择](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/store/xhs/__init__.py#L54-L85)

`[派生输出风险]` XHS标题、正文、评论等上游字符串未经公式前缀中和就进入CSV；Excel也把原值直接赋给openpyxl cell。CSV至少要处理`= / + / - / @`等常见危险前缀，XLSX至少要禁止或转义`=`，其他前缀是否被解释取决于具体消费者；这是条件性静态风险，未做动态PoC。[CSV writer](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/tools/async_file_writer.py#L46-L55) [Excel row](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/store/excel_store_base.py#L206-L227) Rednote exporter必须中和公式并把远端内容视为不可信derived data；现成CSV/Excel exporter列为D。

### 4.4 checkpoint、幂等和文件恢复

`[README 声明]` “断点续爬”列在 MediaCrawlerPro 相对开源版的功能差异中，不是本 fixed tree 的开源能力。[Pro 对比](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/README.md#L74-L85)

`[源码证据]` 开源版只有 `START_PAGE`、最大数量和并发配置。重启重新生成 search ID，未保存 keyword/sort/page/cursor/watermark/已提交项或 provider revision；手工页码不能证明无重漏。[配置](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/config/base_config.py#L98-L108) [运行时状态](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/xhs/core.py#L140-L160)

- CSV/JSONL 按日期追加，重跑产生重复；JSON 读全文件、追加后直接覆盖，损坏时静默视为空列表。[文件写入](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/tools/async_file_writer.py#L37-L80)
- 每次 XHS update 都会重新取得 Store；CSV/JSON/JSONL路径会新建对应Writer，而Excel使用singleton、数据库/Mongo后端不使用该Writer。文件Writer的lock是实例级，无法证明跨多个文件Store调用共享同一文件锁。[Store factory](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/store/xhs/__init__.py#L34-L51) [Writer lock](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/tools/async_file_writer.py#L30-L64)
- SQL 先查后写，而 `note_id/comment_id` 只有普通索引、没有 unique constraint；并发下不是数据库级幂等。已存在 note 只更新互动计数与时间，其他字段可能陈旧。[SQL store](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/store/xhs/_store_impl.py#L122-L227) [模型](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/database/models.py#L191-L229)
- Mongo `upsert=True` 是稳定 ID 行为参考，但底层失败返回值没有被上层检验，上层仍记录 Saved。[Mongo store](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/database/mongodb_store_base.py#L105-L113) [XHS Mongo adapter](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/store/xhs/_store_impl.py#L251-L290)

## 5. 浏览器、Cookie、登录、代理与身份

| ID | 严重性 | 静态结论 |
|---|---|---|
| SESSION-01 | 高 | 默认 CDP 连接用户现有浏览器并取第一个 context；没有 expected account、profile ID、owner 或跨进程 lease |
| SESSION-02 | 高 | 自启 CDP 使用 `0.0.0.0` 调试地址、`--no-sandbox` 和隐藏自动化标志，扩大浏览器控制与本机风险面 |
| SESSION-03 | 高 | CDP 任意失败直接回退标准 Playwright，悄然改变 profile、身份和隔离语义 |
| SESSION-04 | 中高 | 登录只验证“我”可见或 web_session 变化，`pong` 只验证 API success，不绑定用户预先指定的账号 |
| SESSION-05 | 中 | 现有 browser context 与 httpx 代理可能不一致；代理到期只更新 HTTP 侧，形成会话网络身份漂移 |
| SESSION-06 | 中 | Cookie、proxy credential和xsec材料各有不同传播路径，均缺少统一SecretRef与字段化脱敏 |
| SESSION-07 | 高（条件性） | 完整CDP WebSocket endpoint与debug port写入普通日志；WebUI启动时日志可经未鉴权HTTP/WS读取，实际远程可达性未动态验证 |

`[配置/源码证据]` 默认开启 CDP 并连接现有浏览器；连接后使用 `browser.contexts[0]`。标准 persistent profile 也只按平台命名。[默认配置](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/config/base_config.py#L52-L87) [首个 context](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/tools/cdp_browser.py#L360-L398) [标准 profile](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/xhs/core.py#L414-L442)

`[源码证据]` 登录状态只看“我”元素或 web_session 变化；CAPTCHA 仅写提示后继续轮询。`pong()` 只看 self API 的 success。两者均没有 `ExpectedAccountId`。[登录检查](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/xhs/login.py#L51-L85) [self check](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/xhs/client.py#L272-L304)

`[源码证据]` 新启浏览器带 `--remote-debugging-address=0.0.0.0`、`--no-sandbox` 和多个自动化隐藏参数。管理器从 localhost 连接不改变浏览器启动参数的安全边界；实际监听范围依具体 Chrome/OS，未动态验证。[Launcher 参数](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/tools/browser_launcher.py#L119-L161)

`[源码证据]` CDP 失败自动回退标准模式，标准模式注入 tracked stealth script。未来 Adapter 建立会话失败必须 fail closed，不能无审批切换 profile/provider。[Fallback](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/xhs/core.py#L444-L471) [Stealth 注入](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/xhs/core.py#L77-L100)

`[条件性影响]` cleanup 会尝试关闭所复用的 context 和 browser connection；对用户现有标签页/浏览器的实际影响依运行时版本，未动态验证。[CDP cleanup](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/tools/cdp_browser.py#L437-L488)

`[正面/不足]` Browser Cookie 转换按目标 URL过滤，Cookie 登录只注入 `web_session`；这可借鉴为名称/域范围意图，但没有完成账号绑定、SecretRef、日志清洗或 profile 生命周期管理。[Cookie 转换](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/tools/crawler_util.py#L138-L156) [Cookie 登录](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/xhs/login.py#L213-L224)

`[秘密传播边界]` Cookie经API请求/current config进入子进程argv和启动日志，再可由HTTP/WS读取；运行时xsec材料会进入完整搜索响应日志、Store和数据文件，tracked `config/xhs_config.py`还提交了两条带访问材料形态参数的示例URL（有效性未知，本报告不复制其值）；proxy credential只见于配置、环境和进程内HTTP proxy路径，没有证据表明它被API拼进argv。461/471处理还把验证challenge字段写入错误日志。CDP discovery/连接路径会记录完整`webSocketDebuggerUrl`；浏览器管理器还返回debug port，XHS core把整份browser info写入日志。WebUI启动时manager收集全部stdout，因此这些控制句柄也进入同一日志读取面。[Cookie argv](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/api/services/crawler_manager.py#L205-L239) [XHS配置样例](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/config/xhs_config.py#L21-L36) [Challenge日志](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/xhs/client.py#L153-L164) [CDP endpoint日志](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/tools/cdp_browser.py#L288-L345) [Browser info](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/tools/cdp_browser.py#L516-L532) [XHS日志调用](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/xhs/core.py#L458-L463)

`[条件性QR风险]` XHS二维码路径调用通用helper；helper意图从DOM `src`取得字符串，仅用是否包含HTTP(S)文本判断，随后启用重定向并整体读取响应，未见解析后scheme/host/private-network allowlist、逐跳重验、Content-Type或字节上限，还记录完整URL和失败响应。响应随后会被base64解码、交给Pillow解析并调用`Image.show()`，因此还可能启动本机外部查看器；这是非必要GUI/本地进程副作用，不是任意代码执行证据。`str(JSHandle)`的精确运行值未验证，因此只认定为意图路径上的条件性blind SSRF/本地请求、资源、秘密日志与本地能力风险，不能断言已经在线可利用。[QR helper](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/tools/crawler_util.py#L43-L63) [QR解析与显示](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/tools/crawler_util.py#L88-L102) [XHS调用](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/xhs/login.py#L167-L200) 它与4.3中默认不显式跟随重定向的媒体helper是两条不同路径。

## 6. 错误、重试、限速与风控停止边界

### 6.1 局部类型化与全局继续冲突

`[源码证据]` client 将 HTTP 401/403/429、业务码 300011/300012 映射到 PlatformAccess/IPBlock，并从 tenacity retry 中排除；这是可独立实现的局部设计。[请求错误](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/xhs/client.py#L127-L196)

`[关键缺口]` 详情任务捕获这些错误并返回 `None`，同一 gather 继续；创作者流捕获后继续下一个 creator，还在日志里建议降低频率、换 IP 或检查账号。[详情继续](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/xhs/core.py#L286-L344) [创作者继续](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/xhs/core.py#L193-L231)

`[测试证据（未运行）]` 测试明确把“受限单条不击穿 batch、受限 creator 后继续”定义为期望行为，说明它不是偶然遗漏。[访问限制测试](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/tests/test_xhs_core_access_error.py#L33-L124)

### 6.2 CAPTCHA 和 fallback

`[源码证据]` HTTP 461/471 提取 Verify headers后抛普通 `Exception`，故会按通用规则固定 1 秒、最多三次总尝试；最终 `RetryError` 在详情层被吞掉并转 HTML，而 HTML解析失败自身也可重试。[CAPTCHA 处理](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/xhs/client.py#L127-L165) [详情 fallback](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/xhs/core.py#L304-L318) [HTML 获取](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/xhs/client.py#L712-L750)

`[Rednote 停止门]` `AUTH_REQUIRED/VERIFICATION_REQUIRED/RATE_LIMITED/SECURITY_BLOCK/IP_BLOCK/SIGNATURE_REJECTED` 必须触发全局 circuit breaker、取消未发任务、原子保存旧 progress并等待人工恢复；不得切换 HTML、代理、账号或网络继续。

### 6.3 限速和“反检测”声明

默认并发 1、sleep 2 秒和有限任务数只证明配置存在；搜索会把 15 上调到 20，transport retry不读取 `Retry-After`。[流量配置](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/config/base_config.py#L98-L141) [Retry](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/xhs/client.py#L127-L151)

`[README/文档声明]` README 和 CDP 指南声称真实浏览器/CDP大幅降低风险或更难检测；固定源码和测试没有账号对照实验或平台保证。[README](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/README.md#L133-L154) [CDP 指南](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/docs/CDP%E6%A8%A1%E5%BC%8F%E4%BD%BF%E7%94%A8%E6%8C%87%E5%8D%97.md#L3-L28)

`[边界]` 本报告不采信也不转述这些有效性主张。低并发、真实浏览器、CDP、可见窗口、随机 sleep、代理与 stealth 均不是合规或账号安全证明。

`[跨平台能力登记]` 仓库另有仅接入抖音登录的自动滑块路径：登录后会检测滑块、尝试多次移动，并调用通用图像匹配/轨迹工具；XHS固定路径没有接入该工具，只提示人工处理并继续轮询。[Douyin调用范围](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/douyin/login.py#L55-L84) [滑块控制流](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/douyin/login.py#L150-L242) [工具存在](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/tools/slider_util.py#L34-L183) 本报告只登记能力和复用风险，不解释算法；自动验证码/滑块求解整体列为D，未来遇验证只允许人工处理后显式恢复。

## 7. API/WebUI/Agent 能力、秘密与本地文件

| ID | 严重性 | 静态结论 |
|---|---|---|
| API-01 | 高 | API 没有认证；模块入口绑定 `0.0.0.0`，可启动/停止任务、读状态/日志、预览/下载数据 |
| API-02 | 高 | Cookie 放入子进程 argv；启动命令含 Cookie并保存在日志中，HTTP/WS又能读取日志 |
| API-03 | 中高 | `/api/env/check` 未鉴权执行固定 `uv run main.py --help`；不是任意命令注入，但属于可触发本地进程/依赖环境的能力 |
| API-04 | 中 | 单进程 lock 只防当前 manager 中的并发 start，没有持久 task owner、checkpoint、审计 receipt 或重启恢复 |
| API-05 | 中 | data 路由最终有resolve containment防越界读取，但接口未鉴权；检查顺序还形成条件性文件存在/类型oracle |
| API-06 | 中 | 未鉴权 env check可反复启动固定子进程；data preview缺总大小/行数/解析预算，形成条件性本机资源耗尽面 |
| API-07 | 高（条件性） | WebUI以明文textarea保留Cookie并提交到相对`/api`；直接模块远程绑定且无外部TLS终止时，Cookie经明文HTTP传播 |
| API-08 | 中（条件性） | 日志/status WebSocket无auth/Origin校验，也未见连接数、接受频率或调用预算，暴露后可形成资源耗尽面 |
| CFG-01 | 中 | MySQL、Redis和Postgres为localhost连接提供众所周知的默认口令；这是不安全默认，不是泄漏的真实生产凭据 |

`[源码证据]` FastAPI 未注册认证 middleware/dependency。CORS只允许四个本地开发 origin是局部边界，但不等于 HTTP/WS 客户端认证；`python -m api.main` 使用 `0.0.0.0:8080`。[API app](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/api/main.py#L40-L66) [模块入口](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/api/main.py#L204-L205)

`[源码证据]` `/crawler/start/stop/status/logs` 没有认证；manager 将 Cookie加入 argv，并把完整命令写入最多500条内存日志。进程继承完整环境。[Crawler routes](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/api/routers/crawler.py#L24-L63) [Manager](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/api/services/crawler_manager.py#L93-L151) [命令构造](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/api/services/crawler_manager.py#L205-L239)

`[条件性传输/UI风险]` WebUI用普通明文`textarea`把Cookie保留在可见React state中，并提交到相对`/api`。直接运行模块入口会以未配置TLS的`0.0.0.0:8080`提供服务；因此只有在直接远程绑定且没有外部TLS终止时，才能推断Cookie经明文HTTP传播。loopback部署或受控反向代理会改变该边界，但不会消除可见输入框和后端日志问题。[Cookie输入](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/webui/src/components/config/CrawlerConfigPanel.tsx#L302-L310) [相对API](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/webui/src/lib/api.ts#L3-L9) [Cookie提交](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/webui/src/lib/api.ts#L67-L71) [模块入口](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/api/main.py#L204-L205)

`[源码证据]` WebSocket无 auth/Origin 校验并广播现有和后续日志；连接集合和accept路径也未见连接数、接受频率或消息/调用预算。data 文件预览/下载最终用`resolve().relative_to(DATA_DIR.resolve())`阻断越界内容读取，但没有访问控制；并且它先对未收敛路径调用`exists()/is_file()`，再做containment。服务暴露给不可信客户端且路由能接收相应traversal/绝对路径编码时，不同404/400/403响应可形成条件性文件存在/类型oracle；URL规范化和代理行为未动态验证。[WebSocket](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/api/routers/websocket.py#L29-L150) [Data preview顺序](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/api/routers/data.py#L98-L156) [Download顺序](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/api/routers/data.py#L169-L187)

`[条件性资源风险]` `/api/env/check` 每次可启动固定argv `uv run main.py --help`，无认证、频率或并发门；这不是shell注入。data preview的`limit`无上限，JSON先整体load，Excel为计数读取完整首列，也没有统一文件字节、解析时间或响应预算。日志/status WebSocket同样没有连接数或接受速率门；这些后果都以服务已暴露给不可信客户端为前提。[Env check](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/api/main.py#L88-L147) [Data preview](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/api/routers/data.py#L98-L156) [WebSocket连接](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/api/routers/websocket.py#L29-L50) [状态广播](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/api/routers/websocket.py#L89-L150)

`[不安全默认]` MySQL、Redis和Postgres默认连接localhost并使用相同的众所周知口令；它们是模板默认值，不是已泄漏的真实部署凭据，也不得复制到Rednote Sync。[DB config](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/config/db_config.py#L23-L83)

`[能力边界]` 该 WebUI不直接提供平台发布/点赞等写操作，但能启动网络采集、使用账号材料、杀任务、读日志和下载本地数据，仍是高权限本地/网络能力。不能直接暴露给 Agent或作为 Rednote Sync production API。

## 8. 依赖、测试、CI 与许可证

### 8.1 依赖和供应链

- `[配置证据]` `pyproject.toml` 声明Python `>=3.11`和浏览器、HTTP、签名、数据库、API等广泛依赖；`uv.lock` 固定92个package节点、91个registry节点及1,118个SHA-256 artifact记录。项目把清华PyPI镜像设为default，lock中的registry/artifact URL也指向该镜像；hash只校验取得内容，不把镜像变成PyPI官方来源。该lock只覆盖当前仓库环境，不证明发布包、浏览器制品或其他安装入口可复现。未来若采用任何依赖，应从受控官方索引重新解析并核验制品来源与hash，而非沿用该lock。[Manifest与默认索引](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/pyproject.toml#L1-L47) [Lock](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/uv.lock)
- `[配置证据]` pyproject把`pre-commit/pytest/pytest-asyncio`列入普通runtime dependencies，没有dev extra；同时存在`requirements.txt`、root npm lock和WebUI npm lock等多套输入，requirements又缺少pre-commit、websockets、asyncpg等项目依赖并有约束漂移。两个npm lock合计有581个integrity记录；其581个`resolved` URL也全部指向`registry.npmmirror.com`。integrity可核验取得内容，不证明来源就是官方npm registry。另有7个标为带install script的lock节点（不是7个唯一包）；生命周期脚本是否执行及行为未运行。本次未安装或做在线SCA，不能从lock推断没有CVE。[Manifest dependencies](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/pyproject.toml#L7-L47) [Requirements](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/requirements.txt) [Root npm lock](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/package-lock.json) [WebUI npm lock](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/webui/package-lock.json)
- `[配置证据]` tracked `.pre-commit-config.yaml`定义两项`language: system`的local hooks，分别检查和改写Python文件头；外部`pre-commit-hooks`包含7项hooks，并只以可变`v4.5.0` tag而非完整commit SHA引用。未见唯一CI workflow执行pre-commit，因此这只证明本地钩子配置存在，不是CI lint门。本次未执行任何hook。[Pre-commit配置](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/.pre-commit-config.yaml)
- `[配置证据]` 唯一GitHub workflow只构建/部署文档Pages；5个external Actions均使用mutable major tag。workflow-level显式设置`contents:read/pages:write/id-token:write`，但build job也继承pages写与OIDC权限并执行`npm ci`、VitePress build和外部Actions，未按job最小化；理想边界是build仅contents read、deploy才持有pages/id-token。固定树另未见Python/WebUI test、lint、build、SCA、secret scan、SBOM、制品签名或release provenance gate。[Workflow权限与build](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/.github/workflows/deploy.yml#L14-L49) [Deploy job](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/.github/workflows/deploy.yml#L53-L64)

### 8.2 测试信号

`[测试证据（未运行）]` fixed tree有 `test/` 和 `tests/` 两套目录、共21个`test_*.py`模块。XHS专项测试覆盖HTTP/业务访问限制、HTML retry和“跳过受限条目继续batch”的明确意图；另有Store、CDP、API limit和隐私字段测试。[XHS raw errors](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/tests/test_xhs_raw_response_errors.py) [XHS batch继续](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/tests/test_xhs_core_access_error.py) [API limits](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/tests/test_api_limits.py)

`[缺口]` 未见XHS测试闭合终页items、creator/comment completeness、媒体部分失败重跑、source ordinal、Live Photo、access-material source持久化、文件/SQL并发幂等、checkpoint恢复、API auth、Cookie日志脱敏或CSV/Excel公式中和。唯一workflow也不执行这些测试。

### 8.3 许可证与复用边界

`[许可证正文]` 根 `LICENSE` 是 `NON-COMMERCIAL LEARNING LICENSE 1.1`，限定非商业学习/研究用途，并限制大规模抓取；源码头也重复这些边界。[根 LICENSE](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/LICENSE) [XHS 源码头](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/xhs/core.py#L1-L18)

`[许可证分层未知]` `webui/LICENSE` 是 GPLv3正文；API侧的WebUI代码头仍指根非商业许可证，前端协议弹窗也链接根许可证。固定树没有清晰的subtree适用声明或NOTICE清单。本报告不判断两者法律效力或优先级，只把适用范围记录为未澄清。[WebUI LICENSE](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/webui/LICENSE) [API 源码头](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/api/main.py#L1-L17) [前端链接](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/webui/src/components/license/LicenseDisclaimer.tsx#L112-L122)

`[结论]` Rednote Sync 当前只允许阅读后独立实现行为/契约；不复制、链接、派生、打包或分发该源码。若未来用途或上游许可变化，必须对固定发布制品、subtree、依赖与 NOTICE重新专项审查。非法律意见。

## 9. 对 Rednote Sync 的参考价值

| 候选行为/反例 | Rednote Sync 落点 | 采用边界 |
|---|---|---|
| Browser → HTTP API → HTML Extractor | 历史实施 Stage 4 Provider内部获取层 | 签名/私有 endpoint 不复制；访问限制不 fallback |
| `note_id + token + source` | 内存态 `DiscoveredNoteRef/AccessMaterial` | token/source不得写 canonical、日志、Markdown或普通 URL |
| typed access errors | `AUTH_REQUIRED/VERIFICATION_REQUIRED/RATE_LIMITED/SECURITY_BLOCK/IP_BLOCK` | 必须全局硬停止，不能单条跳过继续 |
| Page/cursor 局部变量反例 | 版本化 `PageResult` 和 durable cursor provenance | `START_PAGE`、普通列表与本地上限都不是完成证明 |
| note先存、媒体后下载反例 | `NoteState` 与逐 `MediaSlotState` 分离 | note存在不能推导媒体 complete |
| 成功计数命名反例 | source ordinal + stable asset ID | 下载失败不得压缩/重排 slot |
| Mongo upsert意图 | Core `(provider, externalId)` 唯一键与事务 upsert | 必须检查写回执，不采用 SQL check-then-insert |
| 多 Store factory | canonical → derived exporter边界 | provider dict/逗号字符串不能定义 core Schema |
| API 单进程 lock | 未来 Adapter session owner 的局部参考 | 仍需持久 lease、认证、审计和重启恢复 |

历史实施 Stage 3 继续遵循 [`sync-core.md`](../../../projects/rednote-sync-core/docs/sync-core.md) 的完全离线边界。MediaCrawler 的全部运行能力都依赖浏览器、Cookie、签名、网络或账号，只能属于历史实施 Stage 4；它不能接管 Core 的 canonical state、cursor、checkpoint、media receipt 或 exporter所有权。

## 10. 采用分级与排除项

- **整体：B — 局部架构、错误类型和反例参考。** 不直接作为 Provider、MediaStore、checkpoint层或 Agent工具。
- **A/B — 值得独立实现：** 发现引用与访问材料配对、来源明确的 typed fallback、稳定ID、显式分页完整性和逐资产状态验收用例。
- **B — 局部参考：** Browser/API/Extractor模块边界、目标URL范围Cookie读取、低并发/任务预算配置、Mongo upsert意图、多Exporter结构。
- **C — 背景材料：** 私有字段 heuristics、DOM/initial state路径、多数据库后端、CDP/browser差异。
- **D — 明确排除：** 签名、stealth/隐藏自动化、代理池或换IP恢复、自动滑块/验证码处理、日常浏览器首context、CDP失败自动fallback、CDP endpoint/port普通日志、限制后继续、现有分页/媒体/CSV/Excel/文件/SQL状态、QR URL抓取与`Image.show()`副作用、token持久化、未鉴权WebUI/API。
- **许可证隔离：** 根非商业学习许可且WebUI许可证范围未澄清；所有源码复制、链接和派生均排除。

## 11. 未知项、证据索引与独立复审

### 11.1 未知项

- 当前真实搜索、详情、creator/comment cursor、`has_more` 终页 shape和HTML state是否仍兼容。
- xsec token/source的有效期、撤销、真实绑定规则和签名依赖的长期兼容性。
- 原始 payload是否包含未建模的 Live Photo/媒体变体字段。
- CDP `0.0.0.0` 在具体 Chrome/OS的实际监听范围，以及关闭共享 context对用户标签页的精确影响。
- 浏览器和HTTP代理在真实环境的出口一致性；本报告不运行验证。
- 已发布制品是否对应 fixed commit、当前依赖CVE、仓库保护规则和私有Pro实现均未核验。
- 根非商业许可证与 `webui/LICENSE` 的准确 subtree适用范围需由上游澄清。
- CDP、真实浏览器、可见窗口、delay或stealth对账号风险没有可靠性证据。

### 11.2 证据等级与复审状态

- 固定 tracked源码、配置、许可证和测试是一手静态证据；README/CDP指南只作项目声明或冲突依据。
- 测试只读未运行，不能作为当前 pass、线上兼容或账号安全证明。
- SSRF、路径、共享浏览器影响等后果均标为条件性静态推断，没有PoC或真实事件证据。
- 初始研究由三个只读 Subagent分别覆盖架构/状态/媒体、会话/风控、API/供应链/许可证；随后由三个未负责相同初始结论的 reviewer独立检查证据、安全、供应链、许可证与项目适配，均已通过。

### 11.3 审查 finding

- `ARCH-STATE-ROUND-1`：完成；证据 reviewer最终 PASS。
- `SESSION-RISK-ROUND-1`：完成；安全 reviewer确认 `SEC-REV-01`～`SEC-REV-11` 全部关闭并最终 PASS。
- `API-SUPPLY-ROUND-1`：完成；供应链、许可证和适配 reviewer最终 PASS。
- 未关闭 reviewer P0/P1/P2/P3：0。
