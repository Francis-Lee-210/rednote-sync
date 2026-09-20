# xsec_token 协议登录与搜索发现实验

状态：**2026-09-13 13:49 NZST，A–F 各一次身份复核均 HTTP 200 / API -100，按用户条件授权清空六份 Cookie；G 原值保留并标记“小号”（内部 ID `test_g`）。本轮未请求 G、搜索或详情，见 [复核与清理](protocol-method.md#2026-09-13-af-身份复核与条件清理)。G 的 9 月 12 日身份/搜索成功及 F 的先前身份成功、搜索 461 仍保留为历史证据，不代表本轮有效性。**
分类：**研究证据 / 实验工具**，服务于逆向目标 `xhs-xsec-token`。

> 本目录中的账号、频率、停止条件和在线访问授权只适用于本实验，不自动成为产品政策。

曾成功的方式是完整 Cookie + 本地请求签名 + 服务器确认非游客身份，不需要启动浏览器或扫码。E 在 9 月 9 日首次绑定、9 月 10 日 01:30 匹配复核均通过，但最新身份结果为 `-100`；D 在 9 月 9 日也返回 `-100`。可复核的结果、固定版本及限制统一见[登录实测说明](protocol-method.md#已验证的登录方式与结果)，后续研究边界见[token 研究顺序](protocol-method.md#登录成功后的-token-研究顺序)。

2026-09-11 账号登记更新：A–E 的 Cookie 标记为“可能已过期或失效”；F 私有保存后通过首次身份验证，并在另行获准的仅搜索运行中再次通过身份复核，但搜索硬停止。各账号状态统一维护于[当前账号登记状态](protocol-method.md#当前账号登记状态)，字段含义见 [Cookie 字段说明](cookie-fields.md)。登记新 Cookie 或身份通过不自动授权搜索、详情或重试。

2026-09-10 已完成客户端离线修复（`client_revision: 2`）：失败诊断保留白名单错误码/提示标志、UA 与签名平台字段同步、搜索默认 `filters` 补齐。106 项离线测试通过；随后授权的新尝试未通过身份门禁，不能据此认定搜索 461 已解决。细节见[修复与验证](protocol-method.md#2026-09-10-离线修复与验证)。

2026-09-11 新增 `--search-only`（`client_revision: 3`），全实验 119 项离线测试通过；请求与签名代码未改变。F 的实际搜索仍返回 HTTP 461，不能把测试通过当作在线恢复；版本与结果见[协议方法](protocol-method.md#仅搜索模式client_revision3)。

2026-09-12 G 对照未修改运行或签名代码，56 项相关离线测试及新输入 dry-run 通过后只执行一次身份与搜索。成功证明当前自有脚本在 G 的本次会话下可用，不证明旧 Cookie 的具体失效原因、ReaJason 在 G 下可用、详情可访问或 token 生成算法已掌握。

## 已知前提

既有研究已经观察到：裸 `note_id` 详情链接会出现软 404/461，不能作为可靠入口；`xsec_token` 更可能来自搜索、列表或其他发现上下文。因此本实验不再尝试“打开裸 ID 等待 token 出现”，而是验证：

```text
测试小号完整 Cookie → 本地请求签名 → HTTP 当前用户身份验证
→ HTTP 关键词搜索（第一页）→ 精确核对 note_id
→ 获取目标 xsec_token + 明确 source 来源 → HTTP 详情验证
```

## 研究问题

1. Cookie 能否在协议请求中获得可验证的非游客身份？E 的首次绑定及一次后续摘要匹配复核曾通过，但 E 最新身份请求返回 `-100`；F 的 2026-09-11 首次验证及一次摘要匹配复核均通过。未记录 Cookie 内容指纹，不能由此证明跨次输入完全相同、续期或长期稳定性；未验证账号与浏览器会话恢复仍需分别验证。
2. 搜索接口响应是否携带目标 `xsec_token`，返回的 source 与按搜索上下文设定的 source 有何区别？
3. 将目标访问材料交给只读详情接口，能否取得 ID 一致的正文或媒体结构？
4. 标题、正文关键词、推广帖、删除帖等样本的可发现性边界是什么？
5. 浏览器对照仍研究正常点击前后的 DOM、URL 和网络材料；其结果与协议路线分开记录。
6. token 首次出现在哪里，前端有无本地生成过程？请求签名 `x-s` 等与帖子访问材料 `xsec_token` 不同；从搜索响应取得 token 不能写成掌握了生成算法。

## 登录模型

- 只接受用户明确提供的自注册测试小号完整 Cookie。
- 真实账号文件必须位于 Git 工作区外，默认是 `~/.rednote_test_accounts/accounts.json`，权限必须为 `600`。
- 账号可带可选描述标签 `label`（非空、最多 64 字符、禁止控制字符）；例如 G 使用“小号”。选择账号仍用稳定 `account_id`，标签不参与身份绑定、路径或请求签名；已清空 Cookie 的历史条目不能再次联网，须另行提供新凭据。
- 默认 `--transport protocol`，直接向固定 API origin 发送携带完整 Cookie 和本地签名的请求，不启动 Chrome。省略 `--note-id` 时仅做一次身份检查。
- 只执行搜索时使用 `--note-id --search-only`：身份复核后搜索第一页，即使命中也不请求详情；见[仅搜索操作说明](runbook.md#3b-仅搜索不读详情)。
- 严格要求 API 成功、`guest is False`、稳定账号 ID；核对预期身份或既有协议绑定。首次显式 `--bind-identity` 只建立“本次观察到的身份”绑定，不声称已匹配未提供的预期 ID。
- 协议身份摘要位于 `data/protocol-identities/`，脱敏运行报告位于 `data/protocol-runs/`；两者均被 Git 忽略。不会生成浏览器身份 marker，也不把协议成功当成网页登录成功。
- 每次只使用输入 Cookie 快照，服务端 `Set-Cookie` 不回写或合并；不测试续期或浏览器持久化。签名依赖锁定为 `xhshow==0.2.0`，详见 [协议方法与来源](protocol-method.md)。
- 协议最多一次身份、一次搜索和一次详情请求；无重试、翻页、自动换账号或自动切浏览器。两条路线共享原子锁及同账号每日登录/capture 额度。

### 浏览器对照（显式选择 `--transport browser`）

- `login_profile.py` 使用系统 Chrome 和全新 staging profile：先打开匿名首页建立设备状态，再以精确 host 注入完整 Cookie并刷新；只有身份验证成功且 Chrome 正常关闭后，才替换正式 profile，失败候选不会破坏既有登录态。
- 浏览器路线的登录验证只信任页面自身发出的签名 `/api/sns/web/v2/user/me` 响应；协议路线独立发送本地签名请求。
- 验证成功后，只把账号 ID 的 SHA-256 摘要写入 `profiles/<account_id>/experiment-account.json`；不保存明文账号 ID。
- 后续脚本复用 profile，并再次验证身份摘要，防止 Cookie 串号。
- 总控脚本为登录、capture 和离线定位步骤设置独立总时限；超时会终止该步骤及其浏览器子进程，不会继续下一步。
- 登录与 capture 分别受每账号每日三次的原子尝试台账限制；失败尝试也计数，删除 capture 不会重置额度。

## 硬性边界

- 不读取 `prototypes/*`、现有 HAR、主账号 profile 或其他历史登录材料。
- 禁止购买、第三方、来源不明 Cookie；禁止账号密码自动输入和验证码绕过。
- 只处理 `config/notes.yaml` 中 `enabled: true`、`type: public` 的样本。
- 不点赞、收藏、关注、评论、发布或发送私信；出现验证码、461、403/429、登录失效或身份不匹配立即停止。
- Cookie 不进入命令行、日志、capture、报告或 Git；只有与目标 `note_id` 精确关联的 token/source 才允许存在于权限为 `600` 且被 Git 忽略的本地 capture 中，终端只显示 token 前缀和脱敏 URL。

## 主要脚本

- `run_experiment.py`：统一入口，默认协议路线；省略帖子 ID 仅验身份，`--search-only` 限于身份与搜索。浏览器对照需显式 `--transport browser`；默认 dry-run。
- `protocol_experiment.py` / `protocol_session.py`：独立协议编排及限于三个只读操作的 HTTP 客户端；通过身份门禁后才允许搜索和详情。
- `reajason_search.py`：独立的 ReaJason/xhs 搜索对照入口；调用固定 SDK 的身份和搜索方法，保留其六字段搜索正文，通过本地签名与受控 HTTPX 发送。最多一次身份复核、一次第一页搜索，不请求详情或保存 token；默认 dry-run，且要求已有身份绑定。
- `capability_probe.py`：另行授权的 F 常用只读能力检查；最多身份、本账号资料、本账号发帖列表第一页各一次 GET，不调用搜索/详情。要求既有身份绑定，共用锁、每日额度和硬停止条件；只记状态、结构和条数，不存用户/帖子内容，默认 dry-run。范围见 [F 能力检查授权](../scope.md#2026-09-13-f-常用只读功能检查授权)。
- `experiment_io.py`：两条路线共享的公开样本白名单校验与私有 capture 写入。
- `login_profile.py`：用仓库外 Cookie 注入并验证一个 profile；默认 dry-run。
- 可选 `--headed --manual-challenge-timeout-seconds N` 让操作者在可见 Chrome 中人工完成安全验证；脚本不自动处理或绕过挑战，完成后仍须通过签名身份验证。二维码/手机号登录会被拒绝，因为它会重新建立会话，不能证明原 Cookie 有效。
- `capture_visit.py`：搜索、精确匹配 `note_id`、点击并捕获 token 来源；默认 dry-run。
- `locate_token.py`：在私有 capture 中离线定位成对出现的 token/source；拒绝外部路径、符号链接和损坏记录。
- `tests/`：不联网验证安全边界、身份响应解析、进程清理、capture 脱敏、详情页成功判定和 locator 输入约束。

运行时只在被忽略的 `data/` 和 `profiles/` 内保存结果。协议路线只保存脱敏身份摘要、运行报告与目标 access material；浏览器路线另有正式/staging/历史 profile。本实验不提供任意请求 replay、任意 URL 验证或 token 命令行拼装。

完整流程见 [`runbook.md`](runbook.md)。所有在线脚本都需要同时提供 `--execute --yes`；本工具包不会因为配置了 Cookie 就自动联网。

## ReaJason/xhs 搜索对照

此入口不调用旧 `ProtocolSession.search()`，也不启动上游示例中的签名服务。使用本地固定 SDK checkout（提交 `f4b62d9f8e4078e631fc6e4ec8e430bc711ee9f0`），运行前检查版本及 SDK tracked 文件未被修改；缺少源码时拒绝执行。可选依赖锁定于 [requirements-reajason.txt](requirements-reajason.txt)，只在实验 `.venv` 中安装，不修改上游源码。

在本目录执行以下命令仅检查输入，不计算签名或访问平台：

```bash
.venv/bin/python scripts/reajason_search.py \
  --account-id test_f --note-id 6a9e62d2000000002902c012
```

仅当用户明确授权新的在线尝试时，才可增加 `--execute --yes`。查询来自已批准样本的 `search_queries[0]`，可用 `--query-index` 选择该样本中已有的关键词；不会遍历关键词、翻页或在失败后换号。该入口共享在线锁和每日台账，在签名前等待 policy 指定间隔，并保留 HTTP 风险状态与脱敏诊断。结果位于忽略的 `data/reajason-runs/`，分别记录身份通过、搜索 API 成功、返回条数和目标命中；不保存完整搜索结果、关键词、token 或用户身份。
