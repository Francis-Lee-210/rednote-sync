# HTTP Cookie 实验方法

分类：研究方法、实现说明与受控动态证据。更新日期：2026-09-13。产品权威仍为 [产品设计](../../../../../docs/design/product-design.md)；本文不决定产品登录方式。

## 已验证的登录方式与结果

2026-09-09 23:18 NZST，用户指定的 `test_e` 使用仓库外完整 Cookie header，经 `httpx==0.28.1` 携带 `xhshow==0.2.0` 本地生成的 `xys` 请求签名，向固定当前用户接口发送一次 GET。接口返回 HTTP `200`、业务码 `0`；脚本确认 API 成功、`guest is False` 和有效用户 ID，结果为 `PROTOCOL_IDENTITY_VERIFIED`。全程未启动浏览器或进行扫码、手机登录。

这里的“Cookie 登录”是**复用并验证已有会话**：服务端接受现有 Cookie，而不是脚本创建了新会话或把失效 Cookie 变为有效 Cookie。验证的是完整输入与固定签名/客户端的组合，不能推出只提供 `web_session` 或只提供 `a1 + web_session` 就足够。

| 受控身份探针 | HTTP / API code | 结果与证据边界 |
|---|---|---|
| `test_d`，2026-09-09 21:43 NZST | `200 / -100` | `SESSION_EXPIRED`；未通过身份验证，不能据此判断账号永久受限 |
| `test_e`，2026-09-09 23:18 NZST | `200 / 0` | `PROTOCOL_IDENTITY_VERIFIED`；首次观测身份绑定 `first_observed`，不是与预先提供的账号 ID 独立核对 |
| `test_e`，2026-09-10 01:30 NZST | `200 / 0` | 单帖运行的身份步骤通过，摘要与已有绑定 `matched`；随后搜索 HTTP `461` 硬停止，整次运行不是 `PROTOCOL_COMPLETE` |
| `test_e`，2026-09-10 17:19 NZST | `200 / -100` | 用户要求修复后再试；`client_revision=2` 在身份请求返回 `SESSION_EXPIRED` 后停止，未发送搜索或详情请求 |
| `test_a`，2026-09-10 19:42 NZST | `200 / -100` | 用户单独授权一次身份验证及成功后的首次绑定；身份未通过，未创建绑定、未搜索或读取详情 |
| `test_b`，2026-09-11 15:00 NZST | `200 / -100` | 用户指定 B 后按同一规则仅验证身份；结果 `SESSION_EXPIRED`，未创建绑定、未搜索或读取详情 |
| `test_c`，2026-09-11 15:36 NZST | `200 / -100` | 用户指定 C 后按同一规则仅验证身份；结果 `SESSION_EXPIRED`，未创建绑定、未搜索或读取详情 |
| `test_d`，2026-09-11 15:54 NZST | `200 / -100` | 用户再次指定 D，使用修复版仅验证身份；结果 `SESSION_EXPIRED`，未创建绑定、未搜索或读取详情 |
| `test_f`，2026-09-11 17:56 NZST | `200 / 0` | 用户提供新 Cookie 并指定 F；`client_revision=2` 确认非游客身份并建立 `first_observed` 摘要绑定；未搜索或读取详情 |
| `test_f`，2026-09-11 19:51 NZST | `200 / 0` | 用户另行批准仅搜索；`client_revision=3` 身份复核通过并与既有摘要 `matched`，随后搜索 HTTP `461`，带验证相关响应头，未请求详情 |
| `test_f`，2026-09-12 18:45 NZST | `200 / 0` | 为用户指定的 ReaJason/xhs 对照筛选账号；现有协议身份探针通过且摘要匹配，立即停止候选筛选，未测试 A–E |
| `test_f`，2026-09-12 18:56–18:57 NZST | `200 / 0` | ReaJason SDK `get_self_info2()` 接入本地签名后通过并匹配；随后该 SDK 的 `get_note_by_keyword()` 返回 HTTP `461`，未请求详情 |
| `test_g`，2026-09-12 22:33–22:34 NZST | `200 / 0` | 新小号使用自有 `client_revision=3`；非游客身份通过，建立 `first_observed` 摘要绑定，随后搜索也 `200 / 0`，精确命中批准帖子并取得目标 token；未请求详情 |
| `test_f`，2026-09-13 12:00 NZST | `200 / -100` | 用户要求常用只读功能检查；身份门禁返回 `SESSION_EXPIRED`，仅一次请求后停止，资料与发帖列表均未请求；不能由旧身份成功推断当前 Cookie 仍有效 |
| `test_a`–`test_f`，2026-09-13 13:46–13:49 NZST | 各 `200 / -100` | 用户要求逐个复核；六个均 `SESSION_EXPIRED`、无验证头或风险提示，各一次身份请求。满足条件后清空 A–F 的 Cookie；G 原值保留并标为“小号”，本轮未请求 G |

2026-09-09 的两次探针各发送一次身份请求，均未搜索或读取详情；2026-09-10 01:30 的单帖尝试另发送一次身份请求和一次搜索请求，详情未执行。用户在修复后要求再次尝试，17:19 的新版运行只发送一次身份请求便停止；这些运行均未自动重试。E 保留首次观测与一次摘要匹配复核两次历史正面身份结果，但最新输入与客户端组合未通过验证，不能由旧成功推断当前会话有效或续期。本次结果不证明 Cookie 的有效期、网页登录、搜索/详情权限、主号列表可见性、跨账号 token 复用或低风险保证。

19:42 的 A 探针先通过本地 dry-run，再执行一次 `client_revision=2` 身份 GET（当日第 1 次登录尝试）；报告为 `data/protocol-runs/test_a_20260910T194246_b8383c6f.json`，权限 `0600` 且被 Git 忽略。响应为 JSON object，两个验证 header 均不存在，未命中固定消息提示；结果 `SESSION_EXPIRED`、`identity_verified=false`。未创建 A 身份绑定、未发送搜索/详情、未生成 capture，也未继续尝试 B/C/D 或重试 A。这只证明本次 A 的 Cookie 与客户端组合未通过会话验证，不能据此判断账号永久受限或失效的具体原因。

2026-09-11 15:00:35–15:00:45 NZST，用户另行指定 `test_b`，本地 dry-run 通过后只执行一次 `client_revision=2` 身份 GET（当日第 1 次登录尝试）。报告 `data/protocol-runs/test_b_20260911T150035_cda036c5.json` 记录 HTTP `200`、API code `-100`、`identity_verified=false`；响应为 JSON object，`verifytype_present=false`、`verifyuuid_present=false`、`message_flags=[]`。报告权限 `0600` 且被 Git 忽略；未创建 B 身份绑定、未搜索/读取详情、无 capture，也未重试或继续测试其他账号。本结果只说明本次 B 的 Cookie 与客户端组合未通过会话验证，不证明账号永久受限、具体失效原因或其他 Cookie 的状态。

2026-09-11 15:36:41–15:36:55 NZST，用户另行指定 `test_c`，本地 dry-run 通过后只执行一次 `client_revision=2` 身份 GET（当日第 1 次登录尝试）。报告 `data/protocol-runs/test_c_20260911T153641_272197fb.json` 记录 HTTP `200`、API code `-100`、`identity_verified=false`；响应为 JSON object，`verifytype_present=false`、`verifyuuid_present=false`、`message_flags=[]`。报告权限 `0600` 且被 Git 忽略；未创建 C 身份绑定、未搜索/读取详情、无 capture，也未重试或继续测试其他账号。A/B/C 在各自本次身份验证中得到相同分类，但这不证明账号永久受限、具体失效原因或搜索修复是否有效。

2026-09-11 15:54:07–15:54:13 NZST，用户再次指定 `test_d`，本地 dry-run 通过后只执行一次 `client_revision=2` 身份 GET（当日第 1 次登录尝试）。报告 `data/protocol-runs/test_d_20260911T155407_ff78daf2.json` 记录 HTTP `200`、API code `-100`、`identity_verified=false`；响应为 JSON object，`verifytype_present=false`、`verifyuuid_present=false`、`message_flags=[]`。报告权限 `0600` 且被 Git 忽略；未创建 D 身份绑定、未搜索/读取详情、无 capture，也未重试或继续测试其他账号。至此 A/B/C/D 各自获准的修复版身份探针均返回 `-100`，只能确认这些运行未通过身份验证，不能确定共同根因、账号永久限制或搜索修复是否有效。

2026-09-11 17:56:00–17:56:16 NZST，用户指定 `test_f` 后，本地 dry-run 通过，执行一次 `client_revision=2` 协议身份探针。唯一身份 GET 返回 HTTP `200`、API code `0`，`identity_verified=true`、`result=PROTOCOL_IDENTITY_VERIFIED`，非游客身份及有效用户 ID 检查通过；按本次观察到的身份建立 `first_observed` 摘要绑定，不声称与预先提供的账号 ID 独立核对。当日登录尝试为第 1 次，capture 尝试为 0；未启动浏览器、未搜索/读取详情、未生成目标 capture 或 token，也未重试或测试其他账号。报告 `data/protocol-runs/test_f_20260911T175600_a3a36070.json` 和 F 身份摘要文件均为 `0600` 且被 Git 忽略。本结果证明 F 的此次输入与当前客户端组合可通过协议身份验证，不保证未来有效或搜索/详情可用，也不反向证明 A–E 自然过期。

脱敏摘要的规范入口为本节；逐次经过保留在[时间线](../timeline.md)。身份探针的本地审计文件为已忽略的 `data/protocol-runs/test_e_20260909T231831_1525da4f.json` 与 `data/protocol-runs/test_d_20260909T214318_4ddbdb68.json`；单帖运行摘要见下文。不复制 Cookie、签名、平台用户 ID 或身份摘要到文档。

### 当前账号登记状态

更新：2026-09-13 13:49 NZST。按用户授权复核 A–F，六个都明确返回 `200 / -100`、`SESSION_EXPIRED`，随后清空它们在仓库外账号配置中的 Cookie。G 的 Cookie 原值保留，并增加“小号”标签；内部 ID 仍为 `test_g`。本轮未请求 G，不得由其 9 月 12 日成功记录推定现在仍有效。详见[本轮复核与清理](#2026-09-13-af-身份复核与条件清理)。

| 账号 | 当前记录状态 | 依据与限制 |
|---|---|---|
| `test_a` | **Cookie 已清空，历史条目保留** | 本轮身份 `200 / -100`；重新使用前需另行提供新 Cookie |
| `test_b` | **Cookie 已清空，历史条目保留** | 本轮身份 `200 / -100`；重新使用前需另行提供新 Cookie |
| `test_c` | **Cookie 已清空，历史条目保留** | 本轮身份 `200 / -100`；重新使用前需另行提供新 Cookie |
| `test_d` | **Cookie 已清空，历史条目保留** | 本轮身份 `200 / -100`；重新使用前需另行提供新 Cookie |
| `test_e` | **Cookie 已清空，历史条目与绑定保留** | 本轮身份 `200 / -100`；此前成功记录不被改写 |
| `test_f` | **Cookie 已清空，历史条目与绑定保留** | 本轮身份 `200 / -100`；9 月 12 日身份成功、搜索 461 的历史结果保留，不反向归因为当时已过期 |
| **小号**（`test_g`，原 G） | **Cookie 原值保留，本轮未复测** | 私有配置 `label="小号"`；9 月 12 日自有脚本身份及搜索 `200 / 0`、目标已发现。不代表本轮已确认仍有效 |

这些标记描述的是已提供 Cookie 与客户端组合的会话状态，不是账号永久封禁或无法重新登录的结论；`-100` 也不能独立证明自然过期。[前后代码对照](#2026-09-11-成功版与失败版的离线代码对照)没有找到能解释 E 历史结果变化的已验证代码原因，但不排除未观测输入、环境或服务端因素。

F 在 2026-09-11 登记时，凭据仅写入既有仓库外私有账号文件，文件权限 `0600`、目录权限 `0700`，当时原 A–E 配置保持不变。只将消息中字段名的 Markdown 转义 `acw\_tc`、`web\_session`、`id\_token` 还原为标准下划线，未改动 Cookie 值；没有补造、拼接或续期任何字段。未提供来源浏览器 UA，因此仍留空，不把默认 UA 当作实际设备信息。该 F 凭据现已按上表清空；字段含义与证据等级见 [Cookie 字段说明](cookie-fields.md)。

G 来自用户本轮另行提供、其确认已在 Chrome 网页登录的小号。最终输入有 16 项，包含旧样本的 13 项，另有 `unread`、`websectiga`、`sec_poison_id`；本轮未确定这些新增字段的作用或必要性。字段名仅还原聊天下划线转义，值完整保留；私有登记时验证 A–F 原记录内容未改变。网页可用是用户报告，本轮代理只验证协议身份和搜索，没有读取或控制其浏览器。

## 调整依据

用户要求参考 Codex 任务“实施方案-项目登录方式”（`01a067ad-a025-73e0-bfe4-bd2605b20c52`）调整实验。已读取的对话最新讨论的是“纯协议是否指直接在 HTTP 请求中携带 Cookie”；同事的具体实现、示例和成功判据尚未给出。因此这里实现的是可独立验证的 HTTP 候选路线，不声称复现同事的内部方案。

浏览器历史失败不能证明这些 Cookie 在协议客户端中一定无效；反过来，协议身份通过也不证明浏览器恢复成功。两条路线改变了请求 origin、签名产生方式及客户端环境，结果差异不能归因于单一因素。

## 固定调用链

| 步骤 | 固定操作 | 通过判据 |
|---|---|---|
| 身份 | `GET https://edith.xiaohongshu.com/api/sns/web/v2/user/me` | 2xx、JSON 明确成功、`guest is False`、稳定 ID 和身份摘要匹配 |
| 搜索（可选） | 同 origin 的 `POST /api/sns/web/v1/search/notes` | 从已批准样本读取关键词，只请求第一页、最多 20 项；精确匹配目标 ID |
| 详情（可选） | 同 origin 的 `POST /api/sns/web/v1/feed` | 使用同次搜索的目标 token/source；详情卡片 ID、类型及正文/媒体结构存在 |

这里两个 POST 在业务上都是读取操作，基础入口仅允许上述 method/path 组合，不允许平台写入。另行授权的 F [能力检查](#2026-09-13-f-常用只读功能检查)使用独立的两项 GET 白名单，不放宽此入口。省略 `--note-id` 时只有身份步骤，不读取 notes 文件。提供帖子 ID 时，仍须先通过身份门禁；没有命中则返回 `NOT_DISCOVERABLE_FIRST_PAGE`，不能扩大解释为“全站不存在”。

提供 `--note-id --search-only` 时只执行身份复核和一次搜索，最多两个 HTTP 请求；取得精确目标的访问材料后立即结束，不请求详情。该开关仅适用于协议路线，缺少批准样本或查询时在联网前拒绝。默认的 `--note-id` 流程仍包含详情，不能用于仅获准搜索的运行。

`xsec_token` 必须来自精确匹配的搜索条目，不生成、不从裸 ID 页面猜测、不接受命令行 token。搜索响应有 `xsec_source` 时记录 `source_origin=response`；没有时将搜索上下文 `pc_search` 作为详情请求参数，并记录 `source_origin=search_context`。后者是显式构造的上下文，不是捕获到的 source 证据。冲突 ID、token 或 source 均停止。

## 会话与判定

- Cookie 仍来自用户指定的仓库外账号文件，要求完整 header，至少含 `a1` 与 `web_session`。这些字段存在只是输入检查，不能证明登录成功。
- 协议不需要 `profile_dir`，兼容已有账号文件中的该字段。可选 User-Agent 仅接受可识别的 Windows/macOS 桌面 Chrome/Edge 格式，同步传入 HTTP header 与签名配置，并使两个签名模板的平台字段一致；未知、移动端、格式不合法或平台冲突的值在联网前拒绝。留空时保留锁定库的全部默认配置；不宣称恢复了 Cookie 来源设备，也不修改 SDK 版本或签名格式。
- `xhshow` 仅在本地计算 `x-s`、`x-t` 等请求签名；这些是 HTTP 请求签名，与发现上下文中的 `xsec_token` 不同。固定 `xys` 格式；不会在拒绝后自动改签名、切 endpoint 或切浏览器继续。
- 每次运行建立独立 HTTP 客户端和签名状态；Cookie 输入在整个运行中保持不变，忽略 `Set-Cookie`，不回写外部文件。此版本只检验当前快照，不测试续期、重新登录或持久化恢复。报告不记录 Cookie 内容指纹，所以两次运行的身份摘要 `matched` 只证明身份一致，不能证明跨运行 Cookie 字节完全相同；冻结输入的代码保证仅适用于每个运行内部。
- 首次无预期 ID 时须显式 `--bind-identity`，报告标为 `first_observed`；后续必须匹配协议绑定或输入中的 expected digest。只存摘要，不保存平台原始 ID；与浏览器 marker 分开。
- 相同账号、输入 Cookie 的浏览器与协议实验应分别启动和记录。任何一次受限后都不在同一运行中自动改路线。

## 请求与记录范围

TLS 校验开启；不继承环境代理，不跟随重定向，不重试。403/429/461/471、验证码/设备校验、401、`-100`、签名错误、未知 JSON 或身份不匹配都停止。HTTP 状态、API 数字 code 与固定失败分类分开记录；500、非 JSON 或签名失败不标作 Cookie 已过期。

两条路线共用全局在线锁及每账号每天 3 次登录、3 次 capture 的台账。协议身份失败也占一次登录尝试；搜索前才占 capture 尝试。协议每个请求沿用 policy 延迟和超时，正常响应最多 2 MiB，已判定失败的诊断正文最多 16 KiB，整体 210 秒；统一入口另有 225 秒父进程超时。

`data/protocol-runs/` 只保存账号别名、方法、固定版本、步骤状态、HTTP/API 数字状态、时间、验证布尔值及下述白名单化失败诊断。`data/protocol-identities/` 只保存方法和身份绑定摘要。仅目标 token/source 可写入 `data/captures/` 的私有 JSONL；不写整页搜索结果、关键词、正文、Cookie、签名、原始账号 ID 或原始响应 header。目录权限 700、文件权限 600，均被 Git 忽略。

`PROTOCOL_IDENTITY_VERIFIED` 表示本次 API 身份验证通过；`PROTOCOL_SEARCH_VERIFIED` 表示仅搜索模式取得了精确目标的访问材料，详情没有请求；`PROTOCOL_COMPLETE` 额外表示详情验证通过。三者都不证明网页登录、媒体下载、批量导出或长期稳定性。

### 仅搜索模式（client_revision=3）

2026-09-11 新增 `--search-only`，报告版本升为 `3`，并区分 `search_api_succeeded`（搜索 API 明确成功）、`target_discovered`（提取到精确目标的完整访问材料）与 `detail_verified`。搜索 API 成功但第一页未找到目标时，前者为 `true`、后两者为 `false`，结果仍为 `NOT_DISCOVERABLE_FIRST_PAGE`；这不是搜索接口被拒或帖子不存在的证据。缺 token 或材料冲突也不会标作目标发现成功。

此版本只调整运行范围及报告，不修改身份请求、搜索正文、签名配置或失败分类；`protocol_session.py`、`protocol_signer_config.py`、`protocol_diagnostics.py` 的变更前后内容哈希一致。历史报告仍保留原版本，不补写新字段。新增 [13 项仅搜索测试](tests/test_protocol_search_only.py)，全实验 **119 项离线测试通过**，覆盖仅两次请求、不读详情、HTTP 461 硬停止、未命中、缺 token、身份失效、入口参数和 dry-run；全部使用合成输入及 Mock，不代替在线结果。

### 失败诊断（client_revision=2）

2026-09-10 离线修复后，新运行报告增加 `client_revision: 2`，用于区别修复前的客户端；身份方法及绑定格式仍为 `http-cookie-v1`，不会因本次修复要求重新绑定或重置次数。修复阶段未联网；随后用户授权的 17:19 新版在线结果见[身份失效记录](#2026-09-10-1719-新版尝试在身份阶段停止)。旧报告不补写或推断历史错误详情。

失败步骤的 `requests[]` 条目可增加以下字段：

- `api_code`：仅保留 JSON 顶层 `code` 的 32 位有符号整数；缺失、布尔值、字符串、浮点数或越界数字不记录，不能把缺失解释为 `0`。
- `diagnostics.verifytype_present` / `verifyuuid_present`：仅记录响应头字段是否存在，空值也视为存在；绝不记录验证类型原值、UUID、挑战 URL 或 `Set-Cookie`。
- `diagnostics.content_type`：`json`、`html`、`text`、`other`、`missing` 五种固定枚举，不保存原始 Content-Type。
- `diagnostics.body_state`：`json_object`、`non_object_json`、`non_json`、`invalid_json`、`too_large`、`timeout`、`read_error` 或 `encoded_body_skipped`。
- `diagnostics.message_flags`：仅从顶层字符串 `msg` / `message` 的前 2048 字符识别 `captcha_hint`、`security_verification_hint`、`device_verification_hint`、`rate_limit_hint`、`login_hint`；不保存原文、不遍历帖子正文。这些只是文字提示命中，不是已确认的拒绝根因。

已知 HTTP 失败优先决定 `result`。例如收到 `461` 时，即使正文另有业务码或诊断读取失败，仍保留 `HTTP_RISK_STOP`；在取证前先标记会话停止，不发任何后续请求。诊断最多读取 16 KiB 未编码 JSON，非 JSON 与压缩正文不读取/解压；重复 JSON key、非法值或深度异常不作为证据。短读取预算为 2 秒、在原始数据块之间检查，单次阻塞读取仍受原有 httpx read timeout 和总运行截止约束，不声称 2 秒是抢占式硬超时。

以下仅为**合成测试示例**，不是 E 的真实响应：

```json
{
  "result": "HTTP_RISK_STOP",
  "http_status": 461,
  "api_code": 300015,
  "diagnostics": {
    "verifytype_present": true,
    "verifyuuid_present": false,
    "content_type": "json",
    "body_state": "json_object",
    "message_flags": ["security_verification_hint"]
  }
}
```

## 实现来源与版本

参考的是仓库中已有 [Cookie 登录研究](../../../../topics/cookie-login-implementations.md) 的 HTTP 分层，而非执行其中的第三方 checkout：

- [xiaohongshu-cli 固定版本的 HTTP 客户端](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/client.py)：Cookie header、签名与 API transport 的分离。
- [同版本的只读接口定义](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/client_mixins.py)：当前用户、关键词搜索与 feed 详情的 method/path 和参数。没有导入它的浏览器 Cookie 自动提取、缓存、自动重试或 API/HTML 回退链。
- [xhshow v0.2.0 的签名 API](https://github.com/Cloxl/xhshow/blob/v0.2.0/src/xhshow/client.py) / [发布记录](https://github.com/Cloxl/xhshow/releases/tag/v0.2.0)：安装锁定的本地签名依赖，使用其公开 API，不复制签名算法。
- HTTP 客户端为 `httpx==0.28.1`，依赖版本完整锁定在 [requirements.txt](requirements.txt)。

上述版本与方法是实验变量；公开源码存在不等于当前平台接受。代码实现时完成了 82 项离线测试，覆盖合成 Cookie、本地签名和 Mock HTTP；真实结果见[已验证的登录方式与结果](#已验证的登录方式与结果)及下文单帖尝试。身份请求成功、搜索请求 HTTP `461`，尚不能证明搜索/详情 POST 签名或响应契约可用，也不能仅凭该状态断定签名错误。

2026-09-10 针对 [`test_protocol.py`](tests/test_protocol.py) 的 19 项离线测试复核全部通过，含 `461` 停止、不重试及不回退判据；这次验证没有新增平台请求，不代替在线成功证据。

## 登录成功后的 token 研究顺序

可以继续离线研究；2026-09-11 的 F 首次身份验证与后续摘要匹配复核均通过，但新版搜索返回 HTTP 461，并带有验证相关响应头。此次已停止，尚无目标 token。身份通过不自动恢复搜索或详情请求，后续仍须单独确认条件与范围。先区分三层证据：

| 层次 | 当前证据 | 仍不能得出的结论 |
|---|---|---|
| Cookie 会话身份 | E 曾通过两次，之后返回 `-100`；F 于 2026-09-11 17:56 首次观测绑定，19:51 再次通过并匹配摘要 | 不能保证未来有效、续期、浏览器恢复或其他账号成功；不能由旧成功推断当前会话有效 |
| `x-s` / `x-t` / `x-s-common` 请求签名 | 固定本地签名实现参与 E、F 各两次成功身份 GET；E、F 搜索 POST 均返回 HTTP `461` | 不等于 `xsec_token` 生成算法；未证明搜索/详情 POST 可用或查明搜索被拒原因 |
| 帖子 `xsec_token` | 固定源码与历史浏览器实验显示发现层读取、向详情层传递；最新 F 搜索在 HTTP `461` 停止 | 未取得目标 token 或详情；产生位置、输入依赖、生命周期及可计算性未确定 |

先前的单帖实验使用 `test_e` 和一个已批准公开样本，按[手册第 4 节](runbook.md#4-协议单帖发现与详情验证)设计了以下顺序，并在搜索请求处停止。以下保留该既有流程；F 后续仅获准按[第 3b 节](runbook.md#3b-仅搜索不读详情)复核身份并搜索一次，也已停止，不代表继续联网或请求详情的指令：

1. 重新核验身份并匹配已有 E 绑定，再搜索一次已知标题或正文关键词，仅检查第一页的精确 `note_id`；不打开裸 ID 链接。
2. 确认目标 token 是否已存在于搜索 API 响应，分别记录服务端返回的 source 与按搜索上下文构造的 `pc_search`。只把目标访问材料保存在私有 capture。
3. 用同次搜索得到的材料读取一次详情，要求目标 ID 及正文/媒体结构匹配。到 `PROTOCOL_COMPLETE` 才算单帖协议链路通过；这仍只是获取并使用 token，不是生成算法破解，也没有下载媒体或接入 Core。
4. 在该样本证据和固定公开前端源码上做离线数据流追踪，区分本地计算、服务端响应下发和前端透传。2026-08-20 的[静态记录](../timeline.md)仅在当时的两组 bundle 中找到消费点，没有找到生成器；这是“可能在服务端产生”的线索，不是对全部实现的证明。

若后续获准实验中 token 在 API 响应中已经存在，可以研究它的下发条件与使用约束，但仅靠这些输出不能推出服务端密钥或完整生成算法。时间、入口、账号等对照须单独设计并保留预算与停止条件；当前脚本不提供错配 token、任意重放或跨账号矩阵。2026-09-09 文档同步时尚未执行单帖请求；2026-09-10 的首次单帖尝试如下，未扩大授权或把签名/token 实现接入 Core。

### 2026-09-11 F 仅搜索尝试：身份通过，搜索返回验证标志

用户在 F 身份探针成功后明确要求“搜索，进行”。本轮仅授权 F、原已批准公开样本、身份复核后的一次关键词搜索，不含详情。先补充并离线验证 `--search-only`，dry-run 通过后执行一次 `client_revision=3` 运行。报告 `data/protocol-runs/test_f_20260911T195145_64fb196e.json` 记录 UTC `2026-09-11T07:51:45` 至 `07:52:06`，即 NZST 19:51:45–19:52:06；`phase=search`、`search_only=true`。

| 实际步骤 | 脱敏结果 | 可确认的事实 |
|---|---|---|
| 身份 GET | HTTP `200`、API code `0`、`identity_verified=true`、`identity_binding=matched` | 本次非游客身份有效且与已有 F 摘要匹配，不是身份接口返回 `-100` |
| 搜索 POST | HTTP `461`、API code `0`、`HTTP_RISK_STOP` | HTTP 硬停止优先，正文数字 `0` 不使请求变为成功；验证相关响应头 `verifytype`、`verifyuuid` 均存在 |
| 搜索、token 与详情 | `search_api_succeeded=false`、`target_discovered=false`、`detail_verified=false`，无 capture | 搜索结果未被接受或解析，没有本次目标访问材料，未请求详情 |

失败诊断为 `content_type=json`、`body_state=json_object`、`message_flags=[]`；只保存字段存在性，不保存验证类型、UUID、挑战 URL 或原始消息。因此本次有服务端验证标志的证据，但不能确定验证形式是二维码、滑块还是设备确认，也不能据此确认触发原因是 Cookie、签名、客户端环境或账号限制。没有固定文字提示命中不表示验证要求不存在。

本轮共两次 HTTP 请求；当日登录尝试第 2 次、capture 尝试第 1 次，未翻页、换词、重试、切账号/签名/浏览器或复用截图 token。报告、更新后的 F 身份摘要及台账均为私有权限且被 Git 忽略。F 的身份本次仍通过，所以不能把此次搜索失败解释为已经确认的 Cookie 过期；同样，身份成功也不证明当前搜索实现被服务端接受。后续在线操作已暂停。

### 2026-09-10 单帖尝试：身份通过，搜索硬停止

用户选定公开的单图短文帖子作为目标。既有脱敏运行摘要 `data/protocol-runs/test_e_20260910T013022_86652a36.json` 记录运行时间为 UTC `2026-09-09T13:30:22` 至 `13:30:44`，即 NZST 2026-09-10 01:30；`phase=discovery`，当天 `login_attempt=1`、`capture_attempt=1`。恢复任务时确认该报告已存在，因此没有重复发送这套请求；逐次经过见[时间线](../timeline.md)。

| 实际步骤 | 脱敏结果 | 可确认的事实 |
|---|---|---|
| `GET /api/sns/web/v2/user/me` | HTTP `200`、API code `0`、`identity_verified=true`、`identity_binding=matched` | 本次身份通过并与已有 E 摘要匹配，不是首次任意绑定或 Cookie 续期 |
| `POST /api/sns/web/v1/search/notes` | HTTP `461`、`HTTP_RISK_STOP` | 搜索请求被硬停止；未解析搜索结果、业务码或挑战内容 |
| token/source 与详情 | 无 `capture` / `source_origin`，`detail_verified=false` | 没有本次目标 token/source 证据，未发送详情请求，未验证帖子正文或图片 |

最终结果为 `HTTP_RISK_STOP`。当时旧版 `ProtocolSession._request()` 在遇到 `461` 时先于 JSON/挑战内容解析抛出停止分类；[现实现](scripts/protocol_session.py#L156)已增加脱敏诊断，但无法补回这次历史响应。[`run_protocol()`](scripts/protocol_experiment.py#L93) 只有在搜索成功并提取目标材料后才创建 capture 和请求详情。因此不能把本次结果写成“搜索未命中”“Cookie 已过期”或确定的 CAPTCHA，也不能据此归因于账号永久限制、IP 或签名错误；根因仍未确定。相应的[离线停止条件测试](tests/test_protocol.py#L99)证明的是代码不重试/回退，不是平台拒绝原因。

当前暂停后续在线尝试，只分析已有脱敏证据与固定源码；不切换账号、签名格式、端点或浏览器路线规避本次停止。本次尚未推进到 token 来源的动态验证，更没有验证生成算法。恢复在线实验需要单独确认条件和范围。

### 单帖内容与 token 来源的证据边界

以下是 2026-09-10 对当前实验源码的复核，仅描述代码能力，不表示本次已通过搜索或详情；选用“一张图片、少量文字”的样本便于人工比对，但不会自动提高脚本的验证强度。

- **若搜索成功，来源可追踪到同次响应。** [`access_material()`](scripts/protocol_session.py#L290) 只接受目标 ID 一致的搜索条目中的 token；[`ProtocolSession.detail()`](scripts/protocol_session.py#L278) 再核对访问材料来自同次搜索。`source_origin` 区分响应自带 source 与构造的 `pc_search`；这些证据只能定位客户端取得材料的位置，不能证明服务端内部如何生成 token。
- **详情通过不等于逐字段核对。** 在 HTTP/API 成功后，[`require_detail()`](scripts/protocol_session.py#L330) 要求目标卡片 ID 和类型正确，并存在非空正文或非空图片/视频结构；不要求正文与截图相同，也不要求图片恰好一张。仅非空媒体字典不足以证明图片 URL 有效或画面内容一致。
- **当前记录不足以事后复核一图一文。** [`run_protocol()`](scripts/protocol_experiment.py#L93) 只把目标 token/source 写入私有 capture，并保存目标 ID 的详情通过标记；报告保留步骤状态和验证布尔值，不保存正文、图片数量或完整媒体元数据。[`Recorder.emit()`](scripts/experiment_io.py#L31) 只写调用方提供的这些字段，不另行归档响应。若后续需要验收“一张图片与少量文字”，须先增加脱敏结构摘要，再执行相应实验，不能从现有布尔值补推。
- **媒体元数据不等于媒体文件。** 当前 [`READ_OPERATIONS`](scripts/protocol_session.py#L28) 仅含身份、搜索与详情 API；详情请求里的 `image_formats` 只是请求参数。程序没有图片 CDN 下载或图片字节校验步骤，所以单帖链路通过也不代表媒体下载、文件导出或可离线展示完成。

### 2026-09-10 搜索失败的离线诊断

> 本节保留修复前的诊断证据；后续已按用户授权完成下节的离线修复，不能将本节旧实现描述当作当前缺陷状态。真实 HTTP `461` 的根因仍未确定。

诊断轮只核对上述脱敏结果、当时本地实验源码与作者固定版本的公开源码，并使用合成 Cookie、Mock HTTP 做离线检查；没有读取真实 Cookie、浏览器状态或 HAR，没有新增平台请求。当时结论是：**搜索实现存在需要核验的精简差异，诊断记录也有确定的信息缺口；尚未查明真实 HTTP `461` 的根因。** 身份 GET 成功不验证搜索 POST 的整套请求契约，不能先把失败归咎于账号或关键词。

| 核对项 | 查实情况 | 证据能说明什么 |
|---|---|---|
| 搜索入口与参数 | 本地与参考均为 `POST /api/sns/web/v1/search/notes`，第一页、20 项及主要参数相同；本地没有参考请求中的 `filters`。参考新搜索会话会先尝试 `onebox`、`filter`，捕获前置 `XhsApiError` 后仍继续 `notes`，成功后再尝试 `recommend`；本地只请求 `notes`。见[固定 CLI 搜索实现](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/client_mixins.py#L251-L292)及[本地实现](scripts/protocol_session.py#L256)。 | 不是接口路径随意写错，但也不是完整复现参考流程。源码对照不能证明被省略的字段或前置请求为平台强制条件，更不能证明补齐就能解决 `461`；额外请求仍不在当前三接口白名单内。 |
| 搜索 ID | 两边都是时间毫秒左移 64 位、加随机数，再转大写 base36；仅随机数最大值差 1。见[参考生成器](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/client_mixins.py#L41-L54)。 | 没有发现大小写或基本编码方法错误；该边界差异不能解释本次结果。 |
| 请求头与会话行为 | 参考有 `sec-ch-*`、`sec-fetch-*`、语言等 header，并吸收响应 Cookie；本地使用较少 header，明确冻结输入、丢弃 `Set-Cookie`。见[参考 transport](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/client.py#L85-L155)及[本地 transport](scripts/protocol_session.py#L171)。 | 都是实验变量，不能从代码差异推断远端要求，也没有证据证明本次身份响应确实下发了后续搜索必需的 Cookie。 |

签名方面，参考的[固定适配器](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/signing.py#L49-L67)没有显式指定 `sign_format` 或 `x_rap`，其[依赖声明](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/pyproject.toml#L20-L29)为 `xhshow>=0.1.9`，并未锁定唯一版本。对本实验锁定的 `xhshow==0.2.0`，[公开 API](https://github.com/Cloxl/xhshow/blob/v0.2.0/src/xhshow/client.py#L485-L517)默认仍是 `xys`；本地 POST 显式设置 `x_rap=True`，不是漏传该项。作者在该 API 和[发布记录](https://github.com/Cloxl/xhshow/releases/tag/v0.2.0)中将 XYW 与部分数据接口的 `406`、X-RAP 与搜索/feed 请求联系起来；这是作者实现和说明，不是本次 `461` 的因果证据，不能据此宣称“换成 XYW 即可修复”。

另有一个**条件性的本地配置一致性问题**：[本地 `LocalSigner`](scripts/protocol_session.py#L54)只按自定义 User-Agent 覆盖 `PUBLIC_USERAGENT`，不会同步修改两个签名模板的平台字段；库[默认模板](https://github.com/Cloxl/xhshow/blob/v0.2.0/src/xhshow/config/config.py#L85-L145)为 Windows / SDK `4.3.5`。因此若输入 macOS UA，模板仍声明 Windows；本轮以合成 macOS UA 初始化实际安装的 `xhshow==0.2.0`，禁用 socket 连接后确认两个平台字段仍为 Windows。参考则[同时覆盖 UA 和签名模板](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/signing.py#L18-L43)，使用其[固定 macOS / SDK `4.2.6` 常量](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/constants.py#L8-L18)。这能证明自定义配置路径可以不一致；本轮未读取 E 的真实 UA，也未证明该条件发生于实际运行，更不表示任一模板版本当前必然被服务端接受。

合成离线检查把两类问题分开验证：

- **合成用例中未发现的构造错误：** 两组包含中文、转义字符和 emoji 的输入共经过 4 次 Mock 请求；真实本地签名器使用的 XYS 内容与 X-RAP JSON 均对应实际发出的紧凑 UTF-8 正文，method/path/origin、输入 UA 与发送 UA、Cookie 和时间戳一致。人为增加一个正文空格或改动发送 UA 的负对照均能被检查捕获。这只检验这些合成用例中的客户端内部一致性，不验证远端签名算法或 UA 与模板平台的一致性，也不排除所有真实输入相关问题。
- **已确认的诊断缺口：** 给真实 `ProtocolSession.identity()` → `search()` 注入两种合成 `461` 响应，一种含数字业务码、不带挑战 header，另一种含不同业务码并带 `verifytype`，最终 `events` 完全相同。原因是[状态检查](scripts/protocol_session.py#L186)早于 JSON 和挑战 header 检查；它们都被折叠成 `HTTP_RISK_STOP`。这是对信息丢失的复现，不是对真实 `461` 根因的复现，也不说明当时真实响应包含上述任一种内容。

后续应先修订失败诊断，使硬停止与最小化取证可以并存：只保留有界、白名单化的数值业务码和挑战字段存在标志，不记录原始消息、挑战标识值、Cookie、token 或完整响应；并把当前搜索精简项与 UA/模板一致性列为独立待验证项。此处只是诊断建议，本轮未改运行脚本、增加端点、切签名或恢复线上尝试。缺失的历史响应信息无法从现有摘要补回。

### 2026-09-10 离线修复与验证

用户随后明确要求修复诊断信息丢失、UA 配置不一致和搜索参数差异。本轮按诊断技能把先前复现固化成回归测试：先观察错误码缺失、不同 `461` 事件完全相同、macOS UA 的两个模板仍为 Windows，以及默认 `filters` 缺失；再修复实际调用链并运行测试。

- [失败诊断](scripts/protocol_diagnostics.py)与[请求客户端](scripts/protocol_session.py)按上文白名单保留失败信息；读取超时、非法/超大/压缩正文、诊断器或关闭响应异常均不覆盖已知 HTTP 停止分类。报告带客户端版本号；旧报告、Cookie、绑定和预算均不迁移或修改。
- [UA 配置](scripts/protocol_signer_config.py)统一支持的桌面 UA 与两个签名平台字段，实例模板独立。保留 `xhshow==0.2.0`、SDK 默认值、XYS 与 POST X-RAP 设置，不自动猜测来源设备。
- 搜索 payload 补齐固定参考的五项默认 `filters`，与本实验固定的 `sort=general` / `note_type=0` 一致；每次独立构造。未增加 `onebox`、`filter` 或 `recommend` 请求，未改变 Cookie 快照策略、第一页限制或最多三次请求的预算。这是与参考默认参数对齐，不是已证实的 `461` 根因修复。

完整实验套件 **106 项离线测试通过**（其中协议相关 43 项），`pip check` 无依赖冲突。新增[诊断与搜索回归](tests/test_protocol_diagnostics.py)覆盖错误码/提示标志、完整 runner 报告的敏感哨兵不泄漏及 `0600` 权限、硬停止/无 capture、读取与关闭异常、JSON 边界、请求参数独立性，以及真实本地签名器的 XYS/X-RAP 正文与实际发送字节一致；[签名配置测试](tests/test_protocol_signer_config.py)覆盖默认配置、Windows/macOS、拒绝无支持输入及实例隔离。测试使用合成 Cookie 与 Mock HTTP，不访问平台，不代表在线身份、搜索或详情已经恢复。

### 2026-09-10 17:19 新版尝试在身份阶段停止

用户明确要求“再次进行尝试”后，沿用 `test_e` 和同一批准公开样本；先通过本地 dry-run，再仅执行一次新版在线运行。脱敏报告为 `data/protocol-runs/test_e_20260910T171950_c8960124.json`，`client_revision=2`，UTC `2026-09-10T05:19:50` 至 `05:19:58`（NZST 17:19:50 至 17:19:58）。

唯一请求为 `GET /api/sns/web/v2/user/me`，HTTP `200`、API code `-100`，结果 `SESSION_EXPIRED`、`identity_verified=false`。新版诊断确认响应为 JSON object，`verifytype_present=false`、`verifyuuid_present=false`、`message_flags=[]`；这只描述响应中的可保留证据，不证明账号永久受限，也不证明所有验证要求均不存在。

当日登录尝试为第 2 次；未占 capture 尝试、未发搜索/详情、无目标 capture 或 token/source，也未更新既有身份绑定或切换路线。报告权限 `0600` 且已被 Git 忽略。新诊断字段已在真实失败响应中落盘，但搜索参数修复是否有效仍未得到在线验证，不能将本次身份 `-100` 与先前搜索 `461` 混为同一个失败。后续暂停；需更新用户指定测试账号的有效 Cookie 并重新确认条件后才能继续，不在当前会话中反复试探。

### 2026-09-11 成功版与失败版的离线代码对照

用户要求先检查影响登录的代码差异。本轮不修改运行脚本、不读取真实 Cookie、不联网；只恢复历史源码、比较当前实现、运行合成输入，并在本节记录研究证据。

**来源边界。** 实验目录尚未纳入 Git，不能做提交间比较。根据本任务 2026-09-09 的创建补丁及成功运行前的后续补丁，恢复了旧 `protocol_session.py` 与 `protocol_experiment.py`；五个唯一补丁调用均找到成功完成的工具结果。已检索的后续补丁显示，E 两次身份成功之后、首次身份失败之前，相关修改集中在 2026-09-10 17:13–17:15 NZST：UA 配置与失败诊断、搜索 filters、停止分类保护及 `client_revision=2`。在所检查记录中未发现这段期间对 `common.py`、`run_experiment.py`、`experiment_io.py`、`requirements.txt` 的后续修改。这是从已记录补丁恢复的源码，不是当时进程的归档或运行时源码哈希；不能排除未进入记录的本地改动、历史输入差异或环境差异。所检索的主任务记录也未直接提供 `protocol_signer_config.py` 的创建补丁，因此新增 helper 按当前源码核对，不能认证其在首次失败时的精确文件快照。

| 项目 | 成功前版本 → 当前版本 | 对 E 身份失败的解释力 |
|---|---|---|
| 身份请求与 Cookie | 固定身份 GET、无正文、原样 Cookie header、Origin/Referer/UA/Accept 等组装方式不变；`xhshow==0.2.0`、XYS、HTTPX 配置及冻结 Cookie / 丢弃 Set-Cookie 策略不变 | 未找到这些位置的版本差异；不等于历史 Cookie 字节和环境已经被证明相同 |
| UA 与签名模板 | 旧版仅覆盖 UA；新版校验支持的桌面 UA，并同步两个模板的 `x2` 平台字段；默认空 UA 仍用库原始配置 | 合成 macOS UA 确实改变签名。上一轮获准的 E 元数据检查显示其当前没有自定义 UA，走默认 Windows/Edge 路径；不触发该平台变更，也不证明 Cookie 来源浏览器就是 Windows/Edge |
| 成功与失效判据 | `api_data()`、`authenticated_digest()`、`identity()` 不变；业务码 `-100` 两版均映射为 `SESSION_EXPIRED` | 不是新版把同一份成功响应改判为过期；该名称是本地分类，不能据此确认自然过期的原因 |
| 验证响应头 | 旧版只对非空 `verifytype` / `verifyuuid` 停止；新版只要字段存在就停止，包括空值 | 是真实行为差异；E 首次失败报告两个字段均不存在，因此不匹配本次失败 |
| 失败诊断与保护 | 新版保存脱敏业务码、验证头存在标志及固定消息提示，并保护已知 HTTP 停止原因不被诊断异常覆盖 | 改变失败取证；相同 `200 / -100` 两版仍作相同失败分类 |
| 搜索与 runner | 搜索补五项默认 filters；runner 仅增加 `client_revision=2` 报告字段，其余恢复源码与当前相同 | filters 不参与身份 GET，E 首次身份失败时根本未执行搜索；身份绑定检查发生在身份接口通过之后 |

**实际离线验证。** 使用恢复旧版与当前版的真实 `LocalSigner`、同一个已安装的 `xhshow==0.2.0` / `httpx==0.28.1`，仅将 transport 换成 Mock；构造前固定时钟和随机源，阻断 socket 连接，每次只调用一次 `identity()`，不进入绑定/账本 runner。三个 UA 条件各对两版本重复运行，确认各自确定性；另比较七种合成响应，共 26 次 Mock 身份调用，脚本整体复跑结果一致：

- 默认空 UA 与 Windows UA：HTTPX transport 边界的 method、URL、raw path、完整请求头字节及正文完全相同；配置、签名内容、payload / SignState 与指纹探针也一致。
- macOS UA 正对照：只观察到请求头 `x-s`、`x-s-common` 不同，配置差异正是两个模板的 `x2`；证明对照能发现实际签名差异，而非绕过签名器。
- 有效非游客身份、`-100`、游客、缺少 guest 字段、HTTP `461`、非空验证头，两版判定一致；第七个“有效身份但验证头为空”用例为旧版通过、新版 `CHALLENGE_REQUIRED`。新失败诊断按预期增多。
- 本轮另运行现有 `test_protocol*.py`，**43 项测试通过**。Mock 成功响应只验证本地判据，不验证远端接受签名；这些检查不覆盖真实 TLS/网络或服务端状态。

审计脚本、恢复源码、来源元数据和只含比较结果的 JSON 留在已忽略的本地 `data/offline-login-diff.RaVGkD/`，不含真实凭据或签名全文。可在实验目录运行 `.venv/bin/python data/offline-login-diff.RaVGkD/compare_identity.py` 重复上述客户端对照。

**结论：** 已找出具体代码变化，但在 E 当前默认 UA 的配置路径下，没有找到能解释历史身份响应从 `0` 变为 `-100` 的改动。能够确认的是远端响应不同，不是登录核心判据被改坏；仍不能断言真实两次请求所有字节相同、Cookie 必然自然过期，或已排除全部客户端/环境因素。身份绑定在成功响应之后才核对，不会把接口业务码 `0` 改写成 `-100`。本次没有回滚代码、更新 Cookie、重新登录或尝试搜索。

## 第三方搜索候选：Just One API（未接入）

分类：文档核查 / 候选方案，2026-09-11。代理仅核查公开文档，未登录用户控制台、调用业务接口或修改运行范围；本节不替代历史结果或[产品权威](../../../../../docs/design/product-design.md)。

- 服务性质：供应商提供跨平台数据服务，条款说明结果依赖第三方平台及实时采集。因此本研究按第三方 API 评估，文档中的“官方”不能理解为小红书官方接口或授权背书。[官网](https://justoneapi.com/en)、[服务条款](https://justoneapi.com/en/terms)
- V2：`GET /api/xiaohongshu/search-note/v2`，必填 query 参数为 `token`、`keyword`；可选 `page`（整数，默认 `1`）、`sort`（默认 `general`）、`noteType`（默认 `_0`）、`noteTime`。供应商明确提示时间筛选可能不精确。[V2 文档](https://docs.justoneapi.com/zh/api/xiaohongshu-rednote/note-search-v2)
- V4：`GET /api/xiaohongshu/search-note/v4`，供应商称其走移动应用搜索流程；必填参数及分页同上，可选筛选改为 `sortType=general`、`noteType=ALL`、`timeFilter=ALL`。[V4 文档](https://docs.justoneapi.com/zh/api/xiaohongshu-rednote/note-search-v4)
- 认证：请求发往 `https://api.justoneapi.com`，URL query 中的 `token` 是注册取得的服务访问令牌；上述搜索参数未要求传入小红书 Cookie。它与笔记的 `xsec_token` 是不同用途的字段。[使用指南](https://docs.justoneapi.com/zh/usage)
- 返回证据：两份 OpenAPI 的 HTTP 200 响应中，`data` 的 schema 均为 `{}`，未声明内部字段。因此尚不能确认 `note_id`、`xsec_token`、`xsec_source` 或带 token 链接是否返回，也不据此断言实际响应没有这些字段。[V2 OpenAPI](https://docs.justoneapi.com/openapi/xiaohongshu-rednote/note-search-v2-zh.json)、[V4 OpenAPI](https://docs.justoneapi.com/openapi/xiaohongshu-rednote/note-search-v4-zh.json)
- 详情与下载：`GET /api/xiaohongshu/get-note-detail/v1` 的参数仅列服务 `token` 和 `noteId`（也接受含 `/explore/` 的 URL），不支持视频下载；`v6` 明确仅支持视频笔记下载、不支持图文。按该输入契约，已知 ID 的图文笔记可以直接尝试 V1 查详情，不必先调用搜索，也未要求调用者提供小红书 Cookie 或 `xsec_token`。这是接口能力说明，不是目标帖子实测成功。[V1 文档](https://docs.justoneapi.com/zh/api/xiaohongshu-rednote/note-details-v1)、[V6 文档](https://docs.justoneapi.com/zh/api/xiaohongshu-rednote/note-details-v6)
- 下载边界：两份详情 OpenAPI 声明的是 JSON 响应，`data` schema 均为 `{}`；未定义具体正文或媒体字段，也未承诺一键 ZIP/HTML/PDF 归档。实际图片/视频链接及可下载性仍待授权样本验证；如果返回可用媒体链接，保存正文与下载媒体是客户端另需完成的步骤。[V1 OpenAPI](https://docs.justoneapi.com/openapi/xiaohongshu-rednote/note-details-v1-zh.json)、[V6 OpenAPI](https://docs.justoneapi.com/openapi/xiaohongshu-rednote/note-details-v6-zh.json)
- 成本与额度：业务 `code=0` 成功计费；注册有免费测试次数，未注明数量；具体单价须登录查看。无统一速率上限，但接口可另设限制、账号可配置每日成功额度；每日超限为 `code=303` / HTTP `429`，不计费。本次未确认单价、试用次数或账号额度。[使用指南](https://docs.justoneapi.com/zh/usage)

研究判断：可列为关键词搜索候选，取得访问材料的能力待验证。第三方返回材料不证明 F 的原站搜索正常、token 生成机制或可由 F 复用；不能据此改写本实验的成功状态或自动继续详情请求。

上手顺序（首次核查时的建议，尚未由代理执行）：注册供应商账号，取得服务 `token`，在控制台核对免费额度与接口单价，再准备搜索请求。[使用指南](https://docs.justoneapi.com/zh/usage)、[FAQ](https://justoneapi.com/en/faq)。本项目建议：真实调用前另行确认授权范围，将 key 保存在仓库外私有配置；先用一个已批准的公开关键词仅请求第一页，核对 HTTP 状态、业务 `code` 及返回笔记字段，再决定接入。授权确认、仓库外保存和单关键词试验范围是本项目建议，并非供应商声明的接入要求；当前仍未接入、未调用。

费用补充（公开文档核查）：用户本轮自述已注册，代理仍未登录其控制台或调用 API。指南按业务 `code=0` 的成功接口调用计费，各接口单价须登录查看。据此核算：若一篇仅需一次成功详情调用，该步按对应详情接口价计算；附加搜索、评论等成功调用分别计入，不能当作固定“每篇打包价”。[使用指南](https://docs.justoneapi.com/zh/usage) 本次未取得详情 V1/V6 的确切单价或免费额度数字；FAQ 只公开试用和控制台查询入口。[FAQ](https://justoneapi.com/en/faq) 已读详情文档未说明图片/视频链接的下载或流量是否另收费，不能承诺免费或已包含在详情价内。[V1](https://docs.justoneapi.com/zh/api/xiaohongshu-rednote/note-details-v1)、[V6](https://docs.justoneapi.com/zh/api/xiaohongshu-rednote/note-details-v6) 条款说明价格、试用和额度规则可能因接口与账号而异，需核对当前账号配置。[服务条款](https://justoneapi.com/en/terms)

### 2026-09-12 控制台核验与双样本试下载准备

分类：本次账号的在线只读观察，不是产品接入决策。用户已手动登录供应商控制台，并授权从既有脚本导出表选择一篇图文和一篇视频，分别用免费额度试下载；范围见[双样本授权](../scope.md#2026-09-12-第三方双样本试下载授权)。本次不使用 A–F Cookie 或列表中保留的 token。

控制台实读结果（本次调用前快照，不能代表其他账号或未来价格）：

| 接口 | 免费剩余次数 | 单价／请求（CNY） | 调用权限 |
|---|---:|---:|---|
| 图文详情 `/api/xiaohongshu/get-note-detail/v1` | 5 | ¥0.1500 | 允许 |
| 视频详情 `/api/xiaohongshu/get-note-detail/v6` | 5 | ¥0.1500 | 允许 |

来源：[免费额度](https://dashboard.justoneapi.com/zh/dashboard/free-trial)、[账号价格表](https://dashboard.justoneapi.com/zh/dashboard/pricing)，均为登录后的界面观察。只计划各调用一次，不充值、不动付费余额；未实测前不承诺 JSON 中具体媒体字段或下载结果。

准备阶段另发现[API Token 列表](https://dashboard.justoneapi.com/zh/dashboard/token)为 0 个。新增窗口说明初始可用金额留空即不限额，因此未提交创建，已询问用户是否允许新建金额为 0 元的本次测试 Token；若平台不支持在此条件下使用免费次数，停止而不提高金额。此时尚无详情 API 调用，也未下载帖子媒体。

### 2026-09-12 双样本详情实测

用户针对上面的零金额 Token 创建与两次试用请求回复“测试”。随后创建本次命名 Token，控制台确认 `0.00 CNY`；创建后列表另有一个不限额 `Default` 条目，本次未使用或修改，未推断其来源。两次请求均通过供应商文档页的在线调试表单发送，只传服务 Token 和已选帖子的 ID；不传小红书 Cookie 或导出链接 token。

| 样本 | 接口与时间（NZST） | 实际响应 | 已核对内容 | 免费次数前 → 后 | 实际扣费 |
|---|---|---|---|---|---|
| 图文 `normal` | V1，2026-09-12 01:39:20 | HTTP 200 / `code=0` | ID、标题、类型匹配；690 字符正文、8 张图片记录 | 5 → 4 | ¥0.0000 |
| 视频 `video` | V6，2026-09-12 01:48:46 | HTTP 200 / `code=0` | ID、标题、类型匹配；138 字符正文、`video_info_v2` 媒体信息 | 5 → 4 | ¥0.0000 |

来源：[实际调用与扣费记录](https://dashboard.justoneapi.com/zh/dashboard/api-request-logs)、[剩余免费次数](https://dashboard.justoneapi.com/zh/dashboard/free-trial)，均为本次账号的登录后实读；后台记录明确归属于命名测试 Token。后台显示时间为 UTC+8，表中换算为 NZST（UTC+12）。每个接口只发送一次，无搜索、评论、重试或付费调用。

从在线调试页面的实际响应中只读提取精确目标的 ID、类型、标题、正文和媒体字段，经仅监听 `127.0.0.1` 的临时本机保存页写入私有 `data/justoneapi-20260912.IzM5pj/normal-response.json` 和 `video-response.json`；保存后已停止本机服务。两份文件是最小化响应摘录，不是未经处理的完整原始响应；未包含服务 Token、用户资料或分享参数。目录 `0700`、文件 `0600` 且被 Git 忽略，图片 CDN 签名仅在私有响应和下载计划中保留。在线调试表单的服务凭据已替换为无效占位符 `TOKEN_REMOVED`。

较早尝试的 `normal-response.html`、`video-response.html` 只保存了静态文档，没有目标响应，不能作为详情成功或媒体下载证据。最终离线提取依据上述 JSON，并按精确目标 ID、类型和媒体结构核对，26 项合成离线检查通过；不依赖文档示例。

返回结构已有实证：V1 的目标位于 `data[].note_list[]`，图片位于 `images_list[]`；V6 的目标直接位于 `data[]`，视频位于 `video_info_v2.media.stream`。视频的 `function_switch` 数组中，`type=video_download` 项为 `enable=false`，原因是“暂不支持保存5分钟以上视频”；此客户端开关不把本次 API 成功改为失败，也不能代替实际媒体下载验证。媒体下载与文件完整性单独核对；第三方结果不改变 F 原站搜索的 HTTP 461 结论。

实际媒体下载及离线验收均通过（2026-09-12 NZST）：

| 样本与目标 | 本地成果 | 完整性检查 |
|---|---|---|
| 图文：建议去GitHub学这6个项目，打破Agent信息差；`6a6f46d100000000250145db` | `normal/post.md`、`normal/metadata.json`、8 张 WebP；图片共 1,624,424 字节 | 8/8 完整解码，均为 1728 × 2304；字节数和 SHA-256 与清单一致；所有本地引用存在 |
| 视频：看侯麦如何拍集邮女？｜《女收藏家》分析；`6a7fd633000000002500baf8` | `video/post.md`、`video/metadata.json`、`video/media/video.mp4`；211,258,333 字节 | H.264 1280 × 720，AAC 双声道；时长 852.380 秒；容器、字节数、SHA-256 检查通过，FFmpeg 全片音视频解码无错误 |

上述路径均相对于同一私有下载目录。图片使用供应商返回的原图地址，仅将同主机 HTTP 升级为 HTTPS 并保留 CDN 签名；视频使用返回的无 query H.264 备用地址。每个媒体只发起一次下载，无重试或失败回退；下载器校验 HTTPS、域名、全部 DNS 地址为公网、TLS 证书、长度与文件结构，不发送 Cookie、服务 key 或小红书请求签名。交付 Markdown 与元数据无远端媒体 URL，全部输出目录为 `0700`、文件为 `0600` 且被 Git 忽略。

本轮证明了这两篇导出列表样本可以通过第三方“ID 查详情 → 下载媒体 → 本地保存”完成，试用调用实际扣费合计为 0 元。它不证明任意帖子均可下载、不确认长期价格或链接有效期，也没有改变原站实验停止状态、破解 `xsec_token` 生成机制或接入 Core。

## 2026-09-12 ReaJason/xhs 搜索对照

分类：受控动态证据，范围见[本次授权](../scope.md#2026-09-12-reajasonxhs-搜索对照授权)。用户要求使用 ReaJason/xhs 的搜索功能，先找出当前可验证的测试 Cookie。18:45 NZST 优先检查 F：现有协议身份探针返回 HTTP `200` / API `0`，非游客身份与既有摘要匹配，因此未继续测试 A–E。此探针报告为私有 `data/protocol-runs/test_f_20260912T184509_f33e4bc9.json`。

新增独立入口 [reajason_search.py](scripts/reajason_search.py)，导入 [ReaJason/xhs 固定提交](https://github.com/ReaJason/xhs/tree/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0)。实际执行 SDK 的 `get_self_info2()`、`get_note_by_keyword()`、`get/post` 序列化与外部签名回调；搜索正文保留其原生六字段 `keyword/page/page_size/search_id/sort/note_type`，不调用旧实验的搜索构造器、不补 `filters`。Cookie 解析和网络响应处理改由受控适配层承担，签名仍为 `xhshow==0.2.0`，传输仍为有界 HTTPX。因此本轮是“真实 SDK 搜索方法 + 当前本地签名/传输”的测试，不是作者浏览器签名服务或默认 Requests 传输的原样复现。

离线预检与完整实验套件 **135 项测试通过**，含 [16 项 SDK 集成测试](tests/test_reajason_search.py)：确认真实业务方法继承、原生六字段、签名与实际发送字节一致、含等号 Cookie 保真、身份门、禁止详情/直连、停止诊断、篡改拒绝和输出脱敏。真实本地签名器另以默认、macOS、Windows 三种合成输入验证；全部使用 Mock HTTP，不能代替服务端接受结果。可选依赖见 [requirements-reajason.txt](requirements-reajason.txt)，`pip check` 无冲突，上游 tracked 源码未修改。

18:56:54–18:57:12 NZST，只用 F 和原批准样本标题“没人跟我说短信换背景图双方都能看见啊”，执行一次 SDK 身份复核及一次第一页搜索（最多 20 项）：

| 步骤 | HTTP / API code | 结果 |
|---|---|---|
| SDK `get_self_info2()` | `200 / 0` | 非游客身份通过，`identity_binding=matched` |
| SDK `get_note_by_keyword()` | `461 / 0` | `HTTP_RISK_STOP`，`search_api_succeeded=false` |

搜索诊断保留 `verifytype_present=true`、`verifyuuid_present=true`、`content_type=json`、`body_state=json_object`、`message_flags=[]`。HTTP 461 优先于正文业务码 0；这两个响应头只能证明存在验证相关信号，不能确定挑战形式或拒绝根因，也不能把请求被拒解释为“搜索无结果”。没有可接受的搜索结果，故目标是否出现在第一页尚未验证。

本次 SDK 报告为私有 `data/reajason-runs/test_f_20260912T185654_80dcf2af.json`，账号当日 login 第 2 次、capture 第 1 次；加上先前预检，本轮共发送两次身份 GET、一次搜索 POST。报告只含脱敏状态，未保存 Cookie、签名、原始身份、搜索结果或 token。目录 `0700`、报告 `0600` 且被 Git 忽略；没有详情、capture、媒体下载、重试、换号或改签名后再试。

结论：F 的本次 Cookie 可以通过两种客户端接法的身份验证，但改用 SDK 原生搜索参数后仍受拒绝。现有证据不支持将失败简单归为 Cookie 过期，也未证明只是旧脚本多出的搜索参数导致失败；当前签名、客户端环境与服务端状态等因素仍未被隔离。本轮结束，后续线上尝试暂停。

## 2026-09-12 G 自有脚本身份及搜索成功

分类：受控动态证据。用户明确授权使用新小号 Cookie 运行本项目脚本，身份通过后搜索，范围见[G 对照授权](../scope.md#2026-09-12-新小号-g-自有脚本对照授权)。本轮未修改 `run_experiment.py`、`protocol_experiment.py`、HTTP 客户端或签名实现；仍使用 `client_revision=3`、`xhshow==0.2.0`、XYS 与现有默认 UA。未提供原 Chrome 的实际 UA，因此不声称复现了它的设备配置。未执行 ReaJason、浏览器路线或第三方 API。

执行前，56 项 `test_protocol*.py` 合成离线测试通过（网络连接与 DNS 被封锁），覆盖首次身份、仅搜索、风险停止和不读详情；新输入 dry-run 通过，且没有签名、请求或运行状态写入。随后只执行一次 `run_experiment.py --transport protocol --account-id test_g --note-id 6a9e62d2000000002902c012 --search-only --bind-identity --execute --yes`。

运行时间为 **2026-09-12 22:33:50–22:34:04 NZST**。查询仍为已批准标题“没人跟我说短信换背景图双方都能看见啊”，仅第一页、最多 20 项：

| 步骤 | HTTP / API code | 实际结果 |
|---|---|---|
| 身份 `GET /api/sns/web/v2/user/me` | `200 / 0` | 非游客及稳定 ID 检查通过，保存首次观测身份摘要 `first_observed`；没有预先提供的独立 ID 可供匹配 |
| 搜索 `POST /api/sns/web/v1/search/notes` | `200 / 0` | `search_api_succeeded=true`，精确匹配批准 note ID，取得该条目的 `xsec_token`，`target_discovered=true` |

最终结果为 `PROTOCOL_SEARCH_VERIFIED`，当日 G 的 login/capture 尝试各第 1 次，共两次平台请求。`browser_login_verified=false`、`detail_verified=false`；没有重试、换号、翻页、详情或媒体请求。A–F 未复测。先前仅四项的 JSON 没有用于本次请求。

最小材料检查确认：capture 只有一个 `protocol.search_access_material` 事件，payload 仅含精确目标 ID、token、source 和 source 来源。**token 来自搜索结果；`source_origin=search_context`，`pc_search` 是脚本根据搜索上下文设置的值，不是响应提供 source 的证据。** 本次没有运行会显示 token 前缀的 locator。

脱敏报告：`data/protocol-runs/test_g_20260912T223350_732901e0.json`；最小材料：`data/captures/protocol_test_g_20260912T223350_732901e0.jsonl`。账号文件位于仓库外，报告、身份摘要和 capture 均为 `0600` 且运行产物被 Git 忽略；文档不复制 Cookie、token、签名或明文身份。

结论：当前自有脚本及签名配置在 G 的这次输入下可完成身份和目标搜索，不能再把这一搜索调用链视为普遍不可用。相比旧账号失败，Cookie／会话差异值得进一步研究，但本次同时改变了账号及整套 Cookie，运行时间和服务端状态也不同；尚未隔离单个字段，不能认定三个新增字段解决了问题、旧 Cookie 必然自然过期，或完全排除客户端与服务端因素。本轮在搜索后正常结束，详情与 token 生成机制仍未验证。

## 2026-09-13 F 常用只读功能检查

分类：独立能力检查方法与受控动态证据。用户询问身份可验证而搜索受限的账号还能做什么，并要求尝试常见功能；本轮按 F 执行，范围见[专项授权](../scope.md#2026-09-13-f-常用只读功能检查授权)。这不是解除搜索挑战或在失败后自动切路。

新增 [capability_probe.py](scripts/capability_probe.py)，仅允许 F 的身份 → 自己的资料 → 自己的发帖列表第一页，最多三次 GET。后两项参数使用本轮验证并匹配既有绑定的账号 ID，不接受任意 URL、ID、翻页或外部 token。资料和列表契约来自 [ReaJason 固定源码](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/core.py#L344-L425)与 [CLI 固定源码](https://github.com/jackwener/xiaohongshu-cli/blob/4d63f3c0c85ccd9054fa8e96d7f761aaf2507449/xhs_cli/client_mixins.py#L236-L249)；本入口未执行它们的业务方法，不称为该项目原样实测。

签名仍为本地 `xhshow==0.2.0` / `xys`，完整 GET 路径与实际查询串一致；底层传输、Cookie 冻结、共用锁/台账、失败诊断与停止条件沿用实验实现。默认入口白名单未放宽，两个受限子类独立检查新 GET，运行报告删除完整查询串。资料接口只验业务成功和非空对象，明确 `field_schema_verified=false`；发帖列表验 `notes/cursor/has_more` 容器、至多 30 项，以及非空条目的 `note_id` 和 `normal/video` 最小结构，不证明详情正文/媒体可读取，也不假设自己的列表全为公开内容。只保留状态、结构与计数，用户资料、列表元素和 cursor 留在内存、不归档。

新增 18 项合成离线测试覆盖固定查询、账号绑定、原白名单、任意 URL/写入/翻页拒绝、错误结构、空列表、私有输出、停止条件和每日额度。独立审查发现 `notes:[{}]` 曾被误算一篇，先用测试复现再修正；空列表仍允许。全套回归、依赖检查及 F dry-run 通过后执行一次：

```bash
.venv/bin/python -B scripts/capability_probe.py --account-id test_f --execute --yes
```

实际运行于 **2026-09-13 12:00:12–12:00:23 NZST**（UTC `00:00:12–00:00:23`）：

| 功能 | 实际结果 | 判断 |
|---|---|---|
| 当前用户身份 | HTTP `200` / API `-100`，`SESSION_EXPIRED` | 当前输入未通过会话验证，`identity_verified=false` |
| 本账号资料 | `NOT_REQUESTED` | 因身份门禁停止，不能判为该功能被拒绝 |
| 本账号发帖列表 | `NOT_REQUESTED` | 同上，尚无当前功能能力证据 |

本轮只发一次身份请求，当日 login 第 1 次，未预留 capture 次数。`verifytype_present=false`、`verifyuuid_present=false`、`content_type=json`、`body_state=json_object`、`message_flags=[]`；没有新搜索、详情、媒体、平台写入、重试或换号。没有修改原 Cookie、身份绑定或使用 G 的访问材料。

脱敏报告为 `data/capability-runs/test_f_20260913T120012_75c248b4.json`，已核对请求数和 JSON 状态；文件 `0600`、目录 `0700` 且被 Git 忽略。此次不能继续回答 F 的其他功能是否可用：应先由账号本人更新完整会话，再另行确认检查。`-100` 支持本次会话验证失败的结论，不能独立证明自然到期、永久封禁，也不能反向解释 9 月 12 日“身份通过但搜索 461”的根因。

## 2026-09-13 A–F 身份复核与条件清理

分类：受控动态证据与本地凭据维护。用户明确要求检查 A–F 是否还能登录，仅当全部失败时删除这六份 Cookie，并将本人小号 G 标记为“小号”；范围见[专项授权](../scope.md#2026-09-13-af-身份复核与条件清理授权)。

56 项协议离线测试、依赖检查和 A–F 各自 dry-run 通过后，使用自有 `run_experiment.py --transport protocol`，不传帖子 ID，按 A→F 各发一次身份 GET。A–D 使用首次观测绑定开关，E/F 沿用既有摘要门禁；六次均未通过，因此没有新建或更新身份绑定。运行于 **2026-09-13 13:46:57–13:49:11 NZST**，无搜索、详情、浏览器、重试或 G 请求。

| 账号 | HTTP / API / 身份结果 | 私有报告（`data/protocol-runs/` 下） |
|---|---|---|
| A | `200 / -100 / SESSION_EXPIRED` | `test_a_20260913T134657_9c74a15c.json` |
| B | `200 / -100 / SESSION_EXPIRED` | `test_b_20260913T134721_474dc171.json` |
| C | `200 / -100 / SESSION_EXPIRED` | `test_c_20260913T134746_505f73c2.json` |
| D | `200 / -100 / SESSION_EXPIRED` | `test_d_20260913T134815_de65c805.json` |
| E | `200 / -100 / SESSION_EXPIRED` | `test_e_20260913T134846_6620ff02.json` |
| F | `200 / -100 / SESSION_EXPIRED` | `test_f_20260913T134906_7d3d75d4.json` |

六份报告均只有一个固定身份 GET，`identity_verified=false`、无验证响应头或风险提示。每次计入原每日台账（A–E 各第 1 次，F 第 2 次），没有清零额度。此次只确认这些输入本轮不能完成协议身份验证，不证明平台账号永久封禁或具体过期原因。

13:49:41 NZST，在共用操作锁内复核全部六份报告及账号文件未变化后，原子更新仓库外 `accounts.json`：仅将 A–F 的 `cookie` 置空，并给 G 增加 `label: 小号`。G 的 Cookie 与其他元数据原样保留，内部 ID 仍为 `test_g`；A–F 的账号条目、身份摘要和历史报告保留，没有删除浏览器 profile/HAR、平台账号或聊天记录。没有创建旧 Cookie 备份，因此本次清空值不能从该配置恢复；不声称已清除其他位置的历史副本。

标签只是可选描述元数据（非空、最多 64 字符、拒绝控制字符），不参与账号选择、身份绑定、路径或签名，也不自动输出。清理后原加载器接受配置，A–F 会在联网前因缺少 Cookie 被拒绝；G 保留 16 项 Cookie，身份命令的本地 dry-run 通过但未联网。包含两项新增合成标签测试的全套 155 项离线测试通过；82 处本地文档链接、5 处新锚点、示例 JSON、忽略规则与空白检查通过。真实凭据未进入测试、日志或文档。
