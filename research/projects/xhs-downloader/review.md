# XHS-Downloader 专项源码审查

GitHub：[JoeanAmier/XHS-Downloader](https://github.com/JoeanAmier/XHS-Downloader)

> 状态：**研究证据**。本文只对记录的固定 revision 和审查范围负责；评级、排除项、历史实施阶段边界和账号限制不自动成为当前产品决策。

## 2026-09-14 实测补充：完整链接、不使用 Cookie，下载成功

**仅凭包含有效 `xsec_token` 和 `xsec_source=pc_feed` 的完整帖子链接，成功取得详情并下载图片；本次不需要 Cookie。** 样本仍为帖子 `6a9e62d2000000002902c012`。网页和媒体请求均已检查没有 `Cookie` 或 `Authorization` 请求头，没有读取账号配置或启动浏览器，也没有使用响应写入的 Cookie。

| 环节 | 本次结果 |
| --- | --- |
| 网页与帖子详情 | 一次 GET 返回 HTTP 200；固定版本 `Converter` 成功解析 HTML，返回帖子 ID 与目标一致，取得标题、正文及 1 张图片地址。 |
| 图片下载 | 固定版本 `Image` 生成 JPEG 地址，`Download` 完成一次媒体 GET；HTTP 206，完整的 `bytes=0-` 响应，不是接续旧文件。 |
| 文件验证 | 保存 1 张 JPEG，1179 × 1548，97,041 字节；响应长度和 Content-Range 总长度与文件一致，传输与落盘 SHA-256 相同，Pillow 校验及完整解码通过。 |
| 保存结果 | `note.md`、`details.json` 和图片已保存；结果为 `COMPLETE_COOKIE_FREE_LINK_DOWNLOAD`。 |

测试时间为 2026-09-14 15:28–15:34 NZST。使用固定 revision `56c912e0df7920ad0fbf5cd9d911628587b9c7e6` 的真实解析、字段提取和下载组件，由隔离调用器提供无 Cookie 的 HTTP 客户端；未运行完整 CLI，也未读取原有 `Volume`。共请求网页和图片各一次，启用 TLS 验证，关闭代理、自动重试和自动重定向。该样本是单图帖子，本轮没有视频下载测试。

本次证明：**这个完整链接可以在不提供 Cookie 的情况下完成详情与图片下载。** 与下方“带 Cookie、无 token 链接失败”的记录一起保留。

产物和脱敏报告位于被 Git 忽略的 `research/reverse/targets/xhs-xsec-token/experiment/data/xhs-downloader-runs/anonymous_20260914T152828_full_link/`；报告为 `report.json`，图片为 `media/6a9e62d2000000002902c012_1.jpeg`。本文不记录 token 值或完整访问链接。

## 2026-09-14 实测补充：小号 Cookie + 无 token 链接

**这次小号身份核验通过，但第一条无 `xsec_token` 链接没有取得帖子详情。** 测试对象是此前批准的公开实验帖“没人跟我说短信换背景图双方都能看见啊”，帖子 ID 为 `6a9e62d2000000002902c012`；使用本地登记为 G（`test_g`）的“小号”Cookie。测试时间为 2026-09-14 15:02–15:06 NZST。

| 环节 | 本次结果 |
| --- | --- |
| 身份验证 | `GET /api/sns/web/v2/user/me` 返回 HTTP 200、业务码 0；非游客身份成立，账号摘要与已有绑定一致。 |
| 无 token 的 `/explore/` 链接 | 请求 `https://www.xiaohongshu.com/explore/6a9e62d2000000002902c012`，返回 HTTP 302；跳转地址是同站 `/404/…` 错误页，带 `error_code=300031`。没有跟随跳转，没有取得帖子详情。 |
| 无 token 的 `/discovery/item/` 链接 | 第一条已指向错误页，因此停止后续请求，这条链接未测试。 |
| 详情解析与媒体下载 | 未进入真实帖子解析或媒体下载，下载文件数为 0。 |

本次采用**受控 HTTP 请求 + 固定版本解析器的实验调用方式**，不是原版 CLI 的完整运行。沿用固定 revision `56c912e0df7920ad0fbf5cd9d911628587b9c7e6` 的网页请求头和 `Converter`；实际联网前，原版解析器的两个合成样本检查，以及 HTTP 风险状态、重定向、缺少详情状态的三个离线检查通过。在线请求启用 TLS 验证、关闭环境代理、自动重试和自动重定向；Cookie 仅在内存中传递，不合并响应的 `Set-Cookie`。身份请求和网页请求各一次，没有搜索，也没有复用历史 token。由于网页请求在 HTTP 302 处停止，解析器尚未处理这篇帖子的真实 HTML。

**可得出的结论：在这次账号、时间和请求条件下，该帖的无 token `/explore/` 链接没有成功。** 不能据此推断 Cookie 已失效、帖子已被删除，或所有帖子都必须携带 `xsec_token`；本轮未测试另一种链接形式，也未运行原版 CLI 的完整流程。后文的固定版本静态审查结论继续保留。

脱敏报告位于被 Git 忽略的实验目录：身份报告 `research/reverse/targets/xhs-xsec-token/experiment/data/protocol-runs/test_g_20260914T150206_daa87cc1.json`，网页报告 `research/reverse/targets/xhs-xsec-token/experiment/data/xhs-downloader-runs/test_g_20260914T150625_no_token/report.json`。本次记录不包含 Cookie、用户 ID、完整错误页跳转地址或响应正文。

## 先读这里：身份验证与帖子详情获取

补充日期：2026-09-12。以下依据本文固定版本 `56c912e0df7920ad0fbf5cd9d911628587b9c7e6` 的公开源码作静态分析，未实测当前小红书网页兼容性。

### 身份验证方式：可选地传入网页 Cookie，没有独立的账号核验

**它主要接受你手动提供的 Cookie，也允许不填。** Cookie 可以理解为网页请求携带的会话材料。README 教程让用户在浏览器中复制 Cookie，并明确“登录账号”可以跳过；所以填写 Cookie 并不必然代表某个已登录账号。程序把传入值交给 Python 的 HTTP 客户端，供后续请求使用。[Cookie 教程](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/README.md#L513-L524)、[客户端接收 Cookie](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/module/manager.py#L100-L114)

- **不会自动确认“现在登录的是谁”。** 设置界面的“参数已设置”只检查 Cookie 是否非空；详情主流程检查 HTTP 请求是否成功，再尝试解析网页，没有先请求当前用户身份来核对账号、判断登录是否有效。[设置判断](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/TUI/setting.py#L225-L228)、[请求处理](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/application/request.py#L26-L79)
- **“自动从浏览器读取 Cookie”在这个版本已停用。** 主程序的调用被注释，README 也标明失效；不能把残留辅助代码当成仍可用的登录方式。[主程序接线](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/application/app.py#L144-L160)、[功能说明](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/README.md#L131-L135)
- **详情主链由 Python 准备普通网页请求头和 Cookie。** 这条链没有调用额外的 `X-S`／`X-T` 接口签名器，也不需要浏览器替它生成签名。仓库另有未接入主链的 `UserPosted` 签名骨架，其 `run()` 尚未实现。[网页请求头](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/module/static.py#L24-L29)、[主链组件](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/application/app.py#L178-L198)、[签名骨架](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/application/user_posted.py#L37-L71)

### 帖子详情获取方式：主程序下载网页 HTML，另有浏览器用户脚本辅助

**Python 主流程是“给链接 → 下载网页源文件 → 提取其中已有的帖子数据”。**

**下载输入要求：提供完整且包含有效 `xsec_token` 的帖子链接。**

1. 用户传入一条或多条链接；短链接先通过网络请求展开。因此处理范围首先由输入链接决定。[链接处理](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/application/app.py#L363-L395)
2. Python 直接请求该网页，取得 HTML，从 `window.__INITIAL_STATE__` 中提取帖子对象。可以把它理解为“网页源文件中附带的一包帖子数据”；这里没有启动浏览器执行页面 JavaScript，也没有调用帖子详情 JSON 接口。[取得 HTML](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/application/app.py#L397-L426)、[提取页面数据](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/expansion/converter.py#L9-L45)
3. 整理标题、正文、作者、互动数量等，再解析图片／视频地址，按设置下载媒体。这部分可作为 Python 脚本在后台运行，无需保持浏览器窗口，也不需要逐条模拟点击或导出 HAR。[详情字段](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/application/explore.py#L15-L72)、[详情与下载编排](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/application/app.py#L441-L517)

**配套用户脚本则需要打开浏览器页面，有两种用途：**

- **收集待处理链接。** 从当前发布、收藏、点赞、专辑、推荐或搜索页面中读取已加载的帖子列表，可自动滚动，也可勾选部分帖子；链接中的 `xsec_token` 来自页面数据。它收集的是页面实际加载出的范围，不能据此保证收齐全部帖子。[菜单选择范围](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/static/XHS-Downloader.js#L2279-L2337)、[页面数据与链接](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/static/XHS-Downloader.js#L809-L917)、[滚动停止规则](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/static/XHS-Downloader.js#L769-L807)
- **处理当前已打开的帖子。** 用户点击脚本菜单后，它直接读取该页的帖子对象，可在浏览器侧下载媒体；启用脚本服务时，也能通过 WebSocket 把整包数据传给 Python 下载。这条路径沿用当前网页会话，Python 不再重新下载该帖 HTML，同样不经过 HAR。[读取与发送页面详情](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/static/XHS-Downloader.js#L524-L600)、[菜单入口](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/static/XHS-Downloader.js#L2287-L2301)、[Python 接收处理](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/application/app.py#L519-L547)

主链还有一个具体限制：PC 网页解析取详情映射中的最后一项，没有核对返回的帖子 ID 是否等于目标 ID，因此解析出数据也不等于已经确认取对了帖子。[映射取值](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/expansion/converter.py#L12-L17)、[取最后一项的实现](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/expansion/converter.py#L47-L66)

状态：专项静态审查完成，独立复审通过
审查日期：2026-08-13
固定 revision：[`56c912e0df7920ad0fbf5cd9d911628587b9c7e6`](https://github.com/JoeanAmier/XHS-Downloader/tree/56c912e0df7920ad0fbf5cd9d911628587b9c7e6)

> 本报告只说明固定 revision 的静态实现和工程参考价值，不证明当前在线兼容性、运行可靠性、账号安全或许可证法律效力。

## 1. 范围、来源与方法

- 来源、工作树状态和排除目录见 [`provenance.json`](provenance.json)，中断恢复状态见 [`checkpoint.json`](checkpoint.json)。
- 审查输入仅限固定 commit 的 106 个 tracked paths；实际按相关性阅读 README、许可证、配置、workflow 和文本源码。未读取或清理本地保留的 `.venv`、`Volume`、缓存和 `.DS_Store`。
- 本轮不安装依赖、不构建、不执行项目或测试、不启动浏览器、不访问小红书，也不读取任何真实 Cookie、token、profile 或个人数据。
- 证据分为：`[README 声明]`、`[源码证据]`、`[配置证据]`、`[推断]`、`[未知]`。动态在线有效性全部保持未知。
- 当前环境没有可用的 Semgrep、Bandit、OSV-Scanner、Trivy、Syft 或 Gitleaks；因此采用 `git ls-files`、`git show`、`git grep` 和人工数据流审查。没有把“未运行扫描器”写成“没有漏洞”。

## 2. 结论摘要

XHS-Downloader 最有参考价值的部分是详情字段转换、图文与 Live Photo 的同序号双资产表示、媒体候选选择、临时文件两阶段落盘，以及“本次下载任务全部成功后才写 note ID”的保守提交顺序。它不是 Rednote Sync 可直接采用的同步核心：没有服务端分页 cursor、逐资产持久状态、最终长度或哈希校验、账号与 scope 隔离，也会在可选数据记录中持久化原始媒体 URL。

当前建议保持 **A：值得作为历史实施 Stage 4 Adapter、媒体资产模型和恢复语义的专项参考，但只借鉴行为或独立重写，不直接嵌入源码**。主要原因是：API/MCP 服务模式启动后默认监听所有接口且没有显式应用层鉴权、Cookie 和动态 URL 缺少统一 secret 边界、请求客户端关闭 TLS 验证、供应链发布路径没有真正消费完整 lock，以及 GPLv3 文件与 README 附加措辞存在未解决的不一致。

### 核心结论：
- 维持 A 级专项参考，但仅建议借鉴行为或独立实现，不直接复用源码。
- 值得参考详情解析分层、Live Photo 同序号双资产、媒体选择策略和临时文件两阶段落盘。
- 发现合法计数 0 可能被错误转换为 "-1"。
- 只下载部分图片成功后也可能记录整条笔记完成，证明必须使用逐资产状态。
- Range 续传缺少 206/Content-Range、长度和哈希闭环。
- 服务模式存在全接口监听、无显式鉴权、关闭 TLS 验证等风险；可选 WebSocket 路径还存在条件性 blind SSRF。
- GPLv3 文件与 README 附加措辞存在未解决的不一致，当前排除源码复制或链接。
- 发布链未真正使用完整 lock，Action 未固定 SHA，缺少 SBOM/provenance 等门禁。

## 3. 架构与数据流

### 3.1 主处理链

`[源码证据]` 固定版本同时提供 TUI、CLI、Python、HTTP API 和 MCP 入口；`XHS` 对象聚合请求、HTML 转换、详情提取、媒体解析、下载与三类 SQLite recorder。单作品链路是“输入链接 → 请求 HTML → 提取 `window.__INITIAL_STATE__` → 适配 PC/移动端 payload → 规范化详情 → 解析媒体 → 可选下载和记录”。[main.py L12-L59](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/main.py#L12-L59) [app.py L121-L198](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/application/app.py#L121-L198) [app.py L397-L517](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/application/app.py#L397-L517)

`[采用判断]` “原始载荷获取 → variant 适配 → 规范化 → 媒体选择 → 写入”是可借鉴的分层，但候选实现仍共享一个本地化 `dict` 和全局 `Manager`，不能直接充当版本化 Provider/Adapter 契约。

### 3.2 发现与详情是两条链

- `[README 声明]` 项目把主页发布、收藏、点赞、专辑、推荐和搜索结果的链接发现交给用户脚本，Python 程序主要负责详情与媒体。[README L20-L56](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/README.md#L20-L56)
- `[源码证据]` 已接线的 Python 核心从输入文本识别作品、用户和短链接，短链接通过请求跟随跳转展开；它没有收藏/点赞的服务端分页接口。[app.py L98-L112](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/application/app.py#L98-L112) [app.py L363-L395](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/application/app.py#L363-L395)
- `[源码证据]` 仓库另有 `UserPosted` 签名请求骨架，能接收 URL、params 和 Cookie 并生成请求头，但 `run()` 仍是省略号，全仓没有导入/实例化它，也没有 cursor/`hasMore` 契约；它不是当前可用的发现能力。[user_posted.py L1-L71](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/application/user_posted.py#L1-L71)
- `[源码证据]` 用户脚本读取页面 `__INITIAL_STATE__` 的 user、board、feed 和 search 分支，将 note ID 与页面提供的 `xsecToken` 配对生成链接；发布、收藏、点赞分别映射到不同页面数组。[XHS-Downloader.js L809-L917](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/static/XHS-Downloader.js#L809-L917)
- `[未知]` 自动滚动和页面当前已加载数组不能证明完整枚举、稳定排序或账号安全；这些事实仍需历史实施 Stage 4 在明确授权下低频验证。

## 4. 发现、详情与媒体能力

### 4.1 详情载荷与字段

- `[源码证据]` 转换器从 script 文本反向寻找 `window.__INITIAL_STATE__`，清理控制字符后以 `yaml.safe_load` 解析，并尝试移动端 `noteData.data.noteData` 与 PC `note.noteDetailMap.[-1].note` 两条路径。[converter.py L9-L45](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/expansion/converter.py#L9-L45)
- `[风险]` PC 路径的 `[-1]` 实际取映射最后一个 value，依赖字典顺序，没有交叉验证返回 note ID 是否等于请求 ID。[converter.py L47-L67](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/expansion/converter.py#L47-L67)
- `[源码证据]` 详情输出覆盖 note ID、标题、描述、类型、标签、发布时间、更新时间、互动计数、作者 ID/昵称及公开链接。[explore.py L15-L82](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/application/explore.py#L15-L82)
- `[风险]` `safe_extract` 把所有 falsy 值当成缺失，因此合法计数 `0` 也会变成字符串 `-1`；标签被空格拼接，时间按本机时区转换为无 offset 文本，类型值受运行语言影响。这些都不能成为 Rednote Sync canonical Schema。[namespace.py L26-L55](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/expansion/namespace.py#L26-L55) [explore.py L9-L62](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/application/explore.py#L9-L62)
- `[源码证据]` `Explore` 本来生成无 query 的公开链接，但后续链路用原始输入 URL 覆盖；若输入含访问材料，它会进入返回数据，并在 `record_data=true` 时进入 SQLite。[explore.py L39-L43](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/application/explore.py#L39-L43) [app.py L218-L265](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/application/app.py#L218-L265) [recorder.py L81-L143](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/module/recorder.py#L81-L143)

### 4.2 图片、视频与 Live Photo

- `[源码证据]` 图片与 Live Photo motion URL 是两个按 `imageList` 顺序生成的并行列表；下载时使用 `zip` 配对，静态图和 motion 文件共用 `<作品名>_<序号>` 基名，以扩展名区分。[image.py L9-L66](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/application/image.py#L9-L66) [download.py L140-L174](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/application/download.py#L140-L174)
- `[风险]` 并行数组没有显式 asset ID、kind、来源、状态或校验信息。下载层依靠位置和 `zip` 配对且不验证长度；当前 `Image` producer 通常为同一 `imageList` 生成等长列表，但其他调用或未来漂移产生不等长输入时会静默截断。图片回退是“整组 `urlDefault` 均空才使用 `url`”，不是逐项回退，motion 只取 H.264 第一项。[image.py L9-L66](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/application/image.py#L9-L66) [download.py L140-L174](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/application/download.py#L140-L174)
- `[源码证据]` 视频优先使用 `originVideoKey` 构造地址，否则合并 H.264/H.265 rendition，按 resolution/bitrate/size 选最大项，并优先取其第一个 backup URL。[video.py L7-L53](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/application/video.py#L7-L53)
- `[采用判断]` Rednote Sync 应保留 `kind + ordinal` 的显式资产对象和所有候选 rendition，记录选择原因；signed URL 只进入内存 secret envelope，canonical 数据只保留安全来源和稳定身份。

### 4.3 SQLite 与目录输出

- `[源码证据]` `ExploreData.db` 保存详情，`ExploreID.db` 保存已下载 note ID，`MappingData.db` 保存作者映射；详情表以 note ID 为主键，其余字段均为 TEXT，并以 `REPLACE INTO` 覆盖旧行。[recorder.py L13-L28](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/module/recorder.py#L13-L28) [recorder.py L81-L180](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/module/recorder.py#L81-L180)
- `[源码证据]` 媒体 URL 以空格拼接，缺失 motion 以字符串 `NaN` 表示。[app.py L256-L265](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/application/app.py#L256-L265)
- `[风险]` 目录和文件名依赖昵称、标题和本地化时间；作者昵称变化还会触发重命名。这些是展示名称，不应充当 Rednote Sync 稳定内部身份。[app.py L577-L612](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/application/app.py#L577-L612) [mapping.py L28-L69](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/module/mapping.py#L28-L69)

## 5. 状态、checkpoint、幂等与失败恢复

### 5.1 已确认行为

- `[源码证据]` 下载器为每项资产创建临时文件，按临时文件当前长度发送 `Range`，并以追加模式写入；完成后识别文件签名并移动到最终路径。[download.py L196-L246](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/application/download.py#L196-L246) [download.py L304-L337](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/application/download.py#L304-L337)
- `[源码证据]` 收到 `416` 时删除临时文件并返回失败；外层 retry 装饰器在配置的重试次数内再次调用，下一次因临时文件不存在而从 `bytes=0-` 开始。[download.py L219-L267](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/application/download.py#L219-L267) [tools.py L13-L22](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/module/tools.py#L13-L22)
- `[源码证据]` 仅当本次生成的下载任务非空且全部返回成功时，才把 note ID 写入 `ExploreID.db`；部分失败不会写入成功记录。[app.py L218-L254](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/application/app.py#L218-L254) [recorder.py L13-L49](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/module/recorder.py#L13-L49)
- `[源码证据]` 已存在的最终文件只按路径存在性跳过；图片会检查多个可能扩展名，没有对长度、哈希、来源版本或内容签名重新验证。[download.py L124-L194](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/application/download.py#L124-L194)

### 5.2 缺口与对 Rednote Sync 的影响

- `[源码证据]` 非零 Range 遇到服务端忽略 Range 并返回 `200` 时仍会追加全量响应；代码也没有在移动前核对最终长度或内容哈希。因此它是可借鉴的临时文件机制，不是完整性闭环。[download.py L205-L246](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/application/download.py#L205-L246)
- `[源码证据]` `ExploreID.db` 只有 note ID 主键，不能表达媒体 ordinal、资产类型、尝试次数、失败原因、部分完成或来源版本。[recorder.py L13-L58](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/module/recorder.py#L13-L58)
- `[tracked-wide 静态检索]` 对 tracked Python/JavaScript 检索 `cursor`、`hasMore`、`has_more`、`nextCursor` 和 `UserPosted`：已接线核心只处理传入链接和页面数组；唯一服务端请求骨架 `UserPosted` 未接线、`run()` 未实现，也不含 cursor/`hasMore` 状态。因此当前没有可用的服务端分页契约，note ID 只能用于作品级 skip，不能替代 Rednote Sync 的 `ServerCursor`。[app.py L363-L395](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/application/app.py#L363-L395) [user_posted.py L1-L71](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/application/user_posted.py#L1-L71)
- `[源码证据]` 若调用方只选择部分图片序号，本次子集全部成功后仍会记录整个 note ID，后续可直接跳过整条笔记；这会遗漏未选择或后来新增的资产。[download.py L140-L174](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/application/download.py#L140-L174) [app.py L231-L249](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/application/app.py#L231-L249)
- `[采用边界]` Rednote Sync 只借鉴“临时文件、失败不写完成标记、Live Photo 同 ordinal”行为；继续使用自身逐资产 task/failure、内容哈希、完整 scope、cursor provenance 和 durable partial 状态。

## 6. 会话、凭据、网络与文件写入

### 6.1 主要安全发现

| ID | 严重性 | 静态结论 |
|---|---|---|
| SEC-01 | 高（需显式启动服务模式） | API/MCP 以服务模式启动时默认绑定 `0.0.0.0`，审查范围内未见应用层鉴权，并能触发平台访问和本地下载 |
| SEC-02 | 高（需开启脚本服务；子风险另有条件） | WebSocket 服务默认监听所有接口且无显式鉴权或消息 Schema；任意 note 可在视频 fallback 路径提供未做 host allowlist 的媒体 URL，经自动重定向驱动条件性 blind SSRF 与本地落盘；Live Photo 任意 URL 还需启用 motion 下载，作者目录逃逸还需启用作者归档 |
| SEC-03 | 高 | 携带 Cookie 的页面请求客户端关闭 TLS 证书验证；独立媒体下载客户端也关闭验证 |
| SEC-04 | 中 | Cookie 明文配置、CLI 参数、API 对本次 Cookie/proxy 参数的回显，以及含 query URL 日志没有统一 secret 边界 |
| SEC-05 | 中 | 重试不区分认证、429、验证码或安全限制，媒体重试没有状态感知退避 |
| SEC-06 | 中 | 仅有并发 4 和请求超时等局部限制；未见入口消息/请求体、单文件字节、资产/任务总量或磁盘配额，也缺严格 Range 响应和最终完整性校验 |
| SEC-07 | 中 | 用户脚本的 update/download URL 指向可变 master，远端 JSZip URL没有加密完整性固定；启用自定义 WebSocket 后会把完整 note JSON 发往可配置端点 |
| SEC-08 | 低（能力元数据） | 两个 MCP 工具均正确标为非只读，但同时声明 non-destructive 和 idempotent；在数据记录/作者归档等配置下，详情工具也可能覆盖数据或触发映射/重命名，下载工具还会创建、移动文件 |

### 6.2 直接证据与采用边界

- `[源码证据]` API 与 MCP 需要显式选择服务模式；启动后默认绑定所有接口。已审查的 API/MCP 构造和路由中没有 token、身份依赖或认证 middleware；FastMCP 依赖是否另有默认控制保持未知。API 输入允许 Cookie、proxy 和 download，响应又返回本次请求的整个参数对象。[main.py L17-L42](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/main.py#L17-L42) [app.py L696-L767](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/application/app.py#L696-L767) [app.py L769-L928](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/application/app.py#L769-L928) [model.py L4-L16](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/module/model.py#L4-L16)
- `[源码证据]` 可选脚本服务默认关闭，但开启后监听 `0.0.0.0:5558`，对消息直接 `json.loads` 并展开进入下载链，没有显式消息认证或 Schema 校验。[settings.py L10-L37](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/module/settings.py#L10-L37) [script.py L10-L34](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/module/script.py#L10-L34)
- `[源码证据/推断]` 无鉴权 WebSocket 消息会进入 `deal_script_tasks`；视频 fallback 的 `backupUrls/masterUrl` 和可选 Live Photo 的 `masterUrl` 未做 host allowlist，并由启用 `follow_redirects` 的下载 client 请求，未见逐跳校验。这构成启用脚本服务后的条件性 blind SSRF 与本地写入风险；motion 分支还需 `live_download=true`。[script.py L22-L34](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/module/script.py#L22-L34) [app.py L519-L547](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/application/app.py#L519-L547) [video.py L31-L53](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/application/video.py#L31-L53) [image.py L57-L66](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/application/image.py#L57-L66) [manager.py L115-L124](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/module/manager.py#L115-L124) [download.py L196-L246](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/application/download.py#L196-L246)
- `[推断]` 当脚本服务和作者归档都开启时，消息中的 `user.userId` 未经过与昵称相同的清洗，却直接进入 `Path.joinpath`；恶意绝对路径或 `..` 可能逃离输出根。该结论没有运行验证，因此保留条件限定。[explore.py L64-L72](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/application/explore.py#L64-L72) [app.py L231-L240](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/application/app.py#L231-L240) [download.py L114-L122](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/application/download.py#L114-L122)
- `[源码证据]` 携带 Cookie 的页面请求 client 与独立媒体下载 client 都设置 `verify=False`；逐请求代理路径同样关闭校验。[manager.py L100-L124](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/module/manager.py#L100-L124) [request.py L93-L136](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/application/request.py#L93-L136)
- `[源码证据]` Cookie 可明文写入 `settings.json`、作为 CLI 参数输入，并与 proxy 一起由 API 回显本次请求传入值；异常日志包含完整输入 URL，而示例 URL 包含 `xsec_token`。若 proxy URL 自带凭据也属于 secret。[settings.py L62-L91](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/module/settings.py#L62-L91) [CLI main.py L246-L257](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/CLI/main.py#L246-L257) [request.py L63-L69](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/application/request.py#L63-L69) [README L65-L70](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/README.md#L65-L70)
- `[源码证据]` 通用重试器对所有 falsy 结果同样重试，页面请求又把全部 `HTTPError` 归并为空字符串；未见 401/403/429/验证码/安全限制的专门停止条件。[tools.py L13-L22](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/module/tools.py#L13-L22) [request.py L26-L69](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/application/request.py#L26-L69)
- `[源码证据]` 资源控制只有固定并发 `4` 和默认请求超时等局部限制；仓库未显式设置 HTTP body/WebSocket message、单文件字节、单 note 资产数、任务总数或磁盘预算。依赖默认上限保持未知。[static.py L65-L69](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/module/static.py#L65-L69) [settings.py L20-L24](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/module/settings.py#L20-L24)
- `[源码证据]` 用户脚本的 `updateURL`/`downloadURL` 指向可变 master，`@require` 固定 JSZip 3.9.1 URL但没有加密完整性摘要；启用自定义 WebSocket 后，脚本把完整 note JSON 发往可配置端点，默认端点是 loopback。[XHS-Downloader.js L1-L35](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/static/XHS-Downloader.js#L1-L35) [XHS-Downloader.js L312-L323](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/static/XHS-Downloader.js#L312-L323) [XHS-Downloader.js L524-L595](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/static/XHS-Downloader.js#L524-L595)
- `[源码证据]` 两个 MCP 工具都标记 `readOnlyHint:false`，但还声明 `destructiveHint:false`、`idempotentHint:true`。即使详情工具不下载，`record_data` 或 `author_archive` 开启时也可能 `REPLACE` 数据、更新映射并重命名文件；下载工具还会创建和移动文件，因此这些提示不是所有配置下都成立。[app.py L428-L469](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/application/app.py#L428-L469) [app.py L807-L895](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/application/app.py#L807-L895) [recorder.py L121-L131](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/module/recorder.py#L121-L131) [mapping.py L28-L69](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/module/mapping.py#L28-L69)
- `[源码证据]` 当前 revision 仍保留浏览器 Cookie 读取模块，但其导出、APP 和 CLI 调用都已注释；README 也声明该功能失效。因此不能写成“当前程序会扫描浏览器 profile”。[browser.py L1-L82](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/expansion/browser.py#L1-L82) [app.py L683-L694](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/application/app.py#L683-L694) [README L131-L135](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/README.md#L131-L135)
- `[tracked-wide 静态检索]` 运行时路径未发现 Python `eval`/`exec`、pickle 或 shell 调用；本地化维护工具 `locale/po_to_mo.py` 使用 `subprocess.run(..., shell=True)`，命令来自扫描到的本地 `.po` 路径且未被应用入口引用。它作为开发脚本风险记录，不视为当前远程执行链。[po_to_mo.py L1-L24](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/locale/po_to_mo.py#L1-L24)
- `[采用边界]` 历史实施 Stage 4 若参考其能力拆分，服务必须默认 loopback/IPC并强制认证；发现、平台读取和本地写为独立 capability；TLS 不可关闭；每次重定向验证媒体 host；输出路径做 resolved-root containment；Cookie、signed URL 和 token 不进入 CLI、配置、响应、日志或 trace。

## 7. 依赖、CI、测试信号与许可证

### 7.1 依赖与构建入口

- `[配置证据]` `pyproject.toml` 声明 Python 3.12+ 和 14 个生产依赖；`uv.lock` 固定这些声明所解析出的生产/开发依赖图、版本及分发文件 SHA-256。本地静态计数为 111 个 package record。[pyproject.toml L9-L26](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/pyproject.toml#L9-L26) [uv.lock L2201-L2254](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/uv.lock#L2201-L2254)
- `[配置证据]` `requirements.txt` 有 13 个顶层条目，缺少 `pyproject.toml` 声明的 `curl-cffi`；`fastmcp` 仍是范围约束，且整个文件没有分发 hash。tracked Python 源码中也没有检索到 `curl_cffi` import，因此它可能是已漂移的声明或动态依赖，静态审查不能裁定。[requirements.txt L1-L28](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/requirements.txt#L1-L28) [pyproject.toml L11-L26](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/pyproject.toml#L11-L26)
- `[配置证据]` tracked 源码直接 import `rich` 和 `pydantic`，但二者未列为直接依赖，只会随当前传递图出现；休眠的浏览器与签名请求模块还 import 未被 manifest/lock 声明的 `rookiepy`、`xhshow`。后两模块当前没有从包入口导出或调用，可达性未知。这说明 lock 不能被描述为“完整源码依赖清单”。[app.py L16-L21](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/application/app.py#L16-L21) [browser.py L1-L9](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/expansion/browser.py#L1-L9) [user_posted.py L1-L10](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/source/application/user_posted.py#L1-L10)
- `[配置证据]` Docker 和可执行文件 workflow 使用 `requirements.txt` 而不是完整 lock，故“仓库有 lock”不等于正式制品可复现。[Dockerfile L13-L18](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/Dockerfile#L13-L18) [Release workflow L28-L32](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/.github/workflows/Release_build_executable_program.yml#L28-L32)
- `[未知]` 本轮没有安装或联网 SCA，不能判断依赖 CVE、可达性和传递许可证兼容性。

### 7.2 CI 与发布链

- `[tracked-wide 静态计数]` `git ls-files '.github/workflows/*'` 得到六个 workflow，对其 20 个 `uses:` 计数后确认全部采用可变 tag，没有固定完整 commit SHA；其中部分步骤接触 PAT、registry token 或 write token。[workflow 目录](https://github.com/JoeanAmier/XHS-Downloader/tree/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/.github/workflows) [Delete workflow L13-L20](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/.github/workflows/Delete_untagged_images.yml#L13-L20)
- `[配置证据]` Docker 发布显式关闭 provenance 和 SBOM；可执行文件上传没有 tracked checksum、签名或 attestation 步骤。[Docker workflow L85-L93](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/.github/workflows/Manually_docker_image.yml#L85-L93) [Release workflow L45-L58](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/.github/workflows/Release_build_executable_program.yml#L45-L58)
- `[配置证据]` 两个 Docker workflow 在没有可见 attestation 步骤且关闭 provenance/SBOM 时仍授予 `attestations:write` 和 `id-token:write`；可执行文件 release workflow 授予未见使用的 `discussions:write`；镜像删除 workflow 把 scope 未知的 `PAT_TOKEN` 交给未固定 SHA 的第三方 Action。这些是权限/令牌暴露面，不代表已经被利用。[Manual Docker L17-L26](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/.github/workflows/Manually_docker_image.yml#L17-L26) [Release Docker L7-L16](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/.github/workflows/Release_docker_image.yml#L7-L16) [Executable release L7-L10](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/.github/workflows/Release_build_executable_program.yml#L7-L10)
- `[配置证据]` Dependabot 只覆盖 uv；未覆盖 GitHub Actions 或 Docker。Docker 基础镜像未固定 digest，最终镜像没有切换非 root 用户。[dependabot.yml L1-L15](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/.github/dependabot.yml#L1-L15) [Dockerfile L1-L47](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/Dockerfile#L1-L47)
- `[tracked-wide 静态检索]` 高权限 workflow 没有使用 PR 或 `pull_request_target` 触发；触发面是 release、schedule 和手工执行。固定 revision 没有 tracked tests 路径，workflow 也未执行 test、lint、SCA 或 secret scan；构建成功不能替代质量或安全门。[workflow 目录](https://github.com/JoeanAmier/XHS-Downloader/tree/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/.github/workflows)

### 7.3 许可证与复用边界

- `[许可证证据]` `pyproject.toml` 声明 GPL-3.0，仓库的 `LICENSE` 是 GNU GPL Version 3 正文。[pyproject.toml L8-L10](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/pyproject.toml#L8-L10) [LICENSE L1-L20](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/LICENSE#L1-L20)
- `[README 声明]` README 另称不授予专利许可、未经书面授权不得用于商业宣传/推广或再授权，并可能要求销毁衍生作品；仓库没有单独 exception/additional-terms 文件解释这些措辞与 GPLv3 正文的关系。[README L694-L709](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/README.md#L694-L709)
- `[工程判断]` 这些表述与 GPLv3 标准文本存在明显不一致，但本报告不判断其法律效力。在权利人澄清、版本标识、依赖许可证和集成方式完成专项评估前，不复制、改写或链接其源码；只借鉴行为、接口边界和反例，优先独立实现。
- `[发布合规未知]` Dockerfile 明确复制根 LICENSE，但可执行文件 release workflow 只压缩 `dist/main/*`，没有显式包含根 LICENSE、NOTICE/第三方许可清单或 source-offer 的步骤；未动态检查 ZIP，不能断言最终包是否含相应材料。[Dockerfile L20-L38](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/Dockerfile#L20-L38) [Release workflow L45-L58](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/.github/workflows/Release_build_executable_program.yml#L45-L58)
- `[来源/权利未知]` 仓库没有 NOTICE 或第三方许可 inventory；tracked `static/other/20250619.js` 没有来源/许可证头且未检索到 tracked 引用，userscript 的远端 JSZip 也无内容完整性摘要。这些 artifact 不进入 Rednote Sync 复用范围。[20250619.js](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/static/other/20250619.js) [userscript L1-L35](https://github.com/JoeanAmier/XHS-Downloader/blob/56c912e0df7920ad0fbf5cd9d911628587b9c7e6/static/XHS-Downloader.js#L1-L35)

## 8. 对 Rednote Sync 的参考价值

对照 [`sync-core.md`](../../../projects/docs/sync-core.md)：

| 方面 | 当前判断 | 边界 |
|---|---|---|
| 详情规范化 | 值得借鉴字段覆盖与解析分层 | 必须重新定义版本化 Schema 和运行时校验 |
| Live Photo | 值得借鉴 still/motion 同 ordinal | 仍需逐资产稳定 ID、完整性和 failure 状态 |
| 下载恢复 | 只借鉴临时文件和失败不提交 | 不采用仅存在性 skip、作品级完成记录或无哈希续传 |
| 同步状态 | 不直接采用 | 没有完整 scope、page cursor、水位或 durable partial |
| secret 边界 | 作为反例 | Cookie 和动态 URL不得进入 SQLite、日志、派生输出或 API 回显 |
| API/MCP | 仅作能力面研究 | 未来适配器只允许 loopback、认证和精确只读 allowlist；本地写能力独立授权 |
| 阶段边界 | 不改变历史实施 Stage 3 | 所有网络、浏览器、Cookie 和动态在线事实仍只属于历史实施 Stage 4 |

## 9. 采用分级

| 分类 | 结论 |
|---|---|
| 可直接参考的行为 | raw payload/variant/规范化分层、媒体候选与选择策略分离、still/motion 同 ordinal、临时文件成功后移动、失败不写整条完成记录 |
| 必须独立重写 | 版本化详情 Schema、逐资产状态、Range 与完整性校验、secret envelope、Adapter/Session 边界、错误分类、只读服务面 |
| 仅作风险背景 | 用户脚本页面发现、API/MCP/WebSocket 服务、现有 CI/发布链 |
| 当前排除 | 复制/链接 GPL 源码、作品级单一完成标记、明文 Cookie、关闭 TLS、全接口无鉴权服务、自动更新远端用户脚本 |

**最终建议等级：A（专项参考），复用方式限制为行为借鉴或独立实现。** A 不代表运行可靠、在线兼容、账号安全或许可证可直接集成。

## 10. 未知项

- 固定 commit 对当前在线页面结构、媒体 URL 和 token 的兼容性未验证。
- 没有运行依赖解析或漏洞数据库扫描，依赖漏洞与可达性尚未确认。
- 没有动态验证 API/MCP/WebSocket 的网络暴露或认证行为；当前判断只来自配置和相邻源码。
- FastMCP、uvicorn 和 websockets 的默认请求大小、传输与安全控制没有通过依赖源码或运行环境验证。
- README 附加措辞的法律效力、GPL-3.0-only/or-later 版本选择和全部权利人意图无法由静态仓库确定。
- 未声明的直接/休眠模块依赖、可执行 ZIP 的许可材料、混淆 tracked artifact 的来源与权利状态仍未知。

## 11. 证据索引与独立复审

### 11.1 审查分工

- 架构、详情与媒体：独立领域 Subagent，固定 commit tracked-only。
- 状态、checkpoint、恢复和 `sync-core.md` 映射：主 Agent，固定 commit tracked-only。
- 会话、网络、secret、路径和能力面：独立安全 Subagent，固定 commit tracked-only。
- 依赖、CI、制品和许可证：独立供应链 Subagent，固定 commit tracked-only。

### 11.2 独立复审

- **证据与链接复审：PASS。** 返修后确认 `0 → "-1"`、未接线 `UserPosted`、tracked-wide cursor/CI 结论、Live Photo 长度限定、SQLite/URL 证据和 MCP annotation 语义均准确；固定 commit blob 路径与本地相对链接有效。
- **安全复审：PASS。** SEC-01～08 的适用条件、严重性和 blind SSRF/路径/secret/TLS/资源控制数据流得到确认；建议只包含防护、暂停和隔离，不包含平台规避方案。
- **供应链、许可证与项目适配复审：PASS。** 依赖计数、lock 边界、CI 权限、制品未知项和 GPL/README 分歧均有充分限定；A 级仅表示专项参考，历史实施 Stage 3 继续离线。
- 首轮 reviewer findings 已全部修正并完成末读；无剩余 P0～P3 阻断项。
