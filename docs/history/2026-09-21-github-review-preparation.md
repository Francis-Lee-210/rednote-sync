# 2026-09-21 GitHub 审阅准备与验证

状态：**日期化验证记录**。这是首次私有 GitHub 上传的准备记录，不是产品路线图或真实平台验收。当前进度以[路线图](../design/roadmap.md)为准，审阅入口见 [HANDOFF](../../HANDOFF.md#外部-agent-审阅)。

## 本次整理范围

保留原有 8 条 `main` 提交，在其后按 Core、userscripts、本地原型、研究证据及文档导航整理当前工作树。Core 上移到 `projects/` 的变动同时包含已有的离线内核重构，不能描述为纯目录移动。Notion、资料库与 Wiki 原型保留相邻目录依赖；没有删除私人资料、回滚既有实现或更改产品决定。

上传内容包括自有源码、合成样例、测试、实现契约和研究报告。真实帖子库、凭据、HAR、会话、浏览器 profile、第三方源码副本及运行材料保持忽略；没有把这些材料复制到上传集合。已补充 `.env`、私钥、storage state 和其他目录 HAR 的忽略规则，同时保留合成配置例子可见。

## 本机验证

环境：macOS、Node.js 26.0.0、npm 11.12.1、Python 3.13.12。Core 环境与安装契约见 [Core README](../../projects/README.md)，原型依赖与命令见[原型入口](../../prototypes/README.md#外部审阅与离线验证)。

| 检查 | 结果与边界 |
|---|---|
| Core `npm run check` | 类型、dist 一致性、静态与离线产物检查通过 |
| Core `npm test` | 167 项通过 |
| Core `npm run pack:check` | 35 个包文件、连续两次打包字节一致、8 个安装后 CLI 检查通过 |
| Core `npm run test:offline-demo` | 21 条命令通过，禁用网络权限，零警告 |
| Core `npm run test:readme-smoke` | zsh 下 7 条命令通过 |
| userscript 合成浏览器测试 | 24 项通过；未运行真实 Tampermonkey 页面 |
| note-library | 99 项通过；其中 3 项 loopback HTTP 测试在允许本机端口后单独通过 |
| LLM Wiki 前置原型 | 37 项通过，合成 lint 与 plan 通过 |
| Python 语法 | 原型的 24 个 Python 文件通过 Python 3.9 语法解析 |
| xsec 自有研究实验 | 10 个模块、141 项离线测试通过，包括固定 `xhshow 0.2.0` 的合成签名测试 |
| 文档与元数据 | 本地链接、文档锚点和 35 份研究元数据 JSON 检查通过 |
| 忽略规则 | 14 个私有路径探针被排除，6 个源码/合成样例探针保持可见；未发现已跟踪但应被忽略的文件 |

研究测试使用临时审阅器阻断网络、真实账号配置、私有运行材料及第三方源码目录。`config/policy.yaml` 是仓库内的策略配置，明确允许读取。未运行依赖第三方 checkout 的 `test_reajason_search`，也未启动 `test_page_classification` 的浏览器验证。上述 141 项结果不表示整个研究集成测试或线上能力通过。

已修复历史架构报告中的本机绝对链接；历史行号仍明确标为原行号。私人备份只保留路径说明，不要求克隆者取得这些文件。

## 上传内容检查

使用官方 Gitleaks 8.30.1 发布包，先校验其归档 SHA-256，再在本机扫描候选文件和已有 Git 提交历史；扫描输出启用完整脱敏。候选扫描命中两处、原有提交历史命中一处，逐项确认为合成测试值：

- `projects/scripts/offline-artifact-check-test.mjs` 中用于验证拒绝 JWT 形状的负例；旧历史位于 `projects/rednote-sync-core/` 下。
- `research/reverse/targets/xhs-xsec-token/experiment/tests/test_locator_hardening.py` 中用于验证输出脱敏的假 token。

另检查了访问参数、签名链接和 Cookie 赋值样式；命中项是合成样例或变量引用，未发现真实凭据。历史中保留的公开实验帖标识和研究证据不等同于私人帖子库或可用会话。此检查不是完整安全审计，也没有读取被忽略的真实凭据来比较值。

## 远端复核

已创建并推送到私有仓库 [Francis-Lee-210/rednote-sync](https://github.com/Francis-Lee-210/rednote-sync)，默认分支为 `main`。已有 8 条提交保留；只推送主分支，没有上传本机 Codex 内部快照引用。

从 GitHub 重新克隆初始上传提交 `45561229ecf13f82a881ee90ea2605661b03c4db`，286 个受控文件逐项 SHA-256 与本地提交一致，私有材料路径未进入仓库。克隆后按锁文件安装开发依赖，Core 的 check、167 项测试和 pack:check 再次通过。打包 SHA-256 与原工作区相同：`e6e63a631bb19e35e4dec93306e94c43849cedc869442b4949f5261a7cee71f4`。文档检查覆盖 84 个 Markdown/HTML 文件、838 个本地链接、161 个锚点和 35 份研究元数据。

新克隆中 userscripts 24 项、Wiki 37 项及 Python 3.13.12 下资料库 99 项通过。系统 Python 3.9.6 暴露一处测试兼容问题：`HTTPSHandler` 会延迟到连接层才创建默认 SSLContext，旧测试直接断言 Handler 的内部 context 已存在。提交 `438260e` 改为按 Handler 实际转交的配置构造连接，再验证有效 context 的证书和主机名检查；没有连接网络，也未修改运行时代码或放宽 TLS 要求。

修复后的 CDN 模块在 Python 3.9.6 和 3.13.12 下各 11 项通过。远端克隆拉取该提交后，系统 Python 3.9.6 的资料库完整 99 项通过，克隆工作树保持干净。其余代码与初始克隆验证时逐字节相同；本记录的后续提交仅补充验证证据。

GitHub CLI 可读取和克隆此私有仓库，但当前会话的 GitHub 插件读取新仓库返回 404。目标 GPT-6 Pro Chat 尚未完成访问验收：需要在该 Chat 使用的 GitHub 连接中确认此仓库已获授权，然后要求读取指定提交的源码与测试。上传、克隆和本机测试完成，不代表 Chat 已经读取或审阅仓库。
