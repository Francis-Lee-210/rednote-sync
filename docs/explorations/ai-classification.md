# 小红书本地知识库：AI 内容理解与分类模型选型

更新日期：2026-09-19（初稿：2026-08-10）

状态：**探索**。统一记录帖子处理需求、候选模型、官方及中转价格、套餐与评测方案；尚未确定产品选型，也未进行真实帖子的付费模型评测。

本文合并前期讨论与2026-09-19研究，以本次研究替换旧型号推荐和报价。研究已核对公开来源及本地规范化索引，没有上传帖子、购买套餐或调用付费模型；本次文档合并没有重新抓取价格或统计资料库。价格与字段统计均为该次核查快照，不能视为实际账单或效果排名。

相关背景：[项目使命](../mission.md)、[产品设计](../design/product-design.md)、[文档地图](../README.md)、[分类流程学习材料](../../learning/reference/ai-classification-pipeline.html)。

导航：[处理需求](#requirements) · [本地字段](#local-data) · [帖子与能力](#post-types) · [分层处理](#routing) · [视频理解](#video) · [官方模型与价格](#official-pricing) · [中转与托管](#relay-pricing) · [套餐](#plans) · [成本算例](#cost) · [评测](#evaluation)

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

依据2026-09-19逐行解析 `资料库/索引/笔记.jsonl` 的汇总；按真实 LF 分行，未输出帖子正文、作者或访问参数。格式定义见 [note-library](../../prototypes/note-library/README.md)。

| 项目 | 2026-09-19读取结果 | 对处理方案的影响 |
|---|---:|---|
| 总记录 | 2,494 | 包括 1 条详情不可用记录，不等于全部内容均可处理 |
| 来源帖子类型 | normal 1,729；video 749；unknown 16 | 有现成粗粒度类型，不需模型再次判断 |
| 图片文件 | 8,496 | 需要保留顺序；最多一帖 24 张 |
| 视频文件 | 939，分布于 797 帖 | 其中 192 个 ID 以 `-motion` 结尾，为动态照片附件 |
| 音频附件 | 231，分布于 231 帖 | 227 个原声、4 个背景音乐；独立音频不是所有视频音轨的总数 |
| 字幕附件 | 635，分布于 212 帖 | 有多语或不同字幕版本，不能解释为 635 个视频已有转写 |
| 只有图片的媒体组合 | 1,677 帖 | 可走一次图文处理 |
| 无媒体附件 | 17 帖 | 是导出结果的缺口/来源状态，不推翻平台帖子至少有图的前提 |
| 正文为空 | 19 帖 | 不可仅按正文归类；其中有来源空内容和未取得详情等不同情况 |
| 正文字符数 | 中位 272；P90 965；最大 1,920 | 字符数不是 token 数，主要变量可能是视觉、音频与生成长度 |
| 来源标签非空 | 1,651 帖 | 可作为弱线索，不能替代模型理解或人工标准答案 |

实际顶层字段包括 `note_id`、`title`、`type`、`body_text`、`body_markdown`、`source_tags`、`author`、`relations`、`sources`、`variants`、`content_status`、`media_status` 和 `media`。媒体含 `kind/path/status/bytes/sha256/verification`，字幕另有语言和角色信息，音频有原声/BGM 角色。

需要注意三个边界：

1. 50 篇 `normal` 帖子实际上带视频；两篇 `video` 没有视频文件。路由应读取 `media[].kind` 与可用状态，不能只信 `type`。
2. 这份索引没有 `ocr/transcript/summary/topics/embedding/image_role` 字段；不代表其他目录一定没有加工产物，但不能把这些能力当作本索引已提供。
3. 939 个视频中，只有 424 个的现有 `verification.probe` 记有时长；已知部分合计 1,176.23 分钟。其余缺时长不是时长为零，因此本轮不报全库视频推理总价。独立音频与视频可能重合，也不能把两种时长相加当作净处理量。

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

2026-09-19的研究进一步比较其额外开销：

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

**官方接口证据：**

- [Qwen 视觉文档](https://www.alibabacloud.com/help/en/model-studio/vision)说明 `fps` 控制抽帧频率，`max_frames` 可限制帧数，超过时再均匀采样；该视觉接口不理解视频音轨。因此“支持视频输入”不等于“支持声音”。
- [Gemini 视频文档](https://ai.google.dev/gemini-api/docs/video-understanding)的静态方式默认 1 FPS，可设置抽帧频率和片段。其示例计数为低分辨率 66 token/帧、其他分辨率 258 token/帧，音频 32 token/秒，另有时间等元数据；一分钟约 6,000 或 18,000 输入 token 是量级估计，实际按返回 usage 和模型/模态费率结算。部分新版还有动态查看时间线的 agentic 模式，可能减少长视频输入，但增加导航推理和首字等待；宣传中的最高节约比例不能直接用于本库预算。
- [DeepSeek 视觉 API](https://api-docs.deepseek.com/guides/vision/)确认 `deepseek-flash` 支持图片，本轮没有据此确认其直接视频和音轨输入。可以自行提供带时间戳的抽帧与转写，但这是应用侧组合，不能写成官方原生音视频支持。

对本库，视频需要按“问题”选择采样：讲课/口播重字幕和少量画面；操作教程重步骤变化；舞蹈、运动、剪辑节奏需要更密的时序信息；审美/氛围还要听音轨。不能用同一低 FPS 声称覆盖所有需求，也不应仅因静音视觉路线便宜就用于音乐情绪分类。

<a id="official-pricing"></a>

## 6. 官方模型能力、价格与限制

以下均为每百万 Token；输入为未命中缓存的标准输入，输出包含收费的推理 Token。人民币与美元分表，不用未核实汇率混算。媒体 Token 数在不同模型间不同，相同视频不能只按输入单价比较。额度、活动、地域与正式账单仍需区分。

| 模型 | 官方服务/计价档 | 输入 CNY | 输出 CNY | 候选用途 |
|---|---|---:|---:|---|
| Qwen3.7 Flash | 百炼北京，单请求 ≤32K | 0.2 | 0.8 | 廉价图文与静音视频理解基线 |
| Qwen3.8 Flash | 百炼北京，≤1M | 0.8 | 2.7 | 较新图文/视频通用候选 |
| Qwen3.8 Omni Flash | 百炼北京，统一输入价格 | 0.8 | 2.7 | 有声视频、口播和声音语义优先候选 |
| Qwen3.7 Plus | 百炼北京，≤256K，原价 | 2 | 8 | 复杂视觉/跨图理解升级候选 |
| Qwen3.5 OCR | 百炼北京 | 0.5 | 2 | 密集截图/表格的独立提取候选 |
| Qwen3 VL Flash | 百炼北京，≤32K | 0.15 | 1.5 | 旧视觉专用对照，未必优于3.7 Flash |
| Doubao Seed2.0 Lite 260428 | 火山方舟常规，≤32K | 非音频0.6；音频9 | 3.6 | 图文/视频/声音统一理解对照 |
| Doubao Seed2.0 Mini 260428 | 火山方舟常规，≤32K | 非音频0.2；音频3 | 2 | 更便宜的全模态候选，需验证信息遗漏 |

价格依据：[百炼官方价格](https://help.aliyun.com/zh/model-studio/model-pricing)。3.7 Flash 的后两档为输入/输出 ¥0.6/2.4（32K–256K）、¥1.2/4.8（256K–1M），全请求按所属档计费。其北京条目明确 Batch 半价。3.7 Plus 显示限时八折，不能把活动价当永久价。Omni 缓存输入 ¥0.1。新加坡3.7 Flash短档 ¥0.225/0.974，3.8 Flash及Omni ¥1.094/3.427。

| 模型 | 官方服务/计价档 | 输入 USD | 输出 USD | 候选用途 |
|---|---|---:|---:|---|
| DeepSeek V4.1 Flash (`deepseek-flash`) | 官方 API，非高峰 | 0.15 | 0.60 | 中文图文结构化理解的重要新对照 |
| 同上 | 官方 API，高峰 | 0.30 | 1.20 | 同一模型，按调用时段变价 |
| Gemini 3.1 Flash-Lite | Developer API，标准 | 0.25；音频0.50 | 1.50 | 低成本原生音视频国际基线 |
| Gemini 3.5 Flash-Lite | Developer API，标准 | 0.30，包含音频 | 2.50 | 新一代低成本全模态对照 |
| Gemini 3.8 Flash | Developer API，2026年底前标准活动价 | 0.75 | 3.75 | 复杂音视频升级对照 |
| GPT-5.6 Luna | OpenAI API，≤272K输入 | 0.20 | 1.20 | 图文结构化输出国际低价基线 |

DeepSeek依据：[官方定价](https://api-docs.deepseek.com/quick_start/pricing/?push_animated=1&show_loading=0&theme=light&webview_progress_bar=1)。高峰为周一至周五 UTC 01:00–04:00、06:00–10:00，其余时段半价。缓存输入高峰/低峰 $0.006/0.003。定价页明确 V4 Pro 继续提供，但不支持视觉。谷歌依据：[官方定价](https://ai.google.dev/gemini-api/docs/pricing)。上表三款列有半价 Batch；3.8 Flash于2027-01-01标准价变为 $1.50/7.50。免费层与付费层的数据使用政策不同。

OpenAI价格与模态依据：[GPT-5.6 Luna模型页](https://developers.openai.com/api/docs/models/gpt-5.6-luna)支持文本与图片输入、结构化输出，不支持音频/视频输入。缓存输入 $0.02；超过272K输入时全请求输入价2倍、输出价1.5倍；缓存写入价1.25倍。[Batch](https://developers.openai.com/api/docs/guides/batch)提供50%折扣，24小时内完成。视频需自行抽帧并结合转写，不能把该组合与原生音视频的输入Tokens直接等同。

### 能力证据与限制

#### DeepSeek：用户提及的新视觉能力属实

[官方更新日志](https://api-docs.deepseek.com/updates/)确认2026-09-10发布 V4.1 Flash，原生多模态视觉理解。正式调用名为 `deepseek-flash`；旧的 `deepseek-v4-flash` 与 `deepseek-v4-flash-vision-exp` 已退役并临时转到新Flash，不能当三个独立模型比较。

[视觉接口](https://api-docs.deepseek.com/guides/vision/)展示图像输入；当前证据确认文本+图像、JSON输出、1M上下文，不据“多模态”一词推断原生音频或视频文件输入。视频路线可以自行抽帧并附时间戳，声音另行转写，但这是组合方案。

#### Qwen：便宜视觉与便宜全模态已经需要重新比较

[视觉模型文档](https://help.aliyun.com/zh/model-studio/vision-model)列出3.7 Flash、3.8 Flash、3.7 Plus均支持图像、最长2小时/2GB视频与结构化输出；视觉模型的视频理解不自动包括声音。OCR专用款适合提取，不应把提取准确率等同帖子归类准确率。

[Qwen3.8 Omni Flash模型页](https://help.aliyun.com/zh/model-studio/qwen3-8-omni-flash)明确支持文字、图片、音频、视频输入与文字输出，1M上下文，113种语言和方言，缓存与思考强度调节。因此旧的“千问统一只做视觉、豆包处理音频”的分工已不是唯一合理方案。需测它与Seed Lite在口播、BGM、环境声上的成本和信息保留。

[Batch API文档](https://help.aliyun.com/zh/model-studio/openai-compatible-batch-chat)列有Qwen3.8 Flash支持，但价格页其条目未标Batch半价；调用前应核对当期价格/控制台，不能仅据其他型号自动推断。Qwen3.8 Omni Flash不在本次读取的Batch清单中，不预设支持。

#### Gemini：新款不必然比旧款便宜

[3.1 Flash-Lite官方模型页](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite)确认文本、图像、视频、音频、PDF输入，文字输出，结构化输出与Batch。新3.5 Flash-Lite音频输入价更低，但输出价更高；图文摘要短输出与口播长音频的最优选择可能不同。3.8 Flash仅作为复杂案例对照，不能用其较新版本号替代真实集评估。

#### 豆包：Lite与Mini必须区分音频价及版本

2026-09-19通过浏览器读取[火山方舟官方动态价格表](https://docs.volcengine.com/docs/ark/model-pricing?lang=zh)，补全了此前网页提取器未返回的表格。以下为在线常规服务，单位人民币/百万Token；缓存存储另按 ¥0.017/百万Token/小时计。

| 模型 | 输入长度 | 非音频输入 | 音频输入 | 非音频缓存命中 | 音频缓存命中 | 输出 |
|---|---|---:|---:|---:|---:|---:|
| Seed2.0 Lite | ≤32K | 0.6 | 9 | 0.12 | 1.8 | 3.6 |
| Seed2.0 Lite | (32K,128K] | 0.9 | 13.5 | 0.18 | 2.7 | 5.4 |
| Seed2.0 Lite | (128K,256K] | 1.8 | 27 | 0.36 | 5.4 | 10.8 |
| Seed2.0 Mini | ≤32K | 0.2 | 3 | 0.04 | 0.6 | 2 |
| Seed2.0 Mini | (32K,128K] | 0.4 | 6 | 0.08 | 1.2 | 4 |
| Seed2.0 Mini | (128K,256K] | 0.8 | 12 | 0.16 | 2.4 | 8 |

同页“批量推理”表明确：上述Lite/Mini各档非缓存输入及输出均为常规价格一半，缓存命中价不变。例如Lite ≤32K Batch为非音频¥0.3、音频¥4.5、输出¥1.8；Mini为¥0.1/1.5/1.0。在线低优也列出相同的非缓存输入/输出单价；低优只支持隐式缓存，不产生缓存存储费用。不能把Batch与低优折扣再相乘。

[官方2026功能发布记录](https://www.volcengine.com/docs/6492/2165228?lang=en)的5月28日条目列出 `doubao-seed-2-0-mini-260428` 与 `doubao-seed-2-0-lite-260428`，6月9日明确Mini/Lite仅260428版本支持音频理解；调用时应固定版本，不能看到Seed2.0家族名称就把旧版当作支持声音。[Seed2官方介绍](https://seed.bytedance.com/en/seed2)也说明4月底Lite升级统一文字、图片、视频、音频理解。

因此比较千问Omni与豆包时，不能只取豆包“¥0.6起”当有声视频统一输入价。反过来，音频单价相差也不能直接当每分钟或每帖成本倍数：不同厂商的音频/视频Token生成数量及采样策略不同，需固定同一视频记录实际usage和总账单。

同一官方价表另核实Seed2.1 Turbo ≤256K常规输入/输出¥3/15，Batch ¥1.5/7.5；Pro ≤1M常规¥6/30，Batch ¥3/15。这两行音频输入列为“-”，不能由版本更新推断直接音频输入；本轮不据此替代已确认的260428音频模型。

### 仍值得纳入，但本次价格证据不完整的候选

| 候选 | 已证实 | 价格核查状态 |
|---|---|---|
| Kimi K2.6 / K3 | 官方指南确认图像/视频能力；K2.6可关闭思考，K3始终思考且有严格JSON Schema | 官方价格页可打开但价格表没有返回；不使用第三方转述补成“已核实官方价” |

来源：[Seed2官方介绍](https://seed.bytedance.com/en/seed2)、[豆包官方产品](https://www.volcengine.com/product/doubao/)、[Ark产品](https://www.volcengine.com/product/ark)、[Ark价格入口](https://www.volcengine.com/docs/82379/1544106)、[Kimi K2.6指南](https://platform.kimi.ai/docs/guide/kimi-k2-6-quickstart)、[Kimi K3指南](https://platform.kimi.ai/docs/guide/kimi-k3-quickstart)、[Kimi官方价格入口](https://platform.kimi.ai/docs/pricing/chat)。

GLM多模态型号亦值得备选，但本次未取得足够可读的官方新价/新型号证据，不列出猜测价。Seedance是视频生成家族，不是本任务要买的视频理解接口。

### MiniMax-M3 与独立转写费用

作为按量对照，**`MiniMax-M3` Standard** 输入 ≤512K 时为 **$0.30 输入／$1.20 输出／$0.06 缓存读，每百万 tokens**；输入 >512K 为 $0.60／$2.40／$0.12。Priority 为 Standard 的 1.5 倍。另一条图像理解路径 `API-vlm` MCP 为 **$0.01/次**，也可抵扣 Token Plan，不能与 M3 原生图像输入当成同一计费路径；这项 MCP 价格于 2026-07-22 调整。来源：[MiniMax PAYG 一手价表](https://platform.minimax.io/docs/guides/pricing-paygo)。

若选择“先转写、再看画面”，`qwen3-asr-flash-filetrans` 北京官方报价为 ¥0.00022/音频秒，即 ¥0.0132/分钟、¥0.792/小时，输出不另收费；新加坡为 ¥0.00026/秒。应加上后续图文理解费用，不能把 ASR 单价当视频总价。已有212帖提供字幕，应先检查覆盖与质量，避免重复转写。[官方 ASR 价格](https://help.aliyun.com/zh/model-studio/model-pricing)

<a id="relay-pricing"></a>

## 7. 中转、聚合与开源托管价格

本次比较OpenRouter、AIHubMix、302.AI和SiliconFlow的公开一手报价，未注册、充值或进行媒体请求实测。不同平台同名模型可能使用不同上游、区域或版本；以下是可核查的平台样本，不是所有中转站的穷尽列表。

### 平台定位与收费边界

| 平台 | 本次比较的服务 | 已核实收费方式 | 对自动处理帖子的意义 |
| --- | --- | --- | --- |
| OpenRouter | 多供应商 API 聚合／路由 | 美元用量计费；Standard 平台费 5.5%，Business 8%；推理单价按上游传递 | 适合脚本调用。另有 Batch，但当前仅文本；图像、音频、视频须同步 API |
| SiliconFlow 中国站 | 开源模型托管推理，不等同于模型原厂 API 转售 | 人民币／百万 tokens；不同于其国际站价格 | 可脚本调用视觉模型；限流、具体账号额度和本次所选模型的 Batch 折扣未核实 |
| AIHubMix | 多上游 API 聚合／自动回退 | 模型页美元报价，可列出具体上游与分层价格 | 有 API 示例；自动批处理的订阅套餐权益未核实，不能把网页聊天套餐当 API 配额 |
| 302.AI | API 聚合、工具与统一钱包 | 预充值、按用量／次数扣费；价格页声明 1 PTC = 1 USD，余额永久有效 | 可脚本调用；本次未核实可用于无人值守批量处理的包月套餐及独立 Batch 折扣 |

来源：[OpenRouter 价格](https://openrouter.ai/pricing)、[OpenRouter FAQ](https://openrouter.ai/docs/faq)、[SiliconFlow 价格](https://siliconflow.cn/pricing)、[SiliconFlow 多模态接口](https://docs.siliconflow.cn/docs/userguide/capabilities/multimodal-vision)、[AIHubMix 模型目录](https://aihubmix.com/models)、[302 价格页](https://price.302.ai/pricing_website/?region=cn)、[302 入门与钱包说明](https://help.302.ai/docs/302-AI-wu-fen-zhong-shang-shou-jiao-cheng)。

OpenRouter 的 BYOK 规则已经变化：Standard／Business 每月按目录推理价值计算的 25,000 美元免 BYOK 服务费，超额部分收 5%；它并不免除模型上游推理费用。不要继续引用旧的“每月一百万请求免费”规则。[当前政策](https://openrouter.ai/pricing)

AIHubMix 旧文档搜索摘要中的支付／积分条款已跳转至新版条款。本次不把旧摘要的“12 个月过期”等内容作为当前确认事实；支付兑换率、手续费和余额期限仍需下单页确认。[当前条款](https://aihubmix.com/legal/terms)

### 同模型跨平台报价

除 SiliconFlow 小节外均为 **USD／百万 tokens**，输入指未命中缓存的基础输入；多媒体如何转成 tokens 仍按相应模型及接口规则。以下不含充值、税费、汇兑和重试成本。

| 模型与平台 API ID | 平台／上游 | 输入 | 输出 | 缓存读 | 条件与来源 |
| --- | --- | ---: | ---: | ---: | --- |
| `qwen/qwen3.7-flash` | OpenRouter／Alibaba Cloud Int. | 0.03 | 0.13 | 0.006 | 页面基础报价；显式 5 分钟缓存另列读 0.003、写 0.038；[模型页](https://openrouter.ai/qwen/qwen3.7-flash) |
| `qwen3.7-flash` | AIHubMix／Alibaba Cloud | 0.0282 | 0.1128 | 0.0056 | 输入 ≤32K；32K–256K 为 0.0845／0.338，256K–1000K 为 0.169／0.676；[模型页](https://aihubmix.com/model/qwen3.7-flash) |
| `qwen/qwen3.8-flash` | OpenRouter／Alibaba Cloud Int. | 0.15 | 0.47 | 0.016 | 基础报价；缓存写 0.20；[模型页](https://openrouter.ai/qwen/qwen3.8-flash) |
| `deepseek/deepseek-v4.1-flash` | OpenRouter | 0.15 / 0.30 | 0.60 / 1.20 | 0.003 / 0.006 | 离峰／高峰，模型目录有 UTC 日期与时段 overrides；[目录 API](https://openrouter.ai/api/v1/models) |
| `deepseek-v4.1-flash` | AIHubMix／DeepSeek 或 Bytedance | 0.155 / 0.3098 | 0.62 / 1.2392 | 0.0031 / 0.0062 | 离峰／高峰；高峰 UTC 01–04、06–10；[模型及路由](https://aihubmix.com/model/deepseek-v4.1-flash) |
| 同上，页面上游 ID `alicloud-deepseek-v4.1-flash` | AIHubMix／Alibaba Cloud | 0.1408 / 0.2816 | 0.5632 / 1.1264 | 0.0141 / 0.0282 | 离峰 UTC 14–24，高峰 00–14；与 DeepSeek 路由窗口、缓存价不同；[路由表](https://aihubmix.com/model/deepseek-v4.1-flash) |
| 页面型号 V4.1 Flash，价表调用名 `deepseek-chat` | 302.AI | 0.15 / 0.30 | 0.60 / 1.20 | 0.003 / 0.006 | 高峰 UTC 01–04、06–10；页面没有同等清晰的周末例外说明；调用别名和视觉参数须再核实；[产品价表](https://302.ai/product/detail/deepseek-v4.1-flash) |
| `openai/gpt-5.6-luna` | OpenRouter | 0.20 | 1.20 | 0.02 | 输入 >272K 后 0.40／1.80；[目录 API](https://openrouter.ai/api/v1/models) |
| `gpt-5.6-luna` | AIHubMix／OpenAI 或 Azure | 0.20 | 1.20 | 0.02 | 输入 ≤272K；更长为 0.40／1.80；[模型页](https://aihubmix.com/model/gpt-5.6-luna) |
| `google/gemini-3.5-flash-lite` | OpenRouter／Google AI Studio 或 Vertex | 0.30 | 2.50 | 0.03 | Flex 路由另列 0.15／1.25，不用于 Standard routing；[模型页](https://openrouter.ai/google/gemini-3.5-flash-lite) |
| `gemini-3.6-flash` | AIHubMix／VertexAI 或 Google AI Studio | 0.75 | 3.75 | 0.075 | 正文价格表；视频／音频输入也列 0.75，缓存存储 1 美元／百万 tokens／小时；[模型页](https://aihubmix.com/model/gemini-3.6-flash) |

这里的模型页“支持视觉／视频”是平台声明，未进行实际媒体请求验证。OpenRouter Qwen3.7 Flash 明确接受文本、图片和视频，但只声明 JSON 输出、没有 JSON Schema 强制约束；不能把 JSON mode 当作严格 schema。AIHubMix 的 Qwen3.7 页说明误写为 Plus、最大输出字段前后也不一致；其价格可记为该站报价，能力细节需以原厂文档及实测为准。Gemini3.6 页标题仍显示旧的 1.5／7.5，与正文 0.75／3.75 不同，本表采用正文并保留这一差异。来源见相应行。

OpenRouter V4.1 Flash 目录明确区分周末与工作日：周末离峰价，工作日 UTC 01–04、06–10 为高峰，其余离峰。不要将这一规则自动套到其他站点；例如 AIHubMix 的阿里路由离峰窗口不同。[目录 API](https://openrouter.ai/api/v1/models)

### SiliconFlow 中国站：开源托管候选

单位为 **人民币／百万 tokens**；价格不是美元，也不是 Qwen 商业 Flash API 的同款价格。

| 精确 ID | 输入 | 输出 | 条件／能力证据 |
| --- | ---: | ---: | --- |
| `Qwen/Qwen3.5-35B-A3B` | 0.40 | 3.20 | 输入 <128K；≥128K 为 1.60／12.80；原生视觉模型候选 |
| `Qwen/Qwen3.5-27B` | 0.60 | 4.80 | 输入 <128K；≥128K 为 1.80／14.40 |
| `Qwen/Qwen3.5-122B-A10B` | 0.80 | 6.40 | 输入 <128K；≥128K 为 2.00／16.00 |
| `Qwen/Qwen3.6-35B-A3B` | 1.80 | 10.80 | 定价页当前值；模型目录抓取还出现 1.60／12.80，不假定两者相同 |
| `Qwen/Qwen3.8-27B` | 3.00 | 12.00 | 较新视觉模型候选；部署端视频参数与质量待实测 |
| `zai-org/GLM-4.5V` | 1.00 | 6.00 | 视觉专用候选 |

来源：[中国站价格](https://siliconflow.cn/pricing)、[中国站模型目录](https://www.siliconflow.cn/models)、[视觉模型说明](https://www.siliconflow.com/models/vision)。未给人民币价格强行按固定汇率转换；国际站单价不是中国站人民币报价的简单换汇。

视觉内容会计入 tokens。SiliconFlow 视频接口公布 `fps` 与 `max_frames`，帧数为 `min(fps × 时长, max_frames)`；视频输入能力仍按具体模型区分，不能因平台接受 `video_url` 就推定所有模型理解音轨。[多模态文档](https://docs.siliconflow.cn/docs/userguide/capabilities/multimodal-vision)

<a id="plans"></a>

## 8. Token Plan、Coding Plan、Agent Plan 与 Batch

百炼[个人版](https://help.aliyun.com/zh/model-studio/token-plan-personal-overview)当前月价限时¥39/139/499，原价¥60/180/600；每7天额度2500/10000/40000 Credits，不能将Credits直接当Tokens。仅允许兼容工具内交互使用，禁止自动化脚本、自定义后端和非交互批处理；个人版输入输出可用于服务改进与模型优化。

百炼[团队版](https://help.aliyun.com/zh/model-studio/token-plan-team-overview)“订阅前须知”也明确仅限兼容AI编程/智能体工具中的交互使用，禁止自动化脚本或应用后端；团队版不使用对话数据训练模型。不能因名称从Coding Plan升级到Token Plan或有API Key就推断可跑无人值守全量帖子任务。

本项目按量API/正式Batch是清晰可比基线。厂商订阅是否允许实际任务，应逐项核对具体计划条款；交互式分析少量帖子与脚本循环跑全库是不同使用方式。缓存、Batch、峰谷和订阅不能当作自动叠加的折扣。

OpenRouter Batch 已提供异步 24 小时处理和通常 50% token 折扣，但**当前只接受文本**，明确拒绝图像、音频、视频与文件内容块。可用于已经提取为文本的后续整理，不能直接给整批多模态帖子打五折。是否有该模型的 Batch 路由仍应查对应目录条目。[Batch 文档](https://openrouter.ai/docs/batch-quickstart)

四个平台公开 API 均面向程序化使用。厂商套餐则需要逐家判断，不能将所有 Coding／Token Plan 都视为禁止自动化，也不能将套餐月费视为不限用途的 API 余额。

### 厂商订阅套餐补充核查

| 厂商／套餐 | 当前核实的费用或额度 | 视觉与多模态权益 | 对本项目自动化整理的判断 |
| --- | --- | --- | --- |
| MiniMax Token Plan 国际站 | 文档价 Plus **$22/月**、Max **$55/月**、Ultra **$132/月**；5 小时滚动＋每周配额；营销订阅页仍列 $20／$50／$120，页面间冲突未解决 | 原 Coding Plan 扩展为共享多模态额度；包含 M3／M2.7／图像／语音，M3 原生图像与视频输入。Subscription Key 与按量 API Key 不通用 | **值得纳入个人多模态工作流候选**，不是仅代码文本套餐；官方称面向个人交互开发，对超高并发自动批任务动态限流，并建议生产使用 PAYG；未取得任意无人值守批处理不受限的承诺 |
| 智谱 GLM Coding Plan | 月费在本次公开抓取中未核实；Lite／Pro／Max 每 5 小时积分 2,000／12,000／28,000，每周 10,000／60,000／140,000；工作日 UTC+8 14–18 时外按半额积分消耗 | 官方包括图像视频理解 MCP；GLM-5.3-Flash（含视觉 MCP）使用相同积分系数。旧模型别名自动升级，不能视为固定模型版本 | **只在指定工具／产品环境享受额度**；支持 OpenClaw 但次级调度。自己写通用帖子脚本不在已确认覆盖范围；经支持的 Agent 处理仍需遵守其使用范围与配额 |
| Kimi 会员／Kimi Code | 会员页 Andante **¥49/月**、Moderato **¥99/月**、Allegretto **¥199/月**、Allegro **¥699/月**；Code 另有 5 小时和 7 天限制，并与会员池联动 | 本次权益页不足以核实 Coding endpoint 的原生图像／视频接口；不能把网页或开放平台视觉能力直接移植到套餐 endpoint | Code 权益用于个人开发，允许真实标识的第三方开发工具；通用后台批处理覆盖未确认。官方已预告会员与 Code 权益将拆分，订阅中用户不受影响，不能当作已经完成拆分 |
| 火山方舟 Coding Plan／Agent Plan | 活动页均显示**限时 ¥9.9 起**，未登录页各档正常价为“价格查询中”，不记录为常规月费。Agent Small 每月 20,000 燃料值，Medium／Large／Max 为 5／12.5／25 倍 | Agent Plan 明确有视觉、向量化、ASR 等模型／能力，支持 DeepSeek V4.1 Flash；不要将 Seedance 视频生成当作视频理解 | **Agent Plan 已超出纯编程定位**，宣传办公、内容、研究 Agent，支持 OpenClaw/Hermes；但本次未取得完整 API 调用限制、视觉输入契约与抵扣系数，不能确认任意独立批脚本均适用 |

来源：[MiniMax 当前套餐价格文档](https://platform.minimax.io/docs/guides/pricing-token-plan)、[MiniMax 概览](https://platform.minimax.io/docs/token-plan/intro)、[MiniMax 订阅页及流量 FAQ](https://platform.minimax.io/subscribe/token-plan)；[GLM 套餐与新积分规则](https://docs.bigmodel.cn/cn/coding-plan/overview)、[GLM 使用须知](https://docs.bigmodel.cn/cn/coding-plan/usage-notes)；[Kimi 会员价格](https://www.kimi.com/help/membership/membership-overview)、[Kimi Code 权益及拆分预告](https://www.kimi.com/help/kimi-code/benefits)、[Kimi Code 与开放平台区别](https://www.kimi.ai/zh-hans/help/kimi-code/faq)；[火山 Coding Plan](https://www.volcengine.com/activity/codingplan)、[火山 Agent Plan](https://www.volcengine.com/activity/agentplan)。

MiniMax 广告中的十几亿 tokens 是特定使用结构下的估算，不能直接换算成每月可处理多少张图片。其当前文档按各 endpoint 价格消耗共享用量，Credits 为 1,000 点 = $1、365 天有效、按 PAYG 目录价扣减；超额 Credits 与包月权益应分别算成本。营销页和文档月费差异也不能自行解释为税费。[积分定价](https://platform.minimax.io/docs/guides/pricing-token-plan)

MiniMax 的上述自动批任务限制来自**流量／公平使用 FAQ 的动态限流说明**，不是本次查到的“一切自动化均禁止”条款。当前 $22／$55／$132 文档覆盖 M3、M2.7、图像和语音等合资格资源，但明确不含 MiniMax H3、声音设计、快速克隆等少数模型；原生视觉输入与图片生成／语音生成共用额度不意味着它们的计量相同。火山 Agent Plan 是否允许自建脚本全库运行、燃料值如何对应本任务 tokens，仍是未核实项，不据营销定位直接推荐购买。[MiniMax 概览](https://platform.minimax.io/docs/token-plan/intro)、[流量 FAQ](https://platform.minimax.io/subscribe/token-plan)、[火山 Agent Plan](https://www.volcengine.com/activity/agentplan)

因此，本项目有两条待测方案：一次性清理归档时比较按量／异步 Batch 的实际成功帖成本；持续个人 Agent 工作流可额外测试 MiniMax Token Plan 或火山 Agent Plan 的可用额度与实际限流。**套餐资格、模态接口和有效成本是三个独立问题**，其中一个成立不能替代另外两个。

实际比较应固定版本、上游、区域、峰谷时段与媒体参数，再记录：

`成功帖成本 = (实际输入费 + 输出及思考费 + 缓存写读/存储费 + 重试费 + 平台/支付费) ÷ 成功且通过质量检查的帖子数`

“每百万 tokens 更便宜”不能直接推出“每篇帖子更便宜”：不同视觉 tokenizer、抽帧数量、推理长度与失败率都会改变分母和计费量。对于本项目，优先将 Qwen3.7 Flash、Qwen3.8 Flash、DeepSeek V4.1 Flash 纳入同一批图文样本；声音重要的视频还需独立的原生音视频候选。这个建议是研究判断，尚未做效果测试或选定服务商。

若只是一次处理当前两千多篇，先用按量小样估成本再与月费比较；若每天持续用Agent读资料、整理和检索，再评估包月共享额度。已有订阅且任务在权益范围内时，还应比较剩余额度的边际成本，而不是重复计入整个月费。

<a id="cost"></a>

## 9. 成本算例与计费口径

假设 **1,000 篇，每篇计费输入 4,000 token、计费输出 500 token**，无重试、无缓存，所有单次请求均落低档：

| 路线 | 这组假设计费量的费用 |
|---|---:|
| Qwen3.7 Flash 北京标准 | ¥1.20 |
| Qwen3.7 Flash 北京 Batch（符合接口条件） | ¥0.60 |
| Qwen3.8 Omni Flash 北京标准 | ¥4.55 |
| Seed2.0 Lite / Mini，全部按非音频输入计 | ¥4.20 / ¥1.80 |
| DeepSeek V4.1 Flash 离峰 / 高峰 | $0.90 / $1.80 |
| GPT-5.6 Luna 标准 | $1.40 |
| Gemini 3.1 Flash-Lite，全部按非音频输入计 | $1.75 |
| OpenRouter Qwen3.7 Flash | $0.185 模型费，另计平台费 |
| AIHubMix Qwen3.7 Flash 短档 | $0.1692 模型费，未核实支付附加费 |

这些只是 `4 × 输入单价 + 0.5 × 输出单价` 的算术对比。不能承诺同一千篇真实帖子只需这些费用：图片/音频/视频 token 不同，隐藏思考也可能使输出超出500。本库全视频时长尚不完整，故不以此表乘2.494伪装全库报价。

### 实际成本口径

先统一成每百万输入/输出 token，并分别列币种、地域和长度档。费用公式为：

`输入未缓存 × 输入价 + 缓存读取 × 缓存价 + 输出(含收费思考) × 输出价 + 独立音频/工具/存储费用`

上式各 token 项需除以一百万；若厂商按秒、图片张数或 credit 计费，则分别换算，不能硬套。缓存写入、批量折扣和峰谷折扣仅在供应商明确支持时计入；不同模型对同一张图片的 token 数可能不同，所以同一“每百万单价”不代表同一帖费用。

第三方还要比较充值实付、可用余额、平台服务费、供应商路由、失败重试和是否能传完整媒体。展示的“美元余额”不必然与充值人民币按实时汇率等值。这里只采用可公开核查的标准价，不把未验证的充值折扣算作确定优惠。

模型与平台的具体数值见本文官方与中转价格章节；没有公开价的单元格保留未核实，不用旧模型或同名网页聊天套餐补齐。

<a id="evaluation"></a>

## 10. 真实帖子评测与候选选择

我的研究建议是：**Qwen3.7 Flash 作普通图文的成本基线；Qwen3.8 Omni Flash 作有声视频的成本基线；DeepSeek V4.1 Flash 作图文效果对照；Seed Lite/Mini 260428 与 Gemini 作音画效果对照。** MiniMax-M3及其Token Plan适合进一步比较持续个人Agent工作流。首轮不必接入全部模型，更不必为每个题材建立一条模型链。若希望先用一家，千问目前同时有低价视觉和全模态候选；这只是接入简化的优势，不是已证明理解效果最佳。

先做 60–100 篇人工分层小样，不必先给全库运行一个分类模型。程序按已有 `type`、媒体数量、字幕有无、正文长度取样，再人工补足截图/教程/审美/音画依赖等类型。推荐至少比较：统一便宜多模态一次处理、字段分流后一次处理、首次完成后少量升级；如仍考虑独立路由器，再加为第四组。

用同一组任务与人工参考标签检查：重要信息遗漏、图中文字/数字准确性、音画证据、JSON 有效性、每帖实际账单、重试/升级比例和延迟。不同模型应比较可比的输入覆盖，不是只对齐名义 token 数。做低价路线的随机复核，才能发现它没有主动报告的遗漏。

本轮完成的是公开能力和价格研究、索引字段验证与候选处理方案；未完成模型质量排名、全库视频时长统计或付费小样测试。

除上述指标外，保留原讨论中的逐维度Macro-F1、`unknown/needs_new_tag`召回率及审美类人工满意度。固定标签定义、正反例、输出Schema及媒体覆盖范围；不能把厂商排行榜替代个人收藏的实际验收。

## 11. 尚未核实的事项

- 302.AI V4.1 Flash 的视觉请求契约及 `deepseek-chat` 别名是否固定；本次产品页只足以确认报价。
- 每个平台实际充值汇率、税费、支付处理费、当前账号限流；不能仅靠“美元余额”推导人民币支出。
- AIHubMix 与 SiliconFlow 页面的元信息／价格差异；付款前应以同一模型同一账户的调用账单小样确认。
- 视频与图像的实测质量、延迟、重试率及完整账单；本次没有上传本地资料。
