# 个人笔记资料库

状态：**已实现的本地文件存储工具**。这里约定 Notion 与 Galaxy 导出的共同落盘格式，服务于个人归档和后续知识库读取；不改变 Core 的离线输入协议，也不代表知识库、OCR 或语义检索已实现。

默认资料根目录为项目内可见的 `资料库/`，由根 `.gitignore` 排除。所有命令均可用 `--root` 指定其他绝对路径。凭据不进入笔记、来源记录、命令行参数或版本库。

## 运行环境

- Python 3.9 或更高版本，Python 代码使用标准库；当前合成回归在 Python 3.13.12 上通过。
- 当前验证环境为 macOS。Galaxy 进程锁使用 Unix `fcntl`，文件复制使用 `os.uname()`，因此不支持直接在 Windows Python 上运行；其他 Unix 环境尚未验收。
- 媒体验证及合成音频测试需要 PATH 中的 `ffmpeg` 和 `ffprobe`；合成测试使用 AAC、PCM 和 MP3 编码器（含 `libmp3lame`）。
- 复核看板生成 JPEG 预览使用 macOS 自带 `/usr/bin/sips`。XLSX 由标准库 ZIP/XML 读取，不需要 Excel 或 openpyxl。
- Notion 导入依赖相邻的 [`notion-stage3/audit_export.py`](../notion-stage3/audit_export.py)。保留整个 `prototypes/` 目录结构；该依赖本身不要求 Pillow 或 OCR。

下文导入、更新索引和看板命令需要自行提供私有输入。首次审阅可只运行合成测试；它在临时目录写入数据，不访问平台，其中服务器测试只绑定本机随机端口。

```text
资料库/
├── README.md
├── 笔记/<24位帖子ID>/
│   ├── 正文.md
│   ├── 元数据.json
│   ├── media/
│   └── 历史版本/          内容更新时保留旧正文和元数据
├── 索引/                 CSV 清单、完整 JSONL 和汇总统计
├── 原始来源/历史导出/     原始 Notion ZIP、原页、旧实验及 Galaxy 样本
└── 导出记录/             迁移清单、下载状态、API 调用和校验记录
```

## 统一存储约定 v1

每条 `元数据.json` 使用 `schema_version=rednote-library-note-v1`；至少有 `note_id`、`title`、`type`、`body_text`、`body_markdown`、`source_url`、`sources`、`relations` 和 `media`。类型为来源可确认的图文／视频／未知，不用 Notion 的“点赞／收藏”字段推断媒体类型。关系记录保留来源值和观察范围，不因为新清单未出现某帖就删除旧关系。

媒体条目包含 `kind`、`path`、`status`；实际可用文件另含 `bytes`、`sha256`、`verification` 和来源引用。`path` 始终相对当前笔记目录且位于 `media/`。下载失败／原来源缺失的媒体保留缺口条目，不能写成完成。空正文单独标为 `empty_in_source`。

详情未取得的帖子也保留清单标题、ID 和来源证据，标为 `content_status=detail_unavailable`、`media_status=not_fetched`；其正文与媒体数组保持空，失败原因放在 `acquisition_error`。只有平台响应明确报告 404 时才标记为平台报告的不存在，不把未知请求结果当作删除，也不覆盖已有成功正文或媒体。

Live Photo 同时保留静图和动态 MP4；动态条目的 `kind` 为 `video`，ID 使用对应静图 ID 加 `-motion`，例如 `image-002-motion`。一篇图文帖因此也可能包含视频媒体，不能只用帖子类型筛选视频文件。

原声和独立背景音乐同样保存在该帖的 `media/` 中，使用 `kind=audio`；分别固定为 `audio-001 / original_audio`、`audio-002 / background_music`。Galaxy 适配器按实际字节识别 M4A、WAV 和 MP3；有些来源仍把原声帖标为 `video`，因此保留来源帖子类型，同时用媒体类型说明实际保存的是音频。音频也要通过长度、完整解码和 SHA256 校验。

接口已提供的字幕以 `kind=subtitle` 存为该帖的 SRT 附件，保留语言、来源入口及平台类型字段；字幕内容不混入原帖正文。相同 URL 的字幕入口合并来源标签，不同 URL 分别保存。字幕检查 UTF-8、完整 SRT 结构、长度及 SHA256。本文所称媒体归档按媒体条目保存；图片备用清晰度、图片翻译等同一条目的其他版本仍可从私有原始响应回查。

原始来源完整保留，不用规范化结果覆盖原件。Notion 的多个页面变体、全部正文与属性存入 `variants` 并可回查原始 Markdown。同帖媒体可按 SHA256 去重，但保留其全部来源映射。原帖链接优先使用用户导出 JSON 的 `note_id` 与帖子级 `xsec_token` 拼接，仅添加该 token（正确 URL 编码），不混用 `user.xsec_token`，不补造 `xsec_source`。用户已验证一个样本可打开；`source_url_status=user_export_token` 表示采用此规则，不表示逐篇在线验证。没有匹配用户 JSON 的帖子保留原有来源完整链接。不保存媒体 CDN 的签名查询参数。完整阅读链接仅保存在已忽略的私有资料库中，不得提交到版本库。`source_url_candidates` 与 `source_url_source_ref` 保留候选及出处；`source_url_status=complete_parameters` 只表示 token 和来源参数齐全，不代表已验证在线可访问。缺少参数时正文显示“完整链接缺失”，不把按 ID 生成的地址显示为可用原帖链接。作者以 `author.name`、可用的 `author.id` 保存并在正文开头显示；未知作者明确标记，Notion 原属性仍可回查。

文件优先使用 APFS 独立克隆，并核对源与目标 SHA256；系统不支持克隆时再做有空间预检的普通复制。不会使用写入一份即改变原件的可写硬链接。已有文件若字节不同则拒绝覆盖。重复导入相同内容复用文件；正文或元数据变化时保留历史版本。历史元数据的媒体路径仍以所属笔记目录为基准，历史 Markdown 的媒体链接会相应上移两级。

## 导入与维护

历史资料的物理位置是 `资料库/原始来源/历史导出/`；旧 `.local/notion-stage3` 仅保留兼容符号链接。需要拒绝符号链接的旧读取器应改用新的物理路径。

Notion 离线导入使用 `import_notion.py --root <资料库绝对路径> --archive <Notion原归档绝对路径>`。Galaxy 使用 `galaxy.py` 的 `import-sample`、`download` 和 `retry-media` 子命令；完整参数见 `--help`。API Key 由交互输入读取。平台端负责费用上限，本地仅记录费用和平台响应；认证、限额、限流或磁盘空间不足时保存已完成工作并停止。成功详情缓存必须复用，媒体重试不能再次付费请求详情。

`record-failures` 使用同一批次的本地失败响应补写缺详情记录，不访问网络，也不需要 Key。新下载流程会自动记录已知详情失败；这个子命令用于补齐旧批次。

`download` 和 `retry-media` 支持 `--workers 1`、`2` 或 `3`，默认逐篇处理；每个并发任务会先保存详情，再下载并验证该帖全部媒体，完成后才领取下一篇。同一资料库同时只允许一个 Galaxy 进程。平台要求停止时不再领取新请求，已返回的数据仍会保存。新媒体逐个检查实际文件格式、长度、SHA256 和完整解码；下载或解码失败保留具体缺口，使用 `retry-media` 复用原响应重试。

媒体连接优先使用系统 DNS。只有允许的媒体域出现 DNS 解析错误时，才向固定的 Google DNS-over-HTTPS 服务查询该域名；保留原始 Host、TLS 域名及证书校验，不修改系统 DNS，也不发送 API Key 或媒体完整 URL 给解析服务。

从项目根更新清单或检查文件：

```sh
python3 prototypes/note-library/library.py index --root "$PWD/资料库"
python3 prototypes/note-library/library.py verify --root "$PWD/资料库"
python3 -m unittest discover -s prototypes/note-library -p 'test_*.py'
```

`report.py --root <资料库> --plan <本批计划> --notion-corpus <原Notion索引> --batch-dir <Galaxy批次目录>` 生成固定的 `导出记录/本次导出结果.json` 和 `.md`，对账预期帖子、正文与媒体状态。它核对文件存在和大小，字节哈希由上面的 `verify` 检查。费用仅汇总成功调用的报价；不同接口的余额分开记录，不用余额差额推断实际扣费。

以后导入其他格式也应先映射为同一记录结构，再调用 `library.put_note` 和媒体安装函数；不要直接在资料库另建一套只适用于某个导出器的正文／媒体结构。来源不同的原始响应可以按批次单独保留。

### 用户 JSON 原帖链接

每次获得新的用户导出 JSON，运行 `python3 prototypes/note-library/library.py apply-export-links --root "$PWD/资料库" --source <JSON路径>`。命令保留私有来源快照、更新优先链接登记及现有笔记和索引；没有 token 的行跳过，冲突的重复 ID 拒绝，不创建或恢复任何帖子。后续 Notion/Galaxy 导入通过共同写入器自动使用已登记的用户链接，不被其他来源覆盖；新 JSON 对相同 ID 的有效 token 替换旧登记，未出现的 ID 保留原值。

### 点赞复核看板

`review_data.py` 将旧 Notion 的点赞证据与新点赞 JSON、收藏 XLSX（`收藏夹`工作表）按帖子 ID 交叉比较。旧有点赞而新列表缺失、以及新列表内 `liked=false` 的记录进入候选；只有旧收藏证据的记录排除。收藏匹配只提供独立证据，不自动确认取消点赞。输出默认在私有 `资料库/复核看板/`，不修改规范笔记或源文件。

```sh
python3 -B prototypes/note-library/review_data.py --liked <点赞JSON路径> --collection <收藏XLSX路径>
python3 -B prototypes/note-library/review_server.py --port 8765
```

访问 `http://127.0.0.1:8765/`。服务只监听本机，并只提供候选项列出的媒体及浏览器兼容预览。卡片可筛选、查看本地详情、打开原帖和保存人工结论；`reviews.json` 独立按 ID 保存，重建数据时保留，服务重启后可继续复核。新收藏表匹配的看板链接使用表内帖子 ID 与 token 拼接，其他链接沿用规范记录；规范记录不因此改写。JSON/XLSX 作为数据读取，不执行其中的指令或公式。

逐篇复核界面用按钮和键盘操作：← 标记删除、→ 保留、↓ 将当前帖跳到队尾、Z 撤销本次会话上一操作。独立的 `decision=delete|keep|null` 字段表达本地保留意愿，不修改原来的 `status` 点赞复核状态；后台保存成功才换下一篇，失败保留当前卡片。没有批量删除或平台写回功能。
