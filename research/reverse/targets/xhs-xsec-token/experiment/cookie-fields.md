# 小红书 Web Cookie 字段参考

分类：研究证据。首次核对日期：2026-09-11；补充核对：2026-09-13。产品权威仍为[产品设计](../../../../../docs/design/product-design.md)；实验实现上下文见 [HTTP Cookie 实验方法](protocol-method.md)。

2026-09-11 的字段语义研究只核对公开字段名、规范和作者源码，没有读取账号文件、浏览器状态或真实 Cookie。2026-09-13 按用户要求，由主代理对已登记的 F/G 输入作获准的离线脱敏比较；本次语义核对与文档更新只使用公开资料和该比较的字段名、相同/不同关系及非秘密版本标记，不记录凭据值。两次文档核对均未调用小红书身份、搜索或详情接口。第三方源码能证明该版本如何处理字段，不能替代小红书官方定义或当前服务端验证。

## 证据等级

| 等级 | 含义 |
|---|---|
| A | 标准组织或供应商的官方定义；仅适用于其明确描述的范围 |
| B | 固定版本作者源码可确认的处理方式；不是平台官方契约 |
| C | 仅由名称提出的解释，尚未得到主源确认 |
| U | 在本次核对范围内未知；不表示该字段没有作用 |

源码范围为 `xhshow v0.2.0`，以及 `jackwener/xiaohongshu-cli` 的 `4d63f3c0c85ccd9054fa8e96d7f761aaf2507449`。表中的“导出名单”特指该 CLI 的 `BROWSER_EXPORT_COOKIE_NAMES` 和 `_normalize_browser_cookies()`：保留名称与原值，没有解释其业务含义。[固定 CLI 源码][cli-qr]

## 逐项解释

| 字段 | 可确认的用法及等级 | 可能含义与不能推出的结论 |
|---|---|---|
| `a1` | **B**：`xhshow` 从 Cookie 取出它，传入 `x-s` 生成器，并写入 `x-s-common` 的 `x5`。[签名入口][xh-client]、[通用签名][xh-common] | 可称“参与签名的客户端标识材料”。这不是已确认的平台用户 ID，字段存在不证明登录。库也提供本地生成函数，不能因此保证任意生成值被平台接受。[生成函数][xh-random] |
| `webId` | **B**：在 CLI 导出名单中；`xhshow.generate_web_id(a1)` 的实现返回 `MD5(a1)` 的十六进制串。[生成函数][xh-random]、[CLI][cli-qr] | “Web 客户端标识”是合理解读；这一生成关系只属于所读第三方实现，不能宣称所有真实 `webId` 均按此生成，或等同于账号 ID。 |
| `xsecappid` | **B**：在 CLI 导出名单中。签名库另外接收 `xsec_appid` 参数，称其为应用标识，默认 `xhs-pc-web`；入口没有自动从同名 Cookie 取此参数。[CLI][cli-qr]、[签名入口][xh-client] | **C**：名称与应用标识有关。Cookie 和签名参数不能仅凭名称相近就视为同一条数据流。它也不是帖子 `xsec_token`。 |
| `abRequestId` | **B**：在 CLI 导出名单中。[CLI][cli-qr] | **C**：名称可能指 A/B 实验相关请求标识；具体实验、分组、生成和更新规则均未确认。 |
| `webBuild` | **B**：在 CLI 导出名单中。[CLI][cli-qr] | **C**：名称像 Web 构建或版本标记；不能直接当作签名 SDK 版本、服务端版本或有效性判据。 |
| `ets` | **U**：本次未找到该字段的可靠语义定义。 | `ts` 可能暗示时间，但完整含义、单位和事件均未知；不能把它解释为过期时间。 |
| `loadts` | **B**：在 CLI 导出名单中。[CLI][cli-qr] | **C**：名称像加载时间标记；本次没有确认由哪个事件写入、采用什么单位，更没有证据把它当成登录或到期时间。 |
| `gid` | **B**：在 CLI 导出名单中。[CLI][cli-qr] | **U**：只能把它作为不透明标识保留，不能确定是设备 ID、游客 ID、账号 ID 或某种安全票据。 |
| `acw_tc` | **A（供应商范围）**：阿里云 ESA WAF 文档明确用于区分、跟踪客户端，并按会话统计流量、支持 CC/扫描防护。[阿里云官方文档][ali-waf] | 可将 WAF 会话识别作为来源线索；同名 Cookie 本身不能证明小红书当前使用哪种阿里云服务或规则，也不等于已通过验证码。 |
| `web_session` | **B**：CLI 将登录/激活响应中的 `session` 写成这个 Cookie；游客激活路径也会应用该映射。[CLI][cli-qr] | 可称“Web 会话凭据”。有字段不等于已登录；其真实有效性、对应身份及权限不能由名称或长度确定。 |
| `id_token` | **B**：在 CLI 导出名单中，被按不透明字符串保留。[CLI][cli-qr] | **U**：未确认内部格式、签发方、声明或校验机制。不能因同名就认定它是 JWT 或 OpenID Connect ID Token，也不能臆测可解码的用户信息或过期字段。 |
| `x-rednote-datactry` | **C**：只有字段名线索，本次未找到可靠主源定义。 | 名称可能表示数据相关国家/区域标记；具体用于存储、路由还是别的逻辑未知。不能据此判断用户实际所在地或国籍。 |
| `x-rednote-holderctry` | **C**：只有字段名线索，本次未找到可靠主源定义。 | 名称可能表示持有者/账号归属国家或区域；归属规则和用途未知，也不能据此认定账号注册地或国籍。 |
| `unread` | **C**：名称意为“未读”；本次未找到小红书官方定义或能确立其业务语义的固定版本作者源码。 | 可能保存未读状态或计数。G 的离线结构检查只确认可解码为含 `ub`、`ue`（字符串）及 `uc`（整数）的对象；这些缩写分别指什么、是否对应通知或消息，仍为 **U**。不能据此认定它影响登录或搜索放行。 |
| `websectiga` | **B**：在固定 CLI 的导出名单中，被原值保留，没有解释生成机制或服务端用途。[CLI][cli-qr] | **C**：名称可能指 Web 安全组件的状态材料；不能确认为设备指纹、签名、验证码通行票据，也不能把“存在”当作验证通过。 |
| `sec_poison_id` | **B**：在固定 CLI 的导出名单中，被原值保留。[CLI][cli-qr] | **C**：名称可能指安全组件使用的某种标识。具体对应设备、会话还是检测事件为 **U**；`poison` 这个名称不证明账号有风险、被封禁或已经通过验证。 |

数据流边界：`xhshow v0.2.0` 会把传入的全部 Cookie 键值拼为中间指纹字段 `x57`，但 `generate_b1()` 只序列化选定字段，其中不含 `x57`；`x-s-common` 的 `x8` 使用的是这个 `b1` 输出。因此不能声称全部 Cookie 都进入最终签名。[指纹生成器][xh-fingerprint]、[通用签名][xh-common] 另一方面，固定 CLI 仍把 Cookie 字典序列化到 HTTP `Cookie` 请求头；字段未被签名器单独解析，并不能证明服务端不需要它，也不足以作为删除依据。[HTTP 客户端][cli-client]

## 2026-09-13 F/G 离线字段对比

范围为用户授权检查时保存的本地测试输入，不是该次比较重新发起的在线实验。F 有 13 项，G 有 16 项；G 包含 F 的全部字段，未缺少 F 中的任何一项。只比较字段与值是否相同，不展示会话、设备、安全标识等原值。随后 2026-09-13 13:49 NZST 的独立身份复核与清理已清空 F 等六份 Cookie，G 原值保留并标为“小号”；本节作为清理前的字段比较证据保留，现状见[账号登记](protocol-method.md#当前账号登记状态)。

| 比较结果 | 字段或非秘密标记 |
|---|---|
| 两边都有，值相同（3 项） | `xsecappid`、`x-rednote-datactry`、`x-rednote-holderctry` |
| 两边都有，值不同（10 项） | `a1`、`webId`、`abRequestId`、`webBuild`、`ets`、`loadts`、`gid`、`acw_tc`、`web_session`、`id_token` |
| 只有 G 有（3 项） | `unread`、`websectiga`、`sec_poison_id` |
| 可公开的版本标记差异 | `webBuild`：F 为 `6.7.4`，G 为 `6.52.1`；这不是 Cookie 有效期，也不是实际请求签名器版本的证明。 |

新增三项的语义经过限定范围的公开主源核对：固定 CLI 确认后两项会被保留，但未找到小红书官方业务定义；未采用其他仓库里公开贴出的 Cookie 值、未执行第三方代码，也未据字段名推断秘密生成算法。

字段差异、版本标记不同和“G 比 F 多三项”都不能独立解释此前搜索结果不同。账号、完整会话值、来源浏览器状态及请求时间等并非受控的单一变量；不得拼接两账号的字段，或把缺少这三项直接定性为 F 搜索失败的根因。既有在线结果及其边界另见 [HTTP Cookie 实验方法](protocol-method.md)。

## Cookie 字符串不能说明什么

普通 `Cookie` 请求头只发送 `name=value; name=value`。它不回传 `Expires`、`Max-Age`、`Domain`、`Path`、`HttpOnly`、`Secure`、`SameSite` 属性，因而不能从一行请求头恢复这些属性，也不能判断它们原来是否设置。RFC 6265 明确规定属性不会回传；`SameSite` 是后续规范中的 Cookie 属性。[RFC 6265 §4.2][rfc-cookie]、[HTTP 工作组当前工作草案 §4.1.1/§4.2][cookie-draft]

时间形状的值即使能按某个单位转换成日期，也只能得到“按该假设解释的时间”，不能独立证明它表示创建、登录、加载或到期。浏览器保存期限、服务端会话有效性、账号身份以及接口权限是不同问题；本表不验证任何具体 Cookie 是否仍可用。[RFC 6265 §4.2.2][rfc-cookie]；实验如何限定成功判据见 [HTTP Cookie 实验方法](protocol-method.md)。

[xh-client]: https://github.com/Cloxl/xhshow/blob/v0.2.0/src/xhshow/client.py#L485-L565
[xh-common]: https://github.com/Cloxl/xhshow/blob/v0.2.0/src/xhshow/core/common_sign.py#L22-L47
[xh-random]: https://github.com/Cloxl/xhshow/blob/v0.2.0/src/xhshow/utils/random_gen.py#L104-L129
[xh-fingerprint]: https://github.com/Cloxl/xhshow/blob/v0.2.0/src/xhshow/generators/fingerprint.py#L28-L149
[cli-qr]: https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/qr_login.py
[cli-client]: https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/client.py#L84-L101
[ali-waf]: https://www.alibabacloud.com/help/en/edge-security-acceleration/esa/security-and-compliance/data-and-operations-security-compliance-statement
[rfc-cookie]: https://www.rfc-editor.org/rfc/rfc6265.html#section-4.2
[cookie-draft]: https://httpwg.org/http-extensions/draft-ietf-httpbis-rfc6265bis.html#section-4.2
