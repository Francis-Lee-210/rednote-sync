# xhs-cli-export 专项源码审查

状态：专项静态审查完成，独立复审通过  
审查日期：2026-08-13  
固定 revision：[`6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83`](https://github.com/DoYitNow/xhs-cli-export/tree/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83)

> 本报告只描述固定 revision 的 tracked 静态实现，不证明上游 CLI、登录方式、当前在线兼容性或账号安全。

## 1. 范围、来源与方法

- 来源与快照见 [`provenance.json`](provenance.json)，恢复状态见 [`checkpoint.json`](checkpoint.json)。
- 只读取 19 个 tracked paths；不安装、不运行、不登录、不调用 `xhs-cli-headless`，不访问小红书。
- 证据区分 `[README 声明]`、`[源码证据]`、`[配置证据]`、`[外部官方元数据]`、`[推断]` 和 `[未知]`。
- 当前环境没有可用的 Semgrep、Bandit、OSV-Scanner、Trivy、Syft 或 Gitleaks；没有把“未运行扫描器”写成“没有漏洞”。

## 2. 结论摘要

xhs-cli-export 最有价值的是产品层的输出与中间结果设计：每次运行独立目录、raw/detail 证据旁存、带 provenance 的 frontmatter、人读运行索引、逐条 JSONL/Markdown 落盘，以及“抓取未完整成功时不推进 `last_success_at`”的意图。这些都值得 Rednote Sync 在自己的 canonical state、object store 和 projector 上独立实现。

它不是可直接采用的同步或恢复层。所谓 JSONL “崩溃恢复”没有恢复读取路径，下一次运行还会先清空同名文件；state 直接覆盖且损坏时静默退回空状态；详情和图片失败仍可能把 note 计入 seen；搜索状态没有按 keyword/sort/type 分区；媒体只有图片且缺少逐资产身份、原子落盘、长度和 hash 闭环。快捷包装脚本有命令注入面，未净化 note ID 可逃离 details 目录，媒体下载有条件性 blind SSRF/磁盘耗尽风险，raw/detail/JSONL 又可能持久化 `xsec_token` 或 signed URL。

### 核心结论：

- 维持 **A（专项设计参考）**，但只借鉴输出、partial evidence 和“失败不推进成功水位”的意图；当前状态/下载/provider 执行链不直接复用。
- JSONL 是当前运行的 partial evidence，不是真正 resume checkpoint：启动即 truncate，程序从不回读它，`--input-json` 也只接受单个 JSON。
- `last_success_at` 仅在最终抓取成功时推进，这是正面语义；但 seen IDs 可在详情、图片或 Markdown 完整性未证明时写入，无法表达 durable partial。
- streaming 自动重试最多实际运行 6 轮；成功且有新增仍继续，最终“完整”只看最后一轮返回码，不能证明已到服务端末尾。
- `--max > 0` 会在有限子集后停止并仍可能推进全局成功时间；以后扩大范围时，较旧但未见记录可能被时间窗口跳过。
- search 没有 cursor/checkpoint，并把所有 keyword/sort/type 共用一个 `search` state，存在跨查询错误去重。
- Markdown/frontmatter 与 run index 适合人读派生视图；编号路径、raw dict 和索引不能充当 canonical identity、Schema 或 receipt。
- 只下载图片，不保存视频或 Live Photo；图片失败会改变后续编号，且直接写最终文件、没有长度/hash/magic MIME/原子提交。
- `export.sh eval`、`export.ps1 Invoke-Expression`、details 路径穿越、媒体 blind SSRF/无界下载及 secret 落盘阻断 Agent/生产复用。
- `--input-json` 不是可靠离线模式：默认先要求可解析的 xhs executable，并可能按 item 调详情 provider或媒体 HTTP；search 甚至在 input 分支前直接走在线路径。阶段三不得使用。
- 本项目 MIT 许可清晰，但运行依赖的 `xhs-cli-headless` 未在 manifest 中固定版本或 hash；MIT 不能覆盖整条外部 provider 链。
- 阶段三继续完全离线；上游 CLI、登录、网络、搜索和媒体只属于未来阶段四授权与独立 Adapter 审查门。

## 3. 架构、上游依赖与数据流

### 3.1 主链与上游契约

`[README 声明]` 项目通过 `xhs-cli-headless` 获取收藏、点赞和搜索结果，再导出 Markdown；登录 Cookie 由上游保存在用户目录。[README L8-L17](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/README.md#L8-L17) [README L210-L217](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/README.md#L210-L217)

`[源码证据]` exporter 通过 subprocess 调用外部 `xhs`：收藏/点赞读取 NDJSON 列表，再逐 note 调 `read <id> --xsec-token <token> --json`；搜索按页调用 `search`。它用多 key heuristic 接受多种未版本化 dict shape，没有校验 provider/schema revision。[xhs command L116-L188](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/src/xhs_export.py#L116-L188) [normalize L223-L305](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/src/xhs_export.py#L223-L305) [stream L1191-L1268](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/src/xhs_export.py#L1191-L1268)

`[边界]` provider 拥有浏览器、会话、token、在线请求和字段语义；exporter 只消费 stdout。这个进程边界值得保留，但不能把未经版本验证的 `dict[str,Any]` 直接送进 Rednote canonical state。

### 3.2 发现与详情

- `[源码证据]` 收藏/点赞的流式路径调用上游 `--stream --no-detail`，按行跳过非 JSON/无效 JSON，再从兼容 key 中提取 notes；详情另行串行调用 `read`，并把 token 作为 argv 传入上游。[stream L1191-L1268](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/src/xhs_export.py#L1191-L1268)
- `[风险]` argv 比 shell 拼接安全，但 token 仍可能在本机进程列表、错误和上游日志中暴露；未来 Adapter 应使用用途限定的内存 secret 通道，不把 signed material 放在命令行。
- `[源码证据]` 详情失败被捕获为字符串后继续生成 Markdown；这提供了人工降级输出，却没有 blocker/task 状态。[detail failure L1257-L1312](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/src/xhs_export.py#L1257-L1312)

### 3.3 search 路径

`[源码证据]` search 逐页调用上游，单页最多尝试 3 次，页间等待 1.5 秒，按 note ID 去重并逐页追加 JSONL。[search L947-L1081](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/src/xhs_export.py#L947-L1081)

`[风险]` 后续页返回非 JSON 时只提示“可能已到末尾”并保留 `fetch_complete=True`，之后可推进成功状态；没有服务端 cursor、`hasMore` 或末尾 provenance。[search L1029-L1039](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/src/xhs_export.py#L1029-L1039)

`[文档/源码漂移]` README 搜索示例使用 exporter 不存在的 `--type`，parser 实际参数是 `--search-type`。源码计算了 sort/type map，却把 alias 原样交给上游；上游当前是否接受这些值未验证。[README L93-L100](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/README.md#L93-L100) [maps L48-L58](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/src/xhs_export.py#L48-L58) [parser L1792-L1800](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/src/xhs_export.py#L1792-L1800)

## 4. checkpoint、幂等与失败恢复

### 4.1 JSONL 是 evidence，不是 resume checkpoint

`[README 声明]` README 称“JSONL 流式保存，中断不丢失进度”。源码确实逐 batch 追加 JSONL，但每次调用先清空同一个 `<output>/<source>_stream.jsonl`，且没有任何读取恢复路径；`--input-json` 读取的是单一 JSON，而不是 NDJSON。因此 hard crash 前的文件能暂时保留证据，下一次运行却不会据此续跑并会清空它。[README L12-L17](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/README.md#L12-L17) [JSONL L1163-L1165](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/src/xhs_export.py#L1163-L1165) [append L1226-L1229](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/src/xhs_export.py#L1226-L1229) [input JSON L211-L218](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/src/xhs_export.py#L211-L218)

### 4.2 state 与水位

- `[源码证据]` state 保存 `last_success_at`、全量 sorted seen IDs 和最多 20 条 run 摘要。state 直接 `write_text` 覆盖；JSON 损坏时静默返回空状态，没有 schema/version migration、temp+rename、checksum 或 backup。[state L694-L716](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/src/xhs_export.py#L694-L716) [update L758-L785](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/src/xhs_export.py#L758-L785)
- `[正面行为]` 流式路径在上游非零退出时保留 partial 输出，不推进 `last_success_at`；这一“失败不推进成功水位”意图值得借鉴。[L1357-L1369](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/src/xhs_export.py#L1357-L1369)
- `[缺口]` note ID 在详情、媒体和 Markdown 之前加入运行 seen set，每轮结束即保存；详情异常和图片失败仍能生成 Markdown并最终 seen。下一轮/下次运行可能跳过，不会形成详情/资产 retry task。[L1231-L1238](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/src/xhs_export.py#L1231-L1238) [L1274-L1326](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/src/xhs_export.py#L1274-L1326)
- `[缺口]` streaming loop 写 `while attempt <= MAX_RETRIES`，从 0 开始递增，因此最多 6 轮；即便一轮返回 0，只要有新增且 max=0 仍会再跑，最终 `fetch_complete` 只保留最后一轮返回码。不能据此证明全量完成。[retry L1171-L1189](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/src/xhs_export.py#L1171-L1189) [retry stop L1333-L1341](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/src/xhs_export.py#L1333-L1341)
- `[缺口]` 设置 `--max > 0` 后第一轮即停止，但上游返回 0 仍可推进 `last_success_at`。若以后扩大 max，未处理的较旧记录即便 note ID 未见，也可能因 action timestamp 不在新窗口而被跳过；抽样 limit 不能代表完整水位。[retry stop L1333-L1341](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/src/xhs_export.py#L1333-L1341) [time filter L719-L755](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/src/xhs_export.py#L719-L755) [state update L1357-L1361](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/src/xhs_export.py#L1357-L1361)

### 4.3 scope 与运行审计

`[源码证据]` 收藏/点赞 state 只按 source；search 也只使用 `sources['search']`，不同 keyword/sort/type 共用 seen IDs，一条 note 在查询 A 出现后可能被查询 B 跳过。run 摘要也不含查询、provider revision、outcome、失败、note/media receipts 或 hash。[search state L1392-L1422](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/src/xhs_export.py#L1392-L1422) [run state L758-L785](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/src/xhs_export.py#L758-L785)

## 5. Markdown、媒体与文件边界

### 5.1 derived Markdown 与运行索引

- `[源码证据]` note frontmatter 保存 source、导入时间、增量窗口、action timestamp、public URL、note ID/type 和 author；远端标量多用 JSON 字符串编码。这套 provenance 字段值得参考，但内容仍直接来自未版本化 dict。[Markdown L619-L685](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/src/xhs_export.py#L619-L685)
- `[风险]` `--date` 未校验且不加引号进入 note/index YAML；正文、互动值、失败 URL/reason 也未针对 Markdown 表格转义。渲染结果必须视为非可信 derived view，不能回灌 canonical state。[date L1537-L1545](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/src/xhs_export.py#L1537-L1545) [index L1100-L1131](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/src/xhs_export.py#L1100-L1131)
- `[兼容性风险/未知]` README 示例使用 `![[images/<id>/...]]`；源码却相对 `output_dir` 生成含 run 目录的路径，而 Markdown 本身位于 run 目录。若 output 是 vault root，Obsidian 可能按 vault 路径解析；若是 vault 子目录或标准 Markdown，表现不同。本轮未运行 Obsidian，不能断言必然可用或不可用。[README L184-L186](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/README.md#L184-L186) [relative path L610-L617](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/src/xhs_export.py#L610-L617)
- `[源码证据]` 人读 index 记录运行时间、窗口、开关、数量、文件 basename 和详情失败，但没有图片失败汇总、bytes/hash、逐文件 receipt、程序/provider revision 或机器可验证 outcome。[index L1084-L1132](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/src/xhs_export.py#L1084-L1132)

### 5.2 图片、视频与 Live Photo

- `[源码证据]` 媒体提取只识别图片键/扩展，下载要求 Content-Type 包含 image；没有视频、Live Photo 或 motion 资产输出。`--search-type video` 只是搜索过滤，不是视频下载。[media L415-L499](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/src/xhs_export.py#L415-L499) [download L528-L569](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/src/xhs_export.py#L528-L569)
- `[缺口]` 文件序号按成功数产生，前一 URL 失败会让下一资产占用该 ordinal；直接 `wb` 最终路径，异常/hard crash 可留 partial 文件。没有 source slot、attempt、temp+rename、Range、Content-Length/累计字节上限、hash 或 magic-byte MIME 验证。[download L546-L569](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/src/xhs_export.py#L546-L569)

## 6. 会话、凭据、网络与权限

| ID | 严重性 | 静态结论 |
|---|---|---|
| SEC-01 | 高（脚本参数不可信） | Bash/PowerShell 快捷包装器使用 `eval`/`Invoke-Expression`；Python 路径若选 `.cmd/.bat` provider 还会经 `cmd /c` 二次解释参数，均形成条件性命令注入面 |
| SEC-02 | 高（不可信 provider/input） | note ID 未净化即组成 details JSON 路径，可通过绝对路径或 `..` 逃出 run directory |
| SEC-03 | 高（不可信媒体 URL） | 字符串式 URL 检查与默认 redirect 无 host/IP 重验，形成条件性 blind SSRF；无字节上限和原子落盘还可耗尽磁盘/留下残片 |
| SEC-04 | 高（输出目录可共享/备份） | raw、detail、JSONL 和失败原因可能持久化 `xsec_token`、signed URL 或上游错误，权限依赖 umask且无统一 scrub |
| SEC-05 | 中（Agent 可控本地参数/环境） | `--xhs-bin`、环境变量和 PATH 可选择任意存在的可执行文件；PowerShell wrapper 自动 ExecutionPolicy Bypass |
| SEC-06 | 中 | 通用/streaming 子进程没有 total deadline；媒体下载只有请求 timeout，没有任务总 deadline或可取消进程组 |
| SEC-07 | 高（阶段边界） | `--input-json` 默认先解析 xhs executable，并可能执行详情 provider/媒体 HTTP；search 还会忽略 input 直接在线搜索，不能作为阶段三离线入口 |
| SEC-08 | 中 | QR 原始登录链接可打印到终端、PNG 可写任意路径；全部 subprocess 继承完整父进程环境，扩大 secret 暴露面 |

### 6.1 直接证据与采用边界

- `[源码证据/推断]` Bash wrapper 把 keyword/output/sort/max 拼成命令后 `eval`；PowerShell 用 `Invoke-Expression`，这是直接的 shell 求值边界。Python 对普通 executable 使用 argv list且无 `shell=True`，但当 provider 后缀是 `.cmd/.bat` 时显式改走 `cmd /c`，keyword、note ID/token 等参数会再次进入命令解释器，构成另一条件性注入面。生产 Adapter 应拒绝 `.cmd/.bat/.ps1`，只允许固定 hash 的真实二进制或受审 IPC。[export.sh L34-L106](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/export.sh#L34-L106) [export.ps1 L24-L52](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/export.ps1#L24-L52) [xhs_command L161-L188](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/src/xhs_export.py#L161-L188)
- `[源码证据/推断]` Markdown/图片目录会净化 note ID，但三处 detail 文件直接使用 `details / f'{note_id}.json'`。不可信 `--input-json` 或 provider payload 可用绝对路径/`..` 逃离输出根并覆盖 JSON；未做动态 PoC。[sanitize L329-L335](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/src/xhs_export.py#L329-L335) [detail write L1260-L1273](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/src/xhs_export.py#L1260-L1273) [detail write L1440-L1459](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/src/xhs_export.py#L1440-L1459) [detail write L1628-L1646](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/src/xhs_export.py#L1628-L1646)
- `[源码证据/推断]` media URL 只需 HTTP(S) 且全字符串含关键字或图片扩展；没有解析后的 host allowlist、私网/loopback/link-local拒绝或 redirect 每跳复验。`requests` 默认跟随跳转，请求后才检查 Content-Type，且无 Content-Length/累计字节上限。这构成条件性 blind SSRF/内网请求和资源耗尽面，不代表已观察事件。[URL filter L415-L424](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/src/xhs_export.py#L415-L424) [download L528-L569](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/src/xhs_export.py#L528-L569)
- `[源码证据/推断]` item 中显式识别 `xsec_token`，而完整 item/detail 会写 JSONL/raw/details，异常理由还可进入 Markdown/index；因此访问材料可能落盘。`.gitignore` 降低误提交，不提供目录权限、备份和日志防护。[token L319-L326](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/src/xhs_export.py#L319-L326) [JSONL L1226-L1229](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/src/xhs_export.py#L1226-L1229) [raw/detail L1343-L1347](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/src/xhs_export.py#L1343-L1347) [.gitignore L41-L49](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/.gitignore#L41-L49)
- `[源码证据]` executable 可由 CLI/env/PATH 选择，存在即执行；`.ps1` 自动以 ExecutionPolicy Bypass 运行。它是显式本地信任边界，不是默认远程漏洞，但不能开放给 Agent 修改。[find_xhs L116-L169](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/src/xhs_export.py#L116-L169)
- `[源码证据]` `--input-json` help 称离线转换，但默认 `fetch_details=True`、`save_images=True`：favorites/likes 会先要求能解析 xhs executable；当 item 有 note ID 且缺嵌入详情时调用 provider，提取到媒体 URL 时还会发起 HTTP。即便某个 payload 恰好未触发这些条件，它也不是强制离线 capability。`source=search` 更在 non-streaming input 分支前就进入在线搜索，完全忽略 input 文件。只有 favorites/likes 显式同时使用 `--no-fetch-details --no-images` 时，才能从当前控制流静态推断不发起 provider/媒体请求；search 没有等价离线 input 路径。[input/help L1805-L1819](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/src/xhs_export.py#L1805-L1819) [defaults L1829-L1834](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/src/xhs_export.py#L1829-L1834) [branching L1556-L1600](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/src/xhs_export.py#L1556-L1600) [detail/media L1634-L1659](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/src/xhs_export.py#L1634-L1659)
- `[源码证据]` login 可把原始 QR link 输出到终端，二维码路径由参数决定；所有 subprocess 都从 `os.environ.copy()` 继承完整父环境。登录链接应按短期 secret 处理，生产 Adapter 应使用受限临时路径、禁止日志输出原值，并给子进程 exact env allowlist。[login L1748-L1765](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/src/xhs_export.py#L1748-L1765) [login parser L1782-L1787](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/src/xhs_export.py#L1782-L1787) [run_xhs L172-L184](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/src/xhs_export.py#L172-L184)

## 7. 依赖、测试、CI 与许可证

### 7.1 依赖与上游漂移

- `[配置证据]` project 只声明 `requests>=2.28`，build/dev 依赖也只有下界；没有 lock。实际关键 runtime provider `xhs-cli-headless` 不在 manifest，install scripts 直接安装未固定最新版，`xhs` 还可能从 PATH 选中其他程序。[pyproject L1-L38](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/pyproject.toml#L1-L38) [install.sh L32-L62](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/install.sh#L32-L62)
- `[外部动态元数据]` 调研日 PyPI 页面显示 `xhs-cli-headless` 最新版为 0.8.9，并在“Unverified details”中列出 Apache-2.0 license expression；这只证明安装包名和项目自报元数据当前可解析，不是固定上游 revision 的许可证审计，也不改变 exporter 未固定版本/hash 的事实。[PyPI 0.8.9](https://pypi.org/project/xhs-cli-headless/0.8.9/)
- `[配置漂移]` clone origin 是 `DoYitNow/xhs-cli-export`，pyproject 项目链接却全部指向 `yuyitian/xhs-cli-export`；报告以实际 origin + commit 为准。[pyproject L40-L44](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/pyproject.toml#L40-L44)

### 7.2 测试、CI 与发布

- `[tracked-wide 静态检索]` fixed tree 没有 `tests/` 文件，虽 pyproject 配置 pytest path；CI 只运行 Ruff。checkpoint、路径、媒体 partial、Markdown 和搜索分区均没有 tracked 自动测试证据。[pyproject L67-L68](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/pyproject.toml#L67-L68) [lint workflow L9-L24](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/.github/workflows/lint.yml#L9-L24)
- `[配置风险]` Actions 使用可变 tag，CI 的 ruff/build 没有版本/hash；PyPI 发布使用长期 token，不是 Trusted Publishing/OIDC。未见 artifact attestation/provenance、SBOM、SCA 或 secret scan；`permissions:contents:read` 是正面最小权限信号。[publish workflow L3-L30](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/.github/workflows/publish.yml#L3-L30)
- `[治理缺口]` SECURITY.md 的联系邮箱仍是 `[你的邮箱]` 占位符，只另称可使用 GitHub 私有漏洞报告；仓库是否实际启用该功能未验证，因此可确认的披露渠道不完整。[SECURITY L3-L9](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/SECURITY.md#L3-L9)

### 7.3 许可证

`[许可证证据]` 本仓库 LICENSE 与 pyproject 均为 MIT，复制 substantial portions 需保留版权与许可正文。[LICENSE L1-L20](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/LICENSE#L1-L20) [pyproject L5-L21](https://github.com/DoYitNow/xhs-cli-export/blob/6c9bcbd5ef2aa815ca07f0df83fcd15dd456ed83/pyproject.toml#L5-L21)

上游 provider 是独立外部包，不能由本仓 MIT 或 PyPI 未验证元数据推断其代码和服务权利。维持 subprocess/Adapter 隔离最稳妥；若未来复制上游代码，必须先从固定 upstream revision 独立核对 LICENSE/NOTICE、依赖与修改要求。本报告不是法律意见。

## 8. 对 Rednote Sync 的参考价值

对照 [`sync-core.md`](../../projects/rednote-sync-core/docs/sync-core.md)：

| 方面 | 当前判断 | 采用边界 |
|---|---|---|
| 每 run 目录与 frontmatter | A 级输出设计参考 | 从 canonical DB/object projector 重建；保存 generation、schema/provider revision 与 hash receipts |
| raw/detail evidence | 只借鉴“旁存证据”意图 | 先做版本校验和 secret 清洗；原始 signed payload 不进入普通知识库 |
| JSONL | 当前运行 partial evidence | 不称 checkpoint；使用 durable task/failure/receipt 与可回读恢复协议 |
| 成功水位 | 借鉴失败不推进意图 | cursor/progress 与 seen/task/media 状态分离；只有经验证的整页才推进，抽样/limit 不推进全局水位 |
| Markdown/Obsidian | 产品结构参考 | 标准相对路径与 wiki-link分别测试；派生内容统一转义，不作 source of truth |
| 图片 | 仅目录/失败展示参考 | 使用 `(kind,ordinal)`、temp+hash+length+magic MIME、逐资产 failure/retry |
| 视频/Live Photo | 不支持 | 不能从搜索 video filter 外推；由未来媒体 Schema 独立设计 |
| search | 仅背景 | scope 至少纳入 host/account/query/sort/type；cursor/末尾全部待动态验证 |
| Provider | 不直接采用 | 固定可执行 identity/revision、精确方法 allowlist、deadline、secret envelope |
| 离线 import | 当前实现不可作为阶段三入口 | 另建强制 `offline` capability；禁止 provider/HTTP，search 与 input 模式互斥 |
| 阶段边界 | 不改变阶段三 | 所有上游 CLI/浏览器/网络能力只在未来阶段四明确授权后讨论 |

## 9. 采用分级

| 分类 | 结论 |
|---|---|
| 可直接参考的行为 | run 目录、provenance frontmatter、raw/detail evidence旁存、人读 index、逐条 partial 落盘、失败不推进成功水位 |
| 必须独立实现 | versioned provider Schema、scope/cursor/checkpoint、逐 note/asset task、原子 state/object、secret scrub、媒体完整性、受限 subprocess |
| 仅作背景资料 | 多字段 normalize heuristic、search 分页/去重、详情失败降级、Obsidian wiki-link产品意图 |
| 当前排除 | JSON state/seen 充当 checkpoint、声称真正崩溃恢复、详情/图片失败仍完成、快捷包装器、当前下载器、Agent 可控 xhs-bin、`--input-json` 作为离线安全边界、视频支持声明 |

**最终建议等级：A（专项设计参考），复用方式为行为借鉴或独立实现。** 当前实现不得直接承担 Rednote Sync canonical state、生产下载或 Agent 调用面。

## 10. 未知项

- 未运行项目、测试、上游 CLI 或浏览器；当前上游 JSON shape、登录、搜索 alias、分页末尾和平台兼容性未知。
- 没有验证 PyPI 制品与源仓固定 revision 的一致性，也没有联网 SCA；当前依赖漏洞、可达性和传递许可证未知。
- Obsidian 对生成 wiki-link 的具体解析取决于 vault 与链接设置，本轮未动态验证。
- `xsec_token` 生命周期、上游错误是否含 secret、媒体 CDN query 是否必要均未知；因此默认按 secret 处理。
- wrapper/path/SSRF 结论为静态数据流推断，未执行 PoC。

## 11. 证据索引与独立复审

### 11.1 审查分工

- 架构、上游契约、checkpoint、retry：领域 Subagent，fixed commit tracked-only。
- Markdown、媒体、run index 和 `sync-core.md` 适配：领域 Subagent，fixed commit tracked-only。
- subprocess、路径、网络、secret、CI、供应链与许可证：领域 Subagent，fixed commit tracked-only。
- 综合写作和阶段边界：主 Agent。

### 11.2 独立复审

- **证据与链接复审：PASS。** JSONL truncate/无回读、6 轮 retry、limit 水位、search scope、Markdown 路径和条件性 input 行为均按固定源码核对；revision/tree、19 个 tracked files 和本地/外部链接一致。
- **安全复审：PASS。** 包装器与 batch provider 注入边界、details 路径穿越、blind SSRF/资源上限、secret 落盘、伪离线 input、QR/env 和 deadline 风险均闭环；防护建议不含平台规避。
- **供应链、许可证与项目适配复审：PASS。** 无 lock/未固定 provider、CI/发布门禁、MIT 边界、PyPI 未验证元数据和披露渠道缺口均有准确限定；A 级只表示设计专项参考，阶段三继续离线。
- 首轮 reviewer findings 已全部修正并完成末读；无剩余 P0～P3 阻断项。
