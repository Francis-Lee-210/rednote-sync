# 小红书本地知识库：内容理解与分类方案

更新日期：2026-09-23（初稿：2026-08-10）

状态：**探索**。记录帖子处理需求、所需能力、分层处理与评测方案；尚未确定产品选型，也未进行真实帖子的付费模型评测。

按用户要求删除旧的具体模型研究后，2026-09-23重新核查公开的一手资料，扩展至国内外通用多模态、开源托管、OCR/ASR及视频专用服务。本地统计也重新读取当前索引。价格与接口能力是资料核查结果，中文帖子理解质量仍待实测；本轮没有上传帖子、调用付费模型或购买套餐。

相关背景：[项目使命](../mission.md)、[产品设计](../design/product-design.md)、[文档地图](../README.md)、[分类流程学习材料](../../learning/reference/ai-classification-pipeline.html)。

导航：[处理需求](#requirements) · [本地字段](#local-data) · [帖子与能力](#post-types) · [分层处理](#routing) · [视频理解](#video) · [成本口径](#cost) · [评测](#evaluation) · [新一轮选型](#model-survey) · [官方报价](#official-prices) · [托管与中转](#hosted-prices) · [套餐](#plans)

<a id="requirements"></a>

## 1. 项目处理需求与候选输出

### 1.1 小红书中不存在真正的“纯文字帖子”

每篇帖子至少有一张图片。区别不在于“是否有图片”，而在于图片承担什么作用：

- 图片只是帖子标题卡。
- 图片是简单配图，主要信息仍在正文。
- 图片本身承载文字信息，例如截图、清单、聊天记录或长图。
- 图片承担主要语义，例如摄影、穿搭、家居、设计或审美内容。
- 帖子是短视频，意义由画面、字幕、口播、音乐和环境声共同构成。

因此应区分视觉载体的作用；这不意味着必须先单独调用一个分类模型。

### 1.2 分类结果是多维分类卡，不是单一文件夹

前期讨论提出以下候选维度：

- `topics`：主题，例如求职、旅行、摄影、饮食。
- `uses`：用途，例如教程、灵感、参考资料、待实践。
- `forms`：表达形式，例如清单、攻略、随笔、访谈、氛围视频。
- `emotions`：情绪或氛围，例如轻松、克制、怀旧、疏离。
- `aesthetics`：视觉或听觉风格，例如低饱和、极简、电影感。
- `entities`：地点、品牌、产品、人物、机构等实体。

分类结果还应保留：

- 支持每项标签的可见或可听证据。
- 不确定性和需要人工复核的原因。
- `unknown` 或 `needs_new_tag`，避免把新兴趣强塞进旧词表。
- `model`、`model_version`、`prompt_version` 和 `taxonomy_version`。
- 原始模型输出与人工修改记录。

模型自己报告的置信度不能作为唯一判断依据。还需要结合证据完整性、相似度、模型间分歧和词表外检测决定是否升级或人工复核。

### 1.3 可追溯的分类结果

```json
{
  "note_id": "...",
  "content_package_version": "...",
  "provider": "...",
  "model": "...",
  "model_snapshot": "...",
  "prompt_version": "...",
  "taxonomy_version": "...",
  "neutral_description": "...",
  "topics": [],
  "uses": [],
  "forms": [],
  "emotions": [],
  "aesthetics": [],
  "entities": [],
  "evidence": [],
  "unknown": false,
  "needs_new_tag": false,
  "needs_review": false,
  "review_reasons": []
}
```

以上是候选输出结构，不是已实现契约。模型结果应独立保存，例如 `derived/classification/{note_id}.json`，原始归档保持不变。

<a id="local-data"></a>

## 2. 实际导出字段与媒体覆盖

依据2026-09-23逐行解析 `资料库/索引/笔记.jsonl` 的汇总；按真实 LF 分行，未输出帖子正文、作者或访问参数。这里只代表当前索引，不是历次导出累计量。格式定义见 [note-library](../../prototypes/note-library/README.md)。

| 项目 | 2026-09-23读取结果 | 对处理方案的影响 |
|---|---:|---|
| 总记录 | 1,832 | available 1,829；empty_in_source 3；当前无 detail_unavailable 记录 |
| 来源帖子类型 | normal 1,264；video 568 | 有现成粗粒度类型，不需模型再次判断 |
| 图片文件 | 6,388 | 需要保留顺序；最多一帖 24 张 |
| 视频文件 | 763，分布于 618 帖 | 其中 197 个 ID 以 `-motion` 结尾，为动态照片附件 |
| 音频附件 | 234，分布于 234 帖 | 230 个原声、4 个背景音乐；独立音频不是所有视频音轨的总数 |
| 字幕附件 | 644，分布于 215 帖 | 有多语或不同字幕版本，不能解释为 644 个视频已有转写 |
| 只有图片的媒体组合 | 1,210 帖 | 可走一次图文处理 |
| 无媒体附件 | 0 帖 | media_status 均为 complete；不等于每帖语义信息都充分 |
| 正文为空 | 13 帖 | 不可仅按正文归类；来源空内容与正文为空不是同一统计 |
| 正文字符数 | 中位 275；P90 973；最大 1,920 | 字符数不是 token 数，主要变量可能是视觉、音频与生成长度 |
| 来源标签非空 | 1,057 帖 | 可作为弱线索，不能替代模型理解或人工标准答案 |

实际顶层字段包括 `note_id`、`title`、`type`、`body_text`、`body_markdown`、`source_tags`、`author`、`relations`、`sources`、`variants`、`content_status`、`media_status` 和 `media`。媒体含 `kind/path/status/bytes/sha256/verification`，字幕另有语言和角色信息，音频有原声/BGM 角色。

需要注意三个边界：

1. 52 篇 `normal` 帖子实际上带视频；两篇 `video` 没有视频文件。另有一帖仅有视频附件；导出文件组合不等于平台展示形式。路由应读取 `media[].kind` 与可用状态，不能只信 `type`。
2. 这份索引没有 `ocr/transcript/summary/topics/embedding/image_role` 字段；不代表其他目录一定没有加工产物，但不能把这些能力当作本索引已提供。
3. 763 个视频中，只有 435 个的现有 `verification.probe` 记有时长；已知部分合计 1,198.73 分钟。其余 328 个缺时长不是时长为零，因此本轮不报全库视频推理总价。独立音频与视频可能重合，也不能把两种时长相加当作净处理量。

<a id="post-types"></a>

## 3. 帖子类型对应的模型能力

| 素材/目标 | 第一次应做什么 | 何时追加能力 |
|---|---|---|
| 正文充分、图片似标题卡 | 图文模型同时给出摘要、标签、图片角色与证据 | 不把首图判断外推为所有后续图片都无意义 |
| 截图、聊天记录、长图、清单 | 清晰图片输入，直接提取要点并分类 | 小字或数字不清晰时，针对原图局部裁剪/OCR；需要可搜索逐字文本时再保存完整 OCR |
| 多图教程 | 保留全套图片顺序，提取步骤和实体 | 少数关键图提高分辨率；联系表只适合概览，不能用缩略小字作最终证据 |
| 摄影、穿搭、空间、设计 | 视觉描述与主观审美标签一起生成 | 审美不符或细节不足时升级，不能只用 OCR |
| 已有字幕的视频 | 选择合适语言版本字幕，结合覆盖时间线的画面 | 字幕缺漏、动作步骤或画面与口播冲突时补片段 |
| 无字幕的视频，主要找主题 | 视频模型，或一次 ASR 加时序关键帧 | 转写只保留语言信息；字幕不能覆盖无对白内容 |
| BGM、语气、氛围、音画节奏重要 | 明确支持音轨的全模态模型 | 动作/剪辑快时提高采样密度，需保留时间证据 |
| 已有可靠内容卡，只改标签词表 | 用内容卡和证据做文本归类 | 内容卡不含新问题所需信息时才回查原媒体 |

上述是实验建议。标题和来源标签可以帮助取样，但不足以证明“图片不重要”。首次处理可用中等预算覆盖全部图片；对于长图保留可读分辨率，对于视频确保时间覆盖。先做只看首图的硬分流可能省钱，却无法发现后续图片中的重要内容。

建议第一次输出：简短内容摘要、主题/用途标签、图片/声音角色、实体、可定位的证据，以及明确的 `missing_information`。不要求生成长篇推理。以“关键文字不可读、字幕覆盖不足、时间片段缺失、证据矛盾、JSON 校验失败”等具体条件触发补读；模型自报置信度只作辅助。

这轮产生的 OCR、转写、视觉描述和证据可以作为后续检索、标签更新、知识库整理的共用中间结果。它们应独立保存并绑定素材哈希和模型/提示版本，不能覆盖原帖。提取一次不代表永远足够，新任务可能需要回看原图或视频。

<a id="routing"></a>

## 4. 分层处理：独立路由与一次完成的比较

前期提出的思路是：先让轻量多模态模型判断文字、图片和声音的作用，再分给文本、OCR、视觉或音画模型。这一思路仍作为待验证方案保留，候选路由输出如下：

```json
{
  "content_profile": "text_led|ocr_led|visual_led|video_led|audio_visual_led",
  "image_role": "title_card|decorative|informational|aesthetic|mixed",
  "text_is_sufficient": false,
  "needs_ocr": true,
  "needs_original_images": false,
  "needs_video_understanding": false,
  "needs_audio_understanding": false,
  "routing_confidence": "high|medium|low"
}
```

比较额外开销时，需要注意：

“先调用模型分类，再调用模型整理”确实可能比一次整理更贵。应区分两种分类：

- **媒体判断**：有没有视频、音频、字幕、多少张图片。现有字段足够，程序即可完成，不花模型 token。
- **语义判断**：图片是不是封面、是否有正文未包含的知识、音乐是否影响氛围。这通常需要理解素材，但可以与摘要、标签、证据提取放在同一次调用里。

因此首选对照方案是：**按文件和字段选择输入方式，第一次模型调用就产出可用结果，仅对缺信息的帖子追加处理**。不是让所有帖子固定经过一个只输出路由的模型。

### 成本何时会下降

设每帖直接完整处理费用为 D；单独路由费用为 R；路由后的平均处理费用为 P；误路由、重试和补读平均费用为 E。只有 `R + P + E < D`，先路由才省钱。

另一个方案是低成本模型先完成工作，只有比例 q 的帖子升级。其平均费用为 `C初次完成 + q × C追加处理`，其中追加费用必须包含重新发送的素材、历史消息和输出，不能只算“新增的几个字”。例如假设首次费用为 D 的 20%，20% 帖子需再付一个 D，总费为 40% D；这些是示意数字，尚无本库实测支持。

token 数和费用也不同：便宜模型多读一些 token，可能仍比贵模型少读更省。另一方面，缩小图片、稀疏抽帧带来的遗漏，不能当作无损节约。

<a id="video"></a>

## 5. 多模态模型怎样理解视频

典型链路是：解码视频 → 按时间或场景采样画面 → 编码为视觉 token → 加入时序/时间信息 → 如果接口支持，再结合音频表示或转写 → 输出理解结果。它通常不以原始 30/60 FPS 把所有画面完整放进上下文；模型架构与服务端预处理各不相同。

例如 60 秒、30 FPS 的视频有 1,800 帧。按 1 FPS 输入只有约 60 帧，按 2 FPS 约 120 帧；这只是未遇帧数上限的简单计算，不是所有厂商的固定策略。0.2 秒闪现的文字或快速动作可能被跳过。

选择处理接口时，需要分别确认画面采样、时间信息和音轨支持。“支持视频输入”不必然表示理解音轨；自行组合抽帧与转写，也不等同于原生音画理解。采样频率、帧数上限、分辨率与动态补看片段都会影响信息覆盖、费用和延迟，应在实际评测中记录。

对本库，视频需要按“问题”选择采样：讲课/口播重字幕和少量画面；操作教程重步骤变化；舞蹈、运动、剪辑节奏需要更密的时序信息；审美/氛围还要听音轨。不能用同一低 FPS 声称覆盖所有需求，也不应仅因静音视觉路线便宜就用于音乐情绪分类。

<a id="cost"></a>

## 6. 成本评估口径

先统一成每百万输入/输出 token，并分别列币种、地域和长度档。费用公式为：

`输入未缓存 × 输入价 + 缓存读取 × 缓存价 + 输出(含收费思考) × 输出价 + 独立音频/工具/存储费用`

上式各 token 项需除以一百万；若厂商按秒、图片张数或 credit 计费，则分别换算，不能硬套。缓存写入、批量折扣和峰谷折扣仅在供应商明确支持时计入；不同模型对同一张图片的 token 数可能不同，所以同一“每百万单价”不代表同一帖费用。

第三方还要比较充值实付、可用余额、平台服务费、供应商路由、失败重试和是否能传完整媒体。展示的“美元余额”不必然与充值人民币按实时汇率等值。评估时应采用可核查的报价，不把未验证的充值折扣算作确定优惠。

<a id="evaluation"></a>

## 7. 真实帖子评测

先做 60–100 篇人工分层小样，不必先给全库运行一个分类模型。程序按已有 `type`、媒体数量、字幕有无、正文长度取样，再人工补足截图/教程/审美/音画依赖等类型。推荐至少比较：统一便宜多模态一次处理、字段分流后一次处理、首次完成后少量升级；如仍考虑独立路由器，再加为第四组。

用同一组任务与人工参考标签检查：重要信息遗漏、图中文字/数字准确性、音画证据、JSON 有效性、每帖实际账单、重试/升级比例和延迟。不同模型应比较可比的输入覆盖，不是只对齐名义 token 数。做低价路线的随机复核，才能发现它没有主动报告的遗漏。

目前保留了索引字段核查与候选处理方案；尚未完成模型质量比较、全库视频时长统计或付费小样测试。

除上述指标外，保留原讨论中的逐维度Macro-F1、`unknown/needs_new_tag`召回率及审美类人工满意度。固定标签定义、正反例、输出Schema及媒体覆盖范围；不能把厂商排行榜替代个人收藏的实际验收。

<a id="model-survey"></a>

## 8. 2026-09-23重新选型：先选能力路线，不先选厂商

本轮重新读取官方模型、接口和价格资料，不以已删除研究为依据。覆盖通用多模态、开放权重托管、文档识别、语音转写和视频专用服务。以下“候选”表示值得小样验证，不表示已证明优于其他模型；没有以编程榜单推断中文收藏帖效果。

| 路线 | 适用帖子 | 新一轮重点对照 | 不应承担的任务 |
|---|---|---|---|
| 低价图文一次完成 | 正文配图、截图、多图笔记 | GPT-6 Luna、Mistral Small 4，及下表国产低价候选 | 未读取音轨时不能判断音乐情绪 |
| 原生音画联合理解 | 口播、音乐、节奏、画面共同传意的视频 | Gemini 3.5 Flash-Lite及国产Omni类接口 | “视频输入”不能自动当作音轨支持 |
| 质量升级对照 | 模糊小字、多图矛盾、复杂审美、跨模态证据 | Gemini 3.8 Flash、Claude Sonnet 5、GPT-6 Sol | 不因旗舰名号就全库使用 |
| 专用OCR/ASR后复用 | 长图文字归档、已有转录需求、反复更换标签 | PaddleOCR、Mistral OCR、Step ASR、Voxtral | OCR不理解穿搭审美；ASR不理解BGM和镜头 |
| 开放权重/自托管 | 希望数据留本地、长期持续处理 | Ministral、Gemma、GLM视觉、InternVL系列 | 开源不是零成本；须另核硬件、许可证和运维 |
| 视频专用分析 | 时间片段、事件定位、重复检索 | TwelveLabs Pegasus、Reka Vision | 不是所有图文帖的默认处理器 |

**建议的小样组合，而非采购决定：**图文选两个不同体系的低价模型；音画选两个明确支持音轨的模型；再留一个较强模型处理同样的困难样本。先用约5款收敛，其他作为备选。这样既拓宽范围，也避免把20款全部跑一遍增加评测工作。

先完成“媒体字段分流＋一次产出内容卡”的对照，再决定是否值得做专门路由器。只有标题/正文的廉价文本路线更适合已有可信内容卡的重分类，不能默认用来首次理解全部图片。

<a id="official-prices"></a>

## 9. 官方模型与价格

价格核查日为2026-09-23。表中按 **每百万token、未命中缓存、普通短上下文输入/输出** 标价；人民币与美元分表，不自行换汇。输出可能包含计费思考token。图片和视频的编码量不同，不能只按输入单价宣布谁最省钱。列表不是所有在售型号清单。

### 9.1 国际通用模型（USD）

| 模型 / API ID | 已核实输入能力 | 标准输入 / 输出 | Batch输入 / 输出 | 对本项目的意义 |
|---|---|---:|---:|---|
| GPT-6 Luna `gpt-6-luna` | 文本、图片；无原生音视频 | $0.10 / $0.50 | $0.05 / $0.25 | 低价图文主线候选 |
| GPT-6 Sol `gpt-6-sol` | 文本、图片；无原生音视频 | $2 / $10 | $1 / $5 | 复杂图文小样基线 |
| Gemini 3.5 Flash-Lite `gemini-3.5-flash-lite` | 文本、图片、视频、音频、PDF | $0.30 / $2.50 | $0.15 / $1.25 | 四类输入同价，原生音画候选 |
| Gemini 3.8 Flash `gemini-3.8-flash` | 文本、图片、视频、音频、PDF | $0.75 / $3.75 | $0.375 / $1.875 | 此价至2026-12-31，复杂音画对照 |
| Claude Haiku 4.5 `claude-haiku-4-5-20251001` | 文本、图片；未提供原生音视频 | $1 / $5 | $0.50 / $2.50 | Claude体系低价对照，非市场最低价 |
| Claude Sonnet 5 `claude-sonnet-5` | 文本、图片；未提供原生音视频 | $2 / $10 | $1 / $5 | 解释性标签、多图语义对照 |
| Mistral Small 4 `mistral-small-2603` | 文本、图片；未核实原生音视频 | $0.15 / $0.60 | $0.075 / $0.30 | 低价视觉、开放权重路线 |
| Ministral 3 3B `ministral-3b-2512` | 文本、图片；未核实原生音视频 | $0.10 / $0.10 | $0.05 / $0.05 | 低成本下限对照，中文小字需实测 |
| Grok 4.3 `grok-4.3` | 文本、图片；模型卡非原生音视频 | $1.25 / $2.50 | $1 / $2 | 厂商多样性对照，Batch仅八折 |

以上均有结构化输出支持，但仍须验证具体接口的Schema子集、拒绝响应和截断情况。来源：[OpenAI价格](https://developers.openai.com/api/docs/pricing)、[Luna规格](https://developers.openai.com/api/docs/models/gpt-6-luna)、[Sol规格](https://developers.openai.com/api/docs/models/gpt-6-sol)；[Gemini价格](https://ai.google.dev/gemini-api/docs/pricing)、[Flash-Lite](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite)、[Flash 3.8](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash)；[Claude型号](https://platform.claude.com/docs/en/models/overview)、[价格](https://platform.claude.com/docs/en/about-claude/pricing)、[结构化输出](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)；[Mistral价格](https://docs.mistral.ai/inference/pricing)、[Small 4](https://docs.mistral.ai/models/mistral-small-4-0-26-03)、[Ministral 3B](https://docs.mistral.ai/models/ministral-3-3b-25-12)、[Batch](https://docs.mistral.ai/studio/batch-processing)；[Grok 4.3](https://docs.x.ai/developers/models/grok-4.3)、[价格](https://docs.x.ai/developers/pricing)。

价格条件与排除理由：

- Gemini 3.8在2027-01-01恢复标准$1.50/$7.50、Batch $0.75/$3.75，不能按促销价做永久预算。旧Gemini 2.5 Flash-Lite仍有$0.10/$0.40报价（音频输入$0.30），但投用前应核生命周期。
- Sonnet 5原定涨价已取消，$2/$10是当前标准价；不能沿用旧涨价预期。
- Grok最新4.7为$2/$6，且不支持Batch；不是“越新越适合批量标签”。本表保留较便宜的4.3。4.3达到200K输入后全请求按$2.50/$5计费。[4.7规格](https://docs.x.ai/developers/models/grok-4.7)
- GPT-6 Luna/Sol缓存读取为标准输入的10%，写入为1.25倍；超过272K输入，全请求输入/缓存价翻倍、输出价1.5倍。独特图片通常不能假定命中跨帖缓存；区域附加费未包含。
- Mistral Small 4总参数119B，不能用激活参数少就推断普通Mac适合本地运行。本轮未评估用户硬件。

### 9.2 国内通用模型（CNY，人民币）

| 模型 / API ID | 确认能力与限制 | 输入 / 输出（¥/百万token） | 条件与项目定位 |
|---|---|---:|---|
| Qwen `qwen3.7-flash-2026-07-15` | 图文、视频画面；不当作原生音轨理解 | ¥0.20 / ¥0.80 | 北京≤32K；明确Batch半价；低价图文基线 |
| Qwen `qwen3.8-omni-flash` | 文字、图片、音频、视频 | ¥0.80 / ¥2.70 | 北京，各输入模态统一；缓存¥0.10；音画候选 |
| Doubao Seed 2.0 Mini | 全模态候选；具体部署版本仍需确认 | 非音频¥0.20、音频¥3 / 输出¥2 | ≤32K；常规价，不擅自叠Batch折扣 |
| Doubao Seed 2.0 Lite | 全模态候选；具体部署版本仍需确认 | 非音频¥0.60、音频¥9 / 输出¥3.60 | ≤32K；音画升级对照，不是Seedance视频生成模型 |
| DeepSeek V4.1 Flash `deepseek-flash` | 图像理解、JSON输出；未确认原生音视频直入 | 空闲¥1 / ¥4；高峰¥2 / ¥8 | 缓存分别¥0.02 / ¥0.04；图文对照 |
| GLM `glm-5.3-flash` | 多图、视频、文件、1M、JSON；不能关闭思考 | ¥0.80 / ¥2.80 | 缓存¥0.23；值得加入首轮图文对照 |
| GLM `glm-5.3-flashx` | 同家族加速版本 | ¥2 / ¥7 | 缓存¥0.57；离线任务不优先为延迟加价 |
| `MiniMax-M3` | 原生图像/视频、1M；音轨/严格Schema未核实 | ¥2.10 / ¥8.40 | 标准服务≤512K，官方标永久五折；缓存¥0.42 |
| Step `step-3.7-flash` | 图像/视频、256K；未证实能听视频音轨 | ¥1.35 / ¥8.10 | 缓存¥0.27；不同模型家族的视觉对照 |
| Kimi `kimi-k2.6` | 多图/视频、256K、JSON Mode、可关思考 | 未确认 | 官方动态价格表未展示行，不以第三方报价代填 |
| ERNIE 4.5 Turbo VL | 视觉理解；准确接入ID待核 | ¥3 / ¥9 | Batch ¥1.20 / ¥3.60，即标准40% |
| HY-Vision-2.0-Instruct | TokenHub视觉理解；准确接入ID待核 | ¥7.50 / ¥17.50 | 生态备选，不是当前低价首选 |

来源与约束：

- **Qwen**：[百炼价格](https://help.aliyun.com/zh/model-studio/model-pricing)、[视觉能力](https://help.aliyun.com/zh/model-studio/vision-model)、[Omni能力](https://help.aliyun.com/zh/model-studio/qwen3-8-omni-flash)。3.7 Flash北京32–256K为¥0.60/¥2.40，256K–1M为¥1.20/¥4.80。3.8 Flash本身为¥0.80/¥2.70，并非越新越便宜。Omni新加坡¥1.094/¥3.427，与北京不同。
- **Seed**：[方舟价格](https://docs.volcengine.com/docs/ark/model-pricing?lang=zh)。当日浏览器读常规价：Mini在32–128K为非音频¥0.40、音频¥6、输出¥4；Lite为¥0.90、¥13.50、¥5.40。Mini/Lite的`260428`具体版本模态和Batch资格仍需模型页确认，所以不把型号后缀写成已可直接部署的契约。常规缓存价分别为非音频¥0.04/¥0.12、音频¥0.60/¥1.80，另有存储费¥0.017/百万token/小时。
- **DeepSeek币种明确分开**：[中文官方](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)标上述人民币；[英文官方](https://api-docs.deepseek.com/quick_start/pricing/)另标USD：空闲$0.15/$0.60、高峰$0.30/$1.20。不是同一组数字随意换货币符号，也不是本文做汇率换算。高峰为北京时间工作日9–12、14–18点（不含中国法定节假日），其余空闲。V4-Pro-0813不支持视觉，不因Pro名称就放进图文首轮。
- **GLM**：[能力](https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash)、[价表](https://docs.bigmodel.cn/cn/guide/start/pricing)。介绍提及限时半价，但价表当日展示¥0.80/¥2.80且未确认截止日，不再除二；该ID的Batch资格未确认。强制思考可能增加输出费用。
- **MiniMax**：[实际输入接口](https://platform.minimax.cn/docs/api-reference/text-chat-openai)、[价表](https://platform.minimax.cn/docs/guides/pricing-paygo)。>512K标准价格翻倍；优先服务为标准1.5倍。ASR另¥2.50/小时，不将其生成音乐/TTS能力当作M3音轨理解。
- **Step**：[3.7能力](https://platform.stepfun.com/docs/zh/guides/models/step-3.7-flash)、[价表](https://platform.stepfun.com/docs/zh/guides/pricing/details)。`stepaudio-2.5-asr`现价¥0.15/小时，是廉价口播转录候选，不覆盖BGM/镜头；`step-5-preview`支持图/视频及JSON Schema、1M上下文，但¥7/¥20，不作为全库默认。[Step 5](https://platform.stepfun.com/docs/zh/guides/models/step-5-preview)
- **Kimi**：[K2.6](https://platform.kimi.com/docs/guide/kimi-k2-6-quickstart)、[K3](https://platform.kimi.com/docs/guide/kimi-k3-quickstart)、[价格入口](https://platform.kimi.com/docs/pricing/chat)。K3有1M和严格结构化输出，缓存写入按5分钟/1小时TTL另计；本轮价格抓取及浏览器均无价格行，保留未知。视频由关键帧组成，不能据此声称听懂音轨。
- **文心/混元**：[千帆价格](https://cloud.baidu.com/doc/qianfan-docs/s/Jm8r1826a)、[TokenHub价格](https://cloud.tencent.com/document/product/1823/130055)。ERNIE5.1虽更新，但价格页在文本栏，未证实该入口全模态开放。混元[旧平台停止新购](https://cloud.tencent.cn/document/product/1729/97731)，不能沿用旧入口价格；较低价`youtu-vita`[2026-10-15将下线](https://cloud.tencent.com/announce/detail/2447)，不建议新接。

JSON Mode、按提示输出JSON、严格JSON Schema不是同一能力。除已明确核实者，不宣称所有候选都支持严格Schema。

### 9.3 视频与提取专用服务

| 服务 | 官方价格与单位 | 能力与限制 | 项目定位 |
|---|---|---|---|
| TwelveLabs `pegasus1.5` Analyze | USD $1.75/视频小时＋$7.50/百万输出token | 画面、声音、文字联合理解，时间片段/结构化输出；直接分析无需预建索引；中文是官方“部分支持” | 时间定位的备选，不能预设中文效果优于通用模型 |
| Reka Vision索引＋QA/tagging | USD $0.05/视频分钟索引＋$2/百万输出token；搜索另$0.005/次 | 索引路线按视频时长计费；Developer存储免费但30天后自动删除 | 重复检索/视频标签对照，不与一次问答token价混为一谈 |
| Reka QuickTag | 官方输出价$2/百万token；非索引路径，不套上述索引费 | 小于30秒、无存储的轻量标签接口；字段范围与任意知识卡不同 | 极短视频元数据候选；总计费边界投用前再确认 |
| Mistral `mistral-ocr-4-1` | USD $4/千页；带annotation $5/千页 | 版面、段落框、结构块和置信度；非审美理解模型 | 长图/文档可复用OCR |
| Voxtral Mini Transcribe 2 | USD $0.003/分钟 | 语音转录，不是音画理解；中文准确率未测 | ASR价格参照 |

来源：[TwelveLabs价格](https://www.twelvelabs.io/pricing)、[Pegasus能力与语言](https://docs.twelvelabs.io/docs/concepts/models/pegasus)、[版本发布](https://docs.twelvelabs.io/docs/get-started/release-notes)；[Reka价格](https://docs.reka.ai/vision/pricing)、[QuickTag限制](https://docs.reka.ai/vision/api-reference/metadata-tagging/quick-tag-v-1-qa-quicktag-post)；[Mistral OCR](https://docs.mistral.ai/models/ocr-4-1)、[转录价格](https://docs.mistral.ai/inference/pricing)。TwelveLabs的Marengo是检索/embedding路线，不应拿其embedding报价当Pegasus摘要价格。

具体视频机制例子：Gemini官方静态模式默认1 FPS，另处理音轨和时间戳；新款Flash也支持动态查看帧和音频的agentic视频理解。官方静态近似量约100 token/秒（低分辨率）、300 token/秒（高分辨率），不是所有厂商通用常数。以Flash-Lite $0.30/百万输入粗算，一小时分别约$0.108/$0.324输入费，另加提示、输出、重试；这是同一服务下的机制示意，不是全库实价，也不能断言与Pegasus读取的信息量/准确率相同。[Gemini视频说明](https://ai.google.dev/gemini-api/docs/video-understanding)

<a id="hosted-prices"></a>

## 10. 开放权重、托管与中转

开放权重、自部署、第三方托管和转发原厂API是不同路线。以下为公开目录列出的价格，未通过用户账户实调；模型卡支持的媒体不保证每个托管端点都支持。**固定模型版本、provider和媒体端点后，才可比较实际账单。**

### 10.1 新增开放模型路线

| 候选 | 媒体能力/适用性 | 价格或部署边界 | 一手资料 |
|---|---|---|---|
| Ministral 3 8B `ministral-8b-2512` | 图文；中文小字效果待测 | 官方USD $0.15/$0.15；Apache 2.0；不代表本机已能运行 | [模型卡](https://docs.mistral.ai/models/ministral-3-8b-25-12) |
| GLM-4.6V / `glm-4.6v-flash` | 图片/视频视觉；无已核原生音频 | Z.ai国际完整款USD $0.30/$0.90；Flash免费；FlashX $0.04/$0.40。免费不等于无限配额 | [官方价](https://docs.z.ai/guides/overview/pricing)、[Flash权重](https://huggingface.co/zai-org/GLM-4.6V-Flash) |
| Gemma 4 31B `google/gemma-4-31b-it` | 图片/抽帧视频；31B不接音频，不能套其他变体能力 | OpenRouter的DeepInfra Turbo报价USD $0.09/$0.34；最便宜路由是否支持所需媒体待验证 | [Google模型卡](https://ai.google.dev/gemma/docs/core/model_card_4)、[托管价](https://openrouter.ai/google/gemma-4-31b-it) |
| InternVL3.5 8B `OpenGVLab/InternVL3_5-8B` | 图文/OCR/抽帧视频；非原生音轨 | 未核到可靠托管报价，保留自部署候选；不能将241B成绩套给8B | [团队模型卡](https://huggingface.co/OpenGVLab/InternVL3_5-8B) |
| Llama 4 Scout `meta-llama/llama-4-scout` | 图文；官方12种支持语言不含中文 | OpenRouter DeepInfra USD $0.10/$0.30，Novita $0.18/$0.59；109B总参/17B活跃，不按17B估内存 | [Meta模型卡](https://huggingface.co/meta-llama/Llama-4-Scout-17B-16E-Instruct)、[托管价](https://openrouter.ai/meta-llama/llama-4-scout) |
| PaddleOCR-VL 1.5 / 1.6 | OCR/表格/公式/版面，不是通用标签模型 | 硅基`PaddlePaddle/PaddleOCR-VL-1.5`当前免费；1.6只核实开放权重，不能写成免费托管 | [1.5](https://huggingface.co/PaddlePaddle/PaddleOCR-VL-1.5)、[1.6](https://huggingface.co/PaddlePaddle/PaddleOCR-VL-1.6)、[硅基价格](https://siliconflow.cn/pricing) |
| GLM-OCR | 文档文字提取；不能替代照片语义 | 智谱CNY ¥0.20/¥0.20；Z.ai国际USD $0.03/$0.03；具体OCR接口参数另核 | [国内价](https://docs.bigmodel.cn/cn/guide/start/pricing)、[国际价](https://docs.z.ai/guides/overview/pricing)、[模型卡](https://huggingface.co/zai-org/GLM-OCR) |

Gemma图像可用不同视觉token预算，密集小字不能只用最低档；31B、E2B/E4B等变体的音频能力不同。InternVL官方示例按片段抽帧，不是视频逐帧全部观看。自部署尚未评估硬件、许可证适用范围、量化损失和运维成本，不做“本地更便宜”的确定判断。

### 10.2 同型号直连与聚合价格（USD/百万token）

| 型号 | 原厂输入 / 输出 / 缓存读 | OpenRouter具体上游输入 / 输出 / 缓存读 | 比较结论 |
|---|---:|---|---|
| Ministral 3 8B | $0.15 / $0.15 / $0.015 | Mistral Standard：$0.15 / $0.15 / $0.015；另有$0.165/$0.165路由 | 同上游标价相同，中转不天然更便宜 |
| Mistral Small 4 | $0.15 / $0.60 / $0.015 | Mistral同价；Mistral EU $0.165/$0.66；Venice $0.1875/$0.75 | 不拿最低缓存均价冒充每条新帖价 |
| GLM-4.6V | $0.30 / $0.90 / $0.05 | Z.ai同价；Novita $0.30/$0.90/$0.055 | 普通token同价，缓存/平台费用有差异 |

来源：[Mistral官方](https://docs.mistral.ai/inference/pricing)、[Ministral聚合](https://openrouter.ai/mistralai/ministral-8b-2512)、[Small 4逐上游报价](https://openrouter.ai/mistralai/mistral-small-2603/pricing)、[Z.ai官方](https://docs.z.ai/guides/overview/pricing)、[GLM聚合](https://openrouter.ai/z-ai/glm-4.6v)。OpenRouter[当前定价](https://openrouter.ai/pricing)标准平台费5.5%、Business 8%；上述token价不是充值、税费和兑换后的最终总额。

额外人民币托管对照：硅基中国站`zai-org/GLM-4.5V`为¥1/¥6；Z.ai国际同名款为USD $0.60/$1.80。币种、地域及实现不同，不直接比较数字大小。[硅基](https://siliconflow.cn/pricing)、[Z.ai](https://docs.z.ai/guides/overview/pricing)

### 10.3 平台限制比最低标价更重要

- **OpenRouter Batch**：部分模型/上游有约半价的24小时异步通道；图片只接受公网HTTP(S) URL，不接受base64/data URI；OpenAI、Anthropic、xAI、DeepInfra部分端点支持图片，但该批次通道的Mistral、Google、Together、Fireworks不支持图片，音视频输入均拒绝。不能将此扩展成各家原厂Batch限制，也不能为折扣擅自公开本地媒体。[官方规则](https://openrouter.ai/docs/batch-quickstart)
- **Mistral原厂Batch**：公开五折；本轮未实调图片编码形式，表内折扣不表示所有图文请求已经跑通。[官方Batch](https://docs.mistral.ai/studio/batch-processing)
- **硅基**：免费OCR仍有限速/容量条件；未核到所列视觉型号普遍Batch半价的依据。`GLM-4.6V`在硅基已下线，不能因为原厂/OpenRouter仍有就声称硅基可用；旧PaddleOCR-VL也已被新版本替换。[平台公告](https://docs.siliconflow.cn/docs/release-notes/overview)
- **其他中转站**：本轮没有得到足够可复核的同版本、同模态价表，不列来历不明的充值折扣或群内报价。Together、Fireworks也未核到足够可比的竞争报价，不用旧型号凑表。后续若比较指定站点，应同时核来源路由、保留策略、失败退款、余额折算和媒体限制。

<a id="plans"></a>

## 11. Token Plan与订阅：按授权和有效额度比较

不能笼统说“订阅都不包含API”，也不能把聊天/编程套餐当无人值守批处理额度。只有确认允许本任务、媒体可用、限速可接受，才进入成本比较；本轮未查看用户账户权益。

| 方案 | 本轮核实的边界 | 对本项目的处理 |
|---|---|---|
| MiniMax Token Plan | Plus ¥49/月、Max ¥119/月、Ultra ¥469/月；5小时/周窗口，订阅Key与按量Key分开；补充积分目录价1000积分=¥7 | 面向个人交互，生产建议按量，高并发自动流量可能动态限速；未见全面禁止个人批处理，不自行补禁令 |
| Google AI Pro / Ultra | Pro每月$10开发者抵扣；Ultra 20TB $40、30TB $100；须激活，可用于Gemini API | 是有限抵扣，不是无限API；按用户实际地区/权益确认 |
| Mistral订阅 | 新规则跨Studio/API/Vibe共享monthly usage，超额可PAYG；Free公开$10月API额度 | Pro页面混有教育版额度分支，未确认映射，不报价不确定额度 |
| Claude Pro/Max等 | 官方明确与API/Console分别计费 | 不把订阅当本项目API余额 |
| GLM Coding Plan / Step Plan | 积分或Credits不等于token；脚本适用范围、具体额度映射未完整确认 | 暂不据月费推全库处理成本 |
| OpenAI、Grok等订阅 | 本轮没有核到可直接抵本任务API的充分权益依据 | 仅按已核API单价比较，不推定含API余额 |

来源：[MiniMax FAQ](https://platform.minimax.cn/docs/token-plan/faq)、[Google权益](https://developers.google.com/program/plans-and-pricing)及[API抵扣说明](https://blog.google/innovation-and-ai/technology/developers-tools/gdp-premium-ai-pro-ultra/)、[Mistral订阅](https://docs.mistral.ai/admin/billing-usage/subscriptions)及[报价](https://mistral.ai/pricing/)、[Claude说明](https://support.claude.com/en/articles/9876003-i-have-a-paid-claude-subscription-pro-max-team-or-enterprise-plans-why-do-i-have-to-pay-separately-to-use-the-claude-api-and-console)、[GLM模型/Plan说明](https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash)、[Step Plan](https://platform.stepfun.com/step-plan)、[Grok账单](https://docs.x.ai/console/billing)。

## 12. 当前建议与尚未解决的问题

建议首轮小样以 **GPT-6 Luna、GLM-5.3-Flash** 作图文跨厂商对照，以 **Gemini 3.5 Flash-Lite、Qwen3.8-Omni-Flash** 作音画对照，留 **Gemini 3.8 Flash或Claude Sonnet 5** 一款作为困难样本基线。若优先开放权重，将Mistral Small 4加入或替换一个图文候选；若重中文低价，可增加Qwen3.7 Flash，而不必重新限于原来的三家。此顺序基于能力覆盖和报价，不是实测排名。

尚未解决：各模型真实中文小字/多图关联/审美标签质量、输出Schema可靠性、每帖实际视觉与思考token、视频抽样遗漏、重试率、端点地区可用性、部分套餐和动态价格空缺。下一步最有价值的是获授权后按第7节做同素材小样，而非继续罗列更多旗舰。本次完成公开研究与文档更新，未做实现、模型调用或全库处理。
