# xsec_token 协议登录与搜索发现操作手册

状态：**2026-09-11 19:52 NZST，F 的获准仅搜索运行中，身份复核通过（HTTP 200 / API 0，摘要匹配），搜索返回 HTTP 461 且带验证相关响应头，已停止；无目标 token、无详情请求。A–E 的既有 Cookie 可能已过期或失效。以下在线命令是操作说明，不是立即重跑许可；账号当前状态见[登记表](protocol-method.md#当前账号登记状态)。**

已成功的方式、固定版本和证据边界见[协议登录实测说明](protocol-method.md#已验证的登录方式与结果)。首次绑定和完整链路示例保留 `test_e`，仅搜索示例使用 `test_f`；已有绑定时应省略 `--bind-identity`，不要仅为重现成功输出而重复在线尝试。

本手册只覆盖用户明确提供的自注册测试小号 Cookie。每次在线操作限一个账号、一个已批准公开样本；不使用主账号、`prototypes/*`、历史 HAR 或来源不明 Cookie。

## 0. 准备本地环境

```bash
bash research/reverse/targets/xhs-xsec-token/experiment/scripts/setup_env.sh
source research/reverse/targets/xhs-xsec-token/experiment/.venv/bin/activate
python -m unittest discover \
  -s research/reverse/targets/xhs-xsec-token/experiment/tests -v
```

安装依赖会访问 Python 软件分发服务，但不会登录小红书。默认 HTTP 协议路线无需浏览器；只有显式浏览器对照需要系统 Google Chrome，不额外下载 Chromium。

## 1. 在仓库外保存测试账号 Cookie

```bash
mkdir -p ~/.rednote_test_accounts
chmod 700 ~/.rednote_test_accounts
cp -n research/reverse/targets/xhs-xsec-token/experiment/config/accounts.example.json \
  ~/.rednote_test_accounts/accounts.json
chmod 600 ~/.rednote_test_accounts/accounts.json
```

为每个测试账号填写：

- 唯一 `account_id`；
- `source: self_registered`；
- 从该账号正常浏览器会话复制的**完整 Cookie header**；
- 协议路线无需 `profile_dir`；浏览器对照才要求独立的 `profiles/<account_id>`，已有配置无需删除该字段；
- 可选 `user_agent`：协议路线只接受可识别的 Windows/macOS 桌面 Chrome/Edge 格式，并同步签名平台字段；未知、移动端、格式非法或冲突值在联网前拒绝。留空保留锁定库的默认配置，不代表复原 Cookie 来源设备。

`cp -n` 只在目标不存在时复制模板，已有账号配置应保留。Cookie 只写入这个仓库外文件，不放进 shell 参数、聊天、日志或 Git。更新 Cookie 时必须整体替换，不能只替换 `web_session`。

## 2. 默认：协议 Cookie 身份验证

先只检查登录身份；不需要 notes 文件或帖子 ID：

```bash
python research/reverse/targets/xhs-xsec-token/experiment/scripts/run_experiment.py \
  --transport protocol \
  --accounts-file ~/.rednote_test_accounts/accounts.json \
  --account-id test_e \
  --bind-identity
```

这会读取本地账号配置，但不发送 Cookie、不打开浏览器、不写运行状态。确认输入后执行一次身份探针：

```bash
python research/reverse/targets/xhs-xsec-token/experiment/scripts/run_experiment.py \
  --transport protocol \
  --accounts-file ~/.rednote_test_accounts/accounts.json \
  --account-id test_e \
  --bind-identity \
  --execute --yes
```

客户端把完整 Cookie 和本地签名附到固定的 `edith.xiaohongshu.com` 当前用户 API 请求中。必须获得明确成功、`guest is False` 和稳定 ID；有预期/既有协议绑定时摘要必须匹配。首次显式绑定只表明操作者接受本次观察到的身份映射。成功返回 `PROTOCOL_IDENTITY_VERIFIED`，不代表 Chrome 已登录。

协议身份绑定保存在 `data/protocol-identities/`，报告保存在 `data/protocol-runs/`。后续相同账号可去掉 `--bind-identity`；浏览器 marker 不能替代协议身份验证。401、`-100`、签名错误、非 JSON、重定向或挑战分别报告，不把所有失败统称 Cookie 过期。协议失败后不会自动启动浏览器或要求扫码。

如只看到 `config error`，先检查依赖、外部账号文件权限/格式及必填的 `a1`、`web_session`；缺少字段时还没有进行在线验证。

`client_revision: 2` 引入脱敏失败诊断，当前版本 `3` 另增加仅搜索模式及搜索阶段布尔值。失败时查看 `requests[]` 中的 `http_status`、可用的 `api_code` 和 `diagnostics`：后者仅含验证 header 是否存在、响应类型/读取状态与固定文字提示标志。字段缺失不代表错误码为 `0`；提示标志不是已确认根因。HTTP 461 等仍停止，不会因为成功保存诊断而继续请求。完整字段定义和合成示例见[失败诊断说明](protocol-method.md#失败诊断client_revision2)。旧报告无法补回遗漏的原始响应，不要为补日志自行重跑。

## 2b. 浏览器对照：Cookie 注入 profile

`login_profile.py` 会在 `experiment/profiles/` 下创建一次性 staging profile；该目录被 Git 忽略。候选 Cookie 验证成功且 Chrome 正常关闭后，staging 才会替换 `profiles/<account_id>/`，旧 profile 会保留为本地历史目录。验证失败不会清空或覆盖正式 profile。

首次使用某个账号时，必须显式确认“这个 Cookie 就绑定到这个 `account_id`”：

先检查计划，不联网：

```bash
python research/reverse/targets/xhs-xsec-token/experiment/scripts/login_profile.py \
  --accounts-file ~/.rednote_test_accounts/accounts.json \
  --account-id test_a \
  --bind-identity
```

确认账号和 profile 后，才执行一次 Cookie 注入与只读身份验证：

```bash
python research/reverse/targets/xhs-xsec-token/experiment/scripts/login_profile.py \
  --accounts-file ~/.rednote_test_accounts/accounts.json \
  --account-id test_a \
  --bind-identity \
  --execute --yes
```

脚本使用系统 Chrome，先在全新 staging profile 打开匿名首页建立设备状态，再以 `https://www.xiaohongshu.com/` 精确 host 注入完整 Cookie并刷新。验证只接受该 HTTPS origin 上页面 XHR/fetch 发出的、带签名头的 `/api/sns/web/v2/user/me` JSON 响应；成功 schema、非 guest 和稳定账号 ID 必须同时成立，平台账号 ID 只保存为 SHA-256 身份摘要。任一 HTTP 403/429/461、无可信身份响应、失效身份或页面上实际可见的 CAPTCHA/安全挑战都会停止；仅后台加载 HTTP 200 登录组件资源不会被误判为失败。

如果页面显示需要人工完成的 CAPTCHA/安全验证，可显式使用 headed 人工等待模式：

```bash
python research/reverse/targets/xhs-xsec-token/experiment/scripts/login_profile.py \
  --accounts-file ~/.rednote_test_accounts/accounts.json \
  --account-id test_a \
  --bind-identity \
  --headed --manual-challenge-timeout-seconds 300 \
  --execute --yes
```

该模式只保持 Chrome 窗口最多五分钟，等待操作者亲自完成页面验证；脚本不会识别、点击、拖动或绕过挑战。挑战消失后，脚本重新加载批准的首页并再次执行签名身份验证。二维码/手机号登录属于重新建立会话而非验证现有 Cookie，脚本会直接拒绝，不能借此把扫码登录误记为 Cookie 登录成功。HTTP 403/429/461 仍会立即停止；超时、挑战仍存在或身份无法确认时不会保存候选 profile。

登录和 capture 各自每账号每日最多三次，额度写入权限为 `600` 的原子台账；失败尝试也计数。不要通过删除 capture、切换终端或重复直接调用登录脚本规避冷却限制。

绑定成功后，后续运行不再需要 `--bind-identity`。需要更新 Cookie 时重复本步骤；若新 Cookie 的身份与 profile 已绑定身份不同，脚本拒绝覆盖，避免串号。

## 3. 配置允许搜索的公开样本

```bash
cp -n research/reverse/targets/xhs-xsec-token/experiment/config/notes.example.yaml \
  research/reverse/targets/xhs-xsec-token/experiment/config/notes.yaml
```

每条样本必须包含：

```yaml
- note_id: "EXPECTED_NOTE_ID"
  type: public
  search_queries:
    - "完整标题或足以重发现的关键词"
    - "可选正文关键词"
  enabled: true
```

`note_id` 只用于核对搜索结果，脚本不会拼装或打开裸 ID 链接。推广帖、删除帖或无法搜索命中的帖子应记录为不可发现，不连续重试。

`config/notes.yaml` 已被 Git 忽略，不应强制添加或提交。脚本拒绝 config 目录外的 notes 文件、重复/畸形条目、超过三个或超过 200 字符的搜索词，并会验证整个文件而非只验证选中的条目。

## 3b. 仅搜索（不读详情）

只获准搜索时必须加 `--search-only`。下例使用已有协议身份绑定的 F，不重新首次绑定；先 dry-run：

```bash
python research/reverse/targets/xhs-xsec-token/experiment/scripts/run_experiment.py \
  --transport protocol \
  --accounts-file ~/.rednote_test_accounts/accounts.json \
  --account-id test_f \
  --note-id EXPECTED_NOTE_ID \
  --search-only
```

只有本次账号、样本和在线请求已获明确授权时才追加 `--execute --yes`。先复核身份，再用白名单样本的第一个搜索词请求第一页；最多两个 HTTP 请求，不翻页、不重试，也不请求详情。目标访问材料取得后返回 `PROTOCOL_SEARCH_VERIFIED`，只写入已忽略的私有 capture。搜索 API 成功但目标未命中时仍停止，不能改词再试或把结果当作全站不存在。结果字段与版本边界见[仅搜索模式](protocol-method.md#仅搜索模式client_revision3)。

## 4. 协议单帖发现与详情验证

2026-09-10 01:30 此链曾在 E 身份复核通过后遇到搜索 HTTP 461；17:19 按用户要求使用修复版再试，身份接口便返回 `-100`。两次均未执行详情。2026-09-11 F 的独立身份探针通过后，用户另行批准第 3b 节的仅搜索运行；身份复核通过，但搜索仍 HTTP 461，详情未请求。后续须单独确认账号、批准样本和可执行条件，并满足原有预算与停止规则。以下 E 命令保留为操作示例，不代表其当前 Cookie 可用，也不是继续 F 或读取详情的授权。

样本列入第 3 节白名单、已有 E 协议身份绑定时，可先 dry-run（不需要重新绑定）：

```bash
python research/reverse/targets/xhs-xsec-token/experiment/scripts/run_experiment.py \
  --transport protocol \
  --accounts-file ~/.rednote_test_accounts/accounts.json \
  --account-id test_e \
  --note-id EXPECTED_NOTE_ID
```

执行时追加 `--execute --yes`。这次仍先复核协议身份，再请求一次关键词搜索第一页；只有精确匹配帖子 ID 并取得 token 后，才请求其详情。最多三次 HTTP 请求，不翻页、不重试、不正常点击网页，也不访问裸 ID 链接。

`client_revision: 2` 的搜索参数已补齐固定参考的五项默认 `filters`，保持综合排序、不限类型、第一页 20 项；没有增加搜索前置或推荐请求。该改动已离线验证，不能据此保证服务端接受。

如搜索响应不带 source，客户端显式使用搜索上下文 `pc_search`，capture 标记 `source_origin=search_context`；它不能作为“服务端返回 source”的证据。只有取得 ID 匹配的详情正文/媒体结构才返回 `PROTOCOL_COMPLETE`。没有命中仅表示本次关键词第一页未发现，不代表帖子不存在。

协议各类命令共用浏览器路线的每日尝试额度；身份尝试最多三次，搜索前另占一次 capture。所有请求固定携带同一份输入 Cookie，响应 `Set-Cookie` 不合并、不保存。方法、限制、来源及结果含义见 [protocol-method.md](protocol-method.md)。

本节通过只证明能取得并使用搜索下发的访问材料；生成机制需要另做[数据流与来源分析](protocol-method.md#登录成功后的-token-研究顺序)，不能把本地请求签名等同于 token 生成。

## 4b. 浏览器对照：搜索、点击与 capture

### 显式选择浏览器路线

先检查所有配置，不联网：

```bash
python research/reverse/targets/xhs-xsec-token/experiment/scripts/run_experiment.py \
  --transport browser \
  --accounts-file ~/.rednote_test_accounts/accounts.json \
  --account-id test_a \
  --note-id EXPECTED_NOTE_ID \
  --bind-identity
```

确认后，自动完成 Cookie 登录、身份验证、搜索、ID 核对、点击、capture 和 token/source 定位：

```bash
python research/reverse/targets/xhs-xsec-token/experiment/scripts/run_experiment.py \
  --transport browser \
  --accounts-file ~/.rednote_test_accounts/accounts.json \
  --account-id test_a \
  --note-id EXPECTED_NOTE_ID \
  --bind-identity \
  --execute --yes
```

上面是首次运行示例；身份已经绑定后应去掉 `--bind-identity`。任何一步失败都会停止，不继续后续步骤。需要观察浏览器时增加 `--headed`；使用第二个搜索词时增加 `--query-index 1`。

总控脚本对登录、搜索 capture 和离线定位分别设置总时限。步骤超时会返回 `TIMED_OUT`，并终止该步骤启动的 Chrome 子进程，避免浏览器在失败后继续联网；超时不视为登录成功，也不会进入下一步。

### 分步调试

先 dry-run：

```bash
python research/reverse/targets/xhs-xsec-token/experiment/scripts/capture_visit.py \
  --accounts-file ~/.rednote_test_accounts/accounts.json \
  --account-id test_a \
  --note-id EXPECTED_NOTE_ID
```

确认后执行：

```bash
python research/reverse/targets/xhs-xsec-token/experiment/scripts/capture_visit.py \
  --accounts-file ~/.rednote_test_accounts/accounts.json \
  --account-id test_a \
  --note-id EXPECTED_NOTE_ID \
  --execute --yes
```

脚本执行顺序固定为：

1. 打开首页并从页面自身的签名 `/user/me` 响应复核 profile 身份；
2. 打开站内搜索页并使用 `search_queries[0]`；
3. 在可见链接中寻找路径段与目标 `note_id` 完全相等的卡片；
4. 找不到时最多按 `policy.yaml` 滚动三次，然后返回 `NOT_DISCOVERABLE`；
5. 找到后正常点击卡片；
6. 只保留与目标帖子精确关联的 access material；其他 URL 参数、未知 header 值和非目标 token 全部脱敏；
7. 最终 URL 必须精确为 `https://www.xiaohongshu.com/explore/<note_id>`，搜索 document 必须为 2xx；
8. 在 policy 时限内等待 detail-specific state；仅搜索卡片残留状态不能证明详情成功，否则返回 `DETAIL_UNCONFIRMED`。

使用第二个关键词时增加 `--query-index 1`。捕获文件自动写入 `data/captures/`；不允许用 `--output` 逃出该目录。

## 5. 离线定位与解释 token

定位工具可读取两条路线的私有结构化 capture。协议 capture 以 `protocol.search_access_material` 记录目标材料；解释来源时还须查看 `source_origin`，定位器找到 source 字段不代表服务端返回了该字段，也不验证详情是否成功。

```bash
python research/reverse/targets/xhs-xsec-token/experiment/scripts/locate_token.py \
  --capture research/reverse/targets/xhs-xsec-token/experiment/data/captures/CAPTURE.jsonl
```

浏览器对照重点比较 token 在所捕获记录中第一次出现于：

- 搜索接口响应或页面状态；
- 搜索卡片 `href`；
- 点击后的 `history`；
- 详情请求或最终 URL。

定位工具要求 token 与 source 字段都存在才返回成功；它不是成对来源或生成算法的证明。它始终只输出 token 前缀，不输出后缀或完整值，也不提供显示完整值的开关。

## 6. 停止条件

出现以下任一情况立即停止当前账号：

- CAPTCHA、安全验证或设备校验；
- 任一 HTTP 461、403 或 429（协议路线也停止 471）；
- `/user/me` 失效、guest 或身份摘要不匹配；
- 需要访问非公开帖子；
- 搜索无法命中；
- 需要点赞、收藏、关注、评论、发布或其他平台写入。

停止事件额外只记录账号别名、时间、状态码和失败分类，不记录 Cookie、平台账号 ID、完整 token 或未脱敏 URL；停止前已经捕获的目标 access material 仍只保存在被忽略且权限为 `600` 的 capture 中。
