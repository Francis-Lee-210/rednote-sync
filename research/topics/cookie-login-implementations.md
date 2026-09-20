# 参考项目的 Cookie 登录与会话恢复逻辑

> 状态：**研究证据**。研究日期：2026-09-09（Pacific/Auckland）。本文解释固定版本源码的行为与可检验差异，不代表当前平台登录成功率、账号安全保证或实现路线定案。产品目标与工作顺序以[产品设计](../../docs/design/product-design.md)和[当前路线图](../../docs/design/roadmap.md)为准。

> 同日动态补充：自有协议实验中，`test_e` 的完整 Cookie + 本地签名通过一次非游客身份验证（HTTP 200、API code 0），`test_d` 返回 `-100`。这两次独立实验不改变下文第三方固定源码审查的范围；方法、实测边界见[协议登录实测说明](../reverse/targets/xhs-xsec-token/experiment/protocol-method.md#已验证的登录方式与结果)。

> 2026-09-10 增量：E 身份匹配复核通过，但单帖流程的搜索请求返回 HTTP 461，未取得目标 token 或详情；当次在线流程停止。这是身份有效但搜索未通过的证据，不是 Cookie 过期或搜索未命中的证据。后续逐次记录见[方法与证据](../reverse/targets/xhs-xsec-token/experiment/protocol-method.md)和[时间线](../reverse/targets/xhs-xsec-token/timeline.md)。

## 1. 问题与审查方式

本轮回答：参考项目所谓“Cookie 登录”到底接收什么、怎样建立或恢复会话、怎样判断成功、是否确认用户选择的账号，以及哪些差异可以帮助自有 xsec 实验。

初次源码对照只读本地研究副本中固定 revision 的已跟踪源文件，核对 HEAD 与 `provenance.json`，通过 `git show <revision>:<path>` 读取；该次审查没有读取真实 Cookie、profile、storage state、HAR、运行数据或个人配置，没有安装、执行第三方代码或重新请求小红书。后续自有实验的真实身份结果单列于 §6，不混入第三方源码结论。“未见账号核对”不扩大为整个软件不存在任何账号相关能力。

## 2. “Cookie 登录”并不是一种实现

| 路径 | 实际发生什么 | 成功不能只看什么 |
|---|---|---|
| 直接 HTTP 携带 Cookie | 已有 Cookie 进入请求头，按接口需要另行准备签名，服务器决定是否接受 | Cookie 字符串能解析、请求能发出 |
| 浏览器注入已有 Cookie | 在浏览器 context 写入 Cookie，再访问页面或账号接口确认会话 | `add_cookies` / Cookie 加载返回成功 |
| 交互登录后保存会话 | 用户完成扫码或其他交互，程序保存 Cookie/profile，下一次恢复 | 文件已保存；这种首次登录也不能算 Cookie 注入登录成功 |
| 复用已经登录的浏览器 | 扩展或 browser bridge 使用已有 profile 的站点会话 | 能操作页面、存在“我的”文字或 Cookie |

下文分别用 HTTP 客户端、MediaCrawler、xiaohongshu-mcp 与 OpenCLI/RedCaChe 的源码说明这些区别。它们处理的是已有会话材料或平台交互，不能把无效 Cookie 在本地“转换”为有效登录。

**主要发现：用户记得很多项目支持 Cookie，有源码依据。** 其中相当一部分是直接 HTTP 携带已有 Cookie；浏览器类中又常常是扫码后保存并复用会话。本次研究引用的浏览器注入实验受阻，不能扩大为 Cookie 总路线不可行；同样，参考代码能发带 Cookie 请求，不等于它已证明用户选定账号登录成功。下文已审的六个 HTTP/provider 路径没有找到同时满足“非游客、稳定用户 ID、与预期账号一致”的完整门禁，浏览器组的相关判据也存在缺口。

## 3. 浏览器类项目的实际调用链

### 3.1 MediaCrawler：只注入 `web_session`，随后浏览器与 HTTP 客户端共享 Cookie

研究版本：`5665a271ef15e0ec82b1f48a951b66760e054db9`。原有[项目审查](../projects/mediacrawler/review.md)、[来源记录](../projects/mediacrawler/provenance.json)。

- **输入与流程。** crawler 先打开网站主页，建立 HTTP client，并调用 `pong()`；失败后才执行选定的登录分支。Cookie 分支接收 Cookie 字符串，但只取 `web_session`，写入 `.xiaohongshu.com`、路径 `/`（国际站为 `.rednote.com`）。之后从浏览器读取站点 Cookie，更新 HTTP header。也就是说，浏览器先访问网站后产生的其他 Cookie 与外部提供的 `web_session` 共同组成后续请求环境。[启动链](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/xhs/core.py#L100-L117)、[Cookie 分支](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/xhs/login.py#L213-L224)、[回读 Cookie](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/xhs/client.py#L306-L320)
- **成功判定与缺口。** 启动前 `pong()` 请求 `/api/sns/web/v1/user/selfinfo`，检查嵌套 `result.success`；但 Cookie 注入分支本身没有再验证登录，启动链也没有在注入后再次调用 `pong()`。该链没有把服务器返回的稳定账号 ID 与用户选定账号作相等比较。[账号探针](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/xhs/client.py#L272-L304)、[启动分支](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/xhs/core.py#L103-L128)
- **扫码/手机与 Cookie 分支不同。** 交互分支等待侧栏“我”，或者把 `web_session` 发生变化作为成功；看到“请通过验证”只提示人工验证。Cookie 分支并没有走这一等待函数。不能把交互路径的成功声明推给 Cookie 注入路径。[交互判定](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/xhs/login.py#L51-L97)
- **失败处理。** 常规 HTTP request 对 401/403/429 和部分平台限制使用专门异常；461/471 则抛普通异常，仍可能进入最多三次的通用重试。`query_self()` 又是单独的 HTTP 调用。此处应借鉴错误分类，不能直接沿用其全部重试行为作为自有实验策略。[request 与重试](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/xhs/client.py#L127-L196)、[query_self](https://github.com/NanmiCoder/MediaCrawler/blob/5665a271ef15e0ec82b1f48a951b66760e054db9/media_platform/xhs/client.py#L272-L284)

**对主线的帮助（推断）：** “先访问主页再注入最小会话 Cookie”是值得与自有全量 Cookie 注入比较的变量；它不证明只给 `web_session` 就一定可用，也不应为追求表面成功而取消自有的稳定账号核对。

### 3.2 xiaohongshu-mcp：交互登录取得 Cookie，下次启动浏览器恢复

研究版本：`da9ba0365e176bc0eb11885f1941271d895feb73`。原有[项目审查](../projects/xiaohongshu-mcp/review.md)、[来源记录](../projects/xiaohongshu-mcp/provenance.json)。

- **输入与恢复。** 浏览器启动从指定 Cookie 文件读取数组，并通过 `WithCookies` 传入浏览器库。文件支持旧版裸 Cookie 数组与 v2 `version/seed/saved_at/cookies`；`COOKIES_PATH` 优先于默认位置。数组里的 Cookie 字段原样保存，而不是转成仅 name/value 字符串。[浏览器加载](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/browser/browser.go#L89-L100)、[文件读写](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/cookies/cookies.go#L12-L115)、[路径优先级](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/cookies/cookies.go#L127-L148)
- **Cookie 从哪里来。** 登录命令打开有界面浏览器，已有会话成功则返回，否则等待网页交互登录；随后用浏览器的整组 Cookie 保存文件。MCP 的二维码接口另开一个等待会话，最多等待四分钟，成功后保存 Cookie；同一时刻保留一个待扫码会话。[登录命令](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/cmd/login/main.go#L16-L81)、[二维码等待和保存](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/service.go#L136-L202)、[等待会话管理](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/login_session.go#L5-L41)
- **成功判定。** `CheckLoginStatus` 导航 explore 页后检查一个用户区 DOM 选择器。它另有 `CurrentUser()` 从页面状态读取 user ID/昵称，但服务层读取身份失败只记 warning，仍可返回 `is_logged_in: true`；没有在这条链里断言账号等于 expected account。[UI 与用户状态](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/xiaohongshu/login.go#L20-L70)、[状态返回](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/service.go#L104-L134)
- **失效处理边界。** 可显式删除 Cookie 文件，并重新取二维码等待；所审查登录函数以选择器和超时为主，没有自有实验那种完整的 challenge 分类或 expected-account 门禁。[删除接口](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/service.go#L97-L102)、[等待函数](https://github.com/xpzouying/xiaohongshu-mcp/blob/da9ba0365e176bc0eb11885f1941271d895feb73/xiaohongshu/login.go#L90-L129)

**对主线的帮助（推断）：** 可借鉴 Cookie 数组元数据保真、会话文件版本和登录等待生命周期。其“扫码一次、以后恢复”不能作为“用户提供 Cookie 在新环境里无需扫码即可登录”的成功证据；浏览器 seed 设置也没有被本轮验证为登录成功的原因。

### 3.3 OpenCLI：复用用户浏览器 profile，再发账号探针

研究版本：`a86d64705c526dc710f790e66cfcabf6ecf786b9`。原有[项目审查](../projects/opencli/review.md)、[来源记录](../projects/opencli/provenance.json)。

- **会话来源。** XHS 的 `whoami/login` 注册为浏览器命令并使用 persistent site session。`login` 先试身份探针，失败才打开登录页让用户完成交互，按间隔轮询，默认五分钟超时。这是现有浏览器会话与交互登录路径，不是粘贴任意 Cookie 后独立建立会话的命令。[通用登录注册](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/clis/_shared/site-auth.js#L45-L118)
- **成功判定。** quick check 只判断 creator 站点是否有 `web_session`；实际 verify 会在 `creator.xiaohongshu.com` 请求 `/api/galaxy/creator/home/personal_info`，要求 HTTP 成功且存在 data，返回 username/followers。不是“看到 Cookie 就算登录”，但也没有稳定 user ID 与 expected account 校验。[XHS auth](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/clis/xiaohongshu/auth.js#L4-L53)
- **账号选择。** profile alias/context ID 是浏览器实例路由，不是平台账号。显式 `--profile` 是硬要求，保存的 preferred default 可以回退到其他在线 profile。自有账号绑定任务可借鉴显式选择，但不能把 profile 名称代替服务器确认的账号 ID。[profile 选择与回退区别](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/src/browser/profile.ts#L56-L90)
- **适用范围。** 点赞采集命令运行在 `www.xiaohongshu.com`，它与上述 creator 探针不是同一应用入口。所审查 auth 对非认证错误直接失败，对认证未完成继续等待；不能据 creator profile 成功宣称用户站帖子详情、主号私有列表或目标 token 都可用。[点赞入口](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/clis/xiaohongshu/liked.js#L4-L28)、[登录错误处理](https://github.com/jackwener/OpenCLI/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/clis/_shared/site-auth.js#L88-L115)

**对主线的帮助（推断）：** “会话材料快检 → 实际账号请求 → 业务入口单独验证”值得借鉴；应保留它们的区别。用户选择采集账号之后，还需要在相应运行环境核对该账号，不能默认切到任一已登录 profile。

### 3.4 RedCaChe：扩展复用浏览器；旧后端保存整个 profile

研究版本：`b3526e66ed1d5b78e35a390edf1b7f29e1399ee9`。原有[项目审查](../projects/redcache/review.md)、[来源记录](../projects/redcache/provenance.json)。

- **纯扩展。** manifest 没有 Cookie 权限；content script 在当前浏览器站点页工作。登录检查依据 URL、登录/账号文字及个人主页链接，返回 `logged_in/login_required/captcha_or_challenge/unknown`，不返回或比对稳定账号 ID。[manifest](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/extension/manifest.json#L1-L18)、[登录检测](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/extension/content-script.js#L161-L168)
- **旧后端。** 使用 `launch_persistent_context(user_data_dir=...)`，可见浏览器由用户手动登录；后续复用同一个 profile，不是导入 Cookie 文本。[profile 生命周期](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/backend/app/crawler/browser.py#L33-L115)、[手动登录入口](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/backend/app/crawler/importer.py#L53-L65)
- **判定与停止。** 旧后端将 URL/正文 challenge、登录提示优先分类；有任意站点 Cookie 且有账号 UI hint 才算登录。导入开始要求 `logged_in`；详情补全遇登录或挑战停止。它仍然没有在这些判据中确认用户指定的账号。[判定函数](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/backend/app/crawler/importer.py#L920-L944)、[导入门禁](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/backend/app/crawler/importer.py#L581-L589)、[详情停止](https://github.com/ValerieTse/RedCaChe/blob/b3526e66ed1d5b78e35a390edf1b7f29e1399ee9/backend/app/crawler/importer.py#L343-L356)

**对主线的帮助（推断）：** 可借鉴把会话留在浏览器、单独检查登录状态与暂停任务；不能用它证明纯 Cookie 导入有效。其宽泛 UI hint 判据也不适合作为采集账号身份的最终证明。

## 4. HTTP 与外部 provider 项目的实际调用链

### 4.1 xiaohongshu-cli：从已有浏览器提取 Cookie，HTTP 请求当前用户

研究版本：`4d63f3c0c85ccd9054fa8e96d7f761aaf2507449`。原有[项目审查](../projects/xiaohongshu-cli/review.md)、[来源记录](../projects/xiaohongshu-cli/provenance.json)。

- **输入与调用。** CLI 可从浏览器读取 Cookie 字典并缓存，`auto` 返回首先找到的材料；提取阶段主要检查 `a1` 是否存在。HTTPX 携带 Cookie 并经签名层请求 `/api/sns/web/v2/user/me`，没有将这些 Cookie 注入 Chrome。[提取判据](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/cookies.py#L351-L370)、[来源选择与缓存](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/cookies.py#L430-L521)、[HTTP 请求](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/client.py#L92-L151)、[当前用户](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/client_mixins.py#L258-L259)
- **成功判定。** 默认 Cookie `login` 拒绝 guest 和空/Unknown 昵称，但没有要求稳定 ID 非空、也没有比较 expected account。相邻 `status` 获得资料即输出 authenticated；QR 分支在 guest 为真时仍可报告 session saved/authenticated。各入口强度不一致。[Cookie 判据与调用](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/commands/auth.py#L26-L31)、[login](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/commands/auth.py#L97-L129)、[QR](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/commands/auth.py#L64-L94)、[status](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/commands/auth.py#L133-L145)
- **持久化与失败。** 文件保存时间并 chmod 0600；七天后尝试重新提取，失败可回退旧材料。响应 Cookie 合并回内存；461/471、会话过期、IP、签名错误分开处理。缓存年龄不是服务器有效期证明。[保存](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/cookies.py#L52-L73)、[缓存更新](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/cookies.py#L481-L521)、[响应处理](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/client.py#L111-L189)

**对主线的帮助（推断）：** 最值得参考 Cookie 读取、签名 HTTP 客户端、身份检查与错误分类分层。应让所有入口共享稳定账号判据；账号由用户选定，不能以“第一个有 Cookie 的浏览器”代替。

### 4.2 ReaJason/xhs：提供 Cookie 客户端和可选的自身资料接口

研究版本：`f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0`。原有[项目审查](../projects/xhs/review.md)、[来源记录](../projects/xhs/provenance.json)。

- `XhsClient(cookie=...)` 将 Cookie 字符串装进 Requests Session，由签名回调参与 HTTP 请求；构造函数不在线验证身份。`get_self_info()` / `get_self_info2()` 由调用方决定是否调用，通用响应处理不强制核对 guest 或 expected account。[构造与 Cookie](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/core.py#L93-L149)、[请求与响应](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/core.py#L151-L204)、[资料接口](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/core.py#L338-L344)
- Cookie setter 可整体更新材料，已审调用链无自动重新登录门禁；461/471、IP block、签名错误有专门异常。其解析函数按等号切分，缺部分字段时补上游硬编码默认材料，不能据此判断会话完整或有效；本文不复制这些常量。[更新与异常](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/core.py#L119-L175)、[解析](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/help.py#L386-L409)

**对主线的帮助（推断）：** 可参考较小的“会话材料 → 请求 → 自身资料”接口；它是调用组件，尚需自有的登录成功、账号绑定和生命周期管理。

### 4.3 Spider_XHS：完整 Cookie + Auth 对象 + HTTP bootstrap

研究版本：`2030f5d4454e556ad7a9caa83b3ec532d4df20c7`。原有[项目审查](../projects/Spider_XHS/review.md)、[来源记录](../projects/Spider_XHS/provenance.json)。

- `from_cookie()` 接收完整 Cookie 并要求 `a1/web_session`，可附设备/存储上下文。源码说明 HttpOnly 会话材料不能用 `document.cookie` 完整取得。名为 BrowserHttpClient 的传输实际是 curl_cffi HTTP Session，不是真正的浏览器页面。[Cookie 输入](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/xhs_utils/xhs_pc/auth.py#L412-L425)、[必要字段](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/xhs_utils/xhs_pc/auth.py#L263-L276)、[HTTP transport](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/xhs_utils/xhs_core/http.py#L79-L100)
- `bootstrap()` 请求 user/me，要求 success 和非空 user_id，写进 Auth；它没有拒绝 guest 或比较 expected ID。单独 QR 流程最终要求 `guest is False`，判据比 Cookie bootstrap 强；两条路径不能混算。[bootstrap](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/apis/xhs_pc_apis.py#L72-L81)、[user/me](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/apis/xhs_pc_apis.py#L275-L290)、[QR 最终校验](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/apis/xhs_pc_login_apis.py#L834-L842)
- Auth 显式更新 Cookie 和 host Cookie；登录身份请求合并响应 Cookie。transport 设置 `discard_cookies=True`，不能假定底层自动持久化浏览器会话。业务 user/me 异常转成 success=False。[更新](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/xhs_utils/xhs_pc/auth.py#L311-L321)、[登录响应合并](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/apis/xhs_pc_login_apis.py#L652-L670)、[传输行为](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/xhs_utils/xhs_core/http.py#L149-L161)

**对主线的帮助（推断）：** 可参考输入完整性、host 范围、Auth 与传输分离。缺少稳定预期身份核对的 bootstrap 不能直接成为我们的验收标准。

### 4.4 XHS_ALL_IN_ONE：Cookie 导入和多账号状态管理

研究版本：`63b85de2b15b3f79134b08fa675381505f45d4db`。原有[项目审查](../projects/XHS_ALL_IN_ONE/review.md)、[来源记录](../projects/XHS_ALL_IN_ONE/provenance.json)。本节深入的是 PC 导入路径；creator 子类型存在，不将 PC 结论扩展成 creator 完整验收。

- `/import-cookie` 接收 cookie_string 和 pc/creator 子类型。PC 路径解析 Cookie，经 login adapter 调内嵌 XHSLoginApi 的 user/me，是 HTTP 认证检查。[输入与导入](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/api/accounts.py#L105-L145)、[身份请求](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/apis/xhs_pc_login_apis.py#L652-L670)
- adapter 只拒绝 success=False，user_id/nickname 可缺失，没有 guest/expected-account 校验。导入根据返回 external_user_id 查找或创建账号并设 active；后续 `check_account` 又可直接覆盖 external_user_id，而非与原绑定比对。[adapter](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/adapters/xhs/pc_login_adapter.py#L38-L57)、[账号存储](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/services/account_service.py#L113-L160)、[复查身份](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/api/accounts.py#L173-L188)
- 保存加密 Cookie 版本，复查读取最新版本，失败可标 expired。PC 导入保存的是提交的原始 Cookie 字符串，不能推断服务器更新的 Cookie 已持久保存；另有 QR/手机入口，属于新会话建立。[版本保存](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/services/account_service.py#L154-L160)、[复查失败](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/api/accounts.py#L149-L209)

**对主线的帮助（推断）：** 对“用户选择哪个采集账号”、Cookie 版本和状态展示尤其有参考价值；实际身份变化应报错并重新确认，不能直接把旧账号记录改成新 ID。

### 4.5 XHS-Downloader：Cookie 是下载请求参数，没有独立登录验收

研究版本：`56c912e0df7920ad0fbf5cd9d911628587b9c7e6`。原有[项目审查](../projects/xhs-downloader/review.md)、[来源记录](../projects/xhs-downloader/provenance.json)。

- Cookie 字符串经 SimpleCookie 解析送给 HTTPX AsyncClient，单次请求也能覆盖 Cookie header。主路径根据 HTTP 状态返回 HTML，没有当前用户身份门禁；配置“已设置”只代表非空。[client 构造](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/module/manager.py#L100-L114)、[解析](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/module/manager.py#L304-L307)、[请求](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/application/request.py#L26-L79)、[配置提示](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/TUI/setting.py#L225-L228)
- 浏览器 Cookie 提取辅助代码存在，但主应用与 CLI 的相关接线被注释。HTTPError 转成网络异常/空结果，再按空结果重试；没有在所审主路径做账号专用的失效或重认证判断。[主应用](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/application/app.py#L144-L160)、[CLI](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/CLI/main.py#L76-L84)、[重试](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/module/tools.py#L13-L22)

**对主线的帮助（推断）：** 适合在登录通过后研究详情/媒体层，对建立所选账号会话的直接帮助较少。

### 4.6 xhs-cli-export：把登录交给外部 CLI

研究版本：`6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83`。原有[项目审查](../projects/xhs-cli-export/review.md)、[来源记录](../projects/xhs-cli-export/provenance.json)。

- exporter 选择外部 xhs 可执行文件，可配置路径，倾向 headless 安装；自己没有独立 Cookie 登录客户端。headless 检查 `auth doctor --json` 的 authenticated；旧 CLI 路径再跑 whoami，以返回码补足可能误报的 status，仍不核对 expected ID。[provider 选择](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/src/xhs_export.py#L121-L147)、[检查逻辑](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/src/xhs_export.py#L1711-L1745)
- login 转调 provider 的 QR 登录，并给失败后的交互提示。这不是另一份独立 Cookie 自动登录成功证据；真实能力取决于运行时 provider 及其版本。[委托登录](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/src/xhs_export.py#L1748-L1765)

**对主线的帮助（推断）：** 借鉴启动前实测 provider 可用性和可恢复导出编排，但登录研究必须继续追到 provider；不能仅依据 wrapper 声明。

## 5. 其余工具中，哪些不提供小红书 Cookie 登录

| 项目及研究版本 | 源码能提供什么 | 对登录主线的边界 |
|---|---|---|
| [Playwright 原审查](../projects/playwright/review.md)，`bcb3563aa73d7ac71ac8cb877433201b1b97b7da` | 通用 Cookie API、storage state 和持久 profile | 浏览器基础设施，没有小红书账号登录或身份验证业务逻辑。[Cookie API](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/client/browserContext.ts#L318-L405)、[state](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/server/browserContext.ts#L616-L665) |
| [Playwright MCP 原审查](../projects/playwright-mcp/review.md)，`7e0457a7cbf88823bf0146d12c46ae12c6818247` | 文档区分 persistent、isolated + state、extension 借用现有浏览器会话 | 属于通用控制模式；支持载入状态不等于小红书接受该状态。不能把相邻 Playwright monorepo 版本等同于包装器使用的精确 alpha 包。[固定模式说明](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/README.md#L458-L519) |
| [xiaohongshu-importer 原审查](../projects/xiaohongshu-importer/review.md)，`b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37` | 以 `requestUrl({url})` 取得分享页 HTML，再提取内容 | 该入口没有 Cookie 配置、会话注入或身份探针，不是 Cookie 登录参考。[分享页读取](https://github.com/bnchiang96/xiaohongshu-importer/blob/b1d3e3b4b4f917c06a8a627cd4c0bd24cf45ce37/main.ts#L120-L131) |
| [xhs_web_crawler 原审查](../projects/xhs-web-crawler/review.md)，`8a7d1b6ec90d9c3d25f3d731cd83a15f8ab08c50` | 在已打开页面点击卡片并尝试配合 HAR 捕获；manifest 只有 activeTab/scripting | 复用当前页面会话，没有独立 Cookie 导入、交互登录管理或账号核验。[manifest](https://github.com/leafiy/xhs_web_crawler/blob/8a7d1b6ec90d9c3d25f3d731cd83a15f8ab08c50/chrome_extension/manifest.json)、[页面流程](https://github.com/leafiy/xhs_web_crawler/blob/8a7d1b6ec90d9c3d25f3d731cd83a15f8ab08c50/chrome_extension/content.js#L77-L124) |

这四个项目与上文四个浏览器项目、六个 HTTP/provider 项目合计覆盖现有 14 个外部参考项目。两份客户端逆向仍是 Core 形成过程的历史证据；本轮没有重新逆向客户端二进制。

## 6. 自有 xsec 实验的历史记录（2026-09-09～09-10）

本节依据 2026-09-09 工作区脚本、两次脱敏协议身份报告与[实验时间线](../reverse/targets/xhs-xsec-token/timeline.md)。实验的账号、频率和停止条件不自动成为产品政策。

### 6.1 当次协议结果：身份通过，搜索未通过

统一入口默认 `--transport protocol`：读取用户指定的外部完整 Cookie，以 `xhshow==0.2.0` 的固定 `xys` 格式在本地签名，经 `httpx==0.28.1` 请求 `GET https://edith.xiaohongshu.com/api/sns/web/v2/user/me`。不打开浏览器、不扫码、不创建新登录会话；只有服务端明确成功、非 guest、有效用户 ID 和所需的摘要核对通过才接受身份。[协议实现](../reverse/targets/xhs-xsec-token/experiment/scripts/protocol_session.py)、[身份编排](../reverse/targets/xhs-xsec-token/experiment/scripts/protocol_experiment.py)

`test_e` 于 23:18 NZST 返回 HTTP `200` / API `0`，结果 `PROTOCOL_IDENTITY_VERIFIED`，以 `first_observed` 建立身份摘要绑定；没有独立的预期 ID，所以不能声称已完成预期账号比对。`test_d` 于 21:43 NZST 返回 HTTP `200` / API `-100`，分类为 `SESSION_EXPIRED`。各一次请求，无重试；完整 Cookie 的组合有效性不能化约为某个字段单独有效，也不能由不同账号结果推断浏览器失败的唯一原因。

这证明 E 的 Cookie 在该次协议请求中被接受，不证明浏览器会话、续期、搜索/详情、媒体下载或跨账号访问。Cookie 不回写，服务端 `Set-Cookie` 不合并；后续运行必须重新验证并匹配已有协议绑定。规范方法、脱敏报告位置和复现命令见[协议说明](../reverse/targets/xhs-xsec-token/experiment/protocol-method.md)与[手册](../reverse/targets/xhs-xsec-token/experiment/runbook.md)。

2026-09-10 01:30 NZST 的单帖流程已再次取得 `200 / 0` 的身份响应，并匹配既有摘要；随后搜索 POST 返回 HTTP 461，按规则停止，共两次请求、无详情和目标 capture。报告未记录 Cookie 内容指纹，不能由身份相同推断跨运行输入字节完全相同；这也不是续期测试。身份 GET 通过与搜索 POST 受阻必须分别记录，461 的具体原因尚无证据确定。

### 6.2 显式浏览器对照：历史失败与现有实现

以下六步只描述 `--transport browser`，不是 E 成功时走的路线：

1. `login_profile.py` 读取用户选定账号和预期身份摘要，在临时 staging profile 中启动系统 Chrome；保留中性页避免关闭 persistent context 的唯一页面。[登录编排](../reverse/targets/xhs-xsec-token/experiment/scripts/login_profile.py)
2. `seed_cookie_and_validate()` 先清 Cookie、匿名访问主页初始化，再把完整 Cookie header 按精确 host 覆盖到浏览器，随后重新进入主页收集身份响应。它没有导入原浏览器的整个 profile 或 storage state。[会话初始化](../reverse/targets/xhs-xsec-token/experiment/scripts/session.py)
3. `parse_cookie_header()` 从 name/value 字符串重建条目，显式设置目标 URL 和 secure，不能保留原 Cookie 的 domain/path/expiry/httpOnly/SameSite/partition 元数据；可选 User-Agent 从账号输入传入。这与 Cookie 数组或完整 profile 恢复存在真实输入差异，但其是否导致失败尚未验证。[Cookie 转换](../reverse/targets/xhs-xsec-token/experiment/scripts/common.py)、[浏览器参数](../reverse/targets/xhs-xsec-token/experiment/scripts/login_profile.py)
4. 身份证据必须来自受信 HTTPS origin、站点自身发出的带签名 GET/XHR/fetch `/api/sns/web/v2/user/me` JSON 响应；要求成功状态、非 guest 和稳定用户 ID，多条候选不能互相冲突。存在既有绑定或 expected identity 时，摘要必须匹配；首次没有这两项时，需显式 `--bind-identity`，以本次实测身份建立绑定。这一首次绑定不能证明实测身份与未提供的预期 ID 一致。它没有自行生成站点请求签名。[响应校验及身份选择](../reverse/targets/xhs-xsec-token/experiment/scripts/session.py)、[首次绑定入口](../reverse/targets/xhs-xsec-token/experiment/scripts/login_profile.py)
5. 当前实际判断顺序是等待页面 → 硬性限制响应 → 可见二维码/手机登录 → 可见 CAPTCHA/安全挑战 → 身份候选/绑定检查。人工完成 challenge 后要重新加载并取得新身份响应；后台 HTTP 200 challenge 资源本身不再等同于可见阻断。[当前门禁实现](../reverse/targets/xhs-xsec-token/experiment/scripts/session.py)
6. 登录浏览器正常关闭后才提升 staging 并写入绑定；后续采集重新打开 profile 并再次核身份。总控在登录失败时退出，不能继续搜索和捕获。[登录落盘](../reverse/targets/xhs-xsec-token/experiment/scripts/login_profile.py)、[采集复核](../reverse/targets/xhs-xsec-token/experiment/scripts/capture_visit.py)、[总控](../reverse/targets/xhs-xsec-token/experiment/scripts/run_experiment.py)

**历史结果应怎样读。** 2026-09-03 时间线已经记录并修复了直接 `context.request` 绕过站点签名链、域 Cookie 未覆盖 host-only Cookie、尾响应覆盖有效身份、后台资源误判、总超时和唯一初始页关闭等脚本问题。修复后的受控结果仍是实际可见 CAPTCHA 或二维码登录，未完成身份绑定、搜索或目标详情捕获。此前 HTTP 500 或旧脚本误判不能作为当前 Cookie 已过期的证据；现成登录浏览器中搜索重发现的成功也不能计入 Cookie 注入登录成功。[逐次实验记录](../reverse/targets/xhs-xsec-token/timeline.md)、[较早的搜索重发现研究](xsec-link-structure.md)

初次源码审查另发现 dry-run 读取了账号配置却输出 “Cookie not loaded” 的提示问题；协议路线实现时已修正为“已读本地账号配置、未注入 Cookie、未请求平台”。dry-run 仍不能当成“不读取凭据”的静态检查。[配置读取](../reverse/targets/xhs-xsec-token/experiment/scripts/common.py)、[已修正分支](../reverse/targets/xhs-xsec-token/experiment/scripts/login_profile.py)

## 7. 初次审查提出的结论与验证建议

**优先把“用户所选账号的可用会话”做成可证明的结果，再获取一篇主号清单的详情和媒体。** Cookie 材料解析、会话被平台接受、账号与用户选择一致、目标帖子可访问，是独立结果。上文源码最有帮助的部分分别是：xiaohongshu-cli 的 HTTP 身份探针与错误分类、MediaCrawler 的最小注入流程、xiaohongshu-mcp 的会话恢复生命周期、XHS_ALL_IN_ONE 的账号选择与 Cookie 版本管理。参考项目中的弱判据不宜用来降低自有验收要求。

**当时建议（2026-09-10）：** 单帖链已在搜索 HTTP 461 处停止，暂停在线请求，先复核既有脱敏结果和固定源码；不能自动换账号、签名、端点或浏览器继续。尚未取得目标访问材料，媒体和 Core 接入仍在其后。`x-s` 等请求签名与 `xsec_token` 不同，后者的生成、下发和使用机制见[研究顺序](../reverse/targets/xhs-xsec-token/experiment/protocol-method.md#登录成功后的-token-研究顺序)。后续实验范围以该协议说明为准，当前工作顺序见[路线图](../../docs/design/roadmap.md)，本节不重复维护最新状态。

以下保留**初次源码审查提出的比较设计**，不是当前强制执行顺序，也不是已确认根因。第 5 项已有 E 的单次正面结果；不要求回到浏览器路线后才继续协议单帖验证。其他变量、持久化与完整导出仍需分别验证。

| 验证步骤 | 保持或比较什么 | 应取得的脱敏证据 |
|---|---|---|
| 1. 明确所选采集账号 | 可为主号、小号或用户指定的其他账号；关系归属仍记录主号 | 所选账号标识；若有预期稳定 ID 则以摘要比对，若为首次实测绑定则明确标注 |
| 2. 核对输入材料 | 确认是完整请求 Cookie、Cookie 数组、还是已登录 profile；区分导出时间与有效性 | 来源/时间/字段名称与元数据完整性；不输出 Cookie 值 |
| 3. 先验现有浏览器链 | 固定账号和运行环境，确认精确 host 的同名 Cookie 覆盖与站点签名身份请求是否发生 | 身份接口 HTTP/JSON/schema/guest/摘要匹配结果；可见登录或 challenge 与后台资源分开记录 |
| 4. 如需比较，单独改变一个变量 | 可比较 header 重建与原生 Cookie 数组的元数据保真，或完整 header 与仅 session 注入；不能同时改材料、浏览器、UA 和判断标准 | 每次差异和结果；没有成功身份则记录具体失败层，不把它统称为 Cookie 过期 |
| 5. HTTP 作为独立候选路线 | 若采用参考的签名 HTTP 方式，应单独定义只读 user/me 验证并锁定账号、输入与实现版本 | API 确认的非游客稳定身份及预期匹配；不推定浏览器已登录，不在挑战出现后自动切路继续 |
| 6. 验证持久化 | 登录成功后关闭并重开所选会话，再核验身份 | 重开后仍为同一账号；保存文件成功不替代复核 |
| 7. 通过登录之后做单帖闭环 | 从主号清单选一帖，由用户选择的账号获取详情/媒体，再交给 Core | 帖子 ID 一致、媒体实际字节、主号关系归属、重复运行和失败恢复结果 |

材料格式差异、HTTP 与页面请求差异、签名入口、用户代理和设备上下文都可以成为后续检验变量，目前没有证据指定哪一个是修复后的失败根因。比较不应放宽身份或可见挑战门禁，也不应把新扫码/手机登录的成功写成纯 Cookie 会话恢复成功。

## 8. 证据边界与增量范围

- 覆盖现有 14 个外部参考项目的登录相关性；重点重新追踪有 Cookie/API/browser 会话路径的项目。通用 Playwright/Playwright MCP 部分结合既有固定源码审查和固定版本官方说明；不宣称重新审查它们整个代码库。
- 第三方源码与来源记录给出的是固定 revision 行为，没有确认这些完整项目在 2026-09-09 的平台上成功登录或下载；自有实验使用锁定签名库取得的单次 GET 成功不能替代它们的验收。
- 初次源码审查没有读取或使用真实凭据，也没有运行登录脚本。后续自有实验从用户授权的外部配置读取 Cookie：9 月 9 日 D、E 各一次身份探针，9 月 10 日 E 的身份复核及搜索尝试。专题仅收录脱敏结论，不保存真实凭据、profile、HAR 或原始响应，也不以运行第三方 checkout 作为文档更新步骤。
- 没有修改外部项目评级；本文建议需结合产品权威与后续受控验证，不替代当前路线图。

## 9. 2026-09-12：已验证协议方法能否迁移

分类：**静态兼容性推断**；沿用 §4.2、§5 的固定版本，未运行第三方或新增平台请求。

ReaJason/xhs 与自有方法同属 Cookie + 签名 HTTP 架构，`get_self_info2()` 使用同一身份端点；但其 `sign(url, data, a1, web_session)` 与自有 `LocalSigner.headers(method, path, cookies, payload)` 不同。迁移需对齐完整 Cookie、方法与正文、UA/签名平台和返回 headers，并保留非游客、稳定 ID 与绑定核对，不能直接替换。[签名入口](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/core.py#L135-L149)、[身份端点](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/core.py#L342-L344)、[自有实现](../reverse/targets/xhs-xsec-token/experiment/scripts/protocol_session.py)

其详情仍另收 `xsec_token/xsec_source`。自有 F 于 9 月 11 日两次身份通过，搜索仍为 HTTP 461；这既未验证第三方客户端，也未证明详情可访问。[详情参数](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/core.py#L206-L222)、[实测边界](../reverse/targets/xhs-xsec-token/experiment/protocol-method.md#已验证的登录方式与结果)

leafiy/xhs_web_crawler 要求先在 Chrome 登录，再操作当前页面；浏览器身份与 Cookie 恢复需单独验收，不能沿用协议成功结论。[上游使用流程](https://github.com/leafiy/xhs_web_crawler#使用说明)、[固定版本审查](../projects/xhs-web-crawler/review.md)
