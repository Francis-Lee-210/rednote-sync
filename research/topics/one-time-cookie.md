# 一次性 Cookie 路线研究：交付形态、接入方式与账号隔离

> 状态：**研究证据**。本文保留 2026-08-16 对一次性或购买 Cookie 路线的公开资料研究和当时实验设想。账号来源、硬停止和主账号限制不自动成为当前产品规则；当前产品允许用户自行选择账号形式，见[产品设计](../../docs/design/product-design.md)。

日期：2026-08-16
状态：公开资料研究 + 当时的候选实验决定记录；任何实现与在线实验均未开始
方法：只读公开网页与公开 GitHub API、仓库内固定 revision 审查结论；未访问小红书任何线上接口，未读取工作区凭据文件，未执行代码。本文档不包含任何真实 Cookie 值、token、HAR 或带 token 的完整 URL；出现的 Cookie 字段名均来自公开资料。

## 1. 要回答的问题

1. "一次性/购买 Cookie"的交付形态有哪几档，各自完整度如何？
2. 三种技术接入方式（Playwright storageState / addCookies / persistent context、浏览器扩展或 DevTools 注入、HTTP 直连）分别适用于哪种交付形态？
3. 小红书会话相关字段各自的类别与稳定性如何？
4. 用户 2026-08-16 提供的 14 字段脱敏 Cookie 样本适用于哪种接入方式，风险画像如何？
5. 该路线当时怎样映射到历史实施阶段；2026-08-16 对话记录过哪些候选实验决定？

## 2. 证据等级

沿用 `research/catalog.md` 与 `research/topics/xsec-link-structure.md`：

- `[外部声明]`：README、博客、Issue 或其他人的描述。
- `[静态证据]`：仓库中固定 revision 的源码、配置或离线样本能直接确认的行为。
- `[本地验证]`：本项目曾实际运行并观察到的结果。
- `[公开资料]`：本轮从公开网页读取的材料；标记日期，不视为平台官方当前事实。
- `[待动态验证]`：只能通过真实环境实验回答。

## 3. 概念与交付形态

`[外部声明，2026-08]` "一次性 Cookie"不是小红书官方概念，是号商把某个账号的登录会话凭据打包出售的民间叫法。典型交付形态三档：

| 形态 | 内容 | 完整性 |
|---|---|---|
| 纯 Cookie 文本 | `name=value; ...`（JSON/Netscape 等格式），只有字段值，不含属性信息 | 最低，无 localStorage/IndexedDB/设备状态 |
| storageState JSON | Playwright 式 `{cookies:[...], origins:[{localStorage}]}` 快照 | 中，默认不含 IndexedDB（`[静态证据]` Playwright 官方文档） |
| 完整浏览器 profile 包 | 整个 user-data-dir（Cookie + localStorage + IndexedDB + sessionStorage + Service Worker + 设备状态） | 最高，接近"原设备状态" |

`[外部声明，2026-08]` 号商常见商业模式：时长计价（小时/天/月/半年）+ 扫码/换绑登录后提取 Cookie + 打包自动发货 + 附"ck 登陆器"注入工具；"包首登"是卖家话术，无可验证性。公开案例：购买"养熟号"后封号退款纠纷（澎湃新闻转载，[链接](https://www.thepaper.cn/newsDetail_forward_25702872)）；号商互相"掀桌"的论坛帖说明一号多卖/回收是常态（[LINUX DO](https://linux.do/t/topic/2296499/10)）。

`[推断]` 扫码登录后提取 Cookie 是"账号→可交易凭据"成本最低的转换方式，因此是主流做法。卖家抓取真实登录浏览器时，Cookie 层（含指纹族与签名族）相对完整，但设备状态（localStorage/IndexedDB/硬件指纹）不随货交付——这是第 7 节风险的技术根源。

## 4. 技术接入方式（面向实现评估）

### 4.1 Playwright 三法

**方式 1 — storageState 文件**（号商给了 JSON 快照时）

1. `browser.newContext({ storageState: 'state.json' })` 直接恢复 Cookie + localStorage。
2. 官方文档：[Auth](https://playwright.dev/docs/auth)、[Storage & Authentication](https://playwright.dev/agent-cli/commands/storage)。
3. 边界（`[静态证据]`）：默认只恢复 Cookie + localStorage，IndexedDB/WebAuthn 需显式选项；快照是明文、可冒充账号的敏感文件。

**方式 2 — browserContext.addCookies()**（号商只给纯 Cookie 文本时）

1. 把 `name=value; ...` 解析为 `[{name, value, domain: ".xiaohongshu.com", path: "/", ...}]`。
2. `await context.addCookies(arr)` 后正常导航。
3. 官方文档：[browserContext.addCookies](https://playwright.dev/docs/api/class-browsercontext#browser-context-add-cookies)。
4. 边界（`[静态证据]`）：只注入 Cookie，不注入任何本地存储/设备状态；`domain/path/expires/secure/httpOnly/sameSite` 必须自行正确填写，补错即不生效。

**方式 3 — launchPersistentContext**（有完整 profile 包或长期复用）

1. `chromium.launchPersistentContext(userDataDir, ...)`，同一目录重启自动恢复。
2. 官方文档：[launchPersistentContext](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context)。
3. 边界（`[静态证据]`）：同一目录不可被多个实例并发使用（需外部 lease）；官方明确警告不得自动化日常 Chrome 主 profile，必须专用目录。

| 维度 | storageState | addCookies | persistent context |
|---|---|---|---|
| 导入内容 | Cookie + localStorage | 仅 Cookie | Cookie + localStorage + IndexedDB + sessionStorage + 设备状态 |
| 持久性 | 每次 newContext 重新载入 | 无持久 | 目录落盘，重启恢复 |
| 设备指纹 | 不含 | 不含 | 真实浏览器进程产生，但仍非号商原机指纹 |
| 适合 | 号商给 JSON 快照 | 号商给纯 Cookie 文本 | 完整 profile 包 / 长期复用 |

### 4.2 浏览器扩展 / DevTools 注入

- Cookie-Editor（Chrome 商店 [链接](https://chromewebstore.google.com/detail/cookie-editor/hlkenndednhfkekhgcdicdfddnkalmdm)）支持 JSON/Netscape 导入导出；EditThisCookie 已停维护，存在社区 fork（`[外部声明]`）。
- `web_session`/`a1` 等字段通常是 HttpOnly，`document.cookie` 注入无效，须用扩展或 DevTools 面板。
- "重启后失效"分两类：会话 Cookie 本地丢失；或 Cookie 还在但**平台侧会话已死**（回到登录页/461）——后者是买号路线的常态风险（`[公开资料/推断]`）。

### 4.3 HTTP 直连

把 Cookie 头直接拼进 curl/requests 请求。与仓库已审查项目对比（`[静态证据]`）：

| 项目 | Cookie 处理方式 | 要点 |
|---|---|---|
| XHS-Downloader | 用户脚本从页面状态同时取 note ID + xsecToken；Cookie 可选项 | 发现上下文是 token 来源，不是 Cookie 直连 |
| xiaohongshu-cli | Cookie 名称 allowlist；auto 模式扫描多浏览器 | 名称 allowlist 可借鉴；扫描不绑预期账号是身份 fail-open |
| MediaCrawler | 只注入 `web_session`；Cookie/签名分层；Cookie 进 argv/日志 | 分层可借鉴；Cookie 进 argv 是严重反例 |

结论：直连把"会话 + 签名 + 设备 + 发现上下文"全部暴露为手工工程，是最脆弱形态，不适合 2000 条批量发现入口（`[推断]`）。

### 4.4 适用性结论

- 纯 Cookie 文本 → **新建专用隔离 profile + addCookies 注入**（最匹配）。
- storageState JSON → 等价可用（无 origins.localStorage 数据时不带来额外收益）。
- 完整 profile 包 → persistent context（长期复用最佳）。
- 扩展/DevTools → 适合人工一次性试探。
- HTTP 直连 → 不推荐。

## 5. 字段速查（`[公开资料]`，非官方、`[待动态验证]`）

| 字段 | 类别 | 要点 |
|---|---|---|
| `web_session` | 登录态关键 | 缺失/过期即掉登录，常见表现 461/回登录页 |
| `id_token` | 登录态关键 | 与 `web_session` 同等级对待的可冒充账号 secret |
| `a1` / `webId` / `gid` | 设备指纹族 | 长期设备/浏览器标识；换环境后与 Cookie 不匹配会被设备风控盯上 |
| `websectiga` / `acw_tc` / `sec_poison_id` | 签名/风控族 | `acw_tc` 常与 IP/TLS 绑定；`websectiga` 陈旧可能直接 461 |
| `abRequestId` / `loadts` / `webBuild` / `xsecappid` / `x-rednote-*` | 辅助 | 版本/时戳/地域标记，不承载登录态 |

来源：[xhs-api-client COOKIE_GUIDE](https://github.com/RavenStorm-bit/xhs-api-client/blob/main/COOKIE_GUIDE.md)、[xhs-cli auth.py](https://raw.githubusercontent.com/jackwener/xhs-cli/main/xhs_cli/auth.py)（catalog.md 已降 B 级参考）、MediaCrawler 专项审查。

`[推断]` 只有 `web_session` 而缺配套指纹（或指纹与下发环境不一致）= "能过登录校验、被设备风控盯上"的典型形态。字段值与稳定性均无官方保证，不能作为实现常量。

## 6. 用户 14 字段样本的脱敏判定（2026-08-16）

样本字段名：`a1, abRequestId, acw_tc, gid, id_token, loadts, sec_poison_id, webBuild, webId, web_session, websectiga, x-rednote-datactry, x-rednote-holderctry, xsecappid`（本文件不记录任何字段值）。

判定结论：

- 属于"纯 Cookie 文本"档的**较全版本**：含双登录凭据（`web_session`+`id_token`）、指纹族（`a1/webId/gid`）、签名/风控族（`websectiga/acw_tc/sec_poison_id`）——说明卖家抓取的是真实登录浏览器的完整 Cookie 层，优于只给 `web_session` 的廉价货。
- 适用接入方式：**新建专用隔离 profile + addCookies/storageState 注入**（第 4.4 节方式 1/2）；属性（domain/path/expires/httpOnly/secure）需自行补齐。
- 风险画像：
  1. 指纹错配：`webId/gid/a1` 是卖家浏览器生成的，注入后与真实设备指纹不一致；
  2. `acw_tc` 常与 IP/TLS 绑定，换网络环境可能立即失效；
  3. `websectiga` 是签名类，平台可能按请求重算，陈旧即 461；
  4. 双凭据任一失效即掉登录；
  5. 有效期无法离线判断，是否仍存活只能实测。
- `[推断]` 首登大概率能短暂进入登录态，持续稳定使用概率低，失效集中在掉登录/461；`[待动态验证]` 只有受监督实测能验证。

## 7. 风险与合规

### 7.1 平台协议条款

购买一次性 Cookie = "第三方使用账号 + 非授权软件登录 + 批量读取"，同时触碰协议 2.3/4.1/3.4（条款全文见 `xsec-link-structure.md` §4 转载链接；正式决策前建议人工核对官方页面）。低频、隔离小号**不改变授权结论**。

### 7.2 设备/IP 绑定

- `[静态证据]` 平台身份不止 Cookie：xiaohongshu-mcp 将 Cookie 与 `FingerprintSeed` 同存一个 JSON；Playwright 审查确认登录依赖 Cookie + localStorage + IndexedDB + sessionStorage + 设备状态组合。
- `[公开资料，2026-08]` 指纹浏览器行业资料：Canvas/WebGL/WebRTC/时区/UA/字体 + Cookie + 本地存储是风控主要维度，Cookie 只是其中一环（[Segmentfault：小红书矩阵号浏览器指纹攻防](https://segmentfault.com/a/1190000047918291)）。
- `[本地验证]` 主账号旧 token 直连重复尝试出现 461；XHS-Downloader Issue #305 无 Cookie 批量约 108 条后账号被下线——归因面比显式 Cookie 更宽。

### 7.3 号商账号来源

`[外部声明]` 盗号（撞库提取 Cookie）、一号多卖、回收/轮换是常见风险；无可验证数据。买家使用第三方账号本身属协议意义上的无效授权。

### 7.4 有效期与失效表现

无可靠有效期承诺；失效表现集中在 461 / 回登录页 / 强制退出 / 验证码，触发点与频率、设备、IP 强相关。

## 8. 当时的候选实验决定（2026-08-16 对话记录）

| 项 | 决定 |
|---|---|
| C1 | 将"购买一次性 Cookie 号"列为**可选的功能实现**（候选实现路线之一） |
| C2 | 交付形态**暂不选择**，待商家商品信息确认后再定 |
| C3 | **接受**"隔离不保证 100% 不与主账号设备/IP 关联"的残余风险 |
| C4 | **接受**协议条款与账号来源（盗号/多卖/回收）相关的合规与道德风险 |
| C5 | 是否坚持严格只读：**待用户答复**（释义见 §10 第 1 条） |
| C6 | Cookie 分两条路线：**购买的 Cookie 暂时忽略硬停止并尝试风控机制**；用户自带小号 Cookie **保留** 461/406/429/验证码硬停止 |
| E2 | `Cialle/RedCrack` 由"仅记录存在、不采用"改为"**候选参考，暂定服务于购买 Cookie 路线**" |

⚠️ 冲突与风险提示（仓库事实）：

- C6 与 `xsec-link-structure.md` §6.1 硬停止条件、`HANDOFF.md` 安全边界冲突；"尝试风控机制"的具体做法（签名/指纹/代理等）目前未定义，其中部分做法落在 `catalog.md` 5.8 的 D 级排除面上（stealth、指纹伪装、签名绕过）。
- E2 与 `sync-core.md` §2.2（禁止签名算法破解、`xsec_token` 生成或转换）及 `catalog.md` 5.8 冲突。
- 上述内容只保留为当时的候选实验决定；账号形式和硬停止规则已经交由当前产品设计重新定义，本文不替代产品权威。
- 当次实验继续不使用主账号，E-C 与旧 token 直连保持冻结；这不表示主账号永远不能参与正常在线采集。离线边界（历史实施 Stage 3 、`offline-input-v1`、安全清单五字段）不受影响。

## 9. 对项目的映射【推断】

- 历史位置：这条路线曾被映射到历史实施 Stage 4 的 `SessionAdapter` browser 模式；该映射不决定当前产品阶段二的实现。
- 离线部分完全不受影响：历史实施 Stage 3 、`offline-input-v1`、五字段安全清单生成器均为纯本地。
- 落地需遵守的既有契约：`ProfileLease + SessionBinding`（专用 profile、单实例排他锁、逐轮身份校验）；secret 边界（Cookie 只在内存，落盘文件 0600/目录 0700，不进 SQLite/日志/路径）；长事务改为事务外预取（`sync-core.md` §9.1）。
- 两条 Cookie 路线的硬停止差异（按 C6）：自有小号 Cookie 保留原硬停止；购买 Cookie 路线暂缓硬停止并尝试风控机制（**具体机制与停止条件在实现前必须另行定义**）。
- RedCrack 若进入购买 Cookie 路线，使用前需先解决：只读裁剪（禁用 `follow_user` 等平台写面）、无节流/停止条件问题、强制代理依赖、供应链与许可证复核——目前均未做。

## 10. 未回答的问题与待拍板清单

1. **C5 释义待答复**：严格只读 = 只用账号读取列表/详情/媒体，**不执行任何改变平台状态的操作**（关注/取关、点赞/取消赞、收藏/取消收藏、评论、发布、删除、私信、编辑资料等）。是否坚持？注：RedCrack README 自带 `follow_user` 等写接口，若不坚持只读，写面会成为额外风险源。
2. C2：交付形态选哪种（纯 Cookie 文本 / storageState JSON / 完整 profile 包）。
3. C6 细节："尝试风控机制"具体指什么（仅 RedCrack 参数层？代理？指纹？）——实现前必须定义，否则不可落地。
4. RedCrack 采用前需复核：许可证（MIT 待核）、供应链、只读裁剪、停止条件。
5. 号商候选核验：用户提供候选名后可做公开信息层面核验（域名、曝光、投诉检索）。
6. 既有未答问题不变：461 触发条件、token 与账号/设备绑定、搜索频率阈值等（见 `xsec-link-structure.md` §8）。
7. 如果未来开展动态实验，是否需要新建与当时范围相匹配的决策记录；E-C 是否解冻（当前冻结）。

## 11. 相关文档

- `research/topics/xsec-link-structure.md`（2026-08-16 第二次会话增补：三条情报核验 + Cookie 路线决定摘要）
- `research/catalog.md`（候选项目审查结论；5.8 stealth/指纹伪装/签名绕过 D 级排除面）
- `projects/rednote-sync-core/docs/sync-core.md`（§2.2 历史实施 Stage 3 禁止项；§6.2 SessionAdapter；§9.1 历史实施 Stage 4 门）
