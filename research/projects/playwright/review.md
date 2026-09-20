# Playwright 专项源码审查

GitHub：[microsoft/playwright](https://github.com/microsoft/playwright)

> 状态：**研究证据**。本文只对记录的固定 revision 和审查范围负责；评级、排除项、历史实施阶段边界和账号限制不自动成为当前产品决策。

## 先读这里：身份验证与帖子详情获取

补充日期：2026-09-12。以下依据固定版本 `bcb3563aa73d7ac71ac8cb877433201b1b97b7da` 的公开文档与源码作静态分析，未启动浏览器，未实测小红书兼容性。

**Playwright 是让脚本控制浏览器和网页的通用工具。** 下面介绍它能提供的机制；小红书的登录步骤、帖子选择和数据判断仍需另外编写。

### 身份验证方式：提供会话保存与恢复能力，登录和账号核验由调用方实现

可以把浏览器会话理解成一套网页访问环境，里面保存着 Cookie 等状态。Playwright 提供几种使用方式：

| 方式 | 工具实际提供什么 |
|---|---|
| 保存和恢复会话材料 | 调用方先安排登录，再用 `storageState` 保存 Cookie、localStorage 等，后续创建浏览器会话时载入。IndexedDB 需要显式选择保存；这不是复制整个浏览器环境。[保存与载入示例](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/docs/src/auth.md#L268-L302)、[实际收集范围](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/server/browserContext.ts#L616-L640) |
| 使用专用持久目录 | `launchPersistentContext(userDataDir)` 启动浏览器，把会话保存在指定目录，下次沿用该目录。官方要求为自动化使用独立目录，不支持把日常 Chrome 主目录直接交给这个方法。[持久目录说明](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/docs/src/api/class-browsertype.md#L329-L351) |
| 连接已有浏览器 | `connectOverCDP` 可连接已经提供调试端点的 Chromium 类浏览器，使用其中已有的会话和页面。它需要可连接的调试地址，不能无条件接管任意已打开的 Chrome。[CDP 连接条件与示例](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/docs/src/api/class-browsertype.md#L140-L178) |

**恢复材料不等于验证账号。** 先开有窗口的浏览器、让用户手动登录，再保存会话，是调用方可以组织的流程；Playwright 不会因此自动知道“小红书登录成功了”“登录的是指定账号”或“Cookie 仍有效”。官方认证示例也要求应用自己完成登录动作、等待成功页面或元素，再保存状态；小红书具体用什么成功判据，需要另行实现。[认证步骤示例](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/docs/src/auth.md#L59-L75)

### 帖子详情获取方式：可读取页面、网络响应或 HTTP 结果，采集流程由调用方编写

| 取数据的路线 | Playwright 能做什么 | 需要自行补齐什么 |
|---|---|---|
| 让网页正常加载，再读页面 | 导航或点击进入帖子，用页面脚本读取标题、正文等元素，也可读取页面保存在 `window` 中的数据。[页面操作](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/docs/src/pages.md#L6-L24)、[页面脚本](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/docs/src/evaluating.md#L6-L16) | 小红书页面选择器、数据位置、加载完成和帖子 ID 的核对。 |
| 让网页正常加载，再读网络响应 | 在导航或点击之前监听目标响应，收到后直接用 `response.json()` 读取 JSON，无须先导出 HAR。[等待响应](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/docs/src/network.md#L307-L334)、[响应 JSON](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/docs/src/api/class-response.md#L91-L98) | 哪个响应是目标帖详情、返回是否成功、字段是否合法，以及如何保存结果。 |
| 直接发送 HTTP 请求 | `page.request`／`context.request` 可以共用浏览器 Cookie；也能用 `request.newContext()` 创建独立 HTTP 客户端，后者不需要浏览器进程。[Cookie 共享与独立请求](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/docs/src/api/class-apirequestcontext.md#L7-L25)、[独立客户端示例](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/docs/src/api/class-apirequestcontext.md#L36-L46) | 接口地址、参数、平台认证和签名要求。共享 Cookie 不代表执行了网页 JavaScript 或满足了接口全部要求。 |

**目标帖子由调用脚本决定。** 例如，脚本可以接收一份帖子链接清单，依次导航并读取详情；也可以先从搜索或收藏页面收集链接，再处理这些链接。这样的列表发现、分页、逐帖循环、去重和结果保存是要编写的应用逻辑，通用导航与点击 API 不会自动替你收齐当前页面的所有帖子。[导航与点击能力](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/docs/src/pages.md#L6-L24)

**使用浏览器路线时，不必先手动打开日常 Chrome。** 脚本可自行启动浏览器；普通启动默认 `headless=true`，即没有可见窗口，但浏览器进程仍在运行，需要人工登录时可选择有窗口模式。使用纯 HTTP 客户端则是另一条路线。上述通用 API 都不代算小红书签名或创造 `xsec_token`；这些访问材料及其有效性必须由具体应用解决，不能由“能带 Cookie 发请求”推定帖子一定可读。[启动浏览器](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/docs/src/api/class-browsertype.md#L256-L281)、[无头模式默认值](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/server/browserType.ts#L299-L307)

状态：专项审查完成；独立复审通过
审查日期：2026-08-13
固定 revision：[`bcb3563aa73d7ac71ac8cb877433201b1b97b7da`](https://github.com/microsoft/playwright/tree/bcb3563aa73d7ac71ac8cb877433201b1b97b7da)
上游快照版本：`1.63.0-next`

> 本报告只把 Playwright 视为通用浏览器自动化底座，不把它描述为小红书业务实现、账号安全证明或风控规避方案。

## 1. 范围、来源与方法

- 官方来源、sparse checkout 范围和固定 revision 见 [`provenance.json`](provenance.json)，中断恢复状态见 [`checkpoint.json`](checkpoint.json)。
- 只读审查已物化的 tracked 文档、`playwright-core` 源码、library 测试、GitHub/Azure CI 与发布配置、manifest、lock、LICENSE 和 NOTICE；没有安装、构建、运行测试或启动浏览器。
- 不读取 profile、storage state、HAR、trace、Cookie、token 或个人数据，不访问小红书。
- 证据标签：`[文档声明]`、`[源码事实]`、`[配置事实]`、`[测试源码]`、`[静态推断]` 和 `[未知]`。测试源码只证明上游覆盖意图，本次没有验证测试通过。

## 2. 结论摘要

建议维持 **A 级专项参考**，准确定位为“历史实施 Stage 4 的通用浏览器执行底座”。它可以作为经固定版本约束的依赖候选，也值得借鉴 Context/Page 生命周期、事件等待、取消与崩溃传播、专用 persistent profile、临时制品和路径 containment；是否实际纳入仍需历史实施 Stage 4 单独规格、授权、威胁建模和动态验收。

Playwright 不提供小红书的链接发现、详情、媒体模型、账号身份核验、游标、水位、逐资产 checkpoint、429/验证码停止门或人工恢复语义。其 API 还能执行任意导航和 JavaScript、上传本地文件、读写 Cookie、拦截请求并发起 HTTP 写操作，因此不能把 `Page`、`BrowserContext` 或通用 HTTP 客户端直接暴露给 Agent。

### 核心结论：

Playwright 最值得借鉴的是浏览器资源所有权和失败传播，而不是业务采集逻辑。历史实施 Stage 4 应在它外面实现 `ProfileLease + SessionBinding + BrowserRednoteClient`：使用专用 profile，启动和恢复后核验预期账号，只开放精确的只读域方法，并以 operation generation 阻止 timeout 后的迟到结果提交。

`storageState` 是明文敏感快照，不是账号身份；persistent context 的单目录限制也不是应用层任务锁。Download、HAR 和 Trace 都只是临时传输或诊断制品：`saveAs()` 没有 Rednote 所需的长度、MIME、SHA-256、fsync/原子发布闭环，HAR/Trace 还可能记录 Cookie、Authorization、signed URL、表单参数、DOM 输入值、截图、console 和本地源文件。生产默认应关闭 HAR/Trace。

浏览器归档 revision 固定，但下载器只核 HTTP 状态和非 chunked `Content-Length`，没有归档哈希或签名校验。`slowMo`、鼠标 steps、真实浏览器和 CDP 都只是自动化机制，不是降低风控或证明账号安全的证据。

## 3. BrowserContext、persistent profile 与身份边界

### 3.1 Context 与 profile

- `[文档声明]` `browser.newContext()` 创建相互隔离的非持久环境；浏览数据不会写入磁盘，适合任务隔离但不能保留登录。[BrowserContext](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/docs/src/api/class-browsercontext.md#L4-L19)
- `[文档声明/源码事实]` `launchPersistentContext(userDataDir)` 返回唯一 Context；关闭它会关闭浏览器。指定目录保存 Cookie/localStorage，同一目录不能由多个浏览器实例并发使用。官方明确警告不得自动化日常 Chrome 主 profile，应使用独立目录。[官方文档](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/docs/src/api/class-browsertype.md#L329-L351) [server 目录处理](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/server/browserType.ts#L150-L174)
- `[源码事实]` 新建 profile 目录使用 `0700`；空路径生成临时 profile，用户指定目录不进入临时清理清单。[browserType.ts](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/server/browserType.ts#L150-L174)
- `[测试源码]` 上游验证指定 profile 关闭再启动可恢复 localStorage；Chromium 同目录冲突依赖浏览器 `ProcessSingleton` 日志识别，相关测试对某些 headless/channel/Windows 场景有 skip/fixme。因此它不能代替 Rednote 自己的跨任务 lease。[profile persistence](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/tests/library/defaultbrowsercontext-2.spec.ts#L96-L137) [冲突识别](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/server/chromium/chromium.ts#L426-L440) [并发测试](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/tests/library/chromium/chromium.spec.ts#L630-L659)

### 3.2 `storageState` 不是身份绑定

- `[文档声明]` 认证状态文件可能含可冒充账号的 Cookie 和 Header，不应提交到仓库。[auth.md](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/docs/src/auth.md#L12-L19)
- `[源码事实]` 客户端从对象/JSON 文件读取状态，并以普通 JSON 写到调用者指定路径；没有内建加密或 secret reference。[browserContext.ts](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/client/browserContext.ts#L479-L490)
- `[源码事实]` 快照默认收集 Cookie 和 origin localStorage；IndexedDB 与虚拟 WebAuthn credentials 均需通过选项显式启用。协议形状没有平台账号 ID、预期主体、上次核验身份或 lease 字段。[服务端收集](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/server/browserContext.ts#L616-L665) [协议形状](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/server/channels.d.ts#L1498-L1523)
- `[文档声明]` sessionStorage 没有正式持久化 API，文档仅给页面脚本自行导出/注入的示例。[auth.md](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/docs/src/auth.md#L589-L605)
- `[源码事实]` Context 还可接收 client certificate、私钥/PFX/passphrase 和带用户名/密码的代理；Rednote 当前不需要这些能力，应默认拒绝。[证书文件读取](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/client/browserContext.ts#L602-L619) [代理凭据处理](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/server/browserContext.ts#L481-L500)

历史实施 Stage 4 建议外建：

```text
ProfileLease(profileRef, leaseId, ownerRunId, acquiredAt, heartbeat)
SessionBinding(provider, expectedAccountId, observedAccountId,
               profileRef|storageStateSecretRef, stateRevision,
               lastVerifiedAt, status, allowedOrigins, leaseId)
```

浏览器启动、checkpoint 恢复及人工重新登录后都必须最小化读取实际账号身份；无法确认、身份不匹配、验证码或安全限制一律暂停，不自动扫描、切换或重新登录其他账号。

## 4. 网络、下载、HAR 与 Trace

### 4.1 网络完成边界

- `[文档声明/源码事实]` 生命周期区分 `request`、收到状态/头的 `response`、正文完成后的 `requestfinished` 与失败的 `requestfailed`；404/503 仍算传输成功。客户端只在 `requestFinished` 后 resolve `Response.finished()`。[Request 文档](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/docs/src/api/class-request.md#L4-L18) [客户端事件](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/client/browserContext.ts#L207-L237)
- `[源码事实]` `Response.body()` 返回完整 `Buffer`，服务端也缓存完整正文；它不适合直接承载无明确上限的大媒体。[client network](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/client/network.ts#L727-L743) [server network](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/server/network.ts#L647-L665)
- `[文档声明]` `allHeaders()` 会返回包含 Cookie 的完整头；Service Worker 接管的请求可能绕过普通 route，需动态确认目标站点可见性。[Request headers](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/docs/src/api/class-request.md#L106-L123) [Service Worker 限制](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/docs/src/network.md#L768-L779)

Rednote 只能把 `response` 记为 `headers_received`；还要等正文完成、单独校验 HTTP 状态，并由受限流式下载器验证 MIME、长度和 SHA-256 后才能把资产设为 stored。

### 4.2 Download/Artifact 不是媒体提交协议

- `[文档声明]` Download event 在下载开始时触发；`path()`/`saveAs()`等待完成，另有 `failure/cancel/delete`。Context 关闭会删除临时下载。[Download 文档](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/docs/src/api/class-download.md#L64-L111) [生命周期](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/docs/src/downloads.md#L8-L14)
- `[源码事实]` 内部文件名经 `resolveWithinRoot` 限制在下载目录，逃逸会拒绝；默认内部名是 UUID。[download.ts](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/server/download.ts#L29-L40)
- `[源码事实]` 本地 `saveAs` 直接 `copyFile`，远程模式直接 pipe 到目标；没有 temp→fsync→rename、长度/hash 后验或 no-clobber 语义。[artifactDispatcher](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/server/dispatchers/artifactDispatcher.ts#L53-L68) [client artifact](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/client/artifact.ts#L38-L51)
- `[测试源码]` `saveAs` 允许覆盖既有目标；Context 关闭会让进行中下载得到 `canceled` 或 target closed。[覆盖测试](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/tests/library/download.spec.ts#L187-L202) [关闭测试](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/tests/library/download.spec.ts#L441-L499)

Playwright 临时下载只能作为 transport staging。Rednote 仍需 `(kind, ordinal)` 逐资产状态、Range/offset、字节上限、MIME/magic bytes、长度、SHA-256、原子 object receipt 和恢复策略；`suggestedFilename` 不能直接成为输出路径。

### 4.3 HAR/Trace 是高敏诊断制品

- `[源码事实]` HAR `urlFilter` 在创建 entry 前生效，值得借鉴为诊断 allowlist；但 `minimal` 仍保存请求/响应头，URL/query 原样进入记录，`content: omit` 下 URL-encoded 表单参数仍可能保存。[过滤](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/server/har/harTracer.ts#L131-L137) [headers](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/server/har/harTracer.ts#L618-L636) [query/form](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/server/har/harTracer.ts#L701-L745)
- `[源码事实]` HAR attach 以 SHA-1 命名内容，仅可参考去重思路；Recorder 会清空最终路径再 append。[静态推断] 若进程在 append 完成前异常中止，最终路径可能留下截断文件。[附件](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/server/har/harTracer.ts#L541-L563) [写入](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/server/har/harRecorder.ts#L102-L140)
- `[源码事实]` Trace 可保存网络、DOM、ARIA、screencast、截图和 sources；DOM snapshot 会记录 INPUT/TEXTAREA 当前值，未对密码框作特殊排除。action params/result/error、console、dialog、下载 URL 也会序列化。[Trace 启动](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/server/trace/recorder/tracing.ts#L106-L190) [输入值](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/server/trace/recorder/snapshotterInjected.ts#L462-L471) [console/download](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/server/trace/recorder/tracing.ts#L640-L672) [action params/result/error](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/server/trace/recorder/tracing.ts#L786-L835)
- `[源码事实/静态推断]` Trace 的 `context-options` 会序列化 Context 配置，递归 visitor 只对 `Buffer` 做占位替换；字符串形式的 Authorization/extra headers、HTTP/代理密码、storage state 内容和 certificate passphrase 可能进入 trace。`storageState()` 写明文 JSON 时也没有显式指定权限 mode。[Context options](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/server/trace/recorder/tracing.ts#L126-L135) [visitor](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/server/trace/recorder/tracing.ts#L752-L783) [state 写入](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/client/browserContext.ts#L479-L484)
- `[源码事实]` 开启 sources 会把堆栈涉及的本地源文件装入 zip；chunk 可以 export/discard，但网络资源跨 chunk 共用，指定 `tracesDir` 时导出后原始文件仍可能保留。[sources](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/server/localUtils.ts#L60-L79) [chunk](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/server/trace/recorder/tracing.ts#L388-L469) [保留测试](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/tests/library/tracing.spec.ts#L270-L286)

`minimal`、`omit`、`urlFilter` 和 Trace Viewer 本地处理都不等于 secret scrub。生产默认关闭 HAR/Trace；诊断若获授权，只使用合成环境或严格字段 allowlist，禁用不必要的 sources/screenshots/DOM snapshot，目录 `0700`、文件 `0600`、短 TTL，删除失败进入审计 finding。

## 5. 生命周期、隔离、并发与失败语义

- `[源码事实]` Browser 创建 Context 时使用可取消进度域；storage state 恢复失败会关闭半成品 Context。Browser 关闭传播到 Context、未完成下载和连接事件。[browser.ts](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/server/browser.ts#L104-L126) [关闭传播](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/server/browser.ts#L173-L198)
- `[源码事实]` Context 维护 `open/closing/closed`，关闭时先刷新 trace/HAR/screencast，再清理下载和临时目录。Page 也区分 open/crashed/closing/closed，关闭或崩溃会关闭长运行操作域。[Context close](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/server/browserContext.ts#L540-L590) [Page state](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/server/page.ts#L167-L205) [close/crash scope](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/server/page.ts#L297-L323)
- `[源码事实]` `ProgressController` 有 deadline、强制拒绝和 AbortController，但源码也存在“底层操作不可取消，完成后再清理”的路径；timeout/abort 不能等于业务动作已经停止或不会迟到。[progress.ts](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/server/progress.ts#L25-L184)
- `[测试源码]` 并发 close、关闭传播、Page crash、等待取消和多 Context 隔离有覆盖，同时部分平台/engine 场景标有 fixme。它们适合变成历史实施 Stage 4 验收用例，但不是本项目实测结果。[browser close](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/tests/library/browsertype-launch.spec.ts#L104-L120) [crash](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/tests/library/page-event-crash.spec.ts#L35-L120)

Rednote 需要外层 watchdog、全局 circuit breaker、operation generation/token、关闭期限和 durable checkpoint。超时后的迟到结果必须因 generation 不匹配而拒绝提交；Playwright 的内存取消不能替代持久任务取消。

## 6. 安全、权限和风控边界

Playwright 是高权限 SDK，而非安全沙箱：

- `[源码事实]` 可导航任意 URL、执行页面 JavaScript、上传本地文件；Context 可读写 Cookie、权限、地理位置、Header、HTTP 凭据、脚本、请求和 WebSocket route。[导航](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/client/frame.ts#L127-L130) [evaluate](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/client/frame.ts#L211-L224) [文件上传](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/client/frame.ts#L468-L470) [Context 能力](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/client/browserContext.ts#L318-L405)
- `[源码/文档事实]` APIRequestContext 支持 GET、POST、PUT、PATCH、DELETE 等任意方法；`context.request`/`page.request` 还与浏览器共用 Cookie jar，自动携带 Cookie，并把响应 `Set-Cookie` 写回 Context。请求默认最多跟随 20 次 redirect。[方法面](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/client/fetch.ts#L131-L176) [Cookie 共享](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/docs/src/api/class-apirequestcontext.md#L7-L25) [redirect/Set-Cookie](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/server/fetch.ts#L203-L218) [写回](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/server/fetch.ts#L420-L488)
- `[文档/源码事实]` `launchServer` 默认 loopback、随机 `wsPath`；显式 `0.0.0.0` 会暴露浏览器 RPC，知道 `wsPath` 的进程或网页可控制 OS 用户。随机路径是 bearer secret，不是调用方身份鉴权。[BrowserType host](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/docs/src/api/class-browsertype.md#L415-L437) [server path](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/browserServerImpl.ts#L81-L90)
- `[源码事实]` 通用 fetch 仅对 `ECONNRESET` 有可选指数重试；`slowMo` 只是协议调用后的固定 sleep，鼠标 steps 只是插值生成移动事件，均不构成 429/验证码/平台风险控制。[fetch retry](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/server/fetch.ts#L287-L310) [slowMo](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/server/dispatchers/dispatcher.ts#L396-L409) [mouse steps](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/server/input.ts#L216-L231)

未来只应暴露窄域方法，如 `openSavedNote`、`observeDetailResponse`、`downloadAllowedAsset`、`pauseForHuman`。强制 host/path、每跳 redirect 目标和 HTTP 方法 allowlist；默认禁用 context-bound APIRequestContext，若确需 HTTP 则使用隔离客户端、关闭自动 redirect 或逐跳复核，并把 `Set-Cookie` 视为会话写操作。Service Worker 应阻断或由更低层网络 gate fail closed。禁止任意 `evaluate`、通用点击、文件上传、平台写操作、带凭据代理和 client certificate。默认只允许进程内连接或本机受控 IPC；网络暴露的 `launchServer` 排除，若确需本地 server，必须 loopback、把随机 path 当 secret、禁止日志泄露并增加 OS 级隔离。登录变化、验证码、429、安全限制或身份不匹配立即保存 checkpoint 并人工暂停。

## 7. 依赖、浏览器制品、CI 与许可证

### 7.1 依赖与浏览器制品

- `[配置事实]` 根 workspace 版本 `1.63.0-next`，要求 Node `>=20`，直接开发依赖使用精确版本；lockfile v3 中 665 个远端 tarball 条目均有 `integrity`。这只固定 npm 图，不证明没有漏洞。[package.json](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/package.json#L1-L17) [package-lock](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/package-lock.json#L1-L13)
- `[配置事实]` `browsers.json` 固定 Chromium/Firefox/WebKit/FFmpeg 等 revision，并允许平台 override。[browsers.json](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/browsers.json)
- `[源码事实]` 浏览器下载支持多 CDN、环境变量改写 host、缓存锁和唯一临时目录；最多尝试五次。完成检查只有 HTTP 200 与非 chunked `Content-Length`，随后解压/chmod/写 marker，未见归档 hash、签名或 attestation 校验。[CDN/host override](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/server/registry/index.ts#L47-L60) [URL 选择](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/server/registry/index.ts#L1066-L1094) [fetcher](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/server/registry/browserFetcher.ts#L35-L77) [下载检查](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/server/registry/oopDownloadBrowserMain.ts#L48-L128)

采用时应 pin npm 包和 browser revision、限制 HTTPS 官方/受控镜像，并在构建链增加 checksum allowlist 或内部制品镜像；本轮未安装或扫描依赖。

### 7.2 CI、发布与许可证

- `[配置事实]` 对已物化 `.github/workflows` 与 `.github/actions` 的 tracked 静态清点共找到 116 个 `uses:`：27 个本地引用，89 个外部 `owner/action@ref` 均固定到 40 位 commit SHA；通用 test action 执行 `npm ci`、构建和浏览器安装。这只是局部门禁：其他步骤仍无 ref clone `playwright-vscode`，安装 major-only `yarn@1`/`pnpm@8`、未固定 `@puppeteer/browsers` 与 `firefox@nightly`，部分维护工作流还安装未固定的 `@github/copilot`，所以 CI 的全部代码与工具输入并未冻结。[固定 `.github` 快照](https://github.com/microsoft/playwright/tree/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/.github) [run-test](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/.github/actions/run-test/action.yml#L42-L89) [VS Code/包管理器](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/.github/workflows/tests_primary.yml#L174-L220) [nightly browser](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/.github/workflows/tests_bidi.yml#L54-L60) [Copilot install](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/.github/workflows/fix-flakes.yml#L37-L47)
- `[配置事实]` 部分可接收 PR 代码的 job 在 job/workflow 级拥有 `id-token: write`，Azure 登录 step 在 composite action 中受 push 条件限制，仍可进一步拆到不执行 PR 代码的独立 job。另有多个 workflow 没有 workflow-level `permissions`（部分 job 会另行声明），其未声明部分最终权限依赖仓库默认设置。[tests_primary job](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/.github/workflows/tests_primary.yml#L53-L60) [push 条件](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/.github/actions/run-test/action.yml#L80-L89) [无 workflow-level permissions 示例](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/.github/workflows/infra.yml#L1-L22)
- `[配置事实]` Azure npm 发布用 `npm ci`/`npm pack`，通过 managed identity、Key Vault signing certificate 和 `EsrpRelease@11` 发布；但 1ES 模板引用 `refs/tags/release`，可见 YAML 没有明确生成 npm provenance/SBOM。模板内部能力和最终制品 attestation 因未展开而保持未知。[publish.yml](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/.azure-pipelines/publish.yml#L23-L31) [build](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/.azure-pipelines/publish.yml#L92-L146) [ESRP](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/.azure-pipelines/publish.yml#L152-L181)
- `[配置/源码事实]` 仓库、根 package 和 `playwright-core` package 均声明 Apache-2.0；根 NOTICE 记录 Microsoft 版权及部分代码源自 Puppeteer。`playwright-core` 另有 ThirdPartyNotices，说明构建包的 bundle 具有 `.js.LICENSE` sidecar；BiDi 目录和个别源码文件也保留独立许可/归属通知。[LICENSE](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/LICENSE) [根 package](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/package.json#L1-L17) [core package](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/package.json#L1-L16) [NOTICE](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/NOTICE) [ThirdPartyNotices](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/ThirdPartyNotices.txt#L1-L13) [BiDi LICENSE](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/server/bidi/third_party/LICENSE) [per-file notice](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/client/eventEmitter.ts#L1-L22)

若复制/分发源码，需保留根许可证、NOTICE、ThirdPartyNotices、适用的 per-file 通知并标记修改；实际 npm tarball 的 `.js.LICENSE` sidecar、浏览器二进制及 vendored 组件许可还要按采用版本分别核对。更合适的边界是依赖正式发布包并独立实现 Rednote adapter，不复制 Playwright 内部源码。以上不是法律意见。

## 8. 对 Rednote Sync 的参考价值

| Rednote 方面 | Playwright 可提供 | Rednote 必须自行实现 |
|---|---|---|
| 浏览器会话 | Context、persistent `userDataDir`、storage state、关闭事件 | `ProfileLease`、账号身份核验、`SessionBinding`、单账号 owner |
| 分层获取 | DOM、页面状态、请求/响应、route、WebSocket 观察 | XHS source-layer 顺序、shape validation、版本化 DTO、access-material secret 层 |
| 可靠性 | deadline、AbortSignal、crash/close 传播、临时目录清理 | durable checkpoint、operation generation、迟到结果拒绝、全局暂停/恢复 |
| 媒体 | Download event、failure/cancel/delete、临时 artifact | 流式限额、Range、逐资产状态、MIME/length/SHA-256、原子 receipt |
| 诊断 | HAR filter、Trace chunk、截图/DOM/network artifact | 默认禁用、字段 allowlist/redaction、容量/TTL/权限、删除失败审计 |
| 权限 | 通用高权限 Page/Context/HTTP API | 只读领域 allowlist、host/path/method gate、本地写 capability 分离 |
| 风控 | 没有 XHS 专用能力 | 合规授权、任务预算、429/验证码/登录变化停止门、人工恢复 |

历史实施 Stage 3 继续完全离线，不引入 Playwright、profile 或 storage state。历史实施 Stage 4 若采用，所有网络和浏览器工作在 SQLite writer transaction 外执行；只有通过 Schema、身份、revision、长度和 hash 校验的安全 DTO/object receipt 才能短事务提交。

## 9. 采用分级

- **A / 值得下一阶段项目级采用评估：** 选择正式 released tag/package 后重新核对 commit、tarball integrity/provenance、browser artifacts 与完整许可清单，再评估其作为历史实施 Stage 4 Browser Provider 底座；当前 `1.63.0-next` 快照只支持源码设计结论，不代表已审查正式发布制品。Context/Page 生命周期、事件等待、取消与崩溃测试场景仍值得提炼。
- **B / 只借鉴设计：** persistent profile、storage state、Download staging、HAR/Trace chunk。都需 Rednote 外层所有权、secret 和完整性协议。
- **C / 背景资料：** 多浏览器一致性、测试 runner 的并行账号/trace retention 模式；不能直接定义单账号同步策略。
- **D / 明确排除：** 直接向 Agent 暴露 Page/Context/evaluate/文件上传/通用 HTTP 写接口；使用会自动读写浏览器 Cookie 的 context-bound APIRequestContext；网络暴露 `launchServer`；自动化日常 Chrome profile；把 HAR/Trace 放入 canonical/知识库；把 `slowMo`、鼠标 steps、真实浏览器或 CDP 当反风控证明。

## 10. 未知项

- 未在目标操作系统和目标浏览器版本运行，crash/close/profile lock 的实际一致性未知。
- 未访问平台，XHS 登录实际依赖 Cookie/localStorage/IndexedDB/sessionStorage/设备状态的组合、账号 ID 读取、Service Worker 可见性、验证码/429/登录变化信号均未知。
- Download 公共 API 没有 Range/进度/hash 契约；浏览器内部存在不可调用的实现也不能成为 Rednote 保证。
- 没有发现官方字段级 HAR/Trace redaction API；下一阶段应按最终采用版本重新核查。
- 1ES 模板内部的 provenance/SBOM/签名能力、已发布 npm/浏览器制品与本 commit 的对应性、依赖 CVE 状态和各浏览器二进制完整许可证矩阵未核验。

## 11. 证据索引与独立复审

### 11.1 快照与完整性

- commit：`bcb3563aa73d7ac71ac8cb877433201b1b97b7da`
- tree：`b476d152ce110a37b1bc1b67679ac9070fbb58a6`
- Git tracked index：3,087；已物化 tracked：915；detached HEAD；审查期间 tracked/untracked clean。
- sparse 范围：文档、`playwright-core/src`、`tests/library`、GitHub workflows/actions、Azure pipelines 和 `browsers.json`。未物化路径不用于本地源码结论。

### 11.2 独立复审

| 审查面 | 结果 | 未关闭 finding |
|---|---|---|
| 证据、固定链接与快照一致性 | **PASS** | 无 |
| 安全、敏感制品与权限边界 | **PASS** | 无 |
| 供应链、许可证与 Rednote 适配 | **PASS** | 无 |

三类独立 reviewer 的 P0–P3 finding 均已关闭。复审修正了 CI Action 计数、许可通知清单、HTTP Cookie/redirect 与 `launchServer` 边界，并确认 A 级只表示历史实施 Stage 4 项目级采用评估。
