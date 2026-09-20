# Spider_XHS 专项源码审查

GitHub：[cv-cat/Spider_XHS](https://github.com/cv-cat/Spider_XHS)

> 状态：**研究证据**。本文只对记录的固定 revision 和审查范围负责；评级、排除项、历史实施阶段边界和账号限制不自动成为当前产品决策。

## 先读这里：身份验证与帖子详情获取

补充日期：2026-09-12。以下基于固定版本 `2030f5d4454e556ad7a9caa83b3ec532d4df20c7` 的公开源码静态分析；未运行项目，未实测当前小红书兼容性。

本节聚焦普通网页版的 `spider/spider.py` 采集链。根目录 `main.py` 是另一组登录演示，默认选择创作者中心扫码后列出已发布作品，切到 PC 才读取指定单帖。[两个演示分支](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/main.py#L20-L79)

### 身份验证方式：提供完整 Cookie，或通过接口扫码／短信登录

批量脚本默认读取用户提供的完整 Cookie，可以理解为“已经登录的会话凭证”：配置来自 `.env`／`COOKIES` 环境变量，再交给 Auth 对象管理。它不会自动从已打开的浏览器取 Cookie。另可选择二维码或手机验证码入口；这两条路线用 HTTP 请求完成登录，用户仍需在手机 App 确认扫码，或输入手机号及短信验证码。[配置读取](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/xhs_utils/common_util.py#L13-L30) [三种入口](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/spider/spider.py#L113-L132) [二维码工厂](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/xhs_utils/xhs_pc/auth.py#L428-L469) [短信流程](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/apis/xhs_pc_login_apis.py#L845-L880)

“有 Auth 对象”和“确认登录”分两步：前者初步检查 `a1/web_session` 等字段；随后 `bootstrap()` 请求当前用户资料，要求响应成功且用户 ID 非空，但不拒绝访客，也不比对用户预先指定的账号。扫码、短信流程另外要求用户资料查询成功且 `guest=false`，才返回 Cookie。[字段检查](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/xhs_utils/xhs_pc/auth.py#L263-L276) [用户资料检查](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/apis/xhs_pc_apis.py#L72-L81) [扫码验收](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/apis/xhs_pc_login_apis.py#L834-L843) [短信验收](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/apis/xhs_pc_login_apis.py#L871-L880)

请求签名由项目的 Python 组件调用 Node.js 中的 JavaScript 准备；Node.js 是脚本运行时，不是浏览器，生成签名也不等于证明账号登录有效。[请求组装](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/apis/xhs_pc_apis.py#L119-L133) [签名调用](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/xhs_utils/xhs_pc/params.py#L180-L197) [Node 子进程](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/xhs_utils/xhs_pc/runtime.py#L108-L117)

### 帖子详情获取方式：脚本逐条请求详情 API，直接读取 JSON

帖子范围由调用方指定。现成批量包装支持“帖子链接清单”“某个用户的发布列表”“关键词及数量／筛选条件”；后两者先请求列表，再逐条获取详情。底层还有喜欢、收藏列表 API，但这两类没有对应的现成批量导出包装。[清单循环](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/spider/spider.py#L28-L52) [用户与搜索](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/spider/spider.py#L54-L103) [喜欢列表](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/apis/xhs_pc_apis.py#L380-L409) [收藏列表](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/apis/xhs_pc_apis.py#L439-L468)

`get_note_info()` 从网址取帖子 ID、`xsec_token` 和 `xsec_source`，向 `/api/sns/web/v1/feed` 发 HTTP POST，读取响应 JSON。缺 token 时发送空字符串，缺 source 时使用 `pc_search`；这不证明无 token 也能访问。该方法失败后返回错误，没有下载 HTML 的备用解析分支。[详情方法](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/apis/xhs_pc_apis.py#L470-L503)

因此，采集阶段可以由后台 Python＋Node.js 脚本执行，不需要先打开浏览器、逐篇点击或导出 HAR。名为 `BrowserHttpClient` 的组件实际使用 `curl_cffi` 发请求，并不启动浏览器；图片、视频另用 HTTP 下载，按选择保存媒体或 Excel。[HTTP 实现](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/xhs_utils/xhs_core/http.py#L79-L100) [下载](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/xhs_utils/data_util.py#L210-L228) [输出选择](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/spider/spider.py#L28-L52)

有两处会影响结果理解：列表包装重建链接时保留 ID、token，却丢掉 source；单帖包装直接取响应第一条，不比对请求 ID。另外，“全部发布”循环可能在追加当前页前退出，不能保证收齐所有帖子。[链接重建](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/spider/spider.py#L54-L98) [首条读取](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/spider/spider.py#L14-L26) [分页停止](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/apis/xhs_pc_apis.py#L335-L346)

状态：专项静态审查完成；独立复审通过
审查日期：2026-08-13
固定 revision：[`2030f5d4454e556ad7a9caa83b3ec532d4df20c7`](https://github.com/cv-cat/Spider_XHS/tree/2030f5d4454e556ad7a9caa83b3ec532d4df20c7)

> 本报告只描述固定 revision 的 tracked 静态证据，不证明当前平台兼容性、运行可靠性、平台许可、账号安全或任何“反风控”效果。未安装依赖，未执行项目、构建、测试、浏览器、签名程序或平台请求，也未读取用户 Cookie、token、profile、日志或个人数据。tracked 示例中的 access-material 只登记存在性，不复制、不验证其值。

## 1. 项目定位、版本和审查范围

- 来源、revision、tree 与静态清点见 [`provenance.json`](provenance.json)，中断恢复状态见 [`checkpoint.json`](checkpoint.json)。
- 仅通过 `git ls-files` 审查固定 revision 的 79 个 tracked 文件；范围包括 PC、Creator、蒲公英和千帆 API，登录/会话，本地 JavaScript 运行时，媒体/文件输出，依赖、容器和许可边界。
- README/项目声明、源码/配置事实、静态推断和未知项分别标记。签名、指纹、验证码、代理和设备重建代码只登记结构、权限与风险，不转换为规避方案。
- 评级表示对 Rednote Sync 的参考优先级，不表示代码质量、合法性、平台许可或账号安全。

## 2. 结论摘要

### 核心结论：

- **最终建议 B：只把单页接口、字段候选、访问材料配对意图及 Creator 重复游标检测作为历史实施 Stage 4 的静态参考；现有聚合器、normalizer、下载器、签名/登录、平台写和 Docker 路线均不直接采用。** PC API 与 Data_Spider/文件输出耦合；Creator是另一条独立上传/发布能力面。两者都没有版本化 Schema、durable checkpoint、逐资产状态或 canonical transaction。[PC入口](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/spider/spider.py#L3-L52) [Creator上传](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/apis/xhs_creator_apis.py#L318-L380) [Creator发布](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/apis/xhs_creator_apis.py#L449-L618)
- README 所称用户发布/喜欢/收藏“所有笔记”有对应循环，但三个循环都可能在缺少 `cursor` 时先退出、后追加当前页；也没有重复 cursor、空页、页数预算或 ID 去重门。它们只能证明功能意图，不能证明完整性。[发布](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/apis/xhs_pc_apis.py#L292-L350) [喜欢](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/apis/xhs_pc_apis.py#L352-L409) [收藏](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/apis/xhs_pc_apis.py#L411-L468)
- 发现结果原本含 `note_id/xsec_token/xsec_source`，包装层重建详情 URL 时只保留 ID 与 token，丢失 source，详情随后使用默认 `pc_search`；静态源码由此证明 access context 没有完整配对，线上影响未知。[包装层](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/spider/spider.py#L54-L103) [详情](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/apis/xhs_pc_apis.py#L470-L503)
- 图片固定取 `info_list[1].url`，缺失时静默丢弃；视频只取第一条 H.264，没有 Live Photo、稳定 media slot、预期资产集合、variant 或逐资产 receipt。下载直写最终文件，无 Range、长度/MIME/hash、字节预算、临时文件或原子提交。[normalizer](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/xhs_utils/data_util.py#L69-L144) [下载](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/xhs_utils/data_util.py#L210-L228)
- 详情失败会被批次跳过，图片描述缺失会静默略过、视频URL缺失只warning，列表成功仍可能成为最终`success=True`；网络或写入异常则触发`@retry(tries=3)`重跑整条笔记，最终失败会抛出但直写残片可能保留。这不是checkpoint或断点续传。[批处理](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/spider/spider.py#L14-L71) [媒体与落盘](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/xhs_utils/data_util.py#L210-L299)
- **安全边界阻断直接采用。** `websectiga`服务端JavaScript被送入Node并由`vm.runInThisContext`执行；子进程超时不是OS级沙箱。Creator DS程序与Cookie也进入临时JSON/Node进程，但Python写`dsProgram`、JS只读`dsfProgram`，固定revision下不能证明DS执行路径已接通；这是项目声明/实现冲突与秘密边界，不提升为已发生执行。[Python bridge](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/xhs_utils/xhs_core/runtime.py#L54-L84) [执行点](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/xhs_utils/xhs_core/js/websectiga_cli.js#L193-L217) [Creator payload](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/xhs_utils/xhs_creator/runtime.py#L88-L132) [JS字段](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/xhs_utils/xhs_core/js/sign.js#L95-L107)
- Creator 登录会把任意二维码/短信初始化失败扩大为最多 16 次匿名设备重建；另有无退避的 406 请求级重发。实现/注释对 406 是请求级还是会话级也相互矛盾，不能当作风控有效性证明；Rednote 应在 406/429/CAPTCHA/安全限制时立即停止并人工恢复。[上限常量](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/apis/xhs_creator_login_apis.py#L82-L86) [设备重建](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/apis/xhs_creator_login_apis.py#L1062-L1095) [短信](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/apis/xhs_creator_login_apis.py#L1125-L1159) [406 helper](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/apis/xhs_creator_login_apis.py#L707-L720)
- 同一库含读取、媒体上传、笔记发布与合作邀请，却没有 expected-account、会话 ownership、只读 allowlist 或写操作 approval；发布还会在 `code=-1` 时自动重发三次且无客户端幂等键。[发布](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/apis/xhs_creator_apis.py#L449-L618) [邀请](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/apis/xhs_pugongying_apis.py#L129-L150)
- 固定树没有 LICENSE/NOTICE。README 的 MIT badge 指向不存在的 LICENSE，同时正文写“仅供学习交流、禁止商业化”；不作法律判断，但工程上按许可冲突/未知处理，禁止复制、链接或再分发源码和内嵌算法/指纹材料。[badge](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/README.md#L15-L18) [限制措辞](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/README.md#L56-L62)
- Python 11 个依赖只有一个精确 pin且全部无 hash；Node 的唯一依赖虽有 lock/integrity，Dockerfile却未运行 `npm ci/install`。仓库又没有 `.dockerignore`；cookie登录模式要求创建含 Cookie 的 `.env`，而 Dockerfile `COPY . .`，因此这类构建上下文存在条件性 secret 入镜像风险。QR/phone模式不需要该文件。[requirements](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/requirements.txt#L1-L11) [Dockerfile](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/Dockerfile#L1-L22) [README配置](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/README.md#L221-L237)
- 历史实施 Stage 3 继续完全离线。历史实施 Stage 4 即使取得明确授权，也只能 clean-room 实现默认只读 Provider、`SessionBinding`、单页 decoder、类型化停止、短期 access-material envelope 与可恢复媒体 writer；签名、指纹抖动、设备重建、代理、TLS impersonation和固定延迟都不是账号安全证明。

## 3. 架构与数据流

```text
PC 用户 URL / 搜索参数
  → XHS_Apis → curl_cffi Session + PC Auth/Node signer → 平台 JSON
  → Data_Spider → handle_note_info
  → info.json / detail.txt / XLSX / jpg / mp4

Creator 调用方
  → Creator API + Creator Auth/Node signer
  → 上传 / 发布响应
```

- `[源码事实]` `Data_Spider` 只做在线 API 编排、成功项收集和直接文件输出，获取、normalization、下载、投影没有 Provider/Core/Writer 边界。[spider.py](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/spider/spider.py#L9-L103)
- `[源码事实]` 详情接口返回平台原始 JSON；项目没有版本化 decoder、schemaVersion、runtime shape validation、canonical Note 或稳定 error envelope。[详情](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/apis/xhs_pc_apis.py#L470-L503)
- `[源码事实]` `handle_note_info` 生成 19 项扁平字段，再由 JSON/TXT/XLSX/媒体 helper 分别落盘；这些是 derived output 候选，不是事务性 canonical state。[字段](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/xhs_utils/data_util.py#L69-L144) [输出](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/xhs_utils/data_util.py#L189-L299)
- `[适配判断]` 未来只能借鉴“原始单页响应 → 严格 decoder → canonical Note → 独立 projector”的拆分方向，不能把当前在线脚本置入 历史实施 Stage 3 Core。

## 4. 发现、详情与媒体能力

### 4.1 发布、喜欢、收藏与搜索

- 用户发布、喜欢和收藏各有单页和“全部”接口；单页请求/响应携带 ID、cursor、token/source 候选，但三个聚合循环先判断 cursor 再追加当前页，缺 cursor 可丢页。它们也不检测停滞、不去重、不持久化 progress。[发布](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/apis/xhs_pc_apis.py#L292-L350) [喜欢](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/apis/xhs_pc_apis.py#L352-L409) [收藏](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/apis/xhs_pc_apis.py#L411-L468)
- 中途错误返回 `success=False` 与内存中累计前缀，但没有 `complete/partial`、request cursor、last accepted page、scope digest 或 failure receipt；调用层又可能丢失这个完成语义。
- Creator 已发布作品聚合器有重复 cursor 集合与 cursor 类型检查，这是小范围正面参考；仍没有持久 checkpoint、页级事务或 ID 去重。[Creator列表](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/apis/xhs_creator_apis.py#L739-L824)
- 搜索按原始 items 数达到 `require_num` 就停止，包装层之后才过滤 `model_type == note`，最终笔记数可能不足；空页、重复项、分页 session 也没有完成性门。[搜索接口](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/apis/xhs_pc_apis.py#L526-L633) [包装层](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/spider/spider.py#L85-L103)
- 评论有一级/二级 cursor 循环，但同样可能先退出后追加、重复 cursor 卡住；tracked入口未形成完整评论导出编排。[评论](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/apis/xhs_pc_apis.py#L692-L825)

### 4.2 详情字段与访问材料

- note 字段包含 ID/URL、类型、作者、正文、四类计数、图片、视频、标签、时间与 IP 地域，但非 `normal` 的类型全部变成“视频”，计数不做类型校验，epoch 通过本机 `localtime` 转为无时区文本。[normalizer](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/xhs_utils/data_util.py#L69-L144)
- `spider_note` 将输入的带 query URL原样写回 `note_url`，后续进入 XLSX、`info.json` 和 `detail.txt`；这些 URL 通常含 access token。[入口](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/spider/spider.py#L14-L25) [输出](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/xhs_utils/data_util.py#L189-L208) [本地详情](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/xhs_utils/data_util.py#L246-L286)
- Rednote 必须把 `noteId` 与短期 `PrivateNoteAccess(token, source, provenance)` 分开；公开 URL去掉 query/fragment，访问材料不得进入 canonical、日志、Markdown或普通 checkpoint。

### 4.3 媒体模型与输出

- 图片依赖 `info_list[1]` 位置，失败静默跳过；视频取第一条 H.264 或 consumer key。固定 tree 未发现 Live Photo/motion asset、H.265选择、variant、source ordinal、MIME/bytes/hash或 `mediaSetComplete`。[媒体解析](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/xhs_utils/data_util.py#L69-L144)
- README 的“无水印”不能由主数据流证明；转换调用已被注释，静态源码不能证明实际资源质量。[字段选择](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/xhs_utils/data_util.py#L90-L105)
- 下载接受 URL并默认跟随重定向，图片整包读内存、视频直接流入最终文件；无 HTTPS/host/private-IP allowlist、字节/总时限、magic MIME、长度/hash、Range或原子提交，形成条件性 blind SSRF、内存/磁盘耗尽和残片风险。[download_media](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/xhs_utils/data_util.py#L210-L228)
- XLSX 将远端标题、描述、作者等字符串原样交给 openpyxl；以 `=` 开头的非可信内容可能被办公软件解释为公式。具体消费者行为未动态验证，未来 projector 应进行公式前缀中和。[XLSX](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/xhs_utils/data_util.py#L189-L208)

## 5. 状态、checkpoint、幂等及失败恢复

| 审查面 | 固定源码事实 | 结论 |
|---|---|---|
| 列表 cursor | 仅在内存循环，无 scope/provenance/停滞/原子推进 | 不采用 `get_*_all`；未来 Provider每次只返回一页 |
| 详情失败 | 单项失败被跳过，成功项继续输出 | 必须形成 durable task/failure，不能把列表成功等同详情完整 |
| 媒体不完整 | normalizer静默跳过异常图片；缺视频cover/address只warning后仍返回路径 | note完成与media完成分离，逐槽状态 |
| 下载/写入失败 | 网络或文件异常触发整note retry；最终失败会抛出，但已直写文件可能残留 | `.part`、逐槽receipt、原子提交；不得整note盲重试 |
| 重试 | `@retry(tries=3)` 重做整条 note并覆盖最终文件 | 不是 resume；排除 |
| 输出 | JSON/TXT/XLSX/媒体直接写文件，无事务/receipt | 只能是由 canonical state重建的 derived view |

- `spider_user_all_note` 的最终 success沿用列表发现结果，不吸收详情遗漏，因此 Excel可以少条目而调用结果仍成功。[批处理](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/spider/spider.py#L54-L71)
- 目录包含作者名、标题、user/note ID；作者名或标题变化会生成另一目录。`excel_name`/搜索 query直接参与 `join` 后只做 `abspath`，未验证结果仍在输出根内，形成条件性越界覆盖。[Excel路径](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/spider/spider.py#L47-L52) [媒体目录](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/xhs_utils/data_util.py#L271-L299)
- Rednote Core继续独占 cursor、水位、task/failure、canonical transaction和逐资产状态；Provider只提交经验证的一页及其 cursor provenance。

## 6. 会话、凭据、网络和风控停止边界

| ID | 严重性 | 固定证据与静态判断 | Rednote 边界 |
|---|---|---|---|
| EXEC-01 | 高 | PC/Creator取得服务器 scripting code并交 Node；`vm.runInThisContext`不是安全沙箱，远端程序与本机环境/权限边界相邻。[PC调用](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/apis/xhs_pc_login_apis.py#L373-L390) [执行](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/xhs_utils/xhs_core/js/websectiga_cli.js#L193-L217) | Core禁止远端程序；历史实施 Stage 4 也排除该执行链 |
| EXEC-02 | 高 | Creator DS程序与完整Cookie同入临时payload/Node signer；文件finally删除，但崩溃残留、权限和宿主可见性未动态验证。Python字段为`dsProgram`而JS调用条件只读`dsfProgram`，所以固定revision只能证明程序/秘密进入进程，不能证明DS已执行。[payload](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/xhs_utils/xhs_creator/runtime.py#L88-L132) [JS条件](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/xhs_utils/xhs_core/js/sign.js#L95-L107) | 不复用；秘密和远端程序不能进入同一helper；运行行为保留未知 |
| SESSION-01 | 高 | PC只检查`a1/web_session`并把实际`user_id`存入实例，但不与expectedAccountId比较；Creator只检查任一认证Cookie，bootstrap丢弃用户响应，登录验收只记录用户名/RedID。两者都没有任务/会话互斥。[PC Auth](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/xhs_utils/xhs_pc/auth.py#L263-L276) [PC bootstrap](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/apis/xhs_pc_apis.py#L72-L81) [Creator Auth](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/xhs_utils/xhs_creator/auth.py#L191-L199) [Creator bootstrap](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/apis/xhs_creator_apis.py#L185-L190) [Creator验收](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/apis/xhs_creator_login_apis.py#L1030-L1042) | `SessionBinding(expectedAccountId, profileId, owner)`；每轮/恢复后校验 |
| SESSION-02 | 中高 | 匿名设备重建会替换login profile/http，但QR/phone工厂可能仍把重试前局部profile装入最终Auth，形成Cookie与旧设备状态重组。[reset](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/apis/xhs_creator_login_apis.py#L134-L155) [factory](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/xhs_utils/xhs_creator/auth.py#L328-L382) | 禁止自动身份/设备切换；状态漂移即停止 |
| SECRET-01 | 高 | debug模式打印Cookie header、签名header、body和响应；PC Auth的cookies字段未设置`repr=False`，tokenized URL日志与输出文件也可传播秘密；Creator Auth的cookies字段则已隐藏repr。[debug](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/apis/xhs_creator_login_apis.py#L231-L266) [PC Auth字段](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/xhs_utils/xhs_pc/auth.py#L168-L176) [URL日志](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/spider/spider.py#L14-L25) | SecretRef、字段allowlist；禁止raw dump和secret repr |
| RISK-01 | 高 | QR/短信初始化任意失败会重建设备，最多16次；没有按CAPTCHA/429/security/Retry-After分类。[QR](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/apis/xhs_creator_login_apis.py#L1062-L1095) [phone](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/apis/xhs_creator_login_apis.py#L1125-L1159) | 安全信号立即全局pause，checkpoint后人工恢复；短信默认一次 |
| SECRET-02 | 高 | PC signer把完整Cookie JSON作为Node argv；PC/Creator profileData也把`documentCookie`等payload放入argv。同机进程列表、诊断或进程日志可能观察，具体OS可见性未动态验证。[PC signer](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/xhs_utils/xhs_pc/runtime.py#L68-L117) [PC profileData argv](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/xhs_utils/xhs_pc/runtime.py#L201-L246) [Creator options](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/xhs_utils/xhs_creator/state.py#L552-L567) [Creator argv](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/xhs_utils/xhs_creator/runtime.py#L155-L160) | 秘密只经受控stdin/专用IPC；禁止argv、环境变量和普通临时文件 |
| RISK-02 | 中高 | 406 helper无退避地重放调用闭包；headers/body在进入helper前已构造，因此源码实际重发相同请求，与注释声称“换新签名”不一致。真实Chrome/TLS impersonation、指纹和代理都无账号安全证明。[helper](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/apis/xhs_creator_login_apis.py#L707-L720) [固定请求示例](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/apis/xhs_creator_login_apis.py#L750-L782) | 不采用设备重建、指纹抖动、代理轮换或强行重试 |
| RISK-03 | 中 | Creator QR在获取成功后`while True`轮询，只有服务端明确成功/错误/过期才退出；没有wall-clock deadline或最大poll次数。PC QR有180秒deadline，属于局部正面对照。[Creator poll](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/apis/xhs_creator_login_apis.py#L1096-L1123) [PC deadline](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/apis/xhs_pc_login_apis.py#L769-L843) | 所有login/poll必须有deadline、请求预算和可审计人工恢复 |
| NET-01 | 中高 | 下载任意URL；Creator接受服务端`uploadAddr`，包含`http`前缀也发送媒体/token。实际host可信度未知。[下载](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/xhs_utils/data_util.py#L210-L228) [上传](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/apis/xhs_creator_apis.py#L318-L372) | HTTPS精确host allowlist、每跳重验、拒绝私网/本地地址 |

正面控制包括：显式 Auth 对象、PC 非访客会话检查、PC QR本地 deadline、host-only Cookie专门存储、`discard_cookies=True`和部分state snapshot不带token。这些是局部实现，不能替代expected-account、secret lifecycle和全局停止机制。[HostCookieStore](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/xhs_utils/xhs_core/cookies.py#L1-L180)

## 7. CLI/API/Agent 权限与平台写操作

- 固定 tree 没有 MCP/server/Agent监听入口；README指向的Skills和成品属于其他仓库，不能归因于当前源码。Docker虽`EXPOSE 5000`，CMD只是运行本地脚本，未发现对应listener。[Dockerfile](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/Dockerfile#L18-L29)
- 同一Python包公开读取、登录、上传、发布、蒲公英合作邀请等能力，没有read/write/local-file/network capability分级或approval token。[发布](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/apis/xhs_creator_apis.py#L449-L618) [合作邀请](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/apis/xhs_pugongying_apis.py#L129-L150)
- 上传接受调用方提供的媒体字节；若未来被宽泛API/Agent包装，会把本地文件读取与平台上传组合成高权限面。当前库调用者本来就有本地权限，故这是条件性集成风险，不描述为远程漏洞。[上传](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/apis/xhs_creator_apis.py#L318-L380)
- `post_note` 对 `code=-1` 自动重发，缺operation ID、unknown-outcome分类和成功后对账；不能用于生产写操作。[重发](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/apis/xhs_creator_apis.py#L594-L618)

未来 Rednote Provider只注册精确只读的`listPage/getDetail/getMediaDescriptor`；登录、签名、raw request、下载写盘、上传、发布、邀请、验证码发送均不进入通用Agent能力面。

## 8. 依赖、测试、CI 和维护风险

### 8.1 依赖与容器

- Python requirements有11项，仅`curl_cffi`精确pin；其他10项无版本，全部无hash，且没有Python lockfile。[requirements](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/requirements.txt#L1-L11)
- Node manifest只有`crypto-js ^4.2.0`；lockfile v3固定4.2.0并含resolved/integrity，这是局部正面信号。[package](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/package.json#L1-L9) [lock](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/package-lock.json#L1-L20)
- Docker只安装Node和Python依赖，从不执行`npm ci/install`，clean build中的JS signer缺声明的Node模块；若本地上下文含`node_modules`，`COPY . .`又会引入宿主状态。未构建，具体失败点保留为静态配置缺口。[Docker](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/Dockerfile#L1-L22)
- base只有mutable tag；NodeSource脚本下载即执行，apt/pip未pin；镜像默认root并保留构建工具。没有`.dockerignore`，而`.gitignore`不能保护Docker上下文。[Docker](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/Dockerfile#L1-L29) [.gitignore](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/.gitignore#L1-L5)

### 8.2 测试、CI与发布

- 静态清点为79 tracked、0 test、0 workflow、0 LICENSE/NOTICE；`.gitignore`还默认忽略`/tests/`。[静态清点](provenance.json) [.gitignore](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/.gitignore#L33-L40)
- 没有test/lint/typecheck、CI、SCA、secret/license scan、SBOM、checksum、signature、attestation或provenance门。package也没有scripts。
- README changelog提到历史PyPI/release，但固定tree没有Python打包元数据，本快照未获取tags；当前源码、PyPI包和release制品对应关系未知。[changelog](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/README.md#L373-L392)
- 固定tree含3个具体token-shaped URL示例；报告不复制值，有效性未知。未来仓库不得提交真实signed URL/access material。[示例位置1](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/main.py#L20-L28) [位置2](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/spider/spider.py#L138-L146)
- 16个JS与若干指纹/算法JSON的外部来源、原始证据hash、许可证和NOTICE不足；只能登记“存在相应运行边界”，不能复制。[rap.js](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/xhs_utils/xhs_pc/js/rap.js#L1-L25) [环境脚本](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/xhs_utils/xhs_core/js/websectiga_env.js#L20-L35)

## 9. 许可证与源码复用边界

- 固定tree没有项目级LICENSE/COPYING/NOTICE；package也没有license字段。[静态清点](provenance.json)
- README一处标MIT，另一处禁止商业化，且MIT链接目标在固定tree不存在。不能把crypto-js lock中的MIT外推为项目许可证。[README badge](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/README.md#L15-L18) [限制](https://github.com/cv-cat/Spider_XHS/blob/2030f5d4454e556ad7a9caa83b3ec532d4df20c7/README.md#L56-L62)
- 本报告不判断这些措辞的法律效力。工程结论是：许可澄清前，源码、JS/JSON、指纹、签名和容器配置均不得复制、链接、打包或再分发；只允许clean-room复现公开行为契约。
- 第三方Python/Node依赖、基础镜像、NodeSource脚本与reverse-derived材料需各自license/SBOM/provenance核验，项目声明不能代替它们。

## 10. 对 Rednote Sync 的具体参考价值

### 10.1 可独立实现的行为

1. discovery item明确携带稳定`noteId`与短期`token/source/provenance`，但两者存储域分离。
2. Provider每次只返回一页：`requestCursor/nextCursor/hasMore/items/pageComplete`；重复、缺失、类型错误cursor立即停止。
3. Creator列表的重复cursor集合可作为停滞检测意图；真正进度由Core原子持久化。
4. detail decoder盘点ID、正文、作者、指标、标签、时间、图片/视频字段，同时核对请求ID、shape和Schema版本。
5. 先形成完整`MediaAsset[]`/`mediaSetComplete`，再下载；slot由`kind+ordinal+role`确定。

### 10.2 必须由 Rednote 自己实现的边界

- 默认只读、精确allowlist的历史实施 Stage 4 Provider；不暴露`XHS_Apis`、Creator/PuGongYing/Qianfan、signer或platform write。
- `SessionBinding(hostId, expectedAccountId, profileId, owner)`、专用身份材料、单账号互斥及每轮/恢复后验身。
- SQLite独占cursor、水位、task/failure、canonical transaction；partial详情/媒体不得提升为完成。
- 媒体逐槽状态、HTTPS host/redirect/private-IP门、总字节/时限、magic MIME、长度/hash、`.part`和原子提交。
- Cookie/token/signed URL/DS program/verify ID只进短生命周期SecretRef，不进Agent、stdout、Trace、Markdown或普通checkpoint。
- CAPTCHA、AUTH变化、406/429、安全限制、签名拒绝、cursor停滞或Schema drift立即全局停止，人工显式恢复。

### 10.3 阶段边界

- **历史实施 Stage 3：保持完全离线。** 继续遵循 [`sync-core.md`](../../../projects/docs/sync-core.md)；本仓库及其HTTP、Cookie、签名、Node、代理和下载不进入Core。
- **历史实施 Stage 4：另立授权与验收门。** 所有endpoint、token/source、cursor、身份和媒体字段需在明确授权下低频、脱敏验证；这仍不构成平台许可或账号安全证明。

## 11. 采用分级、未知项和独立复审

### 11.1 A–D采用分级

| 等级 | 对象 | 结论 |
|---|---|---|
| A | 无端到端组件 | 当前没有可直接采用组件 |
| B | PC/Creator单页字段、ID/access-context概念、Creator重复cursor检测 | 只作历史实施 Stage 4 专项候选与clean-room行为参考 |
| C | note字段清单、JSON/TXT/XLSX目录体验、评论/搜索shape | 背景资料；不能定义canonical/schema或完整性 |
| D | PC“全部”循环、normalizer、downloader、`websectiga`远端JS执行、Creator DS未接通链与临时秘密边界、设备重建/406策略、平台写、Docker/依赖链、源码/算法复制 | 排除直接集成与复用 |

总体评级：**B（局部静态参考）；在线客户端、状态/媒体、签名/登录、平台写、容器和源码复用为D。**

### 11.2 未知项

- 未运行项目或访问平台；fixed endpoint、响应shape、signature与README功能当前是否有效未知。
- 服务器最后一页是否始终返回cursor，发布/喜欢/收藏真实范围、排序、置顶/删除和可见性未知。
- 丢失`xsec_source`后的实际详情行为、token/source生命周期和分页关联未知。
- `info_list[1]`质量/水印语义、Live Photo真实字段、视频variant排序和完整资产集合未知。
- 406/429/CAPTCHA、安全限制与服务端`uploadAddr`当前语义未知；不存在账号安全率证明。
- Node VM finding是静态信任边界判断，未执行逃逸PoC；临时签名文件的真实权限/残留也未动态验证。
- no-tags快照没有核验PyPI、tag、release或镜像与commit对应关系。
- sample access-material是否曾有效、第三方依赖CVE/许可证、仓库外保护规则和发布材料未知。

### 11.3 证据等级与独立复审

- `[源码/配置事实]`：固定commit的tracked Python、JavaScript、JSON、manifest、lock、Dockerfile与README。
- `[项目声明]`：README、注释和更新日志；不提升为在线可靠性、风控或许可证明。
- `[静态推断]`：由数据流/信任边界推导的条件性风险，保留触发前提。
- `[未知]`：需要运行、平台、制品、仓库外配置或法律判断才能确认。

- 事实、链接与元数据复审：**PASS**；固定revision/tree、tracked清点、70个固定源码链接、本地链接、证据分级和secret脱敏通过，P0–P3为0。
- 会话、网络、平台写与安全复审：**PASS**；远端JS/DS边界、argv/日志secret、账号绑定、406/二维码停止、SSRF/路径/预算和平台写全部闭环，P0–P3为0。
- 依赖、容器、许可证与Rednote适配复审：**PASS**；Python/Node依赖、Docker构建上下文、测试/CI、许可冲突/未知、B/D分级与历史实施 Stage 3 与历史实施 Stage 4 边界通过，P0–P3为0。
- 完成门：固定源码仍为detached HEAD，revision/tree与来源一致，tracked工作树clean；报告没有复制token-shaped示例值，没有凭据或真实平台请求记录。
