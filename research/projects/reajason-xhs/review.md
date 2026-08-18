# ReaJason/xhs 专项源码审查

> 状态：**研究证据**。本文只对记录的固定 revision 和审查范围负责；评级、排除项、历史实施阶段边界和账号限制不自动成为当前产品决策。

状态：专项静态审查完成；独立复审通过
审查日期：2026-08-13
固定 revision：[`f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0`](https://github.com/ReaJason/xhs/tree/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0)

> 本报告只描述固定 revision 的 tracked 静态实现，不证明当前在线兼容性、平台许可、运行可靠性或账号安全。未安装依赖，未执行项目、测试、浏览器、签名服务或平台请求，也未读取任何用户 Cookie、token、profile、日志或个人数据。tracked 测试中的 cookie-shaped fixture 只登记存在性，不复制、不验证其值。

## 1. 范围、来源与方法

- 来源、revision、tree 和静态清点见 [`provenance.json`](provenance.json)，中断恢复状态见 [`checkpoint.json`](checkpoint.json)。
- 只通过 `git ls-files` 审查 41 个 tracked paths；README/文档声明、源码/配置事实、测试意图（未运行）、静态推断和未知项分别标记。
- 审查范围包括 Python SDK、媒体 helper、`xhs-api` 浏览器签名示例、测试、CI、Dockerfile、依赖和许可证。
- 不研究或迁移验证码求解、stealth、签名绕过、代理/账号轮换或隐藏自动化；相关实现只登记能力与风险。
- 评级表示对 Rednote Sync 的参考优先级，不表示代码质量、合法性、平台许可或账号安全。

## 2. 结论摘要

### 核心结论：

- **最终建议 B：只参考访问材料配对、单页 cursor 形态和部分错误分类，不直接集成 SDK、下载器、签名服务或平台写能力。** 固定版本把 `note_id + xsec_token` 一起从列表传给详情，这是最有价值的数据流；但没有版本化 Schema、checkpoint、逐资产状态或稳定恢复协议。[列表到详情](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/core.py#L456-L502)
- `XhsClient` 是读、登录、互动、上传和发布混合在一起的同步 `requests.Session` 门面；多数普通 API 还依赖调用者提供外部签名函数。默认 `sign=None` 并不能完成这些调用，不能直接充当 Rednote Sync 的只读 Provider。[客户端与签名](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/core.py#L93-L175)
- 文档、示例、测试和源码存在静态可确认的接口漂移：详情已强制要求 `xsec_token`，下载 helper、文档、示例和测试仍按旧签名调用；包元数据声称 Python `>=3.7`，源码却使用 Python 3.10 才支持的联合类型语法。[详情签名](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/core.py#L206-L223) [旧 helper](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/core.py#L309-L318) [旧文档](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/docs/crawl.rst#L13-L16) [旧示例](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/example/basic_sign_usage.py#L21-L28) [旧测试](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/tests/test_xhs.py#L28-L63) [元数据](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/setup.py#L25-L40)
- 用户发布和评论遍历器静态确认消费 `cursor/has_more`；收藏和点赞只确认请求接受 cursor，响应分页形态未知。两个“全部”遍历器只有内存循环、固定 sleep，没有 cursor 不前进检测、页数/请求预算、持久 checkpoint、失败账本或恢复协议。[笔记遍历](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/core.py#L442-L502) [收藏/点赞请求](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/core.py#L712-L720) [评论遍历](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/core.py#L504-L575)
- 媒体 helper 从页面字段重建随机 CDN URL，结果不确定；没有 Live Photo、variant、稳定 media identity、完整集合声明或逐资产 receipt。下载直接写最终文件，没有超时、Range、长度/hash、临时文件和原子提交。[媒体 URL](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/help.py#L81-L152)
- 错误层能区分验证码、IP block 和签名失败，分类意图值得借鉴；但空/非 JSON 响应返回原始 `Response`，验证码 header 缺失可先触发 `KeyError`，声明的 session-expired 错误没有映射，也没有 429、Retry-After、身份变化或全局停止/人工恢复状态。[异常定义](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/exception.py#L12-L38) [响应分类](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/core.py#L151-L175)
- **安全和会话边界阻断直接采用。** tracked 测试含完整 Cookie形态 fixture，测试/示例有输出 Cookie的路径；helper在缺少指定字段时还会静默补入tracked固定会话标识，上传完成则打印token、file ID和upload ID。本报告没有复制或验证这些材料，若它们曾有效，应按潜在历史凭据处理。[fixture存在位置](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/tests/__init__.py#L9) [默认标识逻辑](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/help.py#L397-L409) [测试输出路径](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/tests/test_xhs.py#L205-L207) [上传输出](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/core.py#L807-L828)
- `xhs-api` 在模块导入时启动共享 Playwright 页面，并提供默认监听所有接口的无认证 `/sign` 和 `/a1`；请求间还会替换全局 `a1`。Docker 构建又用 `curl --insecure` 下载未固定、未校验的远端脚本后注入浏览器。它既不是账号隔离的会话服务，也不是可信供应链；实际远程可达性取决于部署。[服务](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs-api/app.py#L14-L72) [Dockerfile](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs-api/Dockerfile#L1-L23)
- 固定树有 MIT LICENSE，包元数据也声明 MIT；runtime 与根 requirements 均未 pin/hash，仓库没有完整 lockfile，9 个 GitHub Action 引用均非完整 SHA，发布没有显式 SBOM、provenance、attestation 或签名。docs 只有一个精确版本条目且没有 hash，不构成完整依赖锁。MIT 不能代替第三方依赖、容器和远端脚本的许可证核对。[LICENSE](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/LICENSE#L1-L20) [setup.py](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/setup.py#L1-L40) [docs requirements](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/docs/requirements.txt#L1)
- 历史实施 Stage 3 继续完全离线。历史实施 Stage 4 即使获得明确授权，也只能 clean-room 实现默认只读 Provider、短期 access-material envelope、`SessionBinding`、请求预算、类型化停止和可恢复媒体 writer；Playwright、stealth、签名、固定延迟或代理都不是反风控证明。

## 3. 架构与数据流

```text
调用方
  → XhsClient
    → requests.Session + 平面 Cookie jar
    → _pre_headers()
       ├─ creator/customer：内置 quick sign
       └─ 普通 API：调用方 external_sign
    → 固定站点 host 的 GET/POST
    → raw dict / bool / requests.Response / exception

可选 xhs-api：HTTP → 共享 Playwright page → 页面签名函数
```

- `[源码事实]` `XhsClient` 固定 edith、creator、customer 三个 host，Cookie 和 headers 共享一个 Session；普通请求依赖外部 signer，creator/customer 使用内置 quick sign。[core.py](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/core.py#L93-L175)
- `[源码事实]` 响应没有统一 envelope：成功通常返回 `data`，部分接口返回布尔值，空/非 JSON 返回原始 `Response`，错误则抛异常。项目没有 Provider/Adapter、runtime decoder、schemaVersion 或稳定 DTO 层。[request](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/core.py#L151-L175)
- `[项目示例]` Playwright 示例把页面签名函数作为 `sign=` 回调，并在失败时重试；这只是示例行为，不是核心 SDK 的类型化重试或平台稳定性证明。[basic_usage.py](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/example/basic_usage.py#L10-L38)
- `[适配判断]` 可参考“transport client 与业务方法分离”的最小外形；但历史实施 Stage 4 必须把浏览器/session、只读 discovery/detail、Schema decoder 和 Core state ownership 分开，不能暴露原始 `request()`。

## 4. 发现、详情、评论与媒体

### 4.1 发现与访问材料

- 支持用户搜索、home feed、关键词搜索、用户发布、收藏和点赞列表；用户发布静态确认响应 cursor/has_more，收藏和点赞只确认请求 cursor参数，响应分页形态未知。[搜索/feed](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/core.py#L353-L440) [用户发布](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/core.py#L442-L454) [收藏/点赞](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/core.py#L712-L720)
- `get_user_all_notes` 从列表项同时提取 `note_id` 与 `xsec_token` 再请求详情。这能直接支持“稳定 ID 与短期访问材料必须配对”的设计结论，但项目没有将 token/source 封装成不可序列化的敏感对象。[core.py](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/core.py#L469-L481)
- 详情显式接收 `xsec_source`，却默认固定为 `pc_feed`；不同发现来源是否要求不同 source、token 有效期和分页关联均未知。[详情](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/core.py#L206-L223)
- 关键词搜索每次调用重新生成 `search_id`；home feed 又固定空 `cursor_score`，当前实现不构成可恢复分页会话。[搜索](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/core.py#L408-L440) [feed](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/core.py#L381-L401)
- GET helper 直接拼接 `k=v` query，没有标准 URL编码/规范化；特殊字符可能改变参数语义并使签名输入与实际请求不一致。它只能作为协议漂移反例，不应复制。[get](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/core.py#L177-L185)

Rednote Sync 的未来 Adapter 应只把稳定 ID 和无敏感 query 的 public URL交给 Core；`xsec_token/xsec_source` 只进入内存态 `PrivateNoteAccess`，不进 SQLite、日志、Markdown、异常或普通 checkpoint。

### 4.2 详情与字段契约

- API 详情直接取 `res["items"][0]["note_card"]`，没有空数组、shape、请求 ID 与响应 ID一致性校验。[core.py](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/core.py#L206-L223)
- HTML 路线用贪婪正则提取 `window.__INITIAL_STATE__`，无匹配时索引 `[0]`；随后对整段文本全局替换 `undefined`，再假设固定 map 路径存在。错误分支还把 `ErrorTuple` 与字符串比较，不能作为稳健 fallback。[core.py](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/core.py#L224-L264)
- HTML 路线还直接使用底层 Session GET，没有统一客户端的显式 timeout/proxies，也不检查状态码或复用 `request()` 的类型化错误分类；属于 C/D级网络与诊断反例。[core.py](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/core.py#L250-L264)
- `Note` NamedTuple 盘点了 note ID、标题、正文、类型、作者、图片、视频、标签/@、四类指标和两个时间字段；但它只在“所有用户笔记”包装器中生成，详情 API仍返回原始 dict，不能视为项目统一契约。[Note](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/core.py#L73-L90) [构造](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/core.py#L482-L500)

| 上游候选字段 | Rednote Sync 落点 | 采用边界 |
|---|---|---|
| `note_id` | `Note.noteId` | decoder 校验非空并核对请求 ID |
| `title`, `desc`, `type`, `user` | 标题、正文、类型、作者 | 缺失与空值分开；未知类型进入 `unknown` |
| `tag_list`, `at_user_list` | tags/mentions 候选 | 只提取稳定文本与安全 ID，不原样持久化 dict |
| 四个 `*_count` | `Metrics` | 源码把它们声明为字符串；安全解析为非负整数或 `null`，必须保留合法 0 |
| `time`, `last_update_time` | `publishedAt`, `updatedAt` | 单位、时区和缺失语义未经动态验证 |
| `xsec_token`, `xsec_source` | `PrivateNoteAccess` | 仅内存、不可序列化、禁止日志 |

### 4.3 评论与分页契约

- 一级评论和子评论都有 cursor；但子评论调用没有 `xsec_token` 参数，来源访问材料契约与一级评论不一致。[评论接口](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/core.py#L504-L539)
- `get_note_all_comments` 在 `has_more` 为真时循环，没有 page/request 总量、重复 cursor、空页或停滞检测；子评论还把“本页长度必须等于 30”加入继续条件，可能在 `has_more=true` 的短页提前停止。[遍历](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/core.py#L541-L575)
- 评论不属于当前 Rednote Sync MVP。这里仅保留 cursor/has_more 的候选 shape，不扩大实现范围。

### 4.4 媒体模型与落盘

- 图片按 `image_list` 顺序遍历，但只从首个 `info_list` URL提取 trace ID，再随机选择四个 CDN重建 URL；视频也从 `origin_video_key` 随机选择 CDN。相同输入可能产生不同 URL，且丢失原始 variant/source 证据。[图片](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/help.py#L81-L117) [视频](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/help.py#L120-L139)
- 固定树未发现 Live Photo/motion asset、MIME、预期长度、hash、source rank、media completeness 或逐资产状态模型。
- `download_file` 接受任意 URL和文件名，默认跟随重定向，没有 host/private-IP allowlist、显式超时、总字节、内容类型、长度/hash或 Range校验，并直接截断最终路径写入。若被 API/Agent 暴露，静态数据流形成条件性 blind SSRF、磁盘耗尽和任意进程可写路径覆盖面；未执行 PoC。[download_file](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/help.py#L142-L152)
- `save_files_from_note_id` 的标题清理只替换一组非法字符，不阻止 `.`/`..` 目录语义；不过固定快照会先因缺少 `xsec_token` 参数而失败。应同时记录潜在路径边界和当前不可达条件，不能描述为已验证利用。[保存流程](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/core.py#L309-L336)

Rednote Sync 只能把 `image_list` 顺序视为 ordinal 候选；URL 是短期 `TransientMediaSource`，资产身份由稳定 slot 与最终内容 hash确定。下载必须逐跳 HTTPS allowlist、拒绝私网/loopback/link-local、限制字节/时间、使用 `.part`、magic MIME、长度/hash和原子提交。

## 5. 状态、分页、幂等与失败恢复

| 审查面 | 固定源码事实 | 结论 |
|---|---|---|
| 用户发布、收藏、点赞 | 单页方法公开 cursor 候选 | 可作为 历史实施 Stage 4 decoder 输入；需动态验证排序、来源和完整性 |
| 全部用户笔记 | cursor/result 仅在内存，直到 `has_more=false`；无停滞保护 | 排除包装器；每次最多一页并由 Core 持久 checkpoint |
| 全部评论 | 两级 cursor 仅在内存，无预算/去重/completeness | 非 MVP，仅背景资料 |
| 详情 | 无响应 ID、shape 或 schemaVersion 校验 | Adapter 必须 fail closed |
| 媒体 | 无稳定 slot、resume、receipt、hash 或失败 ledger | 排除 downloader |
| 平台写 | 无 operation ID、desired-state、receipt 或 ambiguous-outcome 对账 | 全部不注册 |

- `[源码事实]` 笔记遍历只对两个特定内容错误跳过，其余详情失败中断；被跳过对象没有 failure/task记录，异常后只能从空 cursor重新开始。[core.py](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/core.py#L456-L502)
- `[源码事实]` 媒体下载直接写最终文件；分片上传也只把 upload ID/parts 留在内存，没有持久 resume manifest、abort/cleanup 或 checkpoint。[下载](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/help.py#L142-L152) [上传](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/core.py#L830-L895)
- `[适配判断]` 本项目不能接管 [`sync-core.md`](../../../projects/rednote-sync-core/docs/sync-core.md) 已有的 SQLite progress、task/failure、逐资产状态和原子提交。Provider只返回一次一页的 transient 结果，Core继续独占 cursor、checkpoint和 canonical state。

## 6. 会话、Cookie、签名、错误与风控停止边界

| ID | 严重性 | 固定证据与静态判断 | Rednote 边界 |
|---|---|---|---|
| SESSION-01 | 高 | Cookie字符串被拆成平面字典并重建 CookieJar，domain/path/Secure/HttpOnly 等属性丢失；解析使用无 `maxsplit` 的 `split("=")`，含 `=` 的合法值会被截断。[Cookie helper](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/help.py#L386-L409) | 保留浏览器/SecretStore管理的完整属性；禁止自制平面 Cookie 协议；账号身份需单独校验 |
| SESSION-02 | 中高 | 同一 Session跨 edith/creator/customer及上传 host使用；重建 Cookie为无 domain 条目。具体 requests版本对各 host的发送行为未运行验证，但源码已经失去最小域边界。[客户端 host](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/core.py#L93-L175) [Cookie构造](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/help.py#L386-L409) | Cookie按精确 host/path用途限定；媒体和上传不得继承整个平台 Cookie；不向 Agent返回原值 |
| SESSION-03 | 中高 | 当调用方 Cookie缺少指定字段时，helper会静默补入 tracked 的固定 `a1/webId/gid/gid.sign` 形态默认标识，再放入 domainless CookieJar；实际平台影响未知，但多个客户端会复用同一公共标识，调用方也无法区分“默认匿名身份”和真实浏览器身份。[默认标识逻辑](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/help.py#L397-L409) | 禁止硬编码或静默补全账号/设备标识；缺失即 fail closed，并由专用 profile显式提供身份材料 |
| SECRET-01 | 高 | tracked测试中存在完整 Cookie形态 fixture；未 skip测试会输出 Cookie dict，另一个 skip测试表达了输出 headers的意图，QR/phone示例也输出登录材料。有效性未知，本审查没有复制、验证或用于请求。[fixture](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/tests/__init__.py#L9) [skipped header test](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/tests/test_help.py#L27-L68) [Cookie输出测试](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/tests/test_xhs.py#L205-L207) [QR示例](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/example/login_qrcode.py#L57-L64) [phone示例](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/example/login_phone.py#L41-L59) | 若曾有效应轮换并从跟踪文件/历史中移除；测试只用合成 fixture；日志、示例和报告禁止 secret |
| SECRET-02 | 高 | 上传完成直接输出 XML、token、file ID 和 upload ID；SDK也公开完整 Cookie字符串/字典。[上传输出](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/core.py#L807-L828) [Cookie getter](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/core.py#L113-L128) | SecretRef/字段 allowlist；token、signed URL、verify ID、Cookie不进 stdout、Trace或异常 |
| ERROR-01 | 中高 | 验证码/IP/sign有初步分类；但空/非 JSON返回 raw Response，461/471 缺 header可先 `KeyError`，session-expired enum未映射，其他错误把 raw data装入异常。[异常](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/exception.py#L12-L38) [dispatcher](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/core.py#L151-L175) | 归一为安全错误码和固定模板；原始响应只进受控脱敏证据层 |
| RISK-01 | 高 | 没有 429/Retry-After、账号身份变化、请求预算、持久 pause或全局 circuit breaker；“全部”循环仅固定 sleep。已识别验证码会抛错，但覆盖不足。[循环](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/core.py#L456-L575) | CAPTCHA、AUTH、429、安全限制、sign/schema drift立即全局停止，保留 checkpoint，等待人工显式恢复 |
| SIGN-01 | 高 | 仓库有两套示例签名服务，都会在import阶段启动共享browser/page、输出 `a1`形态材料并绑定 `0.0.0.0` 的无认证 `/sign`、`/a1`。`xhs-api`会按请求替换共享 Cookie；`basic_sign_server`则不使用请求中的 `a1/web_session`。若部署可达，会形成条件性未授权 signing oracle、标识披露和跨请求状态串扰；实际远程可达性未知。[xhs-api](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs-api/app.py#L14-L72) [basic_sign_server](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/example/basic_sign_server.py#L14-L65) | 签名服务、页面 evaluate、stealth和原始 Cookie接口全部排除；未来 Provider也不向 Agent暴露签名能力 |

固定源码没有自动验证码求解路径；识别到 461/471 时会抛异常。这个“停止意图”可借鉴，但不能据此声称完整风控处置。也没有任何证据证明真实浏览器、stealth、固定延迟、代理或签名实现能降低封禁/验证码概率。

## 7. API、下载、上传与平台写能力

### 7.1 签名服务与控制面

- `xhs-api/app.py` 在 import阶段启动浏览器、访问平台并打印浏览器 `a1`，不是安全、可测试的 application factory；所有请求共享同一个 context/page/global state。[app.py](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs-api/app.py#L14-L49)
- `example/basic_sign_server.py` 是第二套同类服务：同样在 import阶段启动共享browser/page并提供全接口监听的无认证 `/sign`、`/a1`，但签名函数不使用请求中的 `a1/web_session`。若部署可达，任意调用者可条件性使用 signing oracle并读取当前标识；实际端口暴露取决于部署。[basic_sign_server.py](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/example/basic_sign_server.py#L14-L65)
- `/sign` 和 `/a1` 没有认证、调用者绑定、TLS、body/并发预算或账号 ownership；Docker/直接启动都绑定 `0.0.0.0:5005`。实际远程可达性取决于端口映射、防火墙和部署环境，不能扩大成已验证远程攻击。[routes/listen](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs-api/app.py#L56-L72) [Docker](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs-api/Dockerfile#L21-L23)
- Docker 构建从可变 CDN URL以 `--insecure` 下载脚本，没有 revision/hash/signature/license验证，随后作为浏览器 init script执行；这是条件性的浏览器供应链执行面，不表示已经发生篡改。[Dockerfile](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs-api/Dockerfile#L14-L20) [注入点](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs-api/app.py#L14-L19)

### 7.2 本地文件、网络与平台写面

- 公共 helper `download_file(url, filename)` 同时拥有任意网络读取和本地写能力；它不是安全的远端“读”操作，不能直接注册为 Agent/MCP 工具。[help.py](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/help.py#L142-L152)
- 上传直接 `open(file_path, "rb")`，没有 allowed-root、文件所有权、真实媒体解码、任务总字节或审批 token。纯本地调用者本来具有文件权限；但若宽泛包装成 API/Agent，就成为条件性本地文件外传与平台发布能力。[上传](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/core.py#L830-L895) [图文发布](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/core.py#L967-L1007) [视频发布](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/core.py#L1030-L1097)
- 同一客户端还包含浏览指标上报、评论/回复/删除、关注/取消、收藏/取消、点赞/取消、验证码/登录、通知和创作者统计。没有只读 allowlist、tool annotation、approval gate或调用者能力模型。[互动/登录](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/core.py#L577-L710) [私人数据](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/core.py#L712-L779) [上传/发布](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/core.py#L781-L1097)
- `report_note_metrics` 是平台副作用，不应因名称含 metrics 就归入只读详情。[core.py](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/core.py#L266-L307)

Rednote Sync 未来只注册精确的 `listPage/getDetail/getMediaDescriptor`；登录、签名、原始 request、下载写盘、上传、互动、发布、通知和 creator能力都不进入通用 Provider/Agent调用面。

## 8. 依赖、测试、CI、制品与许可证

### 8.1 依赖与版本边界

- `docs/requirements.txt` 精确指定一个文档主题版本，但没有 hash，也不覆盖 runtime/build依赖；它不能替代完整 lockfile。[docs requirements](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/docs/requirements.txt#L1)

- `setup.py` 只有 `requests`、`lxml` 两个无版本范围的 runtime requirement；`requirements.txt` 的 11 项同样无 pin/hash，并混合 runtime、test、build/release、Flask与Playwright。仓库没有 lockfile。[setup.py](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/setup.py#L1-L40) [requirements](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/requirements.txt#L1-L11)
- `tox.ini` 对 Python 3.7–3.11 全部安装整份 requirements；但源码使用 `dict | None`，Python 3.7–3.9无法解析。GitHub test workflow又只覆盖 3.11，支持声明与源码/CI不一致。[tox.ini](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/tox.ini#L1-L7) [语法](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/core.py#L190) [CI](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/.github/workflows/test.yml#L13-L35)
- 固定源码版本字符串是 `0.2.13`，但 no-tags 快照没有核验它与任何 PyPI release/tag/artifact的对应关系。[version](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs/__version__.py#L8-L16)

### 8.2 测试与 CI

- 固定树有 57 个 tracked test函数；静态清点 10 个有效 skip、47 个未 skip。测试主要直接调用在线 SDK，并依赖 tracked Cookie fixture、本地签名服务和本地媒体路径；本审查没有运行，不能写成通过或在线兼容证明。
- 未 skip 的测试包含评论/删评论、回复、关注、收藏、点赞与上传/发布等平台写意图；一处发布测试的 skip装饰器被注释。固定前置条件可能使它们在写操作前失败，因此不能断言 CI实际修改过平台，但测试设计没有 integration/destructive隔离。[评论/删除](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/tests/test_xhs.py#L122-L129) [互动](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/tests/test_xhs.py#L215-L253) [发布测试](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/tests/test_xhs.py#L389-L411)
- test workflow仅在 push且 `xhs/**`/`tests/**` 变更时运行，不含 pull_request；它只安装 requests/pytest/pytest-cov，没有显式安装 lxml、项目本身或签名服务，却执行整套 `pytest tests`。[test.yml](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/.github/workflows/test.yml#L1-L35)
- 三个 workflow共有 9 个外部 Action引用，全部使用 tag/branch而非完整 commit SHA；文档 workflow还使用 `ammarskar/sphinx-action@master` 和 PAT部署。[doc.yml](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/.github/workflows/doc.yml#L1-L27)
- tag发布通过 repository secret 注入 PyPI API token并使用可变 Action tag，没有 OIDC Trusted Publishing；未见版本/tag一致性、测试、twine check、checksum、签名、SBOM、provenance或attestation步骤。token有效期/scope、实际仓库外审批、PyPI设置或发布页材料未知。[pypi.yml](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/.github/workflows/pypi.yml#L1-L30)
- `MANIFEST.in` 明确把 `tests/*.py` 递归纳入源码分发，而测试树含前述 Cookie形态 fixture；PyPI workflow会构建并上传制品。因此固定配置形成“fixture可能进入sdist”的条件性制品扩散路径。由于本轮未构建或下载 artifact，不能断言实际已发布sdist或wheel一定包含该文件。[MANIFEST.in](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/MANIFEST.in#L1-L2) [发布构建](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/.github/workflows/pypi.yml#L20-L30)
- 四个 pre-commit repo也均以可变 tag而非完整 commit SHA固定；未见 SCA、secret scan、license scan、Dependabot/Renovate或受审 SBOM门。[pre-commit](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/.pre-commit-config.yaml#L1-L20)

### 8.3 Docker与许可证

- Docker base `mcr.microsoft.com/playwright/python:v1.38.0-jammy` 只有 tag、无 digest；apt/pip依赖未 pin，容器默认 root。更关键的是 Dockerfile执行 `pip install ... xhs ...`，安装发布索引中的包而不是固定 checkout，固定源码与容器运行代码可能漂移。[Dockerfile](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/xhs-api/Dockerfile#L1-L23)
- 根 LICENSE与包元数据声明 MIT；复制或分发本项目源码需保留 copyright和许可文本。本报告不是法律意见。[LICENSE](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/LICENSE#L1-L20) [setup.py](https://github.com/ReaJason/xhs/blob/f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0/setup.py#L20-L40)
- 固定树未见 NOTICE、第三方许可证清单、SBOM或发布 artifact审计。根 MIT不能自动覆盖 Python依赖、Playwright浏览器、基础镜像或远端脚本；如果未来复制源码，必须另行核对依赖许可与发布材料。当前更适合 clean-room重写少量行为。
- 任何未来发布前还必须移除并轮换潜在凭据，对实际 sdist/wheel执行内容、secret、许可证和provenance审计，避免测试材料随分发包扩散。

## 9. 对 Rednote Sync 的具体参考价值

### 9.1 可独立实现的行为

1. discovery结果把稳定 `noteId` 与短期 `xsec_token/xsec_source` 一对一配对；access material不可序列化。
2. posted单页方法静态确认请求/响应 cursor与has_more；collected/liked只确认请求 cursor，响应分页 shape保留未知。Core负责持久化和停滞检测。
3. 详情 decoder核对请求/响应 note ID，按版本校验正文、作者、标签、指标、时间和媒体 shape。
4. 图片列表顺序只作为 media ordinal候选；最终资产身份由 `(kind, ordinal, role)` 和内容 hash确定。
5. CAPTCHA、账号/会话、IP/限流、签名/协议和 schema drift分成不同停止原因；任何安全信号都触发全局暂停。

### 9.2 必须由 Rednote 自己实现的边界

- 默认只读、精确 allowlist 的 历史实施 Stage 4 Provider；不暴露原始 `XhsClient`、signer或平台写方法。
- `SessionBinding(hostId, expectedAccountId, profileId, owner)`、专用 profile、单账号互斥和每轮/恢复后身份校验。
- `StateStore` 独占 cursor、水位、checkpoint、task/failure和 canonical state；Provider不实现“获取全部”。
- `MediaStore`逐资产保存 status、attempt、bytes、magic MIME、hash、receipt和失败原因；网络路径有 HTTPS host/redirect/private-IP门、时间/字节预算和原子提交。
- Cookie、token、signed URL、verify ID、upload token和浏览器 state只进入 SecretRef/短期隔离区，不进 Agent、日志、Markdown或普通 checkpoint。
- CAPTCHA、AUTH变化、429、安全限制、签名拒绝、cursor停滞或 Schema drift立即停止，保存 checkpoint后等待人工显式恢复。

### 9.3 阶段边界

- **历史实施 Stage 3：不改变。** 继续遵循 [`sync-core.md`](../../../projects/rednote-sync-core/docs/sync-core.md) 的完全离线边界；本仓库、浏览器、Cookie、签名、endpoint和网络均不进入 Core。
- **历史实施 Stage 4：另立授权与验收门。** 所有 endpoint、token、cursor、排序和媒体字段必须在明确授权下低频、脱敏验证；仍不得把浏览器/stealth/延迟/代理当作平台许可或账号安全证明。

## 10. 采用分级与排除项

| 等级 | 对象 | 结论 |
|---|---|---|
| A | 无端到端组件 | 当前没有可直接采用的组件 |
| B | ID/access-material配对、单页 cursor候选、详情字段盘点、媒体 ordinal候选、错误分类词汇 | 只借鉴行为和数据契约，clean-room独立实现 |
| C | 同步 Session封装、HTML initial-state解析、评论两级 cursor、creator/通知/上传流程 | 仅作背景或反例资料 |
| D | 当前 SDK直接集成、两个“all”循环、媒体 downloader、`xhs-api`、stealth/签名链、Cookie fixture与日志模式、登录/互动/上传/发布、Docker制品链、现有测试/CI作为生产门 | 排除直接复用或集成 |

总体评级：**B（局部设计参考）；在线客户端、签名、媒体/状态层与平台写能力 D。** MIT本身不阻止依条款复用，但接口漂移、安全边界、第三方依赖和阶段目标使 clean-room重写更合适。

## 11. 未知项、证据等级与独立复审

### 11.1 未知项

- 未运行程序、测试、浏览器、签名服务或平台；固定 endpoint、selector、签名和响应字段在审查日是否有效未知。
- no-tags 快照没有核验 commit、tag、PyPI sdist/wheel、Docker制品和版本 `0.2.13` 的对应关系。
- posted/collected/liked真实排序、置顶、删除、空页、访问范围与 cursor稳定性未知；是否存在收藏专辑/board模型也未知。
- `xsec_token/xsec_source` 的生命周期、来源约束、分页关联、失效表现和可否安全用于详情未知。
- 详情时间字段的单位/时区、`image_list`完整性、原图/水印、Live Photo和多编码视频字段未知。
- 429、Retry-After、session expired、验证码 headers和非 JSON错误的真实响应形态未知。
- tracked Cookie形态 fixture是否曾有效未知；本次没有验证。若曾有效，应视为已公开材料并轮换。
- 实际 PyPI sdist/wheel是否包含该 fixture未知；固定 `MANIFEST.in` 只证明源码包纳入路径的配置意图，本轮没有构建或下载制品。
- 下载/路径、共享 signer和Cookie域finding是固定源码数据流的条件性风险，未执行PoC，也不声称已经发生攻击、泄漏或平台写入。
- 第三方依赖CVE、许可证兼容、可达性、GitHub branch protection、环境审批和仓库外安全设置未核验。

### 11.2 证据等级

- `[源码/配置事实]`：固定 commit 的 tracked Python/YAML/Dockerfile/LICENSE。
- `[测试意图]`：tracked test或workflow；本次未执行，不能证明运行通过或平台写入已经发生。
- `[项目声明]`：README、docs和example文案，不提升为运行证明。
- `[静态推断]`：由数据流与信任边界推导的条件性风险，保留触发前提。
- `[未知]`：需要运行、平台、发布制品、仓库外设置或法律判断才能确认。

### 11.3 独立复审

- 事实、链接与元数据复审：**PASS**；97 个固定 commit 源码链接、revision/tree、清点计数、JSON、本地链接和证据分级通过，P0–P3 为 0。
- 会话、API与安全复审：**PASS**；默认标识、两套签名服务、Cookie/secret、URL/路径/上传、平台写、验证码与停止边界全部闭环，P0–P2 为 0。
- 依赖、CI、许可证与 Rednote适配复审：**PASS**；依赖/lock、测试/CI、Action pin、Docker/远端脚本、sdist条件性扩散、MIT和B/D阶段边界通过，P0–P3 为 0。
- 完成门：固定源码仍为 detached HEAD，revision/tree与来源一致，tracked工作树 clean；报告未复制任何tracked高熵fixture值，没有凭据或真实平台请求记录。
