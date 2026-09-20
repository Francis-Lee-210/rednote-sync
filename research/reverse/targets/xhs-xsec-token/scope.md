# Case Scope

> 路由：master-route → R3 `js-reverse/`（JS 签名 / 前端加密参数分析）。
> 依据：目标是小红书 Web 端 `xsec_token` 的生成/构造逻辑，属于浏览器端加密参数逆向，非二进制/APK/协议。
> 2026-09-09 方法扩展：按用户引用的登录方式，新增 HTTP Cookie + 本地请求签名的独立实验路线；初始 JS 逆向范围及历史结论保留。方法详见 [协议实验](experiment/protocol-method.md)。
> 角色：lead + specialist `cre`（js-reverse）。单人会话内用角色前缀标签记录。

## meta
- case_id: 20260820-xhs-xsec-token
- created: 2026-08-20
- operator: local (LITC)
- primary_skill: js-reverse
- lead_role: lead
- specialist_roles: [cre]

## auth
- status: granted
- basis: own_research_project
- evidence_of_auth: 用户在本会话明确要求“使用 reverse-skill 尝试破解 xsec_token，遇到卡点跟我说”；目标资产为用户自己研究项目（Rednote_Sync）的采集对象。
- experiment_extension_2026_09_02: 用户明确授权修改实验范围，并仅使用其提供的自注册测试小号完整 Cookie，执行低频、只读的登录验证、站内搜索、note_id 精确核对、正常点击和 token/source 捕获。
- method_change_2026_09_09: 用户要求参考“实施方案-项目登录方式”对话调整实验方法；将上述自注册测试账号的只读身份、搜索和详情实验扩展为独立协议路线。方法实现时只做代码与离线验证；随后用户指定的在线身份结果与实现阶段分开记录，见下方验证状态。
- MUST NOT proceed if status != granted

## in_scope
- assets:
  - https://www.xiaohongshu.com/ 主页与公开详情页（无需登录）
  - https://fe-static.xhscdn.com/formula-static/ranchi/public/js/*.js（公开 JS bundle）
  - 工作区既有研究材料 `research/topics/xsec-link-structure.md`、`research/projects/*/review.md`
  - 用户明确提供的自注册测试小号 Cookie；只从仓库外 `accounts.json` 读取，用于独立 HTTP 会话或显式浏览器对照的隔离 profile
  - 登录后只读 `/api/sns/web/v2/user/me` 或官方 Web bundle 定义的 `/api/sns/web/v1/user/selfinfo` 身份接口、站内搜索页及由精确匹配卡片正常点击打开的公开详情页
  - 基础协议路线的固定 origin `https://edith.xiaohongshu.com`；仅 `GET /api/sns/web/v2/user/me`、`POST /api/sns/web/v1/search/notes` 与 `POST /api/sns/web/v1/feed` 三种只读操作，后两者须通过身份与公开样本门禁；另行授权的 F 只读能力检查严格限于下方独立小节
- surfaces: [web]
- activities:
  - recon（公开页面/JS bundle 只读拉取）
  - reverse（静态分析 bundle：定位 xsec_token 消费点与任何生成逻辑）
  - format_analysis（token 结构/编码/长度/熵分析，只对脱敏样本）
  - report
  - cookie_session_bootstrap（先在全新隔离 profile 建立匿名设备状态，再覆盖完整 Cookie，并以只读身份接口或严格页面身份状态验证和绑定账号身份摘要）
  - supervised_search_discovery（标题/正文关键词搜索 → 路径 note_id 精确核对 → 正常点击 → 捕获 token/source）
  - protocol_cookie_experiment（本地签名的 Cookie HTTP 身份探针 → 可选的一页关键词搜索 → 精确目标访问材料 → 只读详情；不产生浏览器登录成功结论）

## out_of_scope
- assets: 除上述身份、搜索、精确目标详情及下方独立授权检查以外的非公开接口；平台写接口；用户主账号登录会话；未明确提供或非自注册测试账号的登录会话
- activities:
  - **使用或读取工作区内既有真实账号材料（`prototypes/*` 的 token/cookie、HAR、登录态）做任何联网试验**（2026-08-20 的禁止仍有效；2026-09-02 的授权只覆盖用户另行提供、位于仓库外的自注册测试小号 Cookie）
  - 自动输入账号密码、二维码代扫、验证码或设备校验绕过；购买、第三方或来源不明 Cookie
  - 点赞、收藏、关注、评论、发布、私信或其他用户状态写入
  - 对生产接口批量请求、fuzz、DoS
  - 把逆向产物接入本项目 Core（Core 规格明确禁止 xsec_token 生成；本 case 只产出研究证据）

## network_profile
- mode: authorized_target_only
- notes: |
    默认仍为仅 GET 公开静态资源与无需登录的公开页面；实验扩展允许用户提供的自注册测试小号 Cookie，
    每次只操作一个账号和一个已批准的公开样本，低频进入站内搜索并正常点击匹配卡片；
    `/api/sns/web/v2/user/me` 与 `/api/sns/web/v1/user/selfinfo` 仅用于只读会话验证。浏览器可能产生站点自身的读取/遥测请求，
    实验代码不调用任何用户状态写接口。出现验证码、461、任一 403/429、身份不匹配或登录失效立即停止。
    协议路线独立选择，携带 Cookie 与本地签名请求固定 API origin；搜索与 feed 的 POST 仅允许业务读取。
    每次最多身份、搜索、详情各一次；省略目标时只做身份探针。无重试、重定向或失败后自动切路；471 也停止。

## deliverables
- report: true
- field_journal: true
- diagrams: false
- timeline: true

## constraints
- timebox: {}
- stealth: medium
- data_handling: anonymize | no_user_pii
- 真实 token 值不进入报告；报告只记录长度/字符集/结构特征与脱敏前缀。
- Cookie 文件必须位于 Git 工作区外且权限为 600；Cookie 不进入 argv、stdout/stderr、capture、报告或 Git。
- 正式、staging、失败和历史 profile 只能位于已忽略的 `experiment/profiles/`；候选 Cookie 必须先在 staging 中验证，正式 profile 以首次验证账号 ID 的 SHA-256 摘要绑定。
- 上一条 profile 约束只适用于浏览器对照。协议路线不建立 profile，Cookie 仅作内存快照；摘要和脱敏报告位于忽略的 `data/protocol-identities/`、`data/protocol-runs/`，仅精确目标访问材料写入私有 `data/captures/`。

## 2026-09-12 第三方双样本试下载授权

本节是独立的供应商验证，不恢复上面已停止的小红书原站实验。用户已手动登录 Just One API，并明确授权使用免费试用额度，下载此前脚本导出列表中的一篇图文和一篇视频帖子。

- 输入只读取导出表的帖子 ID、标题和类型；不读取或发送导出 token、小红书 Cookie、A–F 账号材料、浏览器登录态或 HAR。
- 允许在 `https://dashboard.justoneapi.com` 核对免费额度、单价和调用结果；业务请求仅为 `https://api.justoneapi.com/api/xiaohongshu/get-note-detail/v1` 与 `/v6`，分别使用一个所选 ID，各最多一次。无搜索、评论、批量采集、自动重试或失败后换接口。
- 仅使用已确认的免费试用次数，不充值、不使用付费余额。创建服务访问 Token 属于另一个需要明确确认的动作；未确认前不得创建。若无法确认免费使用条件，暂停业务请求。
- 用户在上述创建动作的确认问题后回复“测试”，本次据此创建 `rednote-two-post-trial-20260912`，初始可用金额明确设为 0 元；不授权不限额 Token、提高金额或新建其他凭据。创建后列表另显示一个不限额 `Default` 条目，未使用或修改该条目，不能据此认定其来源。
- 成功响应若返回所选帖子媒体，允许下载对应图片或视频；使用返回的 HTTPS 地址，或只把同一返回 CDN 地址的 HTTP 升级为 HTTPS，不删除或改写媒体签名参数。不得转发服务 Token、小红书 Cookie 或请求签名；媒体地址自身的签名仅发送给对应 CDN。校验域名/重定向目的地、文件类型与实际内容；图片单张最多 20 MiB、视频最多 300 MiB，不追踪内网或本地地址，每个媒体不自动重试。
- 服务凭据不进入命令行、日志、报告或 Git，不默认持久化。帖子数据和媒体保存在已忽略的 `experiment/data/` 私有子目录；公开研究记录只保留脱敏结果，不复制原始响应或含 token 的链接。
- 第三方详情调用成功、实际媒体下载成功分别验证；不将其写成原站搜索恢复、`xsec_token` 生成机制已解决或 Core 已接入。

## 2026-09-12 ReaJason/xhs 搜索对照授权

用户明确要求从现有自注册测试 Cookie 中找出当前可通过身份验证的一个，并使用 ReaJason/xhs 的搜索功能进行一次帖子搜索。这是本次独立、低频对照，不是恢复无限重试或扩大采集范围。

- 身份筛选仅检查仓库外既有 A–F 测试输入，按最近正面证据优先 F、E，再 A–D；每个账号至多一次现有协议身份 GET，仍计入共用每日台账并使用全局在线锁。只有明确 `SESSION_EXPIRED`（HTTP 200 / API -100）才允许检查下一候选；验证码、403/429/461/471、身份不匹配、签名、网络或未知失败均停止整次对照。
- 找到首个有效身份后立即停止筛选；ReaJason/xhs 固定 revision `f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0` 可再通过自身 `get_self_info2()` 做一次计入台账的身份复核，再以同一进程内冻结的输入调用 `get_note_by_keyword()`。仅既有批准样本关键词、第一页、最多 20 项、一次搜索，不读取详情或下载媒体。先做离线接线验证，不能把自有 `ProtocolSession.search()` 替代该项目搜索函数后称为 ReaJason 实测。
- 客户端允许接入已锁定的本地签名器和有界只读传输；完整 Cookie、UA、签名及实际发送正文必须一致。不得使用上游硬编码默认会话、公开签名服务、浏览器/扫码/验证绕过、主号会话或导出 token；不改上游源码或接入 Core。
- 身份有效、搜索 API 成功、搜索结果非空与目标命中分开记录。任何搜索失败均结束本轮，不切换账号/关键词/签名重试；只保存脱敏状态与计数，不记录 Cookie、请求签名、搜索结果 token 或完整原始响应。
- 现有成功绑定须匹配；无预期身份的候选即使通过，也只记首次观测身份，不声称与未提供的预期账号 ID 独立核对。所有旧实验结果保留，本次无结果前不声明 Cookie 当前有效或搜索恢复。

## 2026-09-12 新小号 G 自有脚本对照授权

用户补充了其确认已在 Chrome 网页登录的小号完整 Cookie，并明确要求“先用本项目的脚本进行身份验证，通过后进行搜索”。此处将该新输入登记为 `test_g`，不覆盖 A–F，不把用户的网页观察写成代理已验证的结果。

- 仅将本会话最新提供的 16 项 Cookie 导入既有仓库外、`0600` 的账号文件；只还原字段名中的聊天下划线转义，不改值、不拼接其他账号字段。未提供实际浏览器 UA，沿用实验原有默认配置，不声称与来源 Chrome 一致。
- 使用自有 `run_experiment.py --transport protocol --search-only`，而不是 ReaJason 入口。仅 G、原批准公开样本的第一个标题关键词、身份 GET 和第一页搜索 POST 各最多一次；继续共享在线锁、每日台账、延迟与总超时。
- 首次身份通过后可按原脚本建立 `first_observed` 摘要绑定；非游客与稳定 ID 必须通过，不称为已匹配预先提供的账号 ID。身份失败即不搜索；403/429/461/471、挑战、签名、网络或未知错误均停止，不重试或换号。
- 不请求详情或媒体，不启用浏览器，不调用 locator。若搜索精确命中目标，沿用既有 `--search-only` 的最小目标访问材料保存规则：仅私有、Git 忽略的 capture，终端和研究文档不显示 token；不保存整页搜索结果。
- Cookie 的字段齐全、网页已登录、协议身份通过和搜索成功分别判断；本轮不因新 Cookie 或旧离线测试通过而预先宣告搜索恢复。

## 2026-09-13 F 常用只读功能检查授权

用户在 F/G 对比后要求检查“能登录、不能搜索”的账号还能使用哪些常见功能。本轮按 F 理解并向用户说明，独立验证当前会话能力，不恢复旧搜索实验或解除任何挑战。

- 只使用仓库外已登记 `test_f` 输入，先发一次 `GET /api/sns/web/v2/user/me`，要求非游客、稳定 ID 且匹配既有身份摘要；不首次绑定、不修改 Cookie、不测试其他账号。
- 通过后至多读取一次本账号资料 `GET /api/sns/web/v1/user/otherinfo?target_user_id=<本轮身份ID>`，以及一次本账号发帖列表 `GET /api/sns/web/v1/user_posted?num=30&cursor=&user_id=<同一ID>&image_scenes=FD_WM_WEBP`。仅固定 API origin、同一进程的身份 ID、第一页；不允许任意 ID、URL、查询参数、翻页或切换签名配置。
- `num=30` 沿用固定参考契约，不声称账号一定有 30 篇帖子，也不声称自己的列表只包含公开项；只检查返回结构及数量，不保存昵称、标题、正文、帖子 ID、token、cursor 或原始响应。
- 独立入口 `experiment/scripts/capability_probe.py` 默认 dry-run，执行必须 `--execute --yes`；原身份/搜索/详情入口白名单不变。共用全局在线锁、每日登录与 capture 台账；本次内容检查消耗一次 capture 类运行额度，即使不创建 capture 文件。总计最多三次 GET、每次按现有 policy 延迟、整体 180 秒上限，无重试或重定向。
- 任一步遇到 403/429/461/471、挑战头/提示、登录失效、身份不匹配、签名/网络/未知失败，立即停止整轮，后续功能保持未测试。搜索、详情、推荐流、媒体、点赞/收藏/关注/评论/发布/私信均不测试，不借用 G 的 token 或来源浏览器。
- 只保存脱敏摘要到被 Git 忽略、目录 700/文件 600 的 `experiment/data/capability-runs/`。资料接口缺少可靠逐字段契约时只能称“业务成功且返回非空对象”，不声称完整资料已验证；空发帖列表可以是正常结果，非空条目须满足最小结构检查。

## 2026-09-13 A–F 身份复核与条件清理授权

用户明确要求检查 A–F 是否还能登录，仅当六个都无法登录时删除这些 Cookie，并将其本人小号 G 标记为“小号”。这是新的有限身份复核，不恢复搜索或内容采集。

- 只读取仓库外已登记的 `test_a` 至 `test_f`；按 A→F 串行，各最多一次现有协议 `GET /api/sns/web/v2/user/me`。共享在线锁、每日三次登录额度、5–15 秒请求间隔和总时限，不修改签名或请求方式，不测试 G。
- A–D 没有预期摘要或既有协议绑定，沿用显式首次观测绑定规则；E/F 必须匹配既有摘要。身份成功与普通会话失效可继续下一个本轮指定账号，但不得重试同一账号。任何挑战、403/429/461/471、身份不匹配、签名、网络或未知失败停止剩余复核。
- 删除条件限定为本轮六个唯一身份请求全部明确返回 HTTP 200 / API -100、`SESSION_EXPIRED`、`identity_verified=false`，且无验证响应头或风险提示。未测试、额度不足、配置或网络失败均不满足条件；只要任一账号通过，本轮不批量删除 A–F。
- 满足条件后，只将外部账号配置中 A–F 的 `cookie` 字段清空；保留账号 ID、原有元数据、脱敏身份绑定和历史报告，不创建旧 Cookie 备份。不删除浏览器 profile、HAR、其他文件或平台账号，不声称已清除其他位置的历史副本。
- G 的 Cookie 原值保持不变，内部 ID 仍为 `test_g`；新增可选描述标签 `label: 小号` 并同步账号登记说明。该标签不作为身份、路径、签名或账号选择依据；不为标签变更重新发送 G 请求。
- 凭据仍仅存在于工作区外、权限 600 的配置文件；清理前核对六份本轮脱敏报告与输入未被并发更新，完成后验证 A–F 无 Cookie、G 原值不变、配置可加载。Cookie 不进入命令行、终端、报告、Git 或保留备份。

## verification_state

- 2026-09-09：`test_e` 的完整 Cookie + 本地 HTTP 签名通过一次非 guest 身份验证，已建立首次观测身份摘要绑定；规范证据见[协议登录说明](experiment/protocol-method.md#已验证的登录方式与结果)。浏览器路线的历史失败不被覆盖。
- 2026-09-10 01:30 NZST：用户指定公开样本后的协议流程，E 身份匹配复核通过，搜索 POST 返回 HTTP 461 后硬停止；详情未请求、目标 token/source 未取得。既有报告见[时间线](timeline.md)，离线复核与后续证据要求见[研究顺序](experiment/protocol-method.md#登录成功后的-token-研究顺序)。
- 2026-09-10 17:19 NZST：用户在离线修复完成后明确要求再次尝试；仅使用同一 E 账号与批准样本运行一次 `client_revision=2`。身份 GET 返回 HTTP 200 / API -100，结果 `SESSION_EXPIRED`；未发送搜索或详情、未生成 capture，旧绑定未更新。当前继续暂停后续请求，需更新指定测试账号的有效 Cookie 并重新确认；本次授权不允许自动重试、换账号或绕过门禁。
- 2026-09-10 19:42 NZST：用户另行明确“允许，先测试 a”，授权一次 A 身份验证及成功后的首次绑定，不含搜索或测试其他账号。dry-run 后仅发送一次身份 GET，返回 HTTP 200 / API -100（`SESSION_EXPIRED`）；未创建身份绑定、未搜索/读取详情、未生成 capture，停止后未重试或继续测试 B/C/D。证据见[协议登录说明](experiment/protocol-method.md#已验证的登录方式与结果)。
- 2026-09-11 15:00 NZST：用户另行指定“测试b”，按上一轮规则仅执行一次 B 身份验证，成功才保存首次绑定；dry-run 后唯一身份 GET 返回 HTTP 200 / API -100（`SESSION_EXPIRED`）。未创建绑定、未搜索/读取详情、未生成 capture；停止后未重试或测试其他账号。本次请求不扩大搜索、详情或账号范围，证据见[协议登录说明](experiment/protocol-method.md#已验证的登录方式与结果)。
- 2026-09-11 15:36 NZST：用户另行指定“测试c”，按相同规则仅执行一次 C 身份验证，成功才保存首次绑定；dry-run 后唯一身份 GET 返回 HTTP 200 / API -100（`SESSION_EXPIRED`）。未创建绑定、未搜索/读取详情、未生成 capture；停止后未重试或测试其他账号。本次请求不扩大搜索、详情或账号范围，证据见[协议登录说明](experiment/protocol-method.md#已验证的登录方式与结果)。
- 2026-09-11 15:54 NZST：用户再次指定“测试d”，按相同规则仅执行一次 D 身份验证，成功才保存首次绑定；dry-run 后唯一身份 GET 返回 HTTP 200 / API -100（`SESSION_EXPIRED`）。未创建绑定、未搜索/读取详情、未生成 capture；停止后未重试或测试其他账号。本次请求不扩大搜索、详情或账号范围，证据见[协议登录说明](experiment/protocol-method.md#已验证的登录方式与结果)。
- 2026-09-11 17:56 NZST：用户提供并登记 `test_f` Cookie 后另行要求使用 F 实验，按相同规则执行一次新版协议身份探针。dry-run 后唯一身份 GET 返回 HTTP 200 / API 0，非游客身份通过，保存首次观测摘要绑定；未启动浏览器、未搜索/读取详情、无 capture，未重试或测试其他账号。此次身份通过不扩展搜索或详情授权，规范证据见[协议登录说明](experiment/protocol-method.md#已验证的登录方式与结果)。
- 2026-09-11 19:51–19:52 NZST：用户在 F 身份通过后明确要求进行搜索，授权仅 F、原批准公开样本、身份复核及一次关键词第一页搜索，不含详情。新增 `--search-only` 并通过 119 项离线测试、dry-run 后执行一次 `client_revision=3`：身份 HTTP 200 / API 0，摘要匹配；搜索 HTTP 461 / API 0，`verifytype` 与 `verifyuuid` 响应头均存在，按 HTTP 硬停止。无目标 capture/token、无详情，未重试、换词/账号/路线；诊断与证据边界见[协议登录说明](experiment/protocol-method.md#2026-09-11-f-仅搜索尝试身份通过搜索返回验证标志)。本次身份仍有效，不能归因于已确认的 Cookie 过期，后续在线请求暂停。
- 2026-09-12 18:57 NZST：上述 ReaJason 对照已完成；F 的现有协议预检与 SDK 身份复核均 HTTP 200 / API 0、摘要匹配，未测试 A–E。SDK 原生搜索接入当前本地签名后仍 HTTP 461，带验证相关响应头；没有详情、capture、token 保存或重试，后续在线请求暂停。规范证据见[ReaJason 实测](experiment/protocol-method.md#2026-09-12-reajasonxhs-搜索对照)。
- 2026-09-12 22:34 NZST：新小号 G 的自有 `client_revision=3` 仅搜索实验完成；身份与搜索均 HTTP 200 / API 0，建立首次观测摘要绑定，第一页精确命中原批准帖子并取得 token。source 按搜索上下文设置而非响应返回；仅保存私有最小材料，没有详情、媒体、重试或 A–F 复测。规范证据见[G 实测](experiment/protocol-method.md#2026-09-12-g-自有脚本身份及搜索成功)。本轮授权已执行完毕，不自动继续详情或 ReaJason 对照。
- 身份成功不扩大访问资产、请求预算或停止条件，不意味着 token 算法已经破解，也不授权把签名或 token 实现接入 Core。任何后续恢复仍限定单账号、单个批准公开样本，并须重新确认可执行条件。
- 2026-09-13 12:00 NZST：用户要求 F 常见只读功能检查；新增独立受限入口并通过离线测试和 dry-run 后，唯一身份 GET 返回 HTTP 200 / API -100，结果 `SESSION_EXPIRED`。资料与发帖列表均未请求，未改 Cookie/绑定、未重试或换号。此专项授权已执行并停止，后续需更新会话及另行确认；规范结果见 [F 能力检查](experiment/protocol-method.md#2026-09-13-f-常用只读功能检查)。

- 2026-09-13 13:46–13:49 NZST：本次 A–F 身份复核已执行，每个账号唯一 GET 均 HTTP 200 / API -100、`SESSION_EXPIRED` 且无验证/风险提示。13:49:41 按条件清空外部配置中六份 Cookie，保留账号条目、绑定和历史；G Cookie 原值保留并加“小号”标签，本轮未请求 G。配置及 fail-closed 检查通过，详见[复核与清理](experiment/protocol-method.md#2026-09-13-af-身份复核与条件清理)。本轮授权执行完毕，不自动重试或开展搜索。

## signoff
- ready_for_act: true
- checklist:
  - [x] auth.status = granted
  - [x] in_scope.assets non-empty
  - [x] network_profile.mode chosen
  - [x] out_of_scope reviewed
