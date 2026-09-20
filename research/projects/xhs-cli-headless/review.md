# xhs-cli-headless 专项源码研究

GitHub：[kyalpha313/xhs-cli-headless](https://github.com/kyalpha313/xhs-cli-headless)

> 状态：**研究证据**。结论只适用于下列固定版本和静态研究范围；参考价值不等于产品采用决定。当前产品状态见[路线图](../../../docs/design/roadmap.md)，本地保存与恢复能力见 [Core 契约](../../../projects/docs/sync-core.md)。

## 先读这里：身份验证与帖子详情获取

研究日期：2026-09-13。固定 revision：`ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589`，项目声明版本 `0.8.9`。已克隆源码并静态阅读，没有运行登录、采集或上游测试，没有读取用户实际 Cookie、token、浏览器状态或个人数据。

**可以把它理解成“让脚本直接搜索和读取小红书内容的命令行工具”。** 你提供会话和帖子入口，它用 Python 向服务器请求数据，再把结果交给调用方。默认流程不需要在浏览器里逐篇点击，也不经过 HAR；下载媒体文件、生成本地文档和维护整份清单的导出进度，仍属于外层工作。[命令入口](https://github.com/kyalpha313/xhs-cli-headless/blob/ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589/xhs_cli/commands/reading.py#L64-L118)、[结果输出](https://github.com/kyalpha313/xhs-cli-headless/blob/ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589/xhs_cli/formatter_utils.py#L51-L109)

**此前说的“补全帖子详情”，就是从清单中的简略记录，再取得正文、图片列表等更完整的信息。** 例如，一条清单记录只有 ID、标题和封面，还不能代表已经保存整篇帖子；`read` 负责向服务器要详情，外层导出器再整理和保存返回的数据。这一步能补到哪些字段，仍取决于返回内容和所走的读取路径。

### 身份验证方式：导入自己的 Cookie，或通过 HTTP 扫码登录

- **已有 Cookie：** 可以导入 Cookie JSON 文件，也可以逐项填写字段。字段导入要求 `a1`、`web_session`、`webId`；只给一个 `web_session` 不够。导入后，普通命令读取程序保存的 Cookie 文件，不自动从日常浏览器提取会话。[导入入口](https://github.com/kyalpha313/xhs-cli-headless/blob/ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589/xhs_cli/commands/auth.py#L557-L670)、[会话读取](https://github.com/kyalpha313/xhs-cli-headless/blob/ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589/xhs_cli/commands/_common.py#L33-L57)
- **没有现成 Cookie：** 默认 `login` 通过 HTTP 请求二维码，在终端显示或保存为图片，由用户用手机小红书扫码确认，再将取得的会话保存到本地。这条默认流程不启动电脑浏览器。[默认选择](https://github.com/kyalpha313/xhs-cli-headless/blob/ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589/xhs_cli/commands/auth.py#L423-L453)、[二维码流程](https://github.com/kyalpha313/xhs-cli-headless/blob/ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589/xhs_cli/qr_login.py#L526-L614)

本仓的主站签名调用 Python 包 `xhshow`，网络请求使用 `httpx`；默认调用链没有 Node.js 或浏览器渲染步骤。不过，包仍包含浏览器相关依赖，并保留隐藏的浏览器辅助登录选项；出现额外验证时也可能提示用户先在浏览器处理。因此，“默认路径可以无需浏览器”有源码依据，“所有登录情况都无需浏览器”没有保证。[签名调用](https://github.com/kyalpha313/xhs-cli-headless/blob/ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589/xhs_cli/signing.py#L68-L90)、[HTTP 客户端](https://github.com/kyalpha313/xhs-cli-headless/blob/ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589/xhs_cli/client.py#L58-L72)、[浏览器辅助分支](https://github.com/kyalpha313/xhs-cli-headless/blob/ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589/xhs_cli/qr_login.py#L411-L433)、[验证提示](https://github.com/kyalpha313/xhs-cli-headless/blob/ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589/xhs_cli/qr_login.py#L95-L103)

### 帖子详情获取方式：直接请求详情接口，或下载网页源码提取数据

`read` 可以接收帖子链接、帖子 ID，或最近一次列表里的数字序号。它会读取入口携带或先前缓存的访问参数，再选择路径：[入口解析](https://github.com/kyalpha313/xhs-cli-headless/blob/ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589/xhs_cli/note_refs.py#L73-L112)

| 条件 | 实际怎么取得详情 |
|---|---|
| 有访问 token，且会话里有 `a1` | Python 先请求 `/api/sns/web/v1/feed`，取得服务器返回的帖子数据。 |
| 不满足上述条件 | Python 直接下载帖子 HTML，从网页内嵌的 `window.__INITIAL_STATE__` 提取数据。这里不启动浏览器，也不执行网页 JavaScript。 |
| 详情接口抛出被捕获的异常 | 再尝试 HTML 路径；接口成功返回空数据时，不会自动进入这个备用分支。 |

上述分支见[详情调度](https://github.com/kyalpha313/xhs-cli-headless/blob/ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589/xhs_cli/client_mixins.py#L384-L439)、[HTML 请求](https://github.com/kyalpha313/xhs-cli-headless/blob/ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589/xhs_cli/client_mixins.py#L226-L246)、[HTML 解析](https://github.com/kyalpha313/xhs-cli-headless/blob/ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589/xhs_cli/html_parser.py#L27-L71)。它们是源码实现方式，不证明当前服务器一定返回内容。

完整公开 URL 可以在没有保存 Cookie 时尝试读取；**裸帖子 ID 和数字序号在 CLI 入口仍要求已有保存会话**。缺少 token 时的 HTML 尝试也不等于能够为任意帖子生成有效 token。[不同入口的会话要求](https://github.com/kyalpha313/xhs-cli-headless/blob/ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589/xhs_cli/commands/reading.py#L59-L118)

```text
已有帖子清单，或先用关键词搜索
        ↓
取得帖子 ID、访问参数；需要登录时使用保存的 Cookie
        ↓
Python 请求详情 API 或帖子 HTML
        ↓
返回帖子数据和媒体地址
        ↓
外层程序：下载媒体、保存文档、更新逐帖进度
```

**与 xhs-cli-export 的关键关系：它是该导出器推荐的上游工具，但本次固定版本没有注册 `favorites` 和 `likes` 命令，不能直接配合旧导出器完成收藏／点赞导出。** 搜索和单帖读取的基本命令仍存在，具体兼容范围见[后面的对照](#与-xhs-cli-export-的固定版本兼容性)。

## 研究范围与版本身份

| 对象 | 本次固定证据 |
|---|---|
| 源仓库 | [`kyalpha313/xhs-cli-headless`](https://github.com/kyalpha313/xhs-cli-headless)，默认分支 `main`；不是 ReaJason/xhs。 |
| 本地源码 | [`source/`](source/)，浅层 partial clone，完整 tracked checkout，固定为 detached HEAD；被本项目 Git 忽略。 |
| 研究提交 | [`ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589`](https://github.com/kyalpha313/xhs-cli-headless/tree/ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589)，tree `4889be175225fd5458e9d78db0983268b90bb5be`。 |
| PyPI 发布 | 本次核实为 `0.8.9`，发布来源记录对应 `v0.8.9` / `bb74779dfdaaad02fdbc8c70dfe50544e8f09377`。[发布记录](https://pypi.org/project/xhs-cli-headless/0.8.9/#files) |
| 发布与研究提交的差别 | 研究提交多一次 CI／发布修订，只改工作流、发布清单和打包测试，未改 `xhs_cli/` 业务代码；两者不是同一个 SHA。[固定差异](https://github.com/kyalpha313/xhs-cli-headless/compare/bb74779dfdaaad02fdbc8c70dfe50544e8f09377...ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589) |
| 上游关系 | NOTICE 声明它是 `jackwener/xiaohongshu-cli` 的维护分支；发行包名是 `xhs-cli-headless`，命令名是 `xhs`。[NOTICE](https://github.com/kyalpha313/xhs-cli-headless/blob/ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589/NOTICE)、[包入口](https://github.com/kyalpha313/xhs-cli-headless/blob/ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589/pyproject.toml#L5-L44) |

已清点 75 个 tracked 文件、47 个 Python 文件、14 个测试文件和两份 CI／发布工作流。研究重点覆盖认证、读取、搜索、结构化输出、访问参数缓存，以及与导出器的契约；未全面审查上传／发布等平台写操作，也未深入审计 `xhshow` 依赖内部算法。详细来源与完成状态见 [provenance.json](provenance.json)、[checkpoint.json](checkpoint.json)。

## 会话与身份的实际边界

1. **Cookie 导入需要区分格式与有效性。** 文件入口接受 JSON 对象、包含 `cookies` 的对象或 name/value 列表；浏览器列表会被展平，domain/path 不保留，普通 Cookie Header 字符串不是该入口的 JSON 格式。文件导入没有与字段入口相同的三字段前置拒绝，但只含 `web_session` 的文件会在后续加载时因缺少 `a1` 而被忽略。[导入标准化](https://github.com/kyalpha313/xhs-cli-headless/blob/ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589/xhs_cli/commands/auth.py#L76-L102)、[保存值读取](https://github.com/kyalpha313/xhs-cli-headless/blob/ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589/xhs_cli/cookies.py#L107-L119)
2. **导入先保存，再诊断。** 默认围绕一份 Cookie 文件工作；导入会覆盖已有内容。`XHS_CONFIG_DIR` 可指定目录，但目录不可写时会尝试其他位置，因此外层不能只设置这个变量就假定账号隔离已经成立。普通 HTTP 响应的 Cookie 更新只保留在当前进程内存。[导入顺序](https://github.com/kyalpha313/xhs-cli-headless/blob/ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589/xhs_cli/commands/auth.py#L278-L301)、[目录选择](https://github.com/kyalpha313/xhs-cli-headless/blob/ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589/xhs_cli/cookies.py#L31-L94)、[Cookie 更新](https://github.com/kyalpha313/xhs-cli-headless/blob/ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589/xhs_cli/client.py#L178-L193)
3. **`auth doctor` 比 `status` 的判据更具体，但都没有预期账号绑定。** doctor 请求主站个人信息和 creator 发布列表，主站以“非游客且昵称有效”判定；它没有要求稳定账号 ID 非空或与用户选定账号匹配。`status` 只要个人信息请求没抛异常，就输出 `authenticated: true`，即使返回的资料仍标为游客。doctor 的外层 `ok: true` 只表示诊断完成，应另外读取内层 `data.authenticated`。[doctor 判据](https://github.com/kyalpha313/xhs-cli-headless/blob/ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589/xhs_cli/commands/auth.py#L51-L56)、[双域诊断](https://github.com/kyalpha313/xhs-cli-headless/blob/ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589/xhs_cli/commands/auth.py#L134-L240)、[status 与 doctor 输出](https://github.com/kyalpha313/xhs-cli-headless/blob/ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589/xhs_cli/commands/auth.py#L507-L554)
4. **二维码流程有内部账号一致性检查。** 完成响应或 `user/me` 的 ID 任一个匹配本次扫码确认的 ID，就接受登录；这不是与用户事先选定的采集账号比较。保存以后若再次查询仍是游客，登录命令也可能报告已认证；源码注释以会话传播延迟解释这一分支，实际输出没有进一步验证这项解释。[QR 完成判据](https://github.com/kyalpha313/xhs-cli-headless/blob/ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589/xhs_cli/qr_login.py#L238-L293)、[后续输出](https://github.com/kyalpha313/xhs-cli-headless/blob/ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589/xhs_cli/commands/auth.py#L436-L453)
5. **诊断和日志需要分别处理。** `auth inspect` 不输出完整 Cookie，但摘要里的 `fingerprint` 仍保留前后部分原始字符；QR debug 日志和某些失败消息还含会话值或原始响应，交互导入也没有隐藏输入。这些原始输出不能直接作为可分享的导出进度文档。[inspect](https://github.com/kyalpha313/xhs-cli-headless/blob/ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589/xhs_cli/commands/auth.py#L304-L343)、[日志与失败消息](https://github.com/kyalpha313/xhs-cli-headless/blob/ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589/xhs_cli/qr_login.py#L267-L292)、[交互输入](https://github.com/kyalpha313/xhs-cli-headless/blob/ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589/xhs_cli/commands/auth.py#L631-L653)

## 发现、详情和媒体

| 能力 | 固定版本实现及限制 |
|---|---|
| 关键词搜索 | `search` 接受关键词、排序、类型和页码，一次返回一页；把结果中的 token/source 缓存供后续读取。搜索不自动保证找到已有清单中的每个目标，仍需核对真实帖子 ID。[搜索与缓存](https://github.com/kyalpha313/xhs-cli-headless/blob/ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589/xhs_cli/commands/reading.py#L30-L90) |
| 分享短链 | 用 HTTP 跳转展开 `xhslink.com`，展开后检查最终域名。没有浏览器导航步骤；本次未实际展开任何帖子链接。[短链处理](https://github.com/kyalpha313/xhs-cli-headless/blob/ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589/xhs_cli/note_refs.py#L28-L70) |
| token 来源 | 主详情路径只使用显式输入或缓存，缺少时转 HTML。另有从网页正则提取 token 的方法，主要供评论等入口使用；没有任意帖子 token 生成器。[访问材料解析](https://github.com/kyalpha313/xhs-cli-headless/blob/ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589/xhs_cli/client_mixins.py#L262-L296)、[主详情路径](https://github.com/kyalpha313/xhs-cli-headless/blob/ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589/xhs_cli/client_mixins.py#L415-L439) |
| 收藏专辑 | `board` 读取指定专辑 HTML 中嵌入的帖子，没有后续分页参数；一个专辑不等于账号全部收藏，声明的 `note_count` 不证明已返回同样多条数据。[board 命令](https://github.com/kyalpha313/xhs-cli-headless/blob/ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589/xhs_cli/commands/social.py#L120-L143)、[提取实现](https://github.com/kyalpha313/xhs-cli-headless/blob/ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589/xhs_cli/html_parser.py#L184-L261) |
| 评论 | 评论是单独命令；`--all` 默认最多取 20 页，结束时却一律返回 `has_more: false`、空 cursor，达到页数上限不能证明已取完。[评论聚合](https://github.com/kyalpha313/xhs-cli-headless/blob/ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589/xhs_cli/client_mixins.py#L501-L538) |
| 媒体和本地文件 | `read` 输出数据、图片地址等字段，没有完整图片／视频下载或 Markdown 归档流程；终端人读展示会截短正文，JSON 输出没有这项展示截断。移动 HTML 规范化只保留部分字段，未完整保留视频对象、Live Photo 等材料。[终端展示](https://github.com/kyalpha313/xhs-cli-headless/blob/ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589/xhs_cli/formatter_renderers.py#L88-L129)、[移动 HTML 字段](https://github.com/kyalpha313/xhs-cli-headless/blob/ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589/xhs_cli/html_parser.py#L86-L148) |

**归档前还需要两项独立判断。** 第一，桌面 HTML 分支找不到请求 ID 对应的键时，会取 `noteDetailMap` 的第一条，并把外层 `items[].id` 写成请求 ID；这可能让外层 ID 看起来匹配，而内部内容属于另一篇，必须校验原始 `note_card` 的真实身份。第二，feed API 的验证码、会话失效和 IP 限制等也属于被捕获的异常，当前实现会继续尝试 HTML；它不等于本项目所需的会话异常暂停策略。[HTML 选择与包装](https://github.com/kyalpha313/xhs-cli-headless/blob/ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589/xhs_cli/html_parser.py#L50-L166)、[异常继承](https://github.com/kyalpha313/xhs-cli-headless/blob/ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589/xhs_cli/exceptions.py#L47-L78)、[备用路径条件](https://github.com/kyalpha313/xhs-cli-headless/blob/ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589/xhs_cli/client_mixins.py#L431-L439)

## 与 xhs-cli-export 的固定版本兼容性

这里对照的是导出器 `6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83` 和本报告 headless revision。导出器没有固定依赖版本，也可能沿用系统中已有的同名 `xhs`；下面不能推定用户电脑上既有安装的行为。[导出器选择与安装](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/install.sh#L32-L55)

| 导出器预期 | headless 实际提供 | 判断 |
|---|---|---|
| `favorites` / `likes` | 默认 CLI 没有注册两命令，虽然源码还保留函数和底层 API | **明确不兼容**，不仅是“尚未实测”。[注册表](https://github.com/kyalpha313/xhs-cli-headless/blob/ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589/xhs_cli/cli.py#L75-L108)、[导出器调用](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/src/xhs_export.py#L1191-L1229) |
| `--max --stream --no-detail` 与逐行 JSON | 保留的列表函数只有 user_id、cursor、JSON/YAML 选项；普通 JSON 输出是一个缩进对象 | 只恢复注册或删掉参数仍不足以满足流式协议。[保留函数](https://github.com/kyalpha313/xhs-cli-headless/blob/ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589/xhs_cli/commands/social.py#L92-L117)、[JSON 输出](https://github.com/kyalpha313/xhs-cli-headless/blob/ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589/xhs_cli/formatter_utils.py#L51-L53) |
| `search` 的关键词、排序、类型、页码参数 | 相应选项及取值存在 | 命令参数静态对应；搜索结果和线上可用性仍需验证。[导出器搜索](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/src/xhs_export.py#L982-L1007)、[headless 搜索](https://github.com/kyalpha313/xhs-cli-headless/blob/ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589/xhs_cli/commands/reading.py#L64-L90) |
| 解析搜索／详情 JSON | headless 输出 `{ok, schema_version, data}`；导出器能拆开相应 data/items/note_card | 没有发现这一层整体结构不兼容；仍不是内容完整性校验。[导出器解包](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/src/xhs_export.py#L223-L305)、[headless envelope](https://github.com/kyalpha313/xhs-cli-headless/blob/ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589/xhs_cli/formatter_utils.py#L68-L109) |
| `read ID --xsec-token TOKEN --json` | 命令存在，但单独传 ID 和 token 不携带来源；CLI 没有独立 `--xsec-source` 选项 | 有静态访问上下文缺口，见下一段。[导出器详情](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/src/xhs_export.py#L1440-L1462)、[headless read](https://github.com/kyalpha313/xhs-cli-headless/blob/ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589/xhs_cli/commands/reading.py#L93-L110) |

具体例子：搜索先将 `token + pc_search` 存入 headless 缓存；导出器再调用 `read ID --xsec-token TOKEN`。裸 ID 没有 URL source，`read` 会先按 `pc_feed` 重写缓存，后续请求就使用这个来源。应保持 ID、token、source 的配对；这是源码可见的不匹配，但没有实测证据证明它必然使所有请求失败。[写入来源](https://github.com/kyalpha313/xhs-cli-headless/blob/ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589/xhs_cli/commands/reading.py#L80-L110)、[缓存覆盖](https://github.com/kyalpha313/xhs-cli-headless/blob/ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589/xhs_cli/cookies.py#L258-L276)、[详情取值](https://github.com/kyalpha313/xhs-cli-headless/blob/ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589/xhs_cli/client_mixins.py#L427-L433)

## 本地缓存与导出进度

| 本仓保存什么 | 能解决什么 | 不能代替什么 |
|---|---|---|
| Cookie 文件 | 下次命令复用登录材料 | 预期采集账号核对、多账号管理、自动续期 |
| 帖子 token/source 缓存 | 复用近期获得的访问材料；最大 500 条，24 小时 TTL | 每帖详情／媒体是否完成、失败重试任务；它按 note ID 作键，没有采集账号维度 |
| 最近一次列表索引 | 让 `read 3` 指向最近列表第 3 条 | 固定导出清单；下一次列表会覆盖这个序号映射 |
| 搜索会话缓存 | 按关键词／排序／类型复用搜索会话，10 分钟 TTL | 已完成页码、逐帖导出成果、持久恢复点 |

证据：[Cookie 与 token 存储](https://github.com/kyalpha313/xhs-cli-headless/blob/ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589/xhs_cli/cookies.py#L107-L287)、[token TTL](https://github.com/kyalpha313/xhs-cli-headless/blob/ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589/xhs_cli/cookies.py#L24-L28)、[最近列表](https://github.com/kyalpha313/xhs-cli-headless/blob/ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589/xhs_cli/cookies.py#L318-L348)、[搜索会话](https://github.com/kyalpha313/xhs-cli-headless/blob/ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589/xhs_cli/client_mixins.py#L36-L168)。

Cookie、token 和列表索引以直接覆盖 JSON 文件的方式保存，设置限制权限不等于原子提交或跨进程事务。结构化结果和错误适合给外层程序使用，但本仓没有用户要求的“成功／失败／待进一步处理”导出清单，也没有媒体下载收据或只补未完成部分的完整循环。[文件写入](https://github.com/kyalpha313/xhs-cli-headless/blob/ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589/xhs_cli/cookies.py#L215-L235)、[错误输出](https://github.com/kyalpha313/xhs-cli-headless/blob/ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589/xhs_cli/commands/_common.py#L116-L133)

## 对 Rednote Sync 的启发与采用判断

**建议等级：B（局部设计参考）。** 默认 HTTP 会话、接口／HTML 读取路径、结构化结果与访问材料传递值得参考；当前不能直接视为完整后台导出器，也不能按原样搭配已研究的 xhs-cli-export 完成收藏／点赞导出。这是本次研究判断，未决定采用或接入。

对于“已有帖子清单，使用选定账号后台导出”的目标，可参考如下职责划分：

```text
已确定的帖子清单 + 用户选定的采集账号
        ↓
会话适配：检查实际账号，保留适用的访问材料
        ↓
读取适配：请求详情，核对真实帖子 ID 和字段
        ↓
媒体保存：下载、校验并记录各项结果
        ↓
Core：保存来源、逐帖状态与尝试记录，恢复未完成项并生成本地导出
```

这是候选适配思路。现有 Core 已能记录关系所属账号与采集账号、部分媒体、失败和恢复，但当前发行包仍只有离线输入；本研究没有实现在线适配器。用户可读进度应来自同一份已保存状态，不能把 headless 的 Cookie／token 缓存当作导出进度。[Core 身份与任务](../../../projects/docs/sync-core.md#2-身份和任务)、[失败与恢复](../../../projects/docs/sync-core.md#3-列表进度与失败隔离)、[导出契约](../../../projects/docs/sync-core.md#6-事实源提交与导出)、[用户后台导出目标](../../topics/project-inspirations.md#003-提供帖子清单和-cookie在后台导出并记录逐帖进度)

后续如果验证这条候选路线，应分别确认：导入后是否为所选账号；完整链接和裸 ID 的读取结果是否对应同一目标；API／HTML 是否保留本次需要的字段和媒体；失败是否正确进入暂停或待处理；重新执行是否只补缺。这些是待验证问题，本次没有启动在线实验，也没有改变[既有实验的状态与恢复条件](../../reverse/targets/xhs-xsec-token/experiment/protocol-method.md)。

## 依赖、测试与本次验证

- 源仓包含 Apache-2.0 LICENSE 和说明 fork 来源的 NOTICE。此处只记录仓库声明，不把源代码许可当成目标平台访问许可。[LICENSE](https://github.com/kyalpha313/xhs-cli-headless/blob/ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589/LICENSE)、[NOTICE](https://github.com/kyalpha313/xhs-cli-headless/blob/ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589/NOTICE)
- `pyproject.toml` 声明 Python ≥3.10、10 个直接运行依赖；`uv.lock` 有 62 个包记录，锁定的 `xhshow` 为 `0.1.9`。安装包的依赖声明多数为下界范围，不能将本地 lockfile 等同于任意用户安装后的依赖版本。本次没有安装包或运行依赖。[项目声明](https://github.com/kyalpha313/xhs-cli-headless/blob/ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589/pyproject.toml#L5-L33)、[锁文件](https://github.com/kyalpha313/xhs-cli-headless/blob/ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589/uv.lock)
- 静态清点到 14 个测试文件、219 个测试函数定义；函数数不是实际测试用例通过数。CI 配置有 lint、单元测试与构建，默认排除 smoke，CI 还跳过 integration 文件；本次没有运行这些测试，也没有核实 CI 运行结果。[测试配置](https://github.com/kyalpha313/xhs-cli-headless/blob/ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589/pyproject.toml#L84-L88)、[CI 配置](https://github.com/kyalpha313/xhs-cli-headless/blob/ffb70f4a9a5a137ef70b7cf14b770b75bb3d8589/.github/workflows/ci.yml#L10-L55)
- 主代理与两项独立研究分别核对了包／源码对应、登录会话、详情与导出器契约；关键注册缺口、字段要求、HTML 分支和缓存逻辑由主代理再次阅读。47 个 Python 文件仅做 AST 语法解析，未导入或执行；TOML 与研究 JSON 仅解析格式。文档链接、固定源码引用、Git 忽略和源码未改动情况另行检查，结果记录在 [checkpoint.json](checkpoint.json)。
- 未下载 PyPI 制品本体、未做 attestation 密码学验证、未完整审计所有平台写命令或传递依赖，未实测当前小红书兼容性。本文所称“兼容”仅指指定源码的命令／数据契约；线上成功、账号访问范围、内容完整性和长期稳定性仍没有本次实测证据。
