# E-006 外部仓库/文章检索：是否存在 xsec_token 生成方式

- observed_at: 2026-08-20
- source_type: network (public web, no credentials)
- linked_workitem: n/a
- 检索面：GitHub 仓库搜索（xsec_token / xiaohongshu shield）、Sourcegraph 公开代码搜索（100 命中/16 仓库）、仓库树逐一核查、文章全文抓取。

## 结果矩阵（脱敏）

| 来源 | 类型 | 含生成代码 | 实际内容 |
|---|---|---|---|
| Cialle/RedCrack (master, 47 files) | 代码 | 否 | 仅 cookie 生成 + x-s/x-s-common/x-rap-param 等签名头；描述含 "xsec_token生成" 关键词但无对应文件 |
| RedNote/Xiaohongshu-Shield-Algorithm (shield_sdk.py 78KB) | 代码 | 否 | libxyass.so 的 Shield/x-mini 纯算还原；全文 0 处 xsec |
| RedNote/Xiaohongshu-API | 营销 README | 否 | 关键词堆砌，正文无 xsec |
| xhs996/xhs_spider | 营销页 | 不可证 | 无源码；DeepWiki 摘要的 "xsec_token Generator" 为 README 措辞派生 |
| xxxxspider/xhs_spider 等克隆 | 营销页 | 否 | 同质 |
| Sourcegraph 100 命中（XHS_RS_TOOLS、LittleCrawler、MediaCrawler 系、各 MCP） | 代码 | 否 | 全部为字段声明/透传/从 feed/search 结果读取 |
| excalibursssooo/xiaohongshu-search | 代码 | 否 | "旁路 300031" = 从页面链接收割 token 后按 source 复用，非生成 |
| blog.ovoii.io 猫捉老鼠（长文） | 文章 | 否 | 明确：xsec_token 是防盗链令牌，"服务端会校验它跟当前会话是不是对得上"；作者三条路线均复用 token，从不生成；防爬层级表把 xsec_token 列为第 1 层会话绑定 |
| zhihu p/619834492 | 文章 | 未验证 | 主题为 Shield 签名算法，无 xsec（403 无法全文核验） |

## 结论

截至 2026-08-20，**本次检索且可核验的来源中，未找到可复现的 `xsec_token` 生成/构造算法**。表中部分来源只有营销声明或无法取得全文，不能据此确认其实现，也不能把有限检索扩展为“公开领域不存在任何生成算法”。

所审代码的常见做法是从发现层取得 token 后透传，与本地所审 Web bundle 中只找到消费点的静态观察一致。这只描述这些版本和检索范围；没有证明 token 必须在服务端生成，也不足以判定后续生成机制研究不可能。后续固定版本证据见 [RedCrack 专项研究](../../../../projects/redcrack/review.md)，当前已验证的取得方式与未决问题见[协议实验方法](../experiment/protocol-method.md)。
