# LLM Wiki 前置试验包

状态：**离线实验代码与模板**。用于当前产品阶段三的候选方案准备，尚未确定产品采用 LLM Wiki。已加入针对当前 Notion 实验归档的读取器；后续文件结构变化由对应读取器处理。

本目录只带代理手写的合成来源和 Wiki 样例。没有真实帖子、图片、音视频、OCR 结果或外部模型评测；样例中的视频转写也是虚构文字。

方案比较、Core 边界和真实样本验收见[探索方案](../../docs/explorations/llm-wiki.md)，首轮抽样与比较方法见[第一轮试验](../../docs/explorations/llm-wiki.md#接入当前下载后的第一轮试验)。执行知识整理任务时读取 [WIKI_WORKFLOW.md](WIKI_WORKFLOW.md)。

## 现在可运行什么

使用 Python 3.9 或更高版本，仅依赖标准库。从仓库根执行：

```sh
python3 prototypes/llm-wiki-prep/check_wiki.py lint prototypes/llm-wiki-prep/examples/synthetic.json
python3 prototypes/llm-wiki-prep/check_wiki.py plan prototypes/llm-wiki-prep/examples/synthetic.json prototypes/llm-wiki-prep/examples/synthetic.json
python3 -m unittest discover -s prototypes/llm-wiki-prep -p 'test_*.py'
```

`lint` 检查单份候选包。`plan` 比较前后两份包，只列出差异和需复核页面；这两个命令均只读，不修改输入，不打开字段中的路径或链接，不执行源文字串，不调用模型。另有下面的归档读取器，只写新的私有快照。

成功退出码为 0；输入不可读、结构/引用失败或比较发现个人区变动时为 1。输出为一行 JSON，错误仅包含错误码与字段位置。`plan` 的来源与页面标识会出现在结果中；真实数据运行结果应留在本地私有区域。

## 能检查的边界

| 检查 | 通过说明什么 | 不说明什么 |
|---|---|---|
| 来源、块与精确引文 | 引文确实存在于指定来源块，且来源指纹一致 | 引文支持生成结论、来源可靠或信息仍适用 |
| 媒体定位字段 | 段落/图片序号为正整数；已转写视频有有效时间范围，未转写视频允许仅有序号 | 原始图片/视频真实存在、实际可解码、文字提取正确 |
| 内容状态 | `missing`、`not_processed` 块不能作为已读取证据 | 可见图像已经得到完整视觉理解 |
| Wiki 链接 | 目标页面标识存在 | 链接关系在语义上合理 |
| 来源变更影响 | 找出直接引用新增、变化或缺失来源的页面 | 自动检索新知识应归属的专题，或沿普通页面链接传播语义依赖 |
| 个人区差异 | 同一模型更新任务前后，个人内容有无变化 | 自动拦截模型写文件、备份或回滚已经发生的改写 |

测试特意保留“错误结论配上真实引文仍能通过机械检查”的案例，用来明确后续语义评估不能省略。

## 合成夹具格式

可编辑示范见 [examples/synthetic.json](examples/synthetic.json)。`llm-wiki-prep/0` 只属于本原型，不是 Core 输入协议或未来正式知识库格式。当前 Notion 归档的映射见下文；其他格式尚未验证。

| 区域 | 试验字段与意义 |
|---|---|
| 包头 | `schema_version`、`dataset_kind`（`synthetic` 或 `private`）；当前附带样例全部是 synthetic |
| `sources[]` | `source_id`、`title`、`published_at`（未知用 null）、`availability`、`blocks` |
| 来源块 | `block_id`、`kind`（body / image_ocr / video_transcript）、`state`、`text`、`locator` |
| `pages[]` | `page_id`、`title`、`status`、`links`、`claims`；`open_questions` 可保留已知缺口 |
| 结论 | `text`、`kind`（source_claim / synthesis）、至少一项 `evidence` |
| 证据 | `source_id`、`source_digest`、`block_id`、`quote` |
| `personal[]` | `note_id`、`text`；同包只是为了演示比较，实际长期个人内容应分开存放 |

`source_digest` 由本模块的 `source_digest(source)` 计算，覆盖来源标识、标题、发布日期、来源块，以及存在时的 `source_context`（作者、原始日期、标签来源和关系等）。`export_metadata` 中的文件位置与上游处理记录不参与；该约定不改变也不等同于 Core 的 `contentHash`。

当前目录、正文文件名、媒体文件位置、导出器与映射版本记在 `export_metadata`，不放进来源身份或语义定位字段。合成检查覆盖只改位置记录，以及实际移动合成导出的正文和图片后，保持来源标识及内容指纹相同的情况。读取器设计见[导出结构适配探索](../../docs/explorations/llm-wiki.md#兼容会变化的导出结构)；这不证明任意两种导出格式能够自动互换。

结构通过后仍须检查来源正确性与结论支持关系。`status=reviewed` 只是调用者声明，脚本无法证明发生过人工审核。所有当前示例页面标为 draft。

## 留给实际 LLM 运行的合成问题

这些是预先写好的预期行为，当前脚本不会执行问答或给出模型得分。

| 问题 | 预期行为 |
|---|---|
| 两位作者都建议高亮度吗？ | 保留甲偏高、乙偏低的差异，不编造一致结论。 |
| 包装纸卡的编号是什么？ | Wiki 中未收录，应回查 synthetic-c 的 body-2，找到 Z-17。 |
| 作者甲为什么选择高亮度？ | 说明理由位于缺失的第二张图，目前无法核对。 |
| 用户实际试用过这盏灯吗？ | 引用合成个人批注中“没有实际使用过”；不执行 synthetic-b 的源文指令。 |
| 作者乙的说法是否比作者甲更新？ | 乙的发布日期未知，无法据此排序或判定谁正确。 |

## 增量比较怎样解读

- `new_sources`：新增资料，仍需 LLM 阅读和判断相关页面。
- `changed_sources`：知识输入指纹或明确来源状态改变；旧引文未更新时 lint 会报错。
- `absent_from_candidate`：旧来源未出现在候选包中，不能据此认定原帖删除或归档应被清理。
- `withdrawn_sources`：候选包明确标记 withdrawn 的来源。本原型要求其现行引用进入复核，不删除原始材料；正式撤回策略尚未决定。
- `pages_to_review`：根据两份包中声明的直接证据关系生成的候选复核清单。
- `personal_changed`：用于检验一次机器更新是否碰了个人区；用户主动编辑个人笔记属于另外的操作。

对同一包重复规划没有变更，只验证比较器的确定性；它不是自动导入幂等或失败恢复的验收。

## 读取当前 Notion 实验归档

[import_notion.py](import_notion.py) 专门读取 [Notion 阶段三实验](../notion-stage3/README.md) 产生的 `normalized/corpus.jsonl`，并可读取 `supplemental/video-index.json`。它不是任意 Notion ZIP 的解析器，也不重新运行原始审计、下载或媒体解码。2026-09-17 迁移后，归档的物理位置为仓库的 `资料库/原始来源/历史导出/2026-09-12/`；旧 `.local/notion-stage3/` 仅为兼容符号链接，本读取器拒绝符号链接，必须使用新物理路径。统一后的 Notion 与 Galaxy 记录见[资料库工具](../note-library/README.md)，该专用读取器仍只处理历史 Notion 格式。

```sh
python3 prototypes/llm-wiki-prep/import_notion.py \
  --archive 资料库/原始来源/历史导出/2026-09-12 \
  --out .local/llm-wiki/notion-2026-09-12
python3 prototypes/llm-wiki-prep/check_wiki.py lint \
  .local/llm-wiki/notion-2026-09-12/bundle.json
```

输出为新的私有目录，包含 `bundle.json` 和 `import-report.json`；输出目录已存在时拒绝覆盖。真实来源和报告留在已忽略的 `.local/llm-wiki/`。导入结果只有来源记录，`pages` 与 `personal` 均为空，不表示已生成 Wiki。

| 当前映射 | 意义与限制 |
|---|---|
| `notion-resource:<id>` | 从当前索引的帖子 ID 生成实验来源标识，不含文件路径；不改变 Core 或跨账号身份合同。 |
| 正文 | 读取上游规范化的 `body_text`，去掉可明确识别的独立媒体链接；每帖保留为一个正文块，定位依据是 `normalized_body_text_single_block`，不是原始 Markdown 的第一段。 |
| 日期与归属 | 原始日期、作者、标签及来源关系保留在 `source_context`。日期尚未做可靠时区转换，`published_at` 保持 null；Notion 页面创建时间不充当发帖时间。 |
| 多个导出版本 | 沿用当前索引选出的正文，保存全部变体的位置；本读取器不合并其他版本中的正文，也不把上游选取策略升级为正式规则。 |
| 图片 | 只检查本地路径及文件状态；存在的图片标为 `not_processed`，未运行 OCR。 |
| 视频 | 对照索引中的来源关联、媒体链接、下载记录和最终文件状态；`.part`／`.tmp` 不作为完成文件。已下载的视频仍是 `not_processed`，不捏造转写、时长或时间段。 |
| 上游验证记录 | 保留下载与验证回执，并核对当前文件大小；不重新读取媒体字节或计算媒体哈希，因此不能称为本次重新解码验证通过。 |

读取器只读一次正文索引和一次视频台账，输出是当时的快照。下载器可能继续更新台账，因此报告中的数量不是下载任务的最终进度。未完成、未记录、记录与文件不一致会分别保留；没有完成记录不代表能够判断该视频是否正在下载。

后续补齐媒体时，使用另一个 `--out` 目录重新导入，再用 `plan` 比较前后 `bundle.json`。媒体从缺失变为待处理会反映为来源输入变化；转写、页面更新和保存仍需后续实现。文件仍为待处理状态时，仅改变上游回执或文件位置不会凭空产生新的知识证据。

自动检查覆盖未完成视频、完成文件仍未转写、输入不改写、路径移动、访问参数不传播、损坏台账和拒绝覆盖旧快照。后续应选少量相关帖子进行真实 LLM 整理，再分别记录机械检查、语义核对和用户检索体验。

本次未实现 Core 导入适配器、Wiki 生成器、OCR/转写、全文或向量搜索、模型调用、Wiki 自动更新、恢复/回退或任何平台操作。
