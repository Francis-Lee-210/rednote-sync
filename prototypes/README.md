# 原型目录

这里保存尚未进入正式项目的个人脚本和实验代码。列表导出脚本已经是成熟的个人使用基础，但尚未完成生产级端到端、全量完整性和恢复验证。

## Tampermonkey 脚本

`tampermonkey/` 当前包含三个小红书列表导出脚本：

- `xiaohongshu-collection-export.user.js`：收藏列表 Excel 导出。
- `xiaohongshu-like-export.user.js`：点赞列表 Excel 导出。
- `xiaohongshu-like-export-json.user.js`：点赞列表 JSON 导出。

脚本依赖已登录的小红书页面，只应在明确理解其读取范围后手动安装和运行。开始长期维护、补齐测试和发布流程后，再迁入 `projects/`。

## 本地敏感测试数据

`test-cookie.txt` 和 `xsec_token.txt` 按当前工作方式保留在本目录根部，但属于本机敏感数据，已由根 `.gitignore` 精确排除。不要提交、分享或在日志中输出它们；不再有效时应在来源端撤销或轮换。
