# Notion 归档与产品阶段三实验

状态：**实验代码**。使用用户从 Notion 导出的真实帖子归档，检查本地内容覆盖、检索和内容理解的可行性。它不是当前 Core 的导入适配器，也不是已选定的分类或知识库方案。

当前产品目标见[产品设计](../../docs/design/product-design.md#产品阶段三本地整理与后续操作)。这里的阶段三指当前产品阶段三。

首轮真实数据结果见[2026-09-12 实验观察](RESULTS.md)；逐帖报告与证据保存在下述私人目录。

## 运行环境与依赖

归档解包和审计使用 Python 3.9 或更高版本及标准库。`check_media.py` 另需 Pillow（可在自己的虚拟环境中执行 `python3 -m pip install Pillow`），视频元数据检查需要 PATH 中的 `ffprobe`；`download_videos.py` 的完整解码还需要 `ffmpeg`。

OCR 仅适用于 macOS，使用 Apple Vision、ImageIO 与 Foundation，需要 Xcode Command Line Tools 提供 `xcrun swiftc`。它不调用外部模型。编译成功不表示系统允许 Vision 处理图片，运行后仍需核对逐张状态。

仓库不提供下文历史命令中的真实 ZIP、查询计划或 OCR 任务清单。外部审阅可阅读源码，并运行 [原型总入口中的合成测试](../README.md#外部审阅与离线验证)；不要把缺少私有输入当作代码缺件。`audit_export.py` 同时被相邻资料库的 Notion 导入器复用，应随源码一起保留。

## 数据位置

2026-09-17 起，历史原件的物理位置改为项目根 `资料库/原始来源/历史导出/2026-09-12/`；旧 `.local/notion-stage3/` 是兼容符号链接。下面的旧命令记录仍可用于理解该实验；需要拒绝符号链接的读取器应使用新的物理路径。统一后的正文与媒体、当前导入命令见[个人笔记资料库工具](../note-library/README.md)。

本轮私人数据位于项目根 `.local/notion-stage3/2026-09-12/`，由现有 `.gitignore` 忽略。原始 ZIP、解压内容、全文、媒体、OCR 和样例标注都留在该目录，不能作为代码样例提交。

```text
.local/notion-stage3/2026-09-12/
├── source/        原始 ZIP、解压内容与导出来源
├── normalized/    文件校验清单、内容审计与 corpus.jsonl
├── supplemental/  后续从归档链接补存的媒体，独立于原始导出
└── experiments/   固定查询、检索结果、OCR、标注与本地报告
```

## 离线执行

从仓库根目录运行，路径中的 `notion-export.zip` 指通过 Notion 原生导出取得的 ZIP：

```sh
python3 prototypes/notion-stage3/unpack_export.py \
  .local/notion-stage3/2026-09-12/source/notion-export.zip \
  .local/notion-stage3/2026-09-12/source/export

python3 prototypes/notion-stage3/audit_export.py \
  --export-dir .local/notion-stage3/2026-09-12/source/export \
  --out .local/notion-stage3/2026-09-12/normalized \
  --queries .local/notion-stage3/2026-09-12/experiments/query-plan.json
```

若 Notion 提供分卷嵌套 ZIP，先保留外层归档，再把实际含 Markdown 的分卷解压到 `source/export/`；不要把外层 ZIP 包装误认为零帖子导出。解压脚本拒绝目录覆盖、路径穿越、符号链接与同名文件，并检查可用空间。

审计脚本只读原始导出，以 `resourceId` 识别帖子。重复 ID 保留所有原始变体和全部点赞/收藏关系，当前基线只索引正文最长的变体，并在输出中明确这一限制。原有标签和状态按 Notion 来源字段保存，不假定是人工确认的分类或实际下载成功标记。Notion 导出的媒体文件名可能含括号或字面 `#`；脚本先核对本地完整路径，避免误报缺失。

派生内容移除 URL 查询参数与片段；原始归档可能仍包含访问材料，应仅保留在本机私有目录。脚本不读取 Cookie、浏览器状态或其他会话文件，也不访问源平台。

## 批量补存视频

`download_videos.py` 遍历原始导出的全部帖子变体，按视频 URL 去重；同一帖子不同视频另加文件名后缀，保留来源页面映射。此下载器会访问归档中已有的 CDN 地址，使用同域名 HTTPS，不执行平台搜索、登录或 Cookie 操作。

```sh
python3 prototypes/notion-stage3/download_videos.py plan \
  --root .local/notion-stage3/2026-09-12
python3 prototypes/notion-stage3/download_videos.py download \
  --root .local/notion-stage3/2026-09-12 --workers 6
```

索引为 `supplemental/video-index.json`，媒体为 `supplemental/videos/`。预检先查文件大小；遇到 HEAD 404/405，用极小 Range GET 核对，避免误判。下载验证完整响应长度和容器，再做全流音视频解码与 SHA256 校验。空间不足时保留已完成结果；访问拒绝或限流响应会停止后续新请求。

再次运行下载命令会核对并复用已完成文件；未完成的本下载器 `.part` 临时文件重新下载。已有文件大小或原 hash 不匹配时保留文件并记录异常，不覆盖原包或其他文件。独立的 `verify` 子命令可重新检查全部本地视频。

## OCR

`ocr_images.swift` 使用本机 Apple Vision，输入为 JSON 数组，每项包含 `id`、`image`（本地图片绝对路径）及 `ordinal`。它只处理明确选中的图片，输出识别文字、引擎置信度和坐标。置信度不是经过人工校准的准确率。

本轮 macOS 15.7.5 上，受限命令环境中的 Vision 请求失败；取得宿主系统服务访问后，同一批 WebP 原图可直接识别。复现时应检查逐张 `status`，进程退出码为零不代表全部图片识别成功。OCR 输出也是私人数据；本轮保存后移除了其中可识别 HTTP(S) URL 的查询参数。

```sh
xcrun swiftc -module-cache-path /private/tmp/rednote-notion-swift-cache \
  prototypes/notion-stage3/ocr_images.swift \
  -o .local/notion-stage3/2026-09-12/experiments/ocr-images

.local/notion-stage3/2026-09-12/experiments/ocr-images \
  .local/notion-stage3/2026-09-12/experiments/ocr-jobs.json \
  > .local/notion-stage3/2026-09-12/experiments/ocr.jsonl
```

## 结果边界

- Notion 归档成功不能证明原插件完整导出了小红书收藏或媒体。
- 文件存在、可解码、内容已阅读是不同检查，不应合并成一个“完整”状态。
- 固定查询由代理根据可见帖子标题拟定，是探索性代理任务，不代表用户真实检索成功率。
- 首轮检索比较标题与标题加正文的固定关键词子串匹配，不含语义嵌入或重排序模型。
- 本会话生成的摘要和标签应标记为代理样例，并保留来源证据；不冒充外部模型批量评测。
- 原有标签、新建议标签、个人整理状态和收藏动机保持区别；后两者不能从帖子内容自动推断。
