# `Cialle/RedCrack` 固定版本源码研究

GitHub：[Cialle/RedCrack](https://github.com/Cialle/RedCrack)

> 状态：**研究证据**。结论只适用于以下 revision 和静态审查范围；借鉴建议不是产品决定。当前产品状态以[路线图](../../../docs/design/roadmap.md)为准，Core 能力以[实现契约](../../../projects/README.md)为准。

## 先读这里：身份验证与帖子详情获取

补充日期：2026-09-12。以下基于固定版本 `a557e328b6e723f63dcd75f1c52640794f2c84b5` 的公开源码静态分析；未运行项目，未实测当前小红书兼容性。

这是供开发者调用的小型 Python HTTP 客户端，提供会话初始化、请求签名及若干接口包装，没有现成的“导入收藏→逐帖详情→媒体归档”完整工具。[会话入口](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/xhs_session.py#L416-L425) [API 分组](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/apis/__init__.py#L1-L11)

### 身份验证方式：外部提供一个会话 Cookie，或初始化游客会话

调用方可以传入 `web_session`，即 Cookie 中的一项登录会话值。程序仍先建立新的设备 Cookie、请求头等材料，再放入这个值；它不会自动读取已登录浏览器，也不是还原整组浏览器 Cookie／profile。不传时会请求平台的 `login/activate` 初始化游客会话，这不等于登录了某个用户账号。“纯算”也不表示全程离线：初始化仍包含数次平台 HTTP 请求。[外部值与游客分支](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/xhs_session.py#L46-L103) [远端初始化](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/xhs_session.py#L121-L155) [游客身份声明](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/README.md#L31-L38)

Cookie 保存在运行中 HTTP 会话的 Cookie jar，仓库没有自动保存／加载整套登录状态的流程。初始化不自动查询当前用户；另有 `user/me` 包装，登录 demo 只是调用后打印响应，没有强制非空用户 ID、拒绝游客或比对预期账号。[会话容器](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/xhs_session.py#L17-L40) [用户资料接口](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/apis/auth.py#L145-L151) [登录示例](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/demo.py#L11-L16)

扫码和短信都还不是现成登录方案：扫码函数虽然请求二维码并轮询，却保留了“需自行接入 APP 扫码”的异常占位；工厂传入 `sid` 后调用它时，还漏传了必需的 `sid` 参数。短信只有发送验证码函数，没有提交验证码完成登录的接口。因此，不能理解为运行后就能弹出二维码、人工扫码并自动保存账号。[扫码缺口](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/apis/auth.py#L13-L68) [工厂调用](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/xhs_session.py#L101-L103) [短信范围](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/apis/auth.py#L126-L151)

请求签名由 Python 组件按网址、参数、正文和 Cookie 组织。它与帖子 `xsec_token` 是两件事：这里没有“给一个帖子 ID 就生成访问 token”的实现，生成签名也不证明账号或目标帖子已获访问。[签名组织](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/xhs_session.py#L158-L188) [Python 组件](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/encrypt/xhs_encrypt.py#L1-L44) [详情所需参数](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/apis/note.py#L86-L106)

### 帖子详情获取方式：向 feed 接口发 HTTP 请求，调用方负责选帖和整理响应

`note_detail(note_id, xsec_token)` 要求调用方提供 ID 和 token，不负责解析分享网址或查找配套 token；`xsec_source` 写死为 `pc_feed`。它把这些参数提交到 `/api/sns/web/v1/feed`，返回原始 `aiohttp.ClientResponse`。调用方还需要读取 JSON／文本、提取帖子字段并保存文件；这里没有浏览器导航、HTML 备用解析或 HAR 中转。[详情包装](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/apis/note.py#L86-L106) [HTTP 分发及返回](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/xhs_session.py#L332-L346)

| 帖子来源 | 此版本提供什么 |
|---|---|
| 已知帖子 | 单帖详情调用；ID、token 由外部给出，没有批量补全循环。 |
| 关键词搜索 | 一次请求一页，返回响应；不自动取出每条 token 再补详情。[搜索](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/apis/note.py#L109-L135) |
| 作者发布列表／推荐流 | 各提供单次请求，调用者管理页码或游标，不能保证全量。[作者发布](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/apis/note.py#L137-L156) [推荐流](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/apis/note.py#L282-L311) |
| 点赞／收藏清单 | 没有对应发现流程；`like_note` 是执行点赞，不是读取点赞列表。[点赞方法](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/apis/note.py#L70-L84) |

搜索还有明确的本地构造问题：默认从第 2 页开始；正文通过 `json=` 发送，签名却只读取 `data=`，两者脱节；配置中的搜索 URL 多了前导空格，使对应请求头的精确匹配失败。这些问题未修正前，不能把“存在搜索函数”理解为已经取得可用搜索结果。[页码与正文](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/apis/note.py#L109-L135) [签名取值](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/xhs_session.py#L299-L319) [配置空格](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/encrypt/web_encrypt_config.ini#L34-L36) [精确匹配](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/encrypt/header/X_Rap_Param.py#L184-L189)

这条链在结构上是可后台运行的 Python HTTP 脚本，不需打开 Chrome、启动 Node.js、通过 CDP 控制浏览器或逐帖点击。现成 demo 只打印推荐流和个人资料，连逐帖详情都没有串起来，更没有媒体下载器或归档导出。[HTTP 会话](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/xhs_session.py#L84-L99) [demo 全流程](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/demo.py#L5-L33)

- 研究日期：2026-09-12（Pacific/Auckland）
- 上游：[Cialle/RedCrack](https://github.com/Cialle/RedCrack)
- 固定 revision：[`a557e328b6e723f63dcd75f1c52640794f2c84b5`](https://github.com/Cialle/RedCrack/tree/a557e328b6e723f63dcd75f1c52640794f2c84b5)
- Git tree：`9ab1a67a1233377bc2bfb9673f6751e900a6c695`
- 来源与静态核验记录：[provenance.json](provenance.json)；恢复状态：[checkpoint.json](checkpoint.json)。

## 结论：能借鉴请求构造，不能直接完成归档

**建议等级：B（局部设计参考，不是原样采用）。** 保留为协议构造的专项参考，暂不把这个版本接入生产采集链路。它的价值是把会话初始化、请求签名和少量 API 封装集中在一个小型 Python 客户端里，便于沿调用链检查“哪些输入参与了签名”。它没有实现 Rednote Sync 所需的“点赞／收藏清单 → 逐帖补全 → 媒体保存 → 可靠导出”工作流，而且搜索封装存在确定的本地构造缺陷。

README 宣称 Web 端“所有加密参数”纯算，实际列出的主要是 Cookie 和请求头，并注明 `web_session` 为游客生成；源码中的详情函数仍必须接收调用方提供的 `xsec_token`。因此，这个项目不能据此被视为 `note_id → xsec_token` 生成器，也不能据此宣称已经解决我们的搜索 HTTP 461。[README 声明](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/README.md#L27-L51)、[详情入口](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/apis/note.py#L86-L106)。

| Rednote Sync 的需求 | 此版本实际覆盖 | 借鉴程度 |
|---|---|---|
| 取得点赞／收藏清单 | 未实现对应列表入口；`like_note` 是发起点赞，`search_user_notes` 读取作者发布列表 | 低，不能替代现有列表脚本 |
| 会话与搜索请求 | 有初始化、签名和搜索封装，但没有自动身份绑定检查，搜索调用还存在下述缺陷 | 中，适合离线比较变量 |
| 已知帖子的详情 | 有 `feed` 包装，要求外部 token，返回原始 `aiohttp.ClientResponse` | 有限，尚缺取得和核对访问材料的流程 |
| 媒体、本地导出与恢复 | 未实现下载器、归档格式、持久检查点或逐帖任务恢复 | 低，这些应继续使用现有 Core |

列表与详情证据见 [Note API](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/apis/note.py#L70-L156)；全部 API 仅注册 auth、comments、note、user 四组，详见 [APIModule](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/apis/__init__.py#L1-L11)。未实现项由固定树清单、全树符号检索及相关模块阅读共同确认，不是由 README 缺少某个词推定。

## 审查范围与证据边界

本轮读取固定树的 36 个 tracked path 清单，对全树执行符号、导入和访问材料检索，重点追踪 README、demo、session、四组 API、加密入口、配置、相关签名函数及 LICENSE。31 个 Python 文件的静态 AST 解析通过；另以 AST／语言调用绑定检查确认下述缺参、位置参数和 `json`／`data` 差异。这些不是上游测试运行，不证明依赖齐全、算法有效或平台可用。没有逐个验证加密算法的数学正确性，本轮也未取得来自当前平台的成功样本或已校验的签名测试向量。

未安装依赖、导入或运行第三方代码、执行其测试、启动浏览器或访问小红书；没有读取真实 Cookie、HAR、profile 或账号存储，也没有修改上游源码。文中的“声明”指上游文字，“静态证据”指源码可直接确认的行为，“判断／建议”指本次分析；平台当前接受什么参数、游客权限和真实账号兼容性均属未知。

## 真实调用链与登录边界

实际入口是 `create_xhs_session()` 创建对象并等待 `_initialize()`；后者建立 `aiohttp.ClientSession`，随机选择 User-Agent，初始化设备 Cookie 与指纹，然后才按需注入已有 `web_session`。接口调用再经过统一的 `request()`，生成请求头、发 HTTP 请求并处理响应。[工厂](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/xhs_session.py#L416-L425)、[初始化](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/xhs_session.py#L46-L103)、[请求分发](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/xhs_session.py#L280-L346)。

两条会话路线需要分别理解：

- **游客路线**：本地生成 `a1`／`webId` 后，请求 `scripting`，用服务端返回材料计算 `websectiga` 并取得 `sec_poison_id`；随后发送指纹上报，再请求 `login/activate` 申请游客会话。因此“纯算”不等于完全离线生成全部 Cookie，更不代表获得了用户登录身份。[初始化顺序](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/xhs_session.py#L53-L82)、[三个远端步骤](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/xhs_session.py#L121-L155)。
- **已有账号路线**：调用者提供一个 `web_session`，程序仍先建立新的设备参数和随机 UA，再把该值放入 Cookie jar；它不是恢复完整浏览器会话。初始化没有自动调用 `user/me` 校验预期账号。`login_demo` 另外查询并打印个人信息，但没有绑定预期身份或拒绝游客的判据。[会话注入](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/xhs_session.py#L79-L103)、[demo](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/demo.py#L11-L16)、[`user/me` 包装](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/apis/auth.py#L145-L151)。

APP 路线尚未完成。`scan_login` 和 `pass_scan_124` 保留了二维码请求与轮询代码，但实际 APP 调用被注释并由异常占位；仓库没有 `request/app/` 实现。另外，初始化调用 `scan_login()` 时未传入该函数必需的 `sid`，所以 README 的 `sid` 工厂示例还存在本地调用签名不匹配，不能视为开箱可用的扫码登录。短信部分只封装发送验证码，没有完整验证码登录流程。[APP 占位与扫码参数](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/apis/auth.py#L13-L68)、[124 与短信](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/apis/auth.py#L70-L142)、[无参数调用](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/xhs_session.py#L101-L103)。

## 请求签名与 `xsec_token` 是两层问题

加密入口组合了 Cookie、`x-s`、`x-s-common`、trace ID、`x-rap-param` 和指纹类；每次请求根据 URL、query、body、Cookie 与指纹更新 header。这种分层便于做输入一致性审查，但本轮未验证计算结果是否被平台接受。[加密组合](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/encrypt/xhs_encrypt.py#L1-L44)、[header 编排](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/xhs_session.py#L158-L188)。

全树检索 `xsec_token` 及常见大小写变体，结果只在 `note.py`、`comments.py`：作为详情／评论函数的必需参数、请求字段、转传参数，以及一处被注释的固定示例。没有发现 token 生成函数或从搜索响应提取并核对目标 token 的实现。详情固定 `xsec_source='pc_feed'`，没有让调用者传入与 token 同源的 source；搜索只返回原始响应，尚未串成“找到精确帖子 → 提取 token/source → 请求详情”的链路。[详情及作者列表](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/apis/note.py#L86-L156)、[评论传参](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/apis/comments.py#L16-L39)、[阅读数调用](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/apis/note.py#L249-L265)。

所以，它提供的是请求签名的另一份实现证据；**没有提供绕过访问材料来源问题的证据**。不能把 `x-s` 成功计算、游客激活或普通身份查询成功，等同于目标帖子的访问权限和详情／媒体成功。

## 搜索实现存在三个确定问题

| 问题 | 静态证据 | 影响边界 |
|---|---|---|
| 正文与签名输入脱节 | `search_notes` 用 `json=data` 调用；`request` 只从 `kwargs['data']` 取签名输入，最后却把 `json` 原样传给 aiohttp | 搜索正文被发送时，签名函数收到的 body 是 `None`。这是本地构造错误，不需要访问平台即可确认 |
| 默认从第 2 页开始 | 函数默认 `page=2`，同一函数 docstring 写默认 1 | 默认调用会跳过请求第 1 页；不等于显式传 page=1 也失效 |
| 搜索的 `x-rap-param` 不会按配置新生成，且可能残留旧值 | 配置中的搜索 URL 有前导空格；生成函数按原字符串精确匹配；session 仅在有新值时写 header，从不在缺省时清除 | 静态配置比较确认精确匹配为 false、去空格后为 true；若前一请求设置过该 header，后续搜索可能带旧值 |

第一、二项见 [search_notes](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/apis/note.py#L109-L135)、[数据与签名输入](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/xhs_session.py#L299-L319)、[实际分发](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/xhs_session.py#L332-L342)；`x-s` 确实把 body 纳入计算，见 [X_S.py](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/encrypt/header/X_S.py#L85-L96)。第三项见 [配置](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/encrypt/web_encrypt_config.ini#L34-L36)、[精确匹配](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/encrypt/header/X_Rap_Param.py#L184-L189)、[有值才更新](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/xhs_session.py#L180-L188)。

对照本地[现行协议实验](../../reverse/targets/xhs-xsec-token/experiment/scripts/protocol_session.py)，其第 171–184 行把同一个 payload 交给 signer 与 HTTP 正文构造，第 245–275 行设有身份门禁，并明确请求第 1 页和 filters。RedCrack 的搜索参数未包含这组 filters，这是差异，尚不能判定平台是否必需。以上比较没有证明本地 signer 正确，也不能把 RedCrack 的问题归因成我们现有 461 的根因；换用这个版本并没有更可靠的搜索证据。

## 列表、媒体与工程完整性

**分页覆盖有限。** 搜索、作者发布页、推荐页只是单次调用，调用者负责 page／cursor；没有点赞／收藏全量扫描和完成判据。`get_all_comments` 虽然维护 cursor／has_more，默认最多三轮，子评论展开被注释，结果最后格式化成字符串，不能作为完整的结构化评论归档器。[作者列表](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/apis/note.py#L137-L156)、[推荐页](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/apis/note.py#L282-L311)、[评论循环](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/apis/comments.py#L159-L215)。

**详情请求不等于媒体保存。** `image_formats` 只是请求字段；详情包装返回响应对象，没有媒体解析、图片／视频下载、临时文件提交、长度／哈希检查、文件名规范化、Markdown／JSON 导出、失败清单或断点。当前 demo 也只打印推荐流和身份响应。[详情包装](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/apis/note.py#L86-L106)、[demo 全流程](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/demo.py#L5-L33)。

**其他调用错误说明尚需工程整顿。** 子评论和删除评论把字典作为 `request` 的第三个位置参数传入，实际绑定的是 `max_retries`；`add_note_readnum` 两处对异步 `response.json()` 缺少 `await`。这些属于源码可确认的调用错误，但不是本轮运行所得的异常记录。[位置参数](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/apis/comments.py#L42-L61)、[删除评论](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/apis/comments.py#L105-L121)、[request 签名](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/xhs_session.py#L280-L288)、[缺少 await](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/apis/note.py#L261-L265)。

**依赖与配置没有可复现交付。** 固定树未包含依赖 manifest、lockfile、测试套件或 CI。导入涉及 `aiohttp`、`loguru`、`getuseragent`、`Crypto`、`xxhash`，另有可选 `aiohttp_socks`，以及辅助文件中的 `pydantic`；静态 import 名不能替代安装发行包和版本的确认。配置读取使用相对工作目录路径，并把配置值交给 `eval`，不宜作为配置层直接复用。[主要依赖](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/xhs_session.py#L1-L14)、[Socks](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/xhs_session.py#L106-L119)、[Crypto](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/encrypt/cookie/gid_webprofile_data.py#L1-L4)、[xxhash](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/encrypt/header/x_rap_param_helper/serialize_fingerprint_payload.py#L1-L6)、[pydantic](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/units/base_response.py#L1-L2)、[配置](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/encrypt/config.py#L4-L16)。

**客户端配置未保证一致。** UA 从 Chrome／Edge／Firefox 集合随机选择，但默认 Client Hints 固定 Chrome 131／Windows，签名平台也固定 Windows；选择不同浏览器或平台的 UA 时，这些字段不会同步调整。这里只确认条件性配置矛盾，不推定每次随机结果都矛盾，也不把它当作已有 461 的原因。[随机 UA](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/xhs_session.py#L46-L51)、[签名平台配置](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/encrypt/web_encrypt_config.ini#L6-L16)、[固定请求头](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/encrypt/web_encrypt_config.ini#L63-L78)。

**会话处理和日志不能原样采用。** 特定禁言、会话过期、无权限和封号分支会把 `web_session` 写进日志；请求日志还包含完整 query 和正文片段，可能带 token。README 另有遍历输出全部 Cookie 的示例。`aiohttp.ClientError` 分支默认最多尝试五次（含首次）、间隔 0.1 秒，且同一个 session 暴露点赞、关注、评论删除及阅读上报等平台写操作；不能把此 session 当作只读下载器。461／471 会分类为挑战或其他异常，但没有本地实验那样的全局停止状态；提供 sid 时还会进入未完成的 APP 处理路线。[敏感日志](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/xhs_session.py#L244-L278)、[请求日志与重试](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/xhs_session.py#L280-L388)、[Cookie 示例](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/README.md#L102-L120)、[461 分类](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/request/web/xhs_session.py#L207-L238)。

许可文本也需要保留区别：根 LICENSE 是 MIT，README 同时写了个人学习研究限定和禁止商业用途。这里仅记录文字并存，不裁定法律效力；作者还声明后续不继续更新指纹内容，不能从仓库存在推定维护持续或当前平台兼容。[LICENSE](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/LICENSE#L1-L21)、[README 条款](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/README.md#L55-L72)、[指纹维护说明](https://github.com/Cialle/RedCrack/blob/a557e328b6e723f63dcd75f1c52640794f2c84b5/README.md#L207-L216)。

## 对 Rednote Sync 的下一步价值

1. **作为离线核对清单。** 可比较序列化正文、签名输入、query 编码、按请求生成 header、会话 Cookie／UA／指纹的来源与一致性；本报告找到的搜索缺陷适合作为本地防回归案例。需要另行实现时，应使用合成材料固定时间与随机输入，不把上游代码直接作为“正确答案”。
2. **保留已完成的 Core 分工。** 当前 Core 已支持 `account`（关系 owner）、`listCollector`、`contentCollector`、逐帖任务和媒体流。未来来源若接入，应向 `SyncSource.client.listPage`／`getDetail(..., neededParts)` 提供验证后的列表、正文和媒体，或先转换成 `offline-input-v1`；不必复制 RedCrack 的会话类进入 Core。[可注入来源契约](../../../projects/docs/offline-input-v1.md#可注入内容来源)。
3. **把现有成功样本优先用于归档桥接。** 本地证据已记录 JustOneAPI 两篇样本详情与媒体下载验收成功，尚未接入 Core；它与 F 原站搜索 461 是不同路线。将现有成果离线接入 Core、验证关系归属、重复导入和补缺，比把 RedCrack 的初始化复杂度当成下载突破更直接。这是后续建议，本轮没有读取私有下载数据或实施接入。[双样本证据](../../reverse/targets/xhs-xsec-token/experiment/protocol-method.md#2026-09-12-双样本详情实测)。

该版本值得保留的成果是可定位的调用链和比较变量；token 获取、账号访问范围、原站搜索恢复、列表完整性及真实适配器接入仍需各自的验证证据。
