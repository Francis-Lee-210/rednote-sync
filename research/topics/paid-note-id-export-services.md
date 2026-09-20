# 只凭 note_id 的付费批量帖子导出平台

状态：**供应商研究证据与候选建议** · 核查日期：2026-09-14

本专题服务于第二阶段“帖子导出”：已有帖子 ID 清单，希望由付费平台获取正文及媒体，不自行维护小红书会话和采集基础设施。它不改变[产品权威](../../docs/README.md)或[当前路线图](../../docs/design/roadmap.md)，也不表示已经接入 Core。

## 范围与证据

- 三个独立 subagents 分别研究 TikHub、中文 API 平台、批量网页平台；另一个独立 subagent 复核输入契约、价格和成品边界，根代理核对并整合。
- 依据核查日的供应商官网、接口参数、定价和存储说明；商业网页没有固定 commit，价格和可用性均可能改变。供应商自己的稳定性、原画和成功率宣传不作为实测结论。
- 本次没有注册、登录、充值、执行 Actor、调用采集接口或读取 Cookie、API key、HAR、私人帖子清单。只引用仓库内已经脱敏的既有实验记录。
- `ID-only` 指内容定位只需 ID；仍需要供应商账号或其 API key。它不表示匿名免费、不表示能取回私密/删除内容，也不证明不同供应商拥有独立上游。
- **截至本次 2026-09-14 核查，本仓库引用的实测只有 JustOneAPI 的一篇图文、一篇视频。** 本次对其他平台的判断来自公开文档，未拿同一批样本比较成功率。旧实验与自建路线背景见[协议实验记录](../reverse/targets/xhs-xsec-token/experiment/protocol-method.md#2026-09-12-双样本详情实测)、[帖子导出机制研究](note-local-export-paths.md)。后续 Notion／Galaxy 本地落盘实现见 [note-library 工具说明](../../prototypes/note-library/README.md)，不回写为本次供应商比较的实测结论。

## 结论与费用对照

优先试 Rnote 的批量工具是否能交付所需成品；若可以接受由本地程序批量请求和下载，Galaxy、TikHub 都值得小样本比较。Apify / Zen 的文档覆盖结构化数据与实际媒体文件，但费用项目更多。JustOneAPI 保留为已有成功证据的基线，不必先放弃。

下面 **2,000 / 2,500 帖只是预算情景，不是重新盘点后的库存**。假设已去重、已知图文/视频类型、每帖一次成功详情请求；不含额外请求、评论、支付/汇兑/税费。美元与人民币分别列示，不作汇率换算。API 详情费不等于完整归档交付价。

| 平台 | ID-only 与批量形式 | 公开单价及限定 | 2,000 / 2,500 帖基础费 | 本地成品边界 |
| --- | --- | --- | --- | --- |
| [Rnote](https://www.rnote.dev/) | ID + 平台 key；有网页批量工具，每批最多 200 条，图文/视频分批 | 官网宣传 **$0.01 USD/次**；实际端点价待账户页确认 | 条件式 **$20 / $25 USD** | 媒体 ZIP；正文/JSON 是否随包未知 |
| [Galaxy](https://api.galaxysapi.com/) | ID + 平台 key；API 逐帖，网页任意 ID 清单批量未证实 | 普通图文 **¥0.03**，视频 **¥0.04/次** | **¥60–80 / ¥75–100** | JSON；媒体字段与实际下载完整性待试 |
| [TikHub App V2](https://tikhub.io/xiaohongshu-api) | ID + 平台 key；API 逐帖，无 ID 数组接口 | **$0.01 USD/次**；未知类型的视频可能需两次调用 | **$20 / $25 USD** | JSON + 图片/视频地址；仍需下载和整理 |
| [Apify / Zen Studio](https://apify.com/zen-studio/rednote-note-detail-scraper/pricing) | ID 数组 + Apify 账号；网页运行 Actor | Starter 详情 **$8.99/千条**；实际媒体文件另计 | 详情事件 **$17.98 / $22.48 USD**；另计其他事件，最低付费计划 $19/月 | 数据导出 + 云端媒体 ZIP 分开下载；非现成逐帖 Markdown |
| [AIDATA](https://aidata.vip/zh-cn/api/pricing) | ID + 平台 key；图文视频通用 API，`xsec_token` 可选 | 新请求 **$0.05 USD/次**，不能按低价缓存估首轮全量 | **$100 / $125 USD** | JSON/Markdown + 可用媒体地址；文件仍需下载 |
| JustOneAPI，既有对照 | ID + 平台 token；V1 图文、V6 视频 | **¥0.15/次**，2026-09-12 本账号价格快照，非本次重查价 | **¥300 / ¥375** | 既有双样本已保存正文和真实媒体；不是全库成功证明 |

各行参数、计费和限制的直接证据见下文；JustOneAPI 价格来源为[此前控制台观察](../reverse/targets/xhs-xsec-token/experiment/protocol-method.md#2026-09-12-控制台核验与双样本试下载准备)。

## Rnote：最值得先验证的免代码批量工具

- 获取：`GET https://rnote.dev/api/v2/crawler/note/image` 或 `/note/video`，业务必填只有 `note_id`，鉴权为供应商 `X-API-Key`；[FAQ](https://www.rnote.dev/faq)声明无需绑定或提供小红书账号、Cookie。[接口文档](https://www.rnote.dev/docs/guide)
- 批量与保存：[官方批量教程](https://rnote.dev/en/blog/rednote-xiaohongshu-batch-media-download-tool)明确接受 ID 或链接，一行一个，最多 200 条，同批保持图文或视频一种类型，生成媒体 ZIP。2,000 / 2,500 条至少需要 10 / 13 批，按类型拆分后可能更多。[工具入口](https://rnote.dev/admin/tools/batch-media)需要登录，本次没有操作。
- 成品缺口：批量文档只证明图片/视频 ZIP，没有明确承诺正文、JSON、逐帖目录规则或失败清单。详情 API 可取得文本数据，但不能因此推定它们已经随 ZIP 保存；也尚未验证 Live Photo、全部视频变体和原图完整性。
- 费用：[首页](https://www.rnote.dev/)宣传 $0.01/次；[专门价表](https://rnote.dev/pricing)端点数据未能公开读取，应在付款前确认图文/视频实际价和工具有无额外费用。无月费，单笔到账 $5 起；银行卡/钱包手续费概要写约 2.9% + $0.30，但页面步骤另写 1%，实际以结算页为准。
- 失败与试用：官网称仅成功 HTTP 2xx 扣费；响应另有 `success`、`billed`，仍需核对空结果实际账单。邮箱验证赠送余额，金额未知；FAQ 称余额不过期。数据接口具体速率上限未确认，免费账户查询的 30 次/分钟不是帖子接口配额。[定价规则](https://rnote.dev/pricing)、[FAQ](https://www.rnote.dev/faq)、[响应说明](https://www.rnote.dev/docs/guide)

## Galaxy：低价 API 候选，先核对媒体和充值条件

官方[接口与计费文档](https://api.galaxysapi.com/)给出：`GET /api/get_note_detail` 图文 ¥0.03，`GET /api/get_note_detail_video` 视频 ¥0.04；二者只要求 `note_id` 与供应商 `Authorization` key。混合清单详情费为 `0.03 × 图文数 + 0.04 × 视频数`。另列两个 rNote 命名路线 ¥0.09/次，不能将它们与低价路线混算，也不能仅凭名称判断上游是谁。

同一文档称失败/异常不收费，但没有完整定义空数据成功如何处理；公开返回样例未展开，媒体下载字段和完整性尚待实测。连续超过一个月未使用的账号会清理且不可找回；充值需联系管理员，最低充值和试用额度未知。建议只在确认这些条件后小额试用，不囤余额。某个另列的 V1 路线还提示类型传错可能返回其他数据，更应逐项核对返回 ID，不能只看请求成功。[官方说明](https://api.galaxysapi.com/)

尚未证实其网页能导入整批任意 ID 并交付正文和媒体包；本轮按 API 候选评价，不按完整免代码归档工具评价。

## TikHub：接口说明较完整，留意视频探测和空结果收费

获取路径为 `https://api.tikhub.io/api/v1/xiaohongshu/app_v2/get_image_note_detail` 与 `get_video_note_detail`，均可只传 `note_id` 和 TikHub Bearer key。图文返回正文/图片，视频返回视频播放地址等；图文接口用于视频时不提供播放地址，视频接口不能代替图文接口。类型未知时官方建议先图文后判断，因此 V 个视频可能使 N 帖产生 N + V 次调用。[图文参数](https://docs.tikhub.io/420136391e0)、[视频参数与类型限制](https://docs.tikhub.io/420136392e0)

[小红书产品页](https://tikhub.io/xiaohongshu-api)明确 $0.01/次、默认 10 RPS、逐帖请求；不能套用别的平台 $0.001 起价。新客 $0.05 约相当于 5 次小红书调用，而非 50 次，部分路由能否使用赠送余额要核对。[入门说明](https://tikhub.io/getting-started)没有给出本次可确认的个人最低充值额或余额有效期。

两个详情接口明确提醒：无效 ID 或上游异常仍可能作为正常响应返回并收费，不能说“取不到内容就不扣费”。重复详情调用仍收费；`cache_url` 仅免费重开已返回的那份响应，保留 24 小时，不是重新取帖免单。媒体实际下载、文件组织与重跑清单仍由使用方负责。[接口计费提醒](https://docs.tikhub.io/420136391e0)、[缓存语义](https://tikhub.io/xiaohongshu-api)

本次只推荐测试 App V2。Web V3 是否仍维护在[专项指南](https://blog.tikhub.io/zh/article/7)与产品页之间有冲突，未以旧路由作可用性承诺。

## Apify / Zen Studio：网页批量输入，数据和媒体分开交付

这是 Apify 市场的**社区维护 Actor**，并非 Apify 自营小红书接口。当前[输入 schema](https://apify.com/zen-studio/rednote-note-detail-scraper/input-schema)明确 `noteUrls` 数组接受裸 ID，无需小红书 Cookie；README 部分旧参数说明仍要求带 token URL，当前格式表与 FAQ 则支持裸 ID。这是待实测的文档不一致，不应隐藏。[产品说明](https://apify.com/zen-studio/rednote-note-detail-scraper)

可导出正文等 Dataset 数据；打开默认关闭的 `downloadVideos`、`downloadImages` 等选项后，实际 MP4、图片保存到云端 key-value store，数据行记录对应文件链接。Apify 提供 KV 全部下载及 [ZIP 下载接口](https://docs.apify.com/api/v2/key-value-store-records-get)，因此可再取回本机；结构化 JSON/CSV 等另行导出。尚未证明一键形成每帖 Markdown 文件夹或自动保存 Live Photo 动态部分。[输入与下载选项](https://apify.com/zen-studio/rednote-note-detail-scraper/input-schema)、[存储说明](https://docs.apify.com/storage/key-value-store)

[Actor 的价格页](https://apify.com/zen-studio/rednote-note-detail-scraper/pricing)区分套餐：Free 详情 $9.99/千条；Starter/Bronze $8.99/千条，另收实际视频 $4.49/千文件、图片/封面 $1.79/千文件、Dataset result $0.01/千条，以及每 GB 启动内存 $0.05（最低一个启动事件）。图片费按张，不按帖子。以 Starter 为例，N 个详情、R 条 result、V 个视频、I 张图片/封面、E 个启动事件的事件费约为：

`0.00899 × N + 0.00001 × R + 0.00449 × V + 0.00179 × I + 0.05 × E` 美元。

2,000 帖若每帖一条 result、一个最低启动事件且不下载媒体，约 $18.05；媒体另算。[平台 Starter](https://apify.com/pricing)是 $19/月，**已含 $19 使用额度**，不可再把这 $19 重复相加。Free 只有 $5/月，耗尽后停止，不能假设免费计划可直接支付超额费跑完同周期全量。Actor 运行期的平台用量包含在事件价内，运行结束后保存/读取/下载仍可能产生平台用量；一次性任务还需处理订阅续费和数据保留。

## AIDATA 与其他备选

[AIDATA 统一详情](https://aidata.vip/zh-cn/api/endpoints/xiaohongshu/note/detail)为 `GET /api/v2/data/xiaohongshu/note/detail`，使用供应商 Bearer key；`note_id` 可定位，`xsec_token` 明确可选且无 token 也可请求。返回正文和可用媒体 URL，支持 JSON/Markdown；这些不是媒体字节。当前[价表](https://aidata.vip/zh-cn/api/pricing)为新请求 $0.05、缓存 $0.0005、TTL 一小时，首轮全量不能假定命中缓存。未确认批量 ZIP、最低充值、完整失败计费和试用政策，暂作备用。

- [Apify / Atomus](https://apify.com/atomus/xiaohongshu-scraper/input-schema)也接受裸 ID 数组，但[详情价](https://apify.com/atomus/xiaohongshu-scraper/pricing)普通套餐 $40/千条，2,000 / 2,500 帖仅详情 $80 / $100；未查到实际媒体自动保存选项，优先级低于 Zen。
- SpiderHubs 的 [App V2 图文](https://www.spiderhubs.com/api-support/xhs-image-note-detail)与[视频](https://www.spiderhubs.com/api-support/xhs-video-note-detail)只需 ID + 供应商 key，各 1 积分；[公开定价](https://www.spiderhubs.com/pricing)不足以确定每积分货币成本。[网页产品](https://www.spiderhubs.com/rednote-scraper)主要展示按作者采集，任意 ID 清单批量导出及媒体 ZIP 未证实，因此未列入费用主表。

## JustOneAPI 基线与本地交付验收

既有[双样本实测](../reverse/targets/xhs-xsec-token/experiment/protocol-method.md#2026-09-12-双样本详情实测)已经使用供应商 token + ID，取得一篇图文、一篇视频；8 张图片下载解码成功，视频也完成下载和解码检查。没有使用小红书 Cookie 或帖子 xsec token。这能证明两个样本的链路，不证明全库、长期媒体链接或供应商稳定性。

官方 [V1](https://docs.justoneapi.com/zh/api/xiaohongshu-rednote/note-details-v1)与 [V6](https://docs.justoneapi.com/zh/api/xiaohongshu-rednote/note-details-v6)仍分别面向图文和视频；[使用指南](https://docs.justoneapi.com/zh/usage)按业务 `code=0` 计费，价格须登录查看。因此本报告使用 09-12 的 ¥0.15 快照作历史对照，未承诺当前账号价格或剩余额度。

建议在任何全量付款前，先用同一组约 10–20 个 ID 验证候选；这是下一步建议，本次未执行：

1. 图文、多图、视频、旧帖和曾难以检索的帖都要覆盖；对照返回 ID、正文与媒体数量，不以 HTTP 200 或任务显示成功代替内容验收。
2. 真正保存并打开图片/视频，检查数量、顺序和文件可读性；只有 CDN URL 不算本地归档完成。
3. 对照平台账单，记录空内容、重试、媒体下载的收费；有现成类型就直接分流，避免为视频重复探测付费。
4. 下载一份样例 ZIP，确认正文/JSON、媒体和失败清单分别在哪里，能否与 note_id 对应；缺文本或状态记录时，询问供应商能否一并交付。
5. 全量前去重，分批保存成功项与失败项，只重跑失败差集。使用真实完整保存帖数计算实际单帖成本。

付费平台可减少自建采集工作，但仍会看到提交的 ID 清单；无需提交 Cookie 不等于零隐私风险。不要把平台 API key 写入研究文档或提交到 Git。是否采购、采购预算、是否允许上传清单及接入 Core，均留待用户确认。
