# AI 内容分类与 LLM Wiki Resources

状态：**学习资源**。本清单用于理解历史实现和候选 AI 方案，不是当前产品权威。

## Knowledge

- [本地：Rednote Sync Core README](../projects/rednote-sync-core/README.md)
  当前实现能力、支持矩阵、离线命令和历史实施 Stage 4 边界。用于判断“现在能运行什么”。
- [本地：历史实施 Stage 3 实现规格](../projects/rednote-sync-core/docs/sync-core.md)
  3A、3B、3C 的契约、测试证据和在线待验证事实。用于判断“为什么离线完成仍不等于真实账号同步”。
- [本地：Obsidian 客户端逆向报告](../research/reverse/targets/rednote2obsidian/report.md)
  当前 Obsidian 样本的接口、签名、分页、数据模型和 Markdown 规则。用于追溯历史实施 Stage 1 结论。
- [本地：Notion 客户端逆向报告](../research/reverse/targets/rednote2notion/report.md)
  当前 Notion 扩展的组件、调度、Notion 写入和凭据风险。用于追溯历史实施 Stage 2 结论。

- [Andrej Karpathy: LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
  LLM Wiki 原始构想。用于区分不可变原始材料、LLM 维护的知识层，以及后加的检索层。
- [OpenAI: Embeddings](https://platform.openai.com/docs/guides/embeddings)
  官方说明文本向量的用途。用于理解相似内容聚类、近义标签发现和后续语义检索；向量不是事实源。
- [OpenAI: Images and vision](https://platform.openai.com/docs/guides/images-vision)
  官方图像输入指南。用于理解图文帖子和视频关键帧如何进入多模态分析。
- [OpenAI: Speech to text](https://platform.openai.com/docs/guides/speech-to-text)
  官方语音转写指南。用于理解短视频语音如何转换成可分类文本。
- [Bendale & Boult: Towards Open World Recognition (CVPR 2015)](https://openaccess.thecvf.com/content_cvpr_2015/html/Bendale_Towards_Open_World_2015_CVPR_paper.html)
  开放世界分类的基础论文。用于理解系统为什么必须识别“现有类别之外”的内容，并在人工提供新标签后增量扩展类别。

## Wisdom (Communities)

- 暂不指定社区。
  当前任务是先用个人真实收藏验证分类流程；等出现稳定的分类误差样本后，再寻找知识管理或多模态检索社区进行针对性讨论。

## Gaps

- 尚未用用户自己的真实帖子比较纯文本、图文和视频分类质量。
- 尚未测量 2000 条内容的实际模态比例、平均视频时长、处理成本和人工复核量。
