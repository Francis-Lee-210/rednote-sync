# “使用 Playwright 模拟人工操作”路线专题

状态：综合静态研究完成；独立复审通过  
调研日期：2026-08-13

> “模拟人工”只是候选路线的历史名称，不是设计目标或安全主张。更准确的路线名称是：**基于 Playwright 的受授权、受监督、窄只读浏览器适配器**。本专题只综合已经完成并独立复审的固定源码报告与 Playwright 官方文档；不运行浏览器、不访问小红书、不读取账号材料，也不研究验证码破解、代理或账号轮换、指纹伪装、stealth、隐藏自动化或签名绕过。

## 核心结论

Playwright 可以作为未来 Stage 4 的浏览器执行底座采用评估对象，但它只提供 Browser、Context、Page、网络事件、下载和诊断等通用机制；它不提供小红书的账号身份、Schema、cursor、逐资产 checkpoint、平台授权、429/验证码停止门或账号安全保证。[Playwright 专项报告](../playwright/review.md)

真实浏览器、persistent profile、CDP、慢速输入、鼠标轨迹、随机延迟和 `slowMo` 都不能证明“更像人工”、降低封禁概率或满足平台许可。OpenCLI 与 MediaCrawler 中的 stealth、隐藏自动化、设备重建和限制后 fallback 只证明实现存在，不能转化为 Rednote Sync 的安全措施。[OpenCLI 专项报告](../opencli/review.md) [MediaCrawler 专项报告](../mediacrawler/review.md)

未来若取得适用于具体账号、数据范围与用途的明确授权，生产路线应 clean-room 实现 `ProfileLease + SessionBinding + BrowserRednoteClient`：专用 profile、单账号单 owner、固定只读领域方法、精确网络 allowlist、版本化 decoder、operation generation、全局停止闸和人工显式恢复。浏览器与网络工作位于 SQLite writer transaction 之外；只有经过身份、Schema、revision、长度和 hash 校验的 DTO/receipt 才能进入 Stage 3 已有的离线 Core。

Playwright MCP、OpenCLI 和其他通用 Agent 浏览器面只适合使用合成、脱敏、无真实账号材料的受监督探索。真实账号诊断的原始结果只能进入人类控制的本地 `ArtifactBroker`；服务端完成结构化 allowlist 与脱敏后，Agent 最多获得 schema、selector、字段存在性和 source-layer 摘要。登录或验证必须由用户直接在专用 profile 中完成；恢复期间断开或禁用 Agent/MCP 控制面，并关闭 Trace、HAR 和 session log。通用 `readOnly` 标签也不能表达本地文件写入、Secret 读取、会话写入或页面读取副作用。[Playwright MCP 专项报告](../playwright-mcp/review.md) [xiaohongshu-mcp 专项报告](../xiaohongshu-mcp/review.md)

最终分级：**Playwright 底层执行能力 A（Stage 4 项目级采用评估）；OpenCLI 的获取分层、租约和 unknown-outcome 模式 A（clean-room 设计参考）；Playwright MCP B（人工探索与能力边界参考）；“模拟人工可降低风控”的主张 D（无证据，排除）。**

## 1. 问题定义、授权门与证据边界

### 1.1 研究问题

本专题回答四个工程问题：

1. Playwright 能确定提供哪些浏览器能力；
2. 哪些能力可以进入未来 Stage 4 的窄只读 Provider；
3. 哪些能力只能用于人工监督的探索或诊断；
4. 遇登录、验证、限流、安全限制或 Schema 漂移时，怎样可靠停止并从 Core checkpoint 恢复。

本专题不回答“如何绕过平台检测”，也不把真实浏览器、延迟、CDP、persistent profile 或自动化痕迹隐藏视为反风控方案。

### 1.2 授权先于技术

`[平台官方规则/此前核验]` 总目录已经核对 2026-03-23 更新的[小红书用户服务协议](https://agree.xiaohongshu.com/h5/terms/ZXXY20220331001/-1)：未经许可读取或统计、非法抓取、模拟下载及未授权第三方工具登录受到限制。低频、可见浏览器或“像人工”不能改变授权结论。Stage 4 立项前必须先确定平台授权、账号授权、数据用途、保存范围和停止责任；没有授权时，本专题只是一份离线威胁模型与架构研究。

### 1.3 证据集

| 来源 | 固定 revision | 本专题使用范围 |
|---|---|---|
| [Playwright](../playwright/review.md) | `bcb3563aa73d7ac71ac8cb877433201b1b97b7da` | Context/profile、storage state、网络、下载、Trace/HAR、生命周期 |
| [OpenCLI](../opencli/review.md) | `a86d64705c526dc710f790e66cfcabf6ecf786b9` | 分层获取、profile/target lease、journal、unknown outcome 与高权限反例 |
| [Playwright MCP](../playwright-mcp/review.md) | `7e0457a7cbf88823bf0146d12c46ae12c6818247` | Agent 工具、HTTP/session、本地文件、Secret 和探索/生产边界 |
| [MediaCrawler](../mediacrawler/review.md) | `5665a271ef15e0ec82b1f48a951b66760e054db9` | CDP/profile fallback、访问限制后继续、验证码重试和宣传主张反例 |
| [xiaohongshu-mcp](../xiaohongshu-mcp/review.md) | `da9ba0365e176bc0eb11885f1941271d895feb73` | capability 注解、side-effecting read、Cookie/会话与 Agent 写能力反例 |
| [XHS_ALL_IN_ONE](../XHS_ALL_IN_ONE/review.md) | `63b85de2b15b3f79134b08fa675381505f45d4db` | 失败暂停行为、状态/资产反例、自动运营与写操作排除 |

证据强度依次为：固定源码/配置事实、官方或项目文档声明、未运行测试意图、带前提的静态推断。没有运行时证据，不证明当前平台兼容性、账号安全率或任何错误码长期稳定。

## 2. Playwright 真正提供的能力

| 能力 | 有证据支持的行为 | 不能据此推导 |
|---|---|---|
| isolated context | `browser.newContext()` 创建非持久、相互隔离的浏览环境，关闭后不保存登录态。[官方文档](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/docs/src/api/class-browsercontext.md#L4-L19) | OS 级安全沙箱、持续登录、账号身份绑定或业务 checkpoint |
| persistent context | `launchPersistentContext(userDataDir)` 保存 Cookie/localStorage；同一目录不能被多个浏览器实例并发使用。官方明确要求使用专用目录，不自动化日常 Chrome 主 profile。[官方文档](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/docs/src/api/class-browsertype.md#L329-L351) | 浏览器目录互斥不等于 Rednote 的跨进程任务租约；profile 存在不代表账号正确或登录仍有效 |
| storage state | 默认收集 Cookie 和 origin localStorage，并以普通 JSON 读写；协议没有预期账号字段或内建加密。[JSON 读写](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/client/browserContext.ts#L479-L490) [服务端收集](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/server/browserContext.ts#L616-L665) [协议形状](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/server/channels.d.ts#L1498-L1523) | SecretStore、账号身份、cursor、task 状态或完成 receipt |
| 生命周期 | Browser、Context、Page 有创建取消、关闭、崩溃和传播；进度域有 deadline/abort，但底层不可取消的操作可能完成后才清理。[Browser 创建/关闭](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/server/browser.ts#L104-L198) [Context close](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/server/browserContext.ts#L540-L590) [Page state](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/server/page.ts#L167-L205) [Progress](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/server/progress.ts#L25-L184) | timeout/abort 不证明底层副作用已回滚；迟到结果仍需外层 generation 拒绝 |
| 网络观察 | 区分 `request`、`response`、`requestfinished` 和 `requestfailed`；HTTP 404/503 仍可属于完成的传输。[Request 文档](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/docs/src/api/class-request.md#L4-L18) | XHS Schema、cursor、稳定 ID、完整性或安全错误分类 |
| Download | 能等待完成、查询失败、取消、删除和 `saveAs()`；内部下载目录有路径 containment，但 `saveAs` 最终是 copy/pipe。[Download 文档](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/docs/src/api/class-download.md#L64-L111) [路径 containment](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/server/download.ts#L29-L40) [服务端 copy/pipe](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/server/dispatchers/artifactDispatcher.ts#L53-L68) [客户端写入](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/client/artifact.ts#L38-L51) | `saveAs()` 没有 Rednote 所需的 Range、MIME、长度、SHA-256、fsync、原子发布和 no-clobber，只能作为 staging |
| Trace/HAR | Trace 能采集 DOM、网络、截图、console、action 和 source；HAR 有 URL filter，但仍保留 headers、query/form 等敏感面。[Trace 启动](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/server/trace/recorder/tracing.ts#L106-L190) [console/download](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/server/trace/recorder/tracing.ts#L640-L672) [action](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/server/trace/recorder/tracing.ts#L786-L835) [source](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/server/localUtils.ts#L60-L79) [HAR filter](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/server/har/harTracer.ts#L131-L137) [HAR 敏感字段](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/server/har/harTracer.ts#L618-L745) | `minimal`、`omit` 或 filter 不等于 secret scrub；制品仍可能含 Cookie、Authorization、signed URL、输入值和本地源码 |
| CDP/remote | 可连接 CDP/remote endpoint，并携带连接 headers、proxy、TLS 与网络暴露选项。[Playwright MCP 配置](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/config.d.ts#L69-L102) | CDP 不证明 profile 隔离、平台许可、人工相似性或更低账号风险 |

因此 Playwright 应被定位为底层执行库，而不是完整的 `BrowserSourceAdapter`。正式采用还必须选择 released tag/package，重新核 revision、npm tarball integrity/provenance、浏览器制品、ThirdPartyNotices、许可证和 CVE；当前 `1.63.0-next` 静态快照不是已验收发布制品。

## 3. “模拟人工”不能证明什么

### 3.1 自动化机制不等于风控证据

Playwright 的 `slowMo` 只是协议调用后的固定 sleep，鼠标 `steps` 只是插值生成移动事件；二者都没有账号级限速、验证码、429、平台安全状态或人工恢复语义。[slowMo](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/server/dispatchers/dispatcher.ts#L396-L409) [mouse steps](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/server/input.ts#L216-L231)

以下机制都只能证明自动化行为存在，不能证明账号更安全：

- `slowMo`、随机等待、慢速输入、滚动或鼠标轨迹；
- headful、真实 Chrome、persistent profile、CDP 或 extension；
- 隐藏 `webdriver`、automation 或 CDP 痕迹的 stealth 代码；
- 设备/fingerprint 重建、代理或网络身份变化。

OpenCLI 默认注入 stealth，且所谓 isolated window 仍使用默认 Chrome profile/Cookie jar；MediaCrawler 文档对 CDP/真实浏览器的风险降低声明没有固定源码测试或账号对照实验支持，代码还会在访问限制后继续批次或把验证码当通用错误重试。[OpenCLI 会话](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/extension/src/background.ts#L923-L1004) [OpenCLI stealth](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/src/browser/stealth.ts#L1-L47) [MediaCrawler 验证错误](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/xhs/client.py#L127-L165) [限制后继续](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/xhs/core.py#L286-L344)

### 3.2 明确排除

- 自动验证码、滑块识别或求解；
- stealth、隐藏 webdriver/automation/CDP 特征；
- 指纹伪造、设备画像重建或设备 ID 轮换；
- 代理、IP、网络、地区、账号或 profile 自动轮换；
- 签名算法复制、补环境、解释或绕过拒绝；
- 遇验证码、429 或安全限制后切换 HTML/API/provider 继续；
- 将延迟、真实浏览器、CDP 或可见窗口描述为反风控、合规或账号安全证明；
- 无人值守的通用 Agent 浏览器控制及发布、点赞、收藏、评论、关注、删除等平台写能力。

## 4. 适合 Rednote Sync 的 Stage 4 路线

### 4.1 Exploration 与生产 Adapter 分离

| 方面 | Agent/MCP 探索面 | 确定性生产 Adapter |
|---|---|---|
| 目的 | 合成环境研究页面结构；真实账号时只由人类做本地诊断 | 执行已经审查的只读领域协议 |
| 调用者 | 合成环境可用受监督 Agent；真实账号原始诊断仅由人类控制的 `ArtifactBroker` | `SyncEngine/Stage4Controller` |
| API | 合成 fixture 可用 snapshot/DOM/network；真实账号只产出服务端脱敏的结构摘要 | `listPage`、`getDetail`、`getMediaDescriptors`、`pauseForHuman` |
| 输入 | 合成、脱敏、无真实账号材料；真实账号的观察点由人类逐次批准 | 完整 scope、cursor、稳定 note ID 与 opaque access ref；禁止任意 URL/script |
| 页面操作 | 合成环境可由 Agent 探索；真实账号时 Agent/MCP 不参与凭据、验证或原始页面观察 | 固定、已审查流程；禁止任意 click/input/evaluate/upload |
| 输出 | 合成数据，或由 `ArtifactBroker` 脱敏后的 schema/selector/字段存在性/source-layer 摘要 | 版本化 DTO、source layer、completeness 和 receipt |
| 会话 | 临时或专用研究 profile | 专用 profile、单账号 lease、expected account 校验 |
| Secret | 只进受保护的人类诊断区 | 用途限定 `SecretRef`；不进入 Agent、日志、DTO 或 SQLite |
| 状态恢复 | MCP session/profile/transcript 仅供诊断 | cursor、task、failure、checkpoint 继续由 Core 独占 |
| Canonical 写入 | 禁止直接写入 | 只提交通过 decoder 与 revision gate 的安全 DTO/ObjectRef |

Playwright MCP 固定根默认工具面包含通用导航、页面操作、网络、文件和 unsafe code 等能力；HTTP session、profile 和 `readOnly` 标记都不是生产授权边界。[Playwright MCP 专项报告](../playwright-mcp/review.md) OpenCLI 也将任意页面 JS、导航、Cookie、截图、上传与网络捕获放在同一高权限控制面。[OpenCLI 协议](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/extension/src/protocol.ts#L1-L23)

推荐 capability taxonomy 不再使用单一 `readOnly`：

```text
remoteRead          sideEffectingRead
remoteWrite         localRead          localWrite
secretRead          sessionWrite       arbitraryCode
openNetwork         diagnosticCapture  controlStateWrite
```

任一未显式声明和批准的维度默认拒绝。`readOnly=true` 不能证明本地无写入、Secret 未读取或页面没有副作用；xiaohongshu-mcp 的二维码工具会启动/替换登录会话并最终写 Cookie，而通知工具描述称读取会清未读，正是注解不足的反例。[xiaohongshu-mcp 专项报告](../xiaohongshu-mcp/review.md)

生产方法必须固定到可执行 capability vector：

| 方法 | 必需能力 | 默认禁止和返回边界 |
|---|---|---|
| persistent-context 的 `listPage/getDetail/getMediaDescriptors` | `remoteRead + openNetwork + sideEffectingRead + sessionWrite` | 能力必须在请求发送前声明和批准；禁止 `remoteWrite/localRead/localWrite/arbitraryCode/diagnosticCapture`。`sessionWrite` 只允许专用 profile 中的受审浏览器会话变化，不授权平台写命令 |
| isolated-context 的读取方法 | `remoteRead + openNetwork + sideEffectingRead + sessionWrite(isolated-discard)` | 会话变化只存在于可丢弃隔离区且不得合并回专用 profile；远端读取副作用仍须事前批准，不能因本地隔离而省略 |
| `fetchAllowedMedia` | `remoteRead + openNetwork` | Provider 只返回真正的 bounded stream；不能调用 Playwright Download、创建 staging 文件、选择本地路径或取得 `localWrite`，最终落盘只由另一个获权的 `MediaStore/ArtifactBroker` 操作完成 |
| `pauseForHuman` | `controlStateWrite` | 只改变内部 task/session 控制状态；不得导航、点击、输入、读取 Secret 或执行平台写 |

方法少报能力、工具映射漂移或 capability policy 版本不匹配时必须在请求发送前 fail closed。浏览器页面的只读导航也可能在响应处理前接收 `Set-Cookie`，远端读取本身也可能改变未读等平台状态；因此 `sideEffectingRead/sessionWrite` 必须按“可能发生的能力”事前声明，不能等副作用发生后再补报，也不能以“GET/只读”隐含批准 Cookie jar 写回。

### 4.2 建议架构

```text
受监督探索面
  Agent + 合成/脱敏 fixture
  人类 + 真实账号本地 ArtifactBroker
  → 服务端只输出脱敏的 schema、selector、source-layer 研究结果
  ────────────────────────────── 单向隔离

Stage 4 Run Controller
  → ProfileLease Store
  → SessionBinding / Identity Verifier
  → BrowserRednoteClient
       → SecretBroker
       → NetworkGate
       → 固定页面流程
       → Versioned Decoder
  → Bounded Media Downloader
  → Safe DTO / Object Receipt
  → Commit Gate
       → 短 BEGIN IMMEDIATE
       → expected state / manifest / session generation
       → Stage 3 SQLite + Object Store
```

生产 `BrowserRednoteClient` 只应暴露：

```text
listPage(scope, cursor, limit)
getDetail(scope, noteId, privateAccessRef)
getMediaDescriptors(scope, noteId)
fetchAllowedMedia(mediaRef)
pauseForHuman(category)
```

`privateAccessRef` 与 `mediaRef` 是不可序列化或短期、用途限定的 capability。Provider 自行根据稳定 ID 和 allowlist 构建目标；调用者和 Agent 不能传任意 URL、Cookie、signed URL、本地路径、Page、Context 或 CDP endpoint。

### 4.3 会话与提交对象

```text
ProfileLease(
  profileRef, leaseId, ownerRunId, accountKey,
  generation, acquiredAt, heartbeatAt, expiresAt
)

SessionBinding(
  provider, hostId, expectedAccountId, observedAccountId,
  profileRef, leaseId, generation, lastVerifiedAt,
  allowedOrigins, status
)
```

- 每个 profile 只绑定一个账号和一个活动 run；
- 启动、checkpoint 恢复、人工重新登录后及每批开始前重新核验身份；
- observed account 缺失或不等于 expected account 时 fail closed；
- 禁止 default/preferred profile fallback、按端口猜账号、共享 context 和日常浏览器 extension；
- profile、storage state、Cookie 和 CDP endpoint 是 Secret/session state，不是同步 checkpoint；
- timeout、disconnect 或 crash 后的迟到结果因 generation 不匹配而拒绝提交。

OpenCLI 的显式 profile/target lease、同 command ID journal 和 unknown-outcome 不盲重放值得独立实现；其 Browser Bridge、默认 profile、固定本地鉴权和通用写能力不复用。[OpenCLI 专项报告](../opencli/review.md)

### 4.4 获取和媒体边界

获取层可以采用“导航与身份确认 → 页面网络响应 → hydrated/SSR state → DOM”的顺序，但每层都必须 shape validate、记录 `sourceLayer/decoderVersion/completeness` 并校验详情 ID；fallback 不能跨越 `AUTH_REQUIRED/VERIFICATION_REQUIRED/RATE_LIMITED/SECURITY_BLOCK` 等安全停止原因。

Playwright Download 不进入生产 Provider；它只能在另一个显式取得 `localWrite` capability token 的 `MediaStore/ArtifactBroker` 操作中作为受限 staging 候选。正常 `fetchAllowedMedia` 只返回 bounded stream，最终媒体由 Rednote 独立下载器实现：

- `(kind, ordinal, role)` 逐资产身份；Live Photo 以同 ordinal 的 still/motion 两项表达；
- HTTPS host/path allowlist、DNS/IP 和 redirect 每跳复核，拒绝 private/loopback/link-local；
- 临时文件、Range/offset、单文件和总量预算；
- canonical MIME、magic bytes、长度、SHA-256；
- 原子发布、no-clobber、immutable `ObjectRef` 与 durable MediaReceipt。

## 5. 停止、checkpoint 与人工恢复

### 5.1 类型化停止原因

```text
AUTH_REQUIRED
IDENTITY_MISMATCH
VERIFICATION_REQUIRED
RATE_LIMITED
SECURITY_BLOCK
SIGNATURE_REJECTED
SCHEMA_DRIFT
PROTOCOL
NETWORK
BROWSER_CRASHED
UNKNOWN_OUTCOME
```

认证、验证、限流、安全限制和身份错误必须与普通网络失败分开。自动重试仅限能够证明请求尚未发送，或能够证明没有页面/会话副作用、结果已知且操作为幂等只读的瞬时网络错误与部分 5xx；`UNKNOWN_OUTCOME` 不得重放。401/403/406/429、challenge、签名拒绝和 Schema 漂移不能当网络错误重试。任何具体请求上限或时间间隔都只是工程预算，不是平台“安全频率”。

### 5.2 全局 circuit breaker

以下任一信号触发 account/profile 级全局停止：登录身份变化或无法确认；验证码/滑块/challenge；401/403/406/429；平台安全限制；签名拒绝；无法安全解释响应的 Schema/selector 漂移；`UNKNOWN_OUTCOME`；以及无法证明已安全终止的 `BROWSER_CRASHED`。

停止动作必须是：

1. 撤销当前 operation generation；
2. 取消尚未发出的滚动、详情和媒体请求；
3. 保留旧 progress，不从 partial page 推导 cursor；
4. 原子保存已完成项、停止原因和安全审计记录；
5. 先原子持久化 account/profile 的 `blocked/quarantined` 状态，再释放当前 profile lease；新 run 取得 lease 前必须检查该状态；
6. 禁止切换 HTML/API/provider、网络、代理、profile 或账号继续；
7. 用户在专用 profile 中人工检查；
8. 只有人工 reconcile 未知结果、重新核验授权、身份和 checkpoint 并显式恢复后，才能清除隔离状态并签发新 generation；
9. 同类信号再次出现时保持禁用，转人工审查或官方支持。

### 5.3 receipt 契约

| Receipt | 必要字段 | 禁止内容 |
|---|---|---|
| `PageReceipt` | 公共封套；完整 scope、request/next cursor、hasMore、sourceLayer、completeness、stable IDs、safe outcome | token、完整 signed URL、raw response |
| `DetailReceipt` | 公共封套；`noteId`、decoder/schema version、sourceLayer、semantic payload hash、mediaSetComplete、safe failure category | Cookie、headers、原始异常和页面 transcript |
| `MediaReceipt` | 公共封套；`noteId + kind + ordinal + role`、`mediaRefDigest`、MIME、length、SHA-256、ObjectRef、source rank、stored/failed/skipped | 远端 URL、Header、Cookie |
| `OperationReceipt` | 公共封套；完整 scope、succeeded/blocked/cancelled/unknown、时间、typed category | stack、request/response、storage state、session transcript |

所有可提交 receipt 共享同一公共封套：`runId/operationId/generation`、`provider/hostId/accountId`、`sessionBindingDigest`、`scopeDigest/expectedRevision`。父对象身份必须足以绑定具体 note/media；`mediaRefDigest` 只能是不可反推出 URL 或 Secret 的瞬态来源摘要。MCP session、profile 存在、storage-state 文件、截图、HAR、Trace 或 session transcript 均不得转换为 canonical receipt。

## 6. Secret、诊断与本地能力边界

- Cookie、token、storage state、signed URL、CDP endpoint、proxy/remote headers、HAR、Trace、截图、真实页面 DOM/正文均按可冒充账号或包含私有内容的材料处理；禁止进入普通日志、Agent、知识库、Git、SQLite 或 Markdown。Agent 只可直接观察合成/脱敏 fixture；真实账号诊断原始材料由人类本地 `ArtifactBroker` 隔离，Agent 只能读取服务端 allowlist/redaction 后的结构摘要。
- Trace 可能记录输入值、DOM、截图、console、action 参数、下载 URL 和本地源码；HAR 即使 `minimal/content: omit` 也可能保留 URL/query、headers 和表单参数。生产默认关闭。
- 授权诊断优先使用合成环境；目录按 run 隔离并设 `0700`，文件 `0600`，配置单文件、单响应、单运行和磁盘总量预算、短 TTL 与删除失败审计。
- `Response.body()` 会整正文入内存，不用于无明确上限的大媒体；原始 headers/body 不返回 Agent。
- Service Worker 可能让普通 route 看不到请求；无法证明来源或完整性时 fail closed，不退化为未经验证的数据。
- 优先进程内/stdio 或受控本地 IPC。网络服务如确有必要，只允许 loopback/Unix socket、强调用者身份与逐能力 token；Host 检查、CORS、固定 header 或客户端声明 roots 都不能替代认证和服务端文件授权。
- 本地写只由 `MediaStore/ArtifactBroker` 执行固定 run root；本地读需 allowed roots、realpath/no-follow 和 OS sandbox。生产 Agent 不获得任意文件读写能力。

## 7. Stage 4 验收研究

### 7.1 离线和本地合成验收

这些场景可在不访问平台、不使用真实账号的条件下先完成：

- 生产构建不含通用 MCP/Agent 工具注册；unsafe/evaluate/upload/platform-write 默认拒绝；
- Agent-assisted exploration 只接受合成/脱敏 fixture；真实账号原始 DOM/network/截图只能进入人类本地 `ArtifactBroker`，Agent 仅收到字段 allowlist 后的结构摘要；
- Exploration 结果不能直接写 SQLite/Object Store，必须经过版本化 decoder；
- 第二个 run 获取同 account/profile lease 时 fail closed；
- 身份缺失/不匹配时零 canonical mutation、零 cursor 前移；
- 无有效本地 capability token、非 loopback 服务、client roots 扩权均被拒绝；
- 任意 URL、本地路径、symlink、path traversal、private/loopback/link-local 和跨 allowlist redirect 被拒绝；
- DNS 解析变化和每跳 redirect 均重新检查目标；
- `Set-Cookie` 被建模为 session write，context-bound APIRequestContext 默认禁用；
- 每个生产方法的实际能力必须是其固定 capability vector 的子集；少报能力、未声明 `sessionWrite`、运行时越权或 policy 版本漂移均 fail closed；
- 未获 `sideEffectingRead/sessionWrite` 授权的方法在发送任何请求前拒绝；测试响应含 `Set-Cookie` 时专用 profile 保持零变化，side-effecting read 未批准时请求计数为零；
- 没有 `localWrite` 的 Provider 不能创建下载或临时文件；只有取得独立 capability token、固定 run root 和预算的 `MediaStore/ArtifactBroker` 操作可以 staging；
- 预载其他 note 时，详情 ID 校验拒绝错误对象；
- scope/cursor provenance 不一致时记 `PROTOCOL`，旧 progress 不变；
- oversized、截断、错误 MIME、长度/hash 不符不生成 stored receipt；
- Live Photo 缺 still 或 motion 形成逐资产 partial，不把整 note 标完整；
- timeout/abort 后迟到结果因 generation 失效不能提交；
- 旧 generation 的 `PageReceipt/DetailReceipt/MediaReceipt/OperationReceipt` 均为零 canonical mutation；错误账号、错误 scope、stale expected revision 或不匹配的 `mediaRefDigest` 同样拒绝；
- crash、Context close、客户端断开后按期限清理租约和临时目录，checkpoint 不依赖清理成功；
- HAR/Trace 默认关闭，Secret canary 不出现在 Agent、日志、异常、receipt、SQLite、Markdown、路径或诊断索引；
- 浏览器/network 预取完成后，短事务使用 expected revisions 提交；并发 Core 更新导致 stale commit 被拒绝；
- Stage 3 forbidden-network/import 静态门继续通过。

### 7.2 未来授权后的动态验收门

只有在另立 Stage 4 规格、取得明确授权并完成离线门后，才能设计最小动态验收。初始运行预算应保守、有硬上限和即时 kill switch，但不得把任一页大小、QPS、延迟或成功率写成平台安全阈值。动态验收首先验证身份绑定、只读范围、停止信号、Schema 与 checkpoint，而不是验证“如何避免风控”。

CAPTCHA、429、登录变化、安全限制出现时应在首个信号停止；没有自动重试、换 profile、换代理、设备重建或 stealth 分支。任何真实账号成功率、验证码率和风险变化都不能从当前静态研究推导。

## 8. 对阶段三和阶段四的影响

### 8.1 Stage 3 不改变

- 继续完全离线；不引入 Cookie、浏览器、CDP、MCP、签名、私有 endpoint 或真实平台数据；
- Core 继续独占 canonical state、cursor、task/failure、逐资产状态和 object receipt；
- fixture 使用合成、脱敏、确定性数据；本专题不修改代码、CLI、Schema 或公共接口。

### 8.2 Stage 4 必须另立门

Stage 4 需要独立的产品范围、授权记录、威胁模型、依赖/浏览器制品审计、SecretStore、本地 IPC、OS sandbox、只读 capability allowlist、会话租约、类型化停止、人工恢复和验收计划。Playwright 是否真正纳入只能在正式发布版本完成上述评估后决定。

## 9. 未知项、证据索引和独立复审

### 9.1 未知项

- 当前 XHS/RedNote origin、路径、DOM、hydrated state、网络响应和字段形状；
- saved/liked 的真实 cursor、排序、删除、置顶、空页、全量与完整性边界；
- access material 的有效期、来源耦合和安全存储周期；
- 可稳定、低副作用读取的账号 ID，以及登录实际依赖 Cookie/localStorage/IndexedDB/sessionStorage/Service Worker/设备状态的组合；
- 验证码、401/403/406/429、Retry-After、平台错误和安全限制的真实映射；
- Live Photo motion 字段、媒体变体、Range 支持、长度/hash 可信度和 signed URL 生命周期；
- 目标 OS/浏览器组合的 profile lock、crash、close、download 与迟到结果行为；
- 最终 Playwright release、npm provenance、browser artifact hash、许可证矩阵和 CVE 状态；
- Playwright MCP 固定 alpha 与相邻 monorepo 实现的精确差异；
- 最终本地 IPC、capability token、SecretStore 和 OS sandbox 的平台实现；
- 任何真实账号成功率、验证码率、风控变化和“模拟人工”有效性。

### 9.2 证据索引

- [候选项目总目录与跨项目映射](../catalog.md)
- [Playwright 专项报告](../playwright/review.md)
- [OpenCLI 专项报告](../opencli/review.md)
- [Playwright MCP 专项报告](../playwright-mcp/review.md)
- [MediaCrawler 专项报告](../mediacrawler/review.md)
- [xiaohongshu-mcp 专项报告](../xiaohongshu-mcp/review.md)
- [XHS_ALL_IN_ONE 专项报告](../XHS_ALL_IN_ONE/review.md)
- [Stage 3 离线核心规格](../../projects/rednote-sync-core/docs/sync-core.md)
- [专题 checkpoint](playwright-human-like-route.checkpoint.json)

### 9.3 独立复审

- **浏览器/会话能力与证据复审：PASS。** storage state、Browser/Context/Page 生命周期、迟到清理、Download containment/copy/pipe、Trace/HAR 敏感字段和全部固定链接已复核。
- **风控、合规和停止边界复审：PASS。** 人工登录期间 Agent/MCP 隔离、`UNKNOWN_OUTCOME/BROWSER_CRASHED` 全局停止、先持久隔离再释放 lease 与人工 reconcile 已闭环；没有验证码、stealth、代理、指纹或签名规避路线。
- **Agent/MCP 探索与生产适配边界复审：PASS。** 合成探索/真实账号诊断隔离、receipt 公共封套、方法级 capability vector、side-effecting read/session write 和本地 staging 分权已闭环。
- 最终未关闭 finding：**P0–P3 均为 0**。
