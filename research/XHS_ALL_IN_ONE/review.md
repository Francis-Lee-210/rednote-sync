# XHS_ALL_IN_ONE 专项源码审查

状态：专项静态审查完成；独立复审通过  
审查日期：2026-08-13  
固定 revision：[`63b85de2b15b3f79134b08fa675381505f45d4db`](https://github.com/cv-cat/XHS_ALL_IN_ONE/tree/63b85de2b15b3f79134b08fa675381505f45d4db)

> 本报告只描述固定 revision 的 tracked 静态证据，不证明当前平台兼容性、运行可靠性、平台许可、账号安全或任何“反风控”效果。未安装依赖，未执行项目、构建、测试、浏览器或平台请求，也未读取用户 Cookie、token、数据库、profile、日志或个人数据。

## 1. 项目定位、版本和审查范围

- 来源、revision、tree 与静态清点见 [`provenance.json`](provenance.json)，中断恢复状态见 [`checkpoint.json`](checkpoint.json)。
- 仅通过 `git ls-files` 审查固定 revision 的 217 个 tracked 文件；范围包括 FastAPI/React 控制面、账号和会话、采集/内容/资产模型、任务/调度/发布、AI 能力、依赖、容器和许可证。
- README/项目声明、源码/配置事实、测试意图、静态推断和未知项分别标记；所有在线、验证码、签名、指纹、代理、多账号和平台写能力只登记权限与风险。
- 仓库将自身定位为“采集→内容库→AI→发布”的一站式运营平台，并声明采集素材自动下载、任务审计、重试与取消；这些属于项目声明，不是 checkpoint、幂等或安全证明。[README 声明](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/README.md#L13-L29) [功能描述](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/README.md#L55-L87) [任务声明](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/README.md#L112-L128)

## 2. 结论摘要

### 核心结论：

维持 **B 级“局部架构与行为设计参考”**，但 **源码复用、直接部署、网络 Provider、自动运营和平台写链均为 D**。最值得借鉴的是 SDK→Adapter→Service/API 的隔离外形、Task 的审计字段、发布素材的逐项状态，以及“连续失败→暂停→通知”的产品行为；这些都应在 Rednote Sync 中 clean-room 独立实现。[Adapter 结构](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/adapters/xhs/pc_api_adapter.py#L8-L59) [发布素材模型](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/models/publish.py#L13-L43) [暂停行为](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/services/monitoring_crawl_service.py#L212-L247)

不能把本项目当作 Rednote Sync Core 的状态层：Note 没有业务唯一约束，账号/平台 provenance 会陈旧；NoteAsset 缺少稳定序号、逐资产状态、长度、哈希、MIME、重试回执和 Live Photo 配对；下载直接把整响应写入最终文件。[内容模型](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/models/note.py#L21-L44) [保存路径](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/api/platforms/xhs/crawl.py#L149-L183) [下载器](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/services/asset_downloader.py#L11-L50)

最关键的恢复断点是：SSE `/crawl/data` 会把 `normalized_for_save` 加入内存列表，但结束前从未调用 `_save_normalized_notes`，因此结果只存在于 SSE/内存；空关键词还会提前返回并把 Task 留在 `running`。通用 retry 只改回 `pending`，不检查 `max_retries`、不分派执行器，也没有 cursor/checkpoint/resume。[SSE 主体](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/api/platforms/xhs/crawl.py#L342-L497) [Task retry](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/api/tasks.py#L141-L171) [空 runner](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/core/task_runner.py#L10-L31)

安全上不适合直接部署：默认 YAML 作为 `Settings(**yaml_values)` 初始化输入，静态代码路径推断会优先于环境变量，可能使固定开发 JWT 密钥实际生效；Fernet 又从同一密钥派生。Creator 素材入口接受任意 HTTP(S) URL或服务器本地路径；另一条 `/notes/batch-save` 链还会把用户提供的媒体 URL 无界下载到无鉴权 media 路由，形成独立的条件性 SSRF、响应外带、资源耗尽和本地文件外传面。[配置加载](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/core/config.py#L15-L78) [Creator 读取](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/adapters/xhs/creator_api_adapter.py#L31-L75) [batch save](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/api/notes.py#L426-L501) [公开 media](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/api/files.py#L149-L156)

平台写是 at-least-once/未知结果语义：远端成功但响应或本地 commit 丢失时会标失败，retry 随后清空外部 ID 并重发；调度也没有数据库 lease/幂等键。production 配置还可无人审批执行“搜索→远端 AI→上传→发布”。这些实现全部排除，不得转换成 Rednote 的 Agent/自动发布能力。[重试清状态](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/api/publish.py#L303-L320) [发布事务边界](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/api/publish.py#L513-L555) [后台自动运营](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/services/scheduler_service.py#L435-L601)

供应链与授权也阻断复用：26 项 Python 依赖无精确 pin；两个 npm lock 虽有 resolved/integrity，绝大多数制品指向腾讯镜像；Docker 在 `npm ci` 失败时降级到 `npm install`、执行远端 shell、使用可变 base tag并以 root 运行。README 同时声称 MIT 和“禁止商业化”，固定树却没有 LICENSE/NOTICE；内嵌逆向/Spider 材料也缺 provenance。因此只能借鉴行为，不能复制、链接或分发源码。[依赖清单](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/requirements.txt#L1-L27) [Docker](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/Dockerfile#L15-L75) [README 许可冲突](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/README.md#L13-L30)

## 3. 架构与数据流

### 3.1 分层与能力面

数据流大致为：`apis/xhs_utils` 逆向 SDK → `backend/app/adapters/xhs` → FastAPI service/router → SQLAlchemy/本地文件 → React；另一条写链从 Draft/PublishJob 进入 Creator adapter。Adapter seam 是可参考形态，但接口以 `Any` 或三元组返回，没有版本化 runtime schema、typed failure envelope 或独立 access-material 类型。[项目结构](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/README.md#L190-L216) [PC adapter](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/adapters/xhs/pc_api_adapter.py#L8-L59)

PC 搜索规范化输出 note ID、访问 URL、标题、正文、作者、图片、互动计数、类型、时间和 raw；发现响应中的 token/source 被拼入详情 URL，说明“稳定 ID 与访问材料配对”的局部行为有参考价值。但带查询材料的 URL 与完整 raw 随后可被写入 DB/API，未与 canonical state 隔离。[访问 URL](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/api/platforms/xhs/pc.py#L135-L152) [规范化](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/api/platforms/xhs/pc.py#L220-L278)

PC router 里 `search/users`、`users/notes`、`homefeed/*` 是无认证的 mock/占位结果；`PATCH /accounts/{id}` 也只返回固定状态，不修改数据库。它们不能算作真实已实现能力，更不能直接暴露给 Agent。[PC placeholders](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/api/platforms/xhs/pc.py#L341-L398) [account placeholder](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/api/accounts.py#L212-L214)

### 3.2 采集与保存断点

普通 search/note-urls/user-notes 会按选项调用保存函数；URL 批次有失败项时仍把 Task 标成 `completed`，只把 errors 放进 payload，因此顶层状态无法表达 partial。[普通路由](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/api/platforms/xhs/crawl.py#L226-L335)

SSE `/crawl/data` 则有独立缺陷：`normalized_for_save` 仅 append、不消费；结果只在进程内 `items` 和 SSE 帧中。keyword 为空会在最终 task 更新前 return；异常只把泛化的 `partial failure` 写入 Task，而具体异常发给 SSE。断线/`GeneratorExit` 是否留下 running 需动态验证，但源码未处理该分支。[SSE 初始化](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/api/platforms/xhs/crawl.py#L342-L414) [SSE 结束](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/api/platforms/xhs/crawl.py#L415-L497)

## 4. 内容、资产、任务与恢复模型

### 4.1 Note 与媒体资产

Note 的业务键没有唯一约束；保存按 `(user_id,note_id)` 查第一条，忽略 platform/account，已有 Note 也不更新 `platform_account_id`。并发、历史重复或跨账号采集可能造成重复/错误 provenance。[模型](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/models/note.py#L21-L44) [保存查询](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/api/platforms/xhs/crawl.py#L149-L183) [初始迁移](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/alembic/versions/3bd70519ad3c_initial_schema.py#L190-L206)

ORM 与最终 Alembic schema 还存在漂移：Note.user_id 在 ORM 是非空 FK，后加列迁移却只有 default/index、没有 FK；PublishJob.user_id 在 ORM 是非空 FK，迁移却添加 nullable 列且没有 FK。固定树未见后续修补，这进一步阻断模型复用。[Note ORM](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/models/note.py#L21-L28) [Note migration](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/alembic/versions/60cd5c95fde1_add_user_id_to_notes.py#L21-L30) [Publish migration](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/alembic/versions/ae358e965bef_add_user_id_to_publish_jobs.py#L21-L38)

NoteAsset 只有类型、URL、本地路径和 sort_order。规范化层能保留 URL 首见顺序，但保存没有赋 sort_order，所有项默认 0；当前读取再按 ID 排序只是偶然保持插入顺序，不是稳定 asset slot。固定 tracked 代码没有 Live Photo 同序号双资产契约。[URL 顺序](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/api/platforms/xhs/pc.py#L99-L115) [写入](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/api/platforms/xhs/crawl.py#L170-L177) [读取顺序](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/api/notes.py#L84-L113)

保存会先删除旧资产，再同步下载并一次 commit；文件写不受 DB transaction 控制，下载失败仍创建空 local_path 行，崩溃可留下孤儿文件。下载器无 temp→fsync→rename、Range/Content-Range、expected length/hash、MIME magic、每跳主机验证或续传。[保存函数](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/api/platforms/xhs/crawl.py#L149-L183) [下载实现](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/services/asset_downloader.py#L11-L50)

### 4.2 Task、checkpoint 与取消

Task 的 status/progress/payload/time/error/retry/parent 字段适合做 UI/审计参考；但 payload 是无版本 JSON，crawl 创建时即持久化 `running/progress=10`，完成/失败没有一致写 started/finished/error_type。[Task model](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/models/task.py#L13-L29) [Task serialization](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/api/tasks.py#L20-L39) [crawl states](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/api/platforms/xhs/crawl.py#L80-L114)

通用 retry 只重置状态，不执行任务、不检查 max_retries；cancel 也只修改数据库状态，没有向正在运行的循环传播取消信号。不存在 durable cursor、水位、page/item receipt、pending asset 或 resume protocol。[取消/重试](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/api/tasks.py#L141-L171) [测试意图](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/tests/backend/test_api.py#L4808-L4873)

监控的连续失败→pause→通知是可借鉴行为，但错误分类只是字符串启发式；指定账号无效时还会静默选择用户第一个 active PC 账号。Rednote 必须 exact account fail-closed，禁止会话 fallback。[错误分类](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/services/monitoring_crawl_service.py#L67-L75) [账号 fallback](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/services/monitoring_crawl_service.py#L30-L42)

### 4.3 发布素材与未知结果

PublishAsset 的 `pending/uploading/uploaded/failed`、远端 media id、error 和 metadata 是本仓库最具体的逐资产状态设计。但外部上传前先 commit `uploading`，远端成功与本地成功 commit 之间崩溃会永久停在 uploading；主路径也只自动处理 pending/failed，缺 reconcile。[上传状态](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/api/publish.py#L400-L490)

发布前持久化 `publishing`，调用后才写 external ID；失败即标 failed，retry 清除外部结果再重发。底层写请求还有局部通用重发，没有 idempotency key/desired-state 确认；调度查询 pending job 后也没有 `FOR UPDATE`/claim lease。[发布边界](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/api/publish.py#L513-L555) [调度](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/services/scheduler_service.py#L120-L220) [底层发布](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/apis/xhs_creator_apis.py#L574-L618)

自动任务的 `total_published` 可能在只创建 pending PublishJob 时就增加；后台任务即使发布失败也增加，故该计数不是完成 receipt。[手动 auto task](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/api/auto_tasks.py#L381-L420) [后台计数](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/services/scheduler_service.py#L550-L601)

## 5. 账号、会话、凭据与网络边界

| ID | 严重性 | 固定源码事实与边界 |
|---|---|---|
| SEC-01 | 高 | 默认 YAML 总会加载并作为 `Settings(**yaml_values)` init 参数；源码未定制 settings source。按 Pydantic Settings 默认优先级静态推断，YAML 会盖过环境变量，使固定开发 secret 可能胜出；Fernet 空时又由同一 secret 派生。该推断未运行验证，但 Compose 明确选用 default YAML。[配置](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/core/config.py#L15-L120) [密钥派生](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/core/security.py#L48-L124) [Compose](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/docker-compose.yml#L7-L25) |
| SEC-02 | 高 | Creator asset 接受任意 HTTP(S) URL或本地 Path，整响应/文件读入内存后上传平台；无 allowed root、主机/IP/redirect/字节预算。公开注册意味着这不是天然管理员能力，构成条件性 blind SSRF、资源耗尽和本地文件外传面。[读取器](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/adapters/xhs/creator_api_adapter.py#L31-L75) [直接上传入口](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/api/platforms/xhs/creator.py#L210-L230) [job asset](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/api/publish.py#L373-L437) |
| SEC-02B | 高 | `/notes/batch-save` 只要求用户拥有任一 XHS account row；在不抓评论时无需 active Cookie。请求体的 image/cover/video URL 会经通用下载器跟随跳转、整响应读内存并写 media，随后响应返回文件名，公开 media 路由可读回结果。若目标响应超过最小 100 bytes，这形成独立的条件性 SSRF、内网响应外带及内存/磁盘耗尽链。[输入与 account gate](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/api/notes.py#L31-L47) [batch save](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/api/notes.py#L182-L197) [下载调用](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/api/notes.py#L426-L474) [下载器](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/services/asset_downloader.py#L11-L29) [公开读取](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/api/files.py#L149-L156) |
| SEC-03 | 高 | 平台写缺幂等和 unknown-outcome reconcile，retry/调度可能重复发布；production scheduler 能无人审批执行采集、AI、上传和发布。全部 D 排除。[retry](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/api/publish.py#L303-L320) [production config](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/config/production.yaml#L23-L34) [auto flow](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/services/scheduler_service.py#L435-L601) |
| SEC-04 | 中 | register/login/短信发送没有应用限速；logout 不撤销 7 天 refresh token，前端把 refresh token 存 localStorage。外部反代/WAF 未核验。[auth](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/api/auth.py#L52-L89) [phone login](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/api/login_sessions.py#L272-L334) [frontend token](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/frontend/src/lib/api.ts#L80-L120) |
| SEC-05 | 中 | `/api/files/media/{file_name}` 无认证/owner gate，只依赖不可预测文件名；exports 路由有认证与 owner prefix，可作为正面对照。[files](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/api/files.py#L149-L173) |
| SEC-06 | 中 | 模型 `base_url` 用户可控，test/AI client 会向其发送解密 API key；更新接口还允许只替换 base URL、保留既有加密 key，因此误配/恶意 endpoint 可接收旧凭据并形成条件性内网探测。reference image/内容也会跨信任域传给 provider。[配置输入](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/api/model_configs.py#L19-L35) [test](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/api/model_configs.py#L117-L163) [独立更新 URL/key](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/api/model_configs.py#L166-L184) [AI client](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/services/ai_service.py#L126-L165) |
| SEC-07 | 中 | 本地资源 ownership 检查较完整，但没有 expected external account 断言或 per-account lease；health check 会用当前 Cookie 身份覆盖记录的 external ID。PC search/crawl、Creator 手动/定时发布和 auto task 都没有统一 `account.status=active` 门，expired/其他非 active account 仍可能发起网络请求。[upsert](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/services/account_service.py#L113-L160) [PC gate](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/api/platforms/xhs/pc.py#L281-L298) [crawl gate](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/api/platforms/xhs/crawl.py#L214-L234) [手动 publish gate](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/api/publish.py#L440-L472) [scheduled publish gate](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/services/scheduler_service.py#L120-L159) [auto task gate](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/api/auto_tasks.py#L90-L115) [后台 auto](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/services/scheduler_service.py#L435-L530) |
| SEC-08 | 中 | 文件上传先整包读内存再检查 100MB，只按扩展名，不做 magic/MIME、配额或原子落盘；UUID 名称降低直接路径穿越，但不能解决并发内存/磁盘风险。[upload](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/api/files.py#L176-L205) |
| SEC-09 | 高（条件性上游信任） | 继承的签名链会取得并执行远端程序/DSL，Node `vm` 不是安全沙箱；属于上游制品受控时的远端代码信任面，不能进入同步器。[DSL](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/xhs_utils/xhs_core/dsl.py#L78-L114) [runtime](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/xhs_utils/xhs_core/runtime.py#L54-L84) [Node VM](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/xhs_utils/xhs_core/js/websectiga_cli.js#L193-L217) |
| SEC-10 | 中 | account status、publish/upload error、Task payload 和 HTTP detail 多处直接保存/回显 `str(exc)`，Creator debug 分支可输出请求/Cookie相关材料；无统一结构化脱敏。[account error](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/api/accounts.py#L190-L205) [upload error](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/api/publish.py#L423-L437) [debug path](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/apis/xhs_creator_login_apis.py#L250-L285) |
| SEC-11 | 中 | LoginSession 只有 created_at、没有 expires_at/cleanup/delete；QR/phone 确认后仍保留 encrypted_temp_cookies。删除 PlatformAccount 只删除 AccountCookieVersion，不清除 LoginSession，因此“临时”Cookie 可能长期存在。[模型](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/models/login_session.py#L13-L27) [QR确认](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/api/login_sessions.py#L219-L269) [手机确认](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/api/login_sessions.py#L355-L396) [账号删除](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/api/accounts.py#L217-L231) |

Cookie version、临时登录 Cookie 和 AI key 确实采用 Fernet 静态加密，API serialization 也不直接回传密文；这是局部正面事实，但 SEC-01 的默认密钥/密钥分离问题削弱其保护。[Cookie envelope](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/services/account_service.py#L153-L159) [login session](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/api/login_sessions.py#L155-L175) [model config output](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/api/model_configs.py#L38-L48)

## 6. 风控、停止条件与 Agent/平台写边界

进程内 limiter 只覆盖监控刷新，默认每账号 5/min；普通 crawl、search、login/SMS、publish、auto task和健康检查不走它。错误分类依赖字符串，缺 typed 403/406/429/challenge/Retry-After/cooldown/global circuit breaker。[limiter](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/services/rate_limiter.py#L10-L46) [classification](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/backend/app/services/monitoring_crawl_service.py#L67-L75)

Creator 登录存在 HTTP 406 gate 重发/设备会话重建，发布也存在业务错误重发；只能登记为实现与风险，不是反风控、合规或账号安全证据，也不能转化为 Rednote 的实现建议。[gate retry](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/apis/xhs_creator_login_apis.py#L726-L739) [设备重建](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/apis/xhs_creator_login_apis.py#L1110-L1169)

未来 Rednote Stage 4 的停止规则应独立实现：登录身份变化、验证码/challenge、401/403/406/429、账号安全限制、schema mismatch和签名失败必须立即停止该 account/profile 全部网络任务、取消待发请求、保存 checkpoint，并等待人工显式恢复；不得切换账号、profile、代理或继续 HTML/provider fallback。发布/点赞/收藏/评论等写能力不进入只读 Adapter 或 Agent allowlist。

## 7. 依赖、测试、CI、容器和维护风险

### 7.1 依赖和镜像来源

- Python 26 个非空声明、0 个 `==` exact pin，仅两项给下界；pytest 也混在 runtime requirements。没有 Python lock/hash，传递图不可复现。[requirements](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/requirements.txt#L1-L27) [静态清点](provenance.json)
- root npm lock v3 有 60 个 non-root node、60 resolved/integrity、0 install-script；59 个 tarball 指向腾讯镜像，只有一个指向 npm registry。frontend 有 257/257 resolved/integrity，全部指腾讯镜像，含 `esbuild` 和 optional `fsevents` 两个 install-script node。[root manifest](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/package.json#L1-L5) [frontend manifest](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/frontend/package.json#L1-L34) [esbuild node](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/frontend/package-lock.json#L2433-L2442) [fsevents node](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/frontend/package-lock.json#L2536-L2546)
- integrity 可校验取得内容，但不把第三方镜像等同官方来源；两份 lock 几乎没有 dependency license 字段，不能替代第三方许可证清单/SBOM。

### 7.2 测试与 CI

固定树有 3 个测试文件、130 个 `test_*` 函数、0 个显式 skip/skipif/xfail。测试意图覆盖 auth/ownership、crawl、Task、发布素材等，也有不少读取前端源码做字符串断言，不能等同浏览器 E2E、真实平台、容器或账号安全验证。README 的“126 passed”与当前 130 个函数静态清点不同；本次未运行，不能确认通过。[README 测试声明](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/README.md#L190-L216) [测试样本](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/tests/backend/test_api.py#L1-L40) [静态清点](provenance.json)

固定树有 0 个 workflow，也未见 SBOM、SCA、attestation、签名、Dependabot/Renovate、SECURITY 或发行门。这里应理解为“未建立可审的门禁”，不是门禁执行失败。

### 7.3 Docker/Compose

Docker base 仅固定 tag、无 digest；apt/pip 不定版；Node 通过远端 shell 安装。frontend `npm ci` 失败会降级到 `npm install`，root 即使有 lock 也使用 `npm install --omit=dev`；runtime 没有 USER，仍保留 Node/curl/build 工具链。[Docker build](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/Dockerfile#L15-L75)

`.dockerignore` 排除 `.env`、DB、data/storage、tests和 `.github`，这是降低常见运行材料进入 `COPY . .` 的正面习惯，但不是通用 secret 防线。[dockerignore](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/.dockerignore#L1-L52)

Compose 直接发布 `8000:8000`，挂载 config/data/media/exports，没有 secrets 机制；敏感值只有注释建议用环境变量覆盖，而 SEC-01 又表明覆盖语义可能不成立。可选 MySQL 端口/示例密码目前注释，不应写成默认活跃服务。[Compose](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/docker-compose.yml#L1-L60)

## 8. 许可证与源码复用边界

README 同时显示 MIT badge/“see LICENSE”，以及“仅供学习交流、禁止商业化”；固定 revision 没有 LICENSE、COPYING、NOTICE 或第三方许可清单。报告不判断哪段法律上优先，只记录授权不一致且缺少正式文本；在作者澄清前，任何源码复制、修改、链接和分发均列 D。[README 顶部](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/README.md#L13-L30) [README 末尾](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/README.md#L286-L288) [本地清点](provenance.json)

`apis/`、`xhs_utils/`、`spider/` 有 61 个共同路径与本地 Spider_XHS 固定树可比较，其中 57 个 Git blob 相同、4 个不同；这只证明当前快照的高度重叠，不推断先后或权利归属。仓库还明确把底层 SDK描述为逆向签名，并包含浏览器采样/fingerprint reference artifact，却没有 provenance/rights inventory；这些材料全部排除复制。[SDK 声明](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/README.md#L93-L110) [keystream artifact](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/xhs_utils/xhs_core/js/mns_0101_keystream.json#L1-L3) [fingerprint artifact](https://github.com/cv-cat/XHS_ALL_IN_ONE/blob/63b85de2b15b3f79134b08fa675381505f45d4db/xhs_utils/xhs_creator/js/rap_fingerprint_creator.json#L1-L5)

## 9. 对 Rednote Sync 的具体参考价值

| 级别 | 结论 | 具体落点 |
|---|---|---|
| B：只借鉴行为 | Adapter seam；发现 ID+访问材料配对；Task 审计字段；PublishAsset 逐项状态；连续失败暂停通知；SSE 逐项进度 UX | Stage 4 重新定义版本化只读 Provider schema、SecretRef、TaskRun/Failure/MediaSlot receipts；只保留行为，不复制实现。 |
| C：背景/反例 | 多账号内容运营台、Tag/Comment/AI/Draft/Scheduler 产品模型、mock endpoint、字符串错误分类 | 用于威胁建模和“不应耦合进 Core”的反例，不作为协议事实。 |
| D：明确排除 | Note/NoteAsset schema、SSE 内存结果、generic retry、账号 fallback、随机名下载、删资产重建、公开 media、任意 URL/路径上传、远端程序执行、自动运营和平台写 | 不进入 Stage 3；未来 Stage 4 也不直接集成或向 Agent 暴露。 |

阶段三继续只拥有完全离线的 canonical SQLite、media slots、failures/runs/checkpoint 和 derived writer。候选在线实现不能接管 Core 的 canonical state/checkpoint ownership。

未来阶段四若立项，只能 clean-room 实现窄只读 Adapter，并满足：固定 expected account/profile、单账号 lease、host/path/operation allowlist、access material 短生命周期隔离、typed stop conditions、全局暂停、逐资产原子落盘与长度/hash、unknown result reconcile、敏感日志默认脱敏。平台写需独立规格与逐次授权，默认排除。

## 10. 未知项与证据限制

1. 未运行项目，因此 Pydantic Settings 的实际版本行为、真实断流/并发/commit failure 状态、Docker 构建和测试结果均未动态确认；SEC-01 明确是固定代码加默认库语义的静态推断。
2. 未访问平台，当前 endpoint/签名/fingerprint、Live Photo payload、验证码率、账号安全和任何风控效果均未知。
3. 未验证上游发布/tag、仓库保护规则、反向代理/TLS/WAF/外部网络隔离或实际部署权限。
4. 未做 SCA/SBOM/container scan；Python/Node 依赖的 CVE、可达性、许可证兼容性和镜像内容未知。
5. 未确认底层异常在真实失败中是否包含 Cookie/token；已确认的是缺少统一 redaction 以及 debug 路径可打印敏感请求材料。
6. 平台是否对上传/发布做自身去重未知；报告只描述客户端没有可见 idempotency/reconcile。
7. README 的许可表述、嵌入材料来源与授权未获作者澄清。

## 11. 证据索引与独立复审

### 11.1 证据等级

- **固定源码/配置事实**：本报告主要证据，链接固定到 revision。
- **测试意图**：只说明 fixture/断言存在，未运行且不证明线上兼容或安全。
- **README 声明**：只表示项目自述，冲突时与源码事实并列。
- **静态推断**：SSRF、重复发布、配置优先级、断流状态等均保留触发前提；未做 PoC。
- **未知**：无法由固定 tracked 材料证明的运行、平台、仓库外和法律事项均不上调结论。

### 11.2 独立复审状态

- 事实、固定链接与清点：**PASS**；revision/tree、217 tracked、依赖/测试/镜像计数、61/57/4 Spider blob 对照、固定链接与敏感值检查均通过。
- 安全、会话与权限边界：**PASS**；补齐 batch-save SSRF/响应外带、登录临时 Cookie 生命周期和所有主要网络路径的 account status 门缺口后，无未关闭 finding。
- 供应链、许可证与 Rednote 适配：**PASS**；依赖、Docker、CI、许可证冲突、来源隔离和 Stage 3/4 边界均通过。
- 未关闭 P0–P3 finding：**0**。
