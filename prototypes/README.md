# 原型目录

这里保存尚未进入正式项目的个人脚本和实验代码。列表导出脚本已经是成熟的个人使用基础，但尚未完成生产级端到端、全量完整性和恢复验证。

## 外部审阅与离线验证

仓库只提供源码、说明和合成样例；文中 `资料库/` 与 `.local/` 路径说明本机运行布局，克隆仓库后不会带有这些私人输入。审阅无需运行下载器或安装用户脚本。先执行下面的合成回归，再按各目录 README 检查实现边界：

```sh
node --test prototypes/tampermonkey/tests/userscripts.test.mjs
python3 -B -m unittest discover -s prototypes/note-library -p 'test_*.py'
python3 -B -m unittest discover -s prototypes/llm-wiki-prep -p 'test_*.py'
```

2026-09-21 在 macOS、Node.js 26.0.0、Python 3.13.12 下验证：分别为 24、99、37 项通过。资料库测试在临时目录生成合成数据，音频测试需要 `ffmpeg` 与 `ffprobe`，HTTP 测试需要允许绑定 `127.0.0.1` 随机端口；受限环境中的 3 项 HTTP 测试在允许本机端口后单独通过。此结果不包含平台访问、真实导出完整性、真实浏览器和 OCR 运行验收。

保留目录之间的相对位置：`note-library/import_notion.py` 直接加载 `notion-stage3/audit_export.py`，不能单独拷贝资料库目录后运行 Notion 导入。

## Tampermonkey 脚本

`tampermonkey/` 当前包含三个小红书列表导出脚本：

- `xiaohongshu-collection-export.user.js`：收藏列表 Excel 导出。
- `xiaohongshu-like-export.user.js`：点赞列表 Excel 导出。
- `xiaohongshu-like-export-json.user.js`：点赞列表 JSON 导出。

脚本依赖已登录的小红书页面，只应在明确理解其读取范围后手动安装和运行。是否纳入正式实现及其目录位置，待对应维护与发布方案确认；`projects/` 当前是 Core 的独立包根。

本地回归从仓库根目录运行：

```bash
node --test prototypes/tampermonkey/tests/userscripts.test.mjs
```

测试执行完整脚本和导出回调，覆盖列表来源、延迟响应、首屏计数、坏条目、去重和滚动按钮；浏览器设施与 Excel 库使用合成替身，不访问平台。2026-09-14 的 24 项回归通过；真实 Tampermonkey 环境、全量列表和中断恢复仍需分别验收。

## 统一个人笔记资料库

[`note-library/`](note-library/README.md) 把 Notion 与 Galaxy 导出保存为统一的正文、元数据与媒体结构，资料位于项目内可见但被 Git 忽略的 `资料库/`。旧 `.local/notion-stage3/` 保留为指向原始归档新位置的兼容入口。知识库方案的选择与内容加工仍独立进行。

## Notion 归档与阶段三实验

[`notion-stage3/`](notion-stage3/README.md) 保存 Notion 导出审计、离线检索和本机 OCR 的实验脚本。真实帖子、媒体及派生结果已迁到 `资料库/原始来源/历史导出/`，旧 `.local/notion-stage3/` 仅为兼容符号链接。实验结果不代表已确定产品阶段三的实现方案。

## LLM Wiki 前置试验

[`llm-wiki-prep/`](llm-wiki-prep/README.md) 保存维护规则、合成样例、引用检查、增量影响比较及当前 Notion 归档的专用读取器。真实导入快照保存在 `.local/llm-wiki/`，尚未生成 Wiki。候选设计见 [LLM Wiki 探索](../docs/explorations/llm-wiki.md)。

## 本地敏感测试数据

`test-cookie.txt` 和 `xsec_token.txt` 按当前工作方式保留在本目录根部，但属于本机敏感数据，已由根 `.gitignore` 精确排除。不要提交、分享或在日志中输出它们；不再有效时应在来源端撤销或轮换。
