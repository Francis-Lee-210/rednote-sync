# `leafiy/xhs_web_crawler` 专项源码审查

研究日期：2026-08-17（Pacific/Auckland）
官方仓库：<https://github.com/leafiy/xhs_web_crawler>
固定 revision：[`8a7d1b6ec90d9c3d25f3d731cd83a15f8ab08c50`](https://github.com/leafiy/xhs_web_crawler/tree/8a7d1b6ec90d9c3d25f3d731cd83a15f8ab08c50)
Git tree：`02328d0c92ca3fe31d571410201c6d2982b6349d`
审查方式：官方仓库 detached HEAD、只读静态审查；仅阅读 `git ls-files` 列出的 8 个 tracked 文件。未安装依赖、未构建、未加载扩展、未运行 Python、未访问小红书、未读取 HAR/账号数据。

状态：专项静态审查完成；复审通过
来源与快照记录：[`provenance.json`](provenance.json)
中断恢复状态：[`checkpoint.json`](checkpoint.json)

## 核心结论

`xhs_web_crawler` 应从“D 级排除项”调整为 **B 级：值得专项研究、局部设计参考**，但当前代码仍未达到可直接采用的完成度。

1. **用户的主要判断成立，但不是 Playwright。** 项目确实实现了一个 Chrome Extension 原型：popup 启停，content script 串行点击卡片、等待详情、关闭弹层、滚动加载更多。它在交互形态上类似 Playwright 状态机，但仓库没有 Playwright/Puppeteer/Selenium 依赖或 API；实际使用原生 DOM 与 `chrome.*` API。
2. **它不是“收藏/点赞专项采集器”。** README 明确示范关键词搜索；源码只按 `.cover.ld.mask`、`.note-item` 和 `data-index` 工作，没有收藏/点赞路由或列表接口判断。若收藏/点赞页仍有相同 DOM，它可能逐篇点击，但本次静态审查不能确认当前页面兼容性。
3. **点击—关闭—滚动循环是真实参考价值。** 这可以作为现有 userscript 的“详情触发 fallback”，也可以为升级到 Chrome 插件提供 popup/content/service-worker 分层的反向设计材料。它不应成为全部 2000+ 收藏/点赞的主扫描路径。
4. **网络采集目前没有真正接通。** `background.js` 未在 Manifest 注册，缺少 `webRequest`、host、`downloads` 权限，且没有任何代码发送它期待的 `START_CAPTURE`/`STOP_CAPTURE`；content script 的 CDP 路线同时存在执行上下文、权限、target 参数、命令名和无人调用导出函数等问题。当前唯一与解析器匹配的实际流程是 README 要求用户在 DevTools 手工执行 “Save all as HAR with content”。
5. **现有 userscript 在列表发现上更高效。** 收藏/点赞脚本直接截取列表响应并按 `note_id` 去重，只需滚动；本项目则逐篇打开卡片。建议保留“列表响应发现为主、点击详情为缺失项补证”的组合，而不是用 Chrome 扩展重写后一律逐篇点击。
6. **许可证仍阻断源码复制。** tracked tree 没有 `LICENSE`；README 同时链接 MIT 和声明“请勿用于商业用途”。可以 clean-room 借鉴行为和边界，不能据此复制或链接代码。

## 1. 仓库定位与真实数据流

### 1.1 README 声明

README 把项目定位为“基于 Chrome 扩展、模拟点击、监控网络请求、Python 处理导出数据”的采集工具，并宣称“不触发反爬措施”；其使用步骤是输入**搜索关键词**、启动扩展、随后在 DevTools Network 面板手工保存含响应正文的 HAR，最后执行 Python 解析器（本地 `source/README.md:1-15, 42-73`；[固定源码](https://github.com/leafiy/xhs_web_crawler/blob/8a7d1b6ec90d9c3d25f3d731cd83a15f8ab08c50/README.md#L1-L15)）。

其中“不会触发反爬”只是 README 声明，仓库没有测试、测量、错误分类或平台一手证据支持；不能把真实浏览器、人工点击或固定延迟当作可靠性/风控证明。

### 1.2 源码实际链路

```text
popup.html / popup.js
  └─ START_CLICKING / STOP_CLICKING + 点击间隔
       ↓
content.js（页面 DOM）
  └─ 查找卡片 → 点击 → 等待 2 秒 → 关闭 → 间隔 → 继续
       └─ 当前卡片处理完 → 滚到底 → 看 scrollHeight 是否增长

用户手工打开 DevTools Network
  └─ Save all as HAR with content
       ↓
extract-content.py
  └─ response.content.text → JSON/base64 → data.items[].note_card → JSON
```

popup 确实把默认 1000ms 间隔和启停消息发送到活动 tab（本地 `source/chrome_extension/popup.html:20-32`、`popup.js:1-17`；[固定源码](https://github.com/leafiy/xhs_web_crawler/blob/8a7d1b6ec90d9c3d25f3d731cd83a15f8ab08c50/chrome_extension/popup.js#L1-L17)）。content script 的 DOM 循环也是真实实现，而不是 README 中尚未落地的设想（本地 `content.js:77-124, 164-218`；[固定源码](https://github.com/leafiy/xhs_web_crawler/blob/8a7d1b6ec90d9c3d25f3d731cd83a15f8ab08c50/chrome_extension/content.js#L77-L124)）。

但是图中没有一条自动化网络路径能把响应正文稳定交给 Python。能产生 `response.content.text` 的只有 README 的人工 HAR 流程。

## 2. 不是 Playwright，而是原生 Chrome Extension

静态 inventory 只有 `.gitignore`、README、5 个扩展文件和 1 个 Python 脚本；没有 `package.json`、lockfile、Playwright 配置、浏览器驱动或 Playwright API。tracked 文件中也没有 `playwright`、`puppeteer` 或 `selenium` 字符串。

Manifest 标明 MV3，静态注入 `content.js`，popup 为 `popup.html`（本地 `manifest.json:1-15`；[固定源码](https://github.com/leafiy/xhs_web_crawler/blob/8a7d1b6ec90d9c3d25f3d731cd83a15f8ab08c50/chrome_extension/manifest.json#L1-L15)）。实际交互使用：

- `document.querySelector(All)` 查卡片、关闭按钮和蒙层；
- `Element.click()` 打开/关闭详情；
- `window.scrollTo()` 滚动；
- `setTimeout`/Promise delay 做等待；
- `chrome.runtime`/`chrome.tabs` 做 popup-content 通信。

因此准确表述应是：**“类似 Playwright 的确定性浏览器交互循环，由 Chrome content script 原生实现。”**

## 3. 自动点击、滚动、停止条件与规模

### 3.1 它会点击什么

每一轮都扫描所有 `.cover.ld.mask`，取最近的 `.note-item`，以 `data-index` 判断是否点击过，然后点击第一个尚未记录且 `display !== none` 的卡片（本地 `content.js:54-94`；[固定源码](https://github.com/leafiy/xhs_web_crawler/blob/8a7d1b6ec90d9c3d25f3d731cd83a15f8ab08c50/chrome_extension/content.js#L54-L94)）。

它没有：

- 收藏/点赞页面路由检查；
- `note_id` 稳定主键；
- 收藏/点赞列表 endpoint 判断；
- 每页条数、最大点击数或任务预算。

所以，“在收藏或点赞页会逐篇点开”是**有条件推断**：只有当前页面仍使用这些 selector 和 `data-index` 时才成立。README 实证范围只声称关键词搜索（本地 `README.md:50-55`；[固定源码](https://github.com/leafiy/xhs_web_crawler/blob/8a7d1b6ec90d9c3d25f3d731cd83a15f8ab08c50/README.md#L50-L55)）。

### 3.2 单篇时延

默认成功路径至少包括：

- 打开后固定等待 2000ms；
- 关闭后等待 500ms；
- 两篇之间默认等待 1000ms。

因此理想最低约 **3.5 秒/篇**。若关闭按钮未立即出现，`waitForElement` 最多再等 1000ms（本地 `content.js:25-37, 96-124, 176-197`；[固定源码](https://github.com/leafiy/xhs_web_crawler/blob/8a7d1b6ec90d9c3d25f3d731cd83a15f8ab08c50/chrome_extension/content.js#L96-L124)）。对项目约 2000 条数据，纯点击理想下限约 1 小时 57 分钟，还未包含滚动、页面变慢、详情失败和人工导出。每次加载更多又固定增加约 2 秒等待（`content.js:39-52, 182-194`）。

### 3.3 停止条件与边界缺陷

- 只有“当前已知可见卡片全点击过”后才滚动；滚动 1 秒后 `scrollHeight` 不增长即停止（本地 `content.js:39-52, 176-198`）。一次慢加载会被误判为到底。
- 若 selector 失效或页面没有匹配卡片，`allVisibleElementsClicked()` 返回 false，主循环进入每秒空等，可能永不自动停止（`content.js:54-75, 195-197`）。
- `clickedIndexes` 在 content script 内存中；刷新、导航、扩展更新或浏览器退出即丢失，没有 checkpoint（`content.js:1-3`）。
- `data-index` 不是稳定 `note_id`。虚拟列表若复用/移动 index，可能漏项；没有 `data-index` 时多个卡片都映射为 `null`，第一项后其余会被当作重复。
- 在确认详情成功打开/响应成功前就把 index 加入集合；点击失败或弹层异常也会标记“已处理”（`content.js:96-106`）。
- stop 只把 `isRunning` 设为 false，不中断当前等待；重新开始保留同一页面内存中的 `clickedIndexes`，但 popup 没有真实恢复状态（`content.js:201-217`）。
- 每找下一项都从头扫描 NodeList；若 DOM 保留 N 个已加载卡片，N 个项目累计元素检查最坏趋近 O(N²)。虚拟列表可能限制 DOM 数量，但同时加重 index 复用风险。
- `MutationObserver` 已创建但回调没有任何处理逻辑，`createPrompt()` 也从未调用（`content.js:5-23, 220-248`）。

## 4. popup、content、background 与 Manifest 接线审计

| 组件 | 已实现行为 | 接线结果 |
|---|---|---|
| popup | 启动、停止、间隔输入、内存点击计数 | 启停到 content 的消息成立；popup 关闭/重开会丢失显示状态和计数，没有从任务状态恢复 |
| content | 点击、关闭、滚动，向 runtime 发送 `CLICK_COUNT` | 核心 DOM 原型成立；selector 和 `data-index` 脆弱；无持久 checkpoint |
| background | 计划监听含 `feed` 的完成请求，STOP 时写简化 HAR | Manifest 没有注册它；消息没有发送者；缺权限；输出不含响应正文，不能喂给当前解析器 |
| Manifest | MV3、popup、`<all_urls>` content script | 只声明 `activeTab`、`scripting`；没有 background service worker、`debugger`、`webRequest`、`downloads`、`storage` |

关键证据：

1. Manifest 没有 `background.service_worker`（本地 `manifest.json:1-15`）。Chrome 官方规定 MV3 background 必须由该字段注册：[Extension service worker basics](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/basics)。因此 tracked `background.js` 不会作为后台入口加载。
2. `background.js` 要求消息字段 `action` 为 `START_CAPTURE`/`STOP_CAPTURE`（本地 `background.js:22-67`；[固定源码](https://github.com/leafiy/xhs_web_crawler/blob/8a7d1b6ec90d9c3d25f3d731cd83a15f8ab08c50/chrome_extension/background.js#L22-L67)），但 popup 只发送 `type: START_CLICKING/STOP_CLICKING`；仓库没有前两种消息的发送者。
3. Chrome 官方要求 `webRequest` 与必要 host permissions，要求 `downloads` 权限；Manifest 均未声明：[webRequest](https://developer.chrome.com/docs/extensions/reference/api/webRequest)、[downloads](https://developer.chrome.com/docs/extensions/reference/api/downloads)。
4. content script 直接调用 `chrome.debugger` 和 `chrome.devtools.inspectedWindow`（本地 `content.js:126-174`）。Chrome 官方只允许 content script 直接访问一小组 DOM/i18n/storage/runtime API，其他能力要经扩展上下文消息转发：[Content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)。`chrome.devtools.*` 只在由 `devtools_page` 加载的 DevTools 页面可用，而当前 Manifest 没有 `devtools_page`：[Extend DevTools](https://developer.chrome.com/docs/extensions/how-to/devtools/extend-devtools)。
5. `chrome.debugger` 需要 `debugger` 权限，`sendCommand` target 应是 `{tabId}`；源码却传 `{target: {tabId}}`：[chrome.debugger](https://developer.chrome.com/docs/extensions/reference/api/debugger)。
6. 当前 CDP Network domain 没有 `Network.getHAR` 命令；官方方法表包含 `Network.getResponseBody(requestId)`：[Chrome DevTools Protocol Network domain](https://chromedevtools.github.io/devtools-protocol/tot/Network/)。源码既没有监听 `Network.responseReceived/loadingFinished` 保存 requestId，也没有逐响应调用 `getResponseBody`。
7. `exportHAR()` 只被定义，从未调用；停止也不执行 `chrome.debugger.detach()`（本地 `content.js:126-174`）。

这些是**实现/接线缺陷**，不等于“Chrome 插件分层”这一概念无价值。

## 5. 网络响应与 HAR：三条候选路径的实际状态

### 5.1 README 人工 HAR：唯一闭环，但隐私成本最高

README 要求用户打开 DevTools，手工 “Save all as HAR with content”（本地 `README.md:44-73`）。解析器读取整个 HAR，遍历 `log.entries`，从 `response.content.text` 解析 JSON 或 base64，然后只取 `data.items[]` 中 `model_type == note` 的 `note_card`（本地 `extract-content.py:40-126`；[固定源码](https://github.com/leafiy/xhs_web_crawler/blob/8a7d1b6ec90d9c3d25f3d731cd83a15f8ab08c50/extract-content.py#L40-L126)）。

这条路径理论上能闭环，但：

- HAR with content 可能保存请求/响应 header、Cookie、Authorization、query token、响应正文和其他页面流量；
- 解析器整文件载入内存，再将所有结果累积到列表，大文件内存占用为 O(HAR + 输出)；
- 不按 URL 过滤解析，只按响应结构取 `note_card`；
- 没有按 `note_id` 去重，重复 feed 响应可能产生重复记录；
- 输出完整 `note_card`，没有字段最小化、敏感材料隔离、schema version 或来源关系；
- `.gitignore` 只排除 `*.har`，没有脱敏、加密、权限、保留期或安全删除机制（本地 `.gitignore:1`）。

### 5.2 `background.js` 简化 HAR：没有接通，也没有正文

即使补上 service worker 和权限，`onCompleted` 只记录 URL、method、timestamp、type、status；生成的 HAR `response` 也只有 status/statusText，没有 `response.content.text`（本地 `background.js:5-20, 31-65`）。所以当前 Python 解析器无法从这种 HAR 取得笔记。

此外它用“URL 含 `feed`”做宽松筛选，并计划监听 `<all_urls>`。若接通，任意站点含 `feed` 的 URL 都可能进入记录，且 URL query 可能带访问材料。应改为精确 origin + endpoint allowlist，而不是修补成全域监听。

### 5.3 content CDP HAR：概念方向存在，具体实现不可用

CDP 确实可以在获得强权限后，通过 Network 事件和 `getResponseBody` 获取响应正文；但本项目当前没有正确上下文、权限、target、命令或事件关联，也没有调用导出。若未来 Stage 4 需要这条路线，应作为明确 opt-in 的高权限 fallback，而不是默认能力。

## 6. 与现有 userscript 的具体比较

| 审查面 | 现有 userscript | `xhs_web_crawler` | 对 Rednote Sync 的启发 |
|---|---|---|---|
| 目标范围 | 明确收藏/点赞 profile 页面和列表响应 | README 是关键词搜索；DOM selector 泛化点击 | 保留 source-specific discovery，不把搜索原型误称收藏同步器 |
| 发现 | 滚动触发分页；拦截收藏/点赞列表 JSON | 扫描卡片 DOM 并逐篇点击 | 列表响应为主；DOM 只做 drift 诊断/补证 |
| 详情触发 | 不逐篇点击，只保存列表字段 | 点击每张卡片，等待详情并关闭 | 只对新增且详情不足、失败补证的 note 做点击 fallback |
| 网络采集 | page-side XHR/fetch hook；收藏脚本处理 `data.notes` | 计划 webRequest/CDP；实际只能人工 HAR；Python 处理 `data.items[].note_card` | Chrome 扩展需明确 MAIN-world bridge、DevTools/CDP 或人工 HAR 三选一，不能混用 |
| 去重 | 收藏脚本用数组 `.some`；点赞新版用 `Set(note_id)` | 用 `Set(data-index)`；解析器不去重 | 统一稳定键 `(account, source, note_id)`；禁止 UI index 作为 canonical identity |
| checkpoint | 数据在内存，只有 UI 位置进 localStorage | 点击状态、后台请求、popup 计数都在内存 | 迁移插件时用 `chrome.storage` 保存任务状态，Core 继续拥有 canonical state |
| 暂停/恢复 | 仅停止滚动 | 停止新循环，但当前等待不可取消；重载丢失 | 需要 durable pause、stop reason、batch cursor 与幂等重放 |
| 输出 | 收藏 XLSX；点赞 JSON 原型含版本/source | Python 输出裸 `note_card[]` | 插件只输出脱敏、版本化 `offline-input-v1` bridge，不另建平行知识库 |

现有收藏 userscript 的直接列表路径见本地 `prototypes/tampermonkey/xiaohongshu-collection-export.user.js:164-255`；点赞 JSON 原型用 `note_id` Set 去重、带 `schema_version`/`source`，见 `prototypes/tampermonkey/xiaohongshu-like-export-json.user.js:138-285`。两者同样缺少数据 checkpoint，只有面板位置存在 `localStorage`；不能把 UI 偏好持久化误认为同步恢复能力。

另一个需要在插件化时显式解决的边界是 Chrome content script 默认处于 isolated world，不能通过覆盖自身的 `window.fetch`/`XMLHttpRequest` 自动影响页面主世界。Chrome 官方提供 `chrome.scripting` 的 `ExecutionWorld.MAIN`，但 MAIN-world 代码和页面消息都必须视为不可信输入，并做精确 schema 校验：[chrome.scripting](https://developer.chrome.com/docs/extensions/reference/api/scripting)、[Content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)、[Message passing](https://developer.chrome.com/docs/extensions/develop/concepts/messaging)。

## 7. 建议的 Chrome 插件升级设计

本项目值得研究的不是“把全部帖子逐篇点开”，而是把现有 userscript 的页面能力拆成权限更清楚、可以恢复的组件：

```text
popup / side panel（只做控制与状态显示）
  ↓ typed messages
MV3 service worker（任务协调、预算、暂停、checkpoint）
  ├─ chrome.storage.session：本次会话内的敏感短期材料
  ├─ chrome.storage.local：最小化任务元数据/checkpoint
  └─ content script（isolated）：DOM 观察、点击 fallback、风控/登录 UI 识别
       ↕ 严格 schema 的最小消息
     MAIN-world bridge：仅观测明确 allowlist 的收藏/点赞列表响应
  ↓
脱敏、版本化 offline-input-v1
  ↓
Rednote Sync Core（canonical state、对象、投影和失败事实源）
```

Chrome 官方说明 MV3 service worker 会休眠，global 变量会丢失，持久状态应放 storage；`chrome.storage` 可供各扩展上下文共享：[Service worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)、[chrome.storage](https://developer.chrome.com/docs/extensions/reference/api/storage)。这正是当前原型最值得转化的地方。

建议的任务状态至少包含：

- `runId`, `accountBinding`, `source`；
- `phase = discovering | detail_fallback | exporting | paused | complete`；
- `lastPageCursor`/列表水位、`seenNoteIds` 摘要；
- 每条 `note_id` 的 `discovered/detail_pending/detail_ok/detail_failed/exported`；
- `attemptCount`, `lastErrorClass`, `stopReason`, `updatedAt`；
- 批次预算：最大页数、最大点击数、最长期限；
- 完整对账是否真正到达列表尾部。未完整不得推断取消点赞/收藏。

### 7.1 推荐数据获取顺序

1. **主路径：列表响应发现。** 延续 userscript 已验证思路，取得 `note_id`、source relation、必要的短期 access material；滚动只用于推进列表分页。
2. **详情队列：只处理新增/变化/列表字段不足项。** 已有且内容未变化的记录不逐篇打开。
3. **点击 fallback：限量、串行、可取消。** 借鉴本项目的点击—等待—关闭—滚动循环，但 identity 改用 `note_id`；确认响应或详情标识后才提交完成状态。
4. **诊断 fallback：人工 HAR。** 默认关闭；只在用户明确触发时保存短期、精确 allowlist、脱敏后的失败样本，不能把整份 HAR 当普通日志。
5. **暂停门。** 登录变化、验证码、安全提示、429、selector/schema drift 立即 checkpoint 并停止；延迟或“模拟人工”不是继续运行的依据。

### 7.2 从原型可直接借鉴的行为，不可直接复制的代码

值得 clean-room 独立实现：

- popup 发出显式 start/stop 和节奏配置；
- content script 内串行点击、等待确认、关闭详情；
- 当前批次耗尽后滚动并检查新内容；
- UI 自动化与离线结构化解析分离；
- 点击计数、错误和停止原因反馈到统一状态视图。

需要重新设计：

- `data-index` → 稳定 `note_id`；
- 固定 sleep → 有上限的条件等待 + 可取消 token；
- 单次 `scrollHeight` 判断 → 多信号、有限重试、明确 `end_of_list/schema_drift/load_timeout`；
- 内存 Set/global 数组 → 持久 checkpoint；
- `<all_urls>` → 精确小红书 origin 与可选权限；
- 全量 HAR → allowlist 结构化记录和敏感字段隔离；
- popup 自己计数 → popup 从 service worker/storage 读取事实状态；
- 每篇点击 → 只对详情缺口点击。

## 8. 安全、隐私、许可证与供应链边界

### 8.1 权限和隐私

- Manifest 将 content script 匹配为 `<all_urls>`，但代码只识别小红书 selector；这是无必要的广域注入（本地 `manifest.json:10-15`）。未来应精确限制 origin，并把强权限设为用户显式启用的 optional permission。
- `debugger` 可以观察页面网络与执行上下文，权限强于普通 DOM 采集；不能只因它能获取响应正文就默认启用。
- HAR、query URL 和输出 `note_card` 可能包含账号标识、xsec/access material 与个人收藏内容；必须分开 canonical 数据、短期 secret envelope 和诊断 artifact。
- 消息来自 content/MAIN world 时，service worker 必须校验 sender tab/origin、消息 type、字段、大小和 run/account 绑定。Chrome 官方同样建议把 content script 消息视为可能被攻击者构造：[Message passing security considerations](https://developer.chrome.com/docs/extensions/develop/concepts/messaging#security-considerations)。

### 8.2 许可证

README 在 `source/README.md:160-166` 链接 `LICENSE`、标注 MIT，同时写“请勿用于商业用途”；但 `git ls-files` 没有 `LICENSE`。因此许可证文本、版权主体和额外限制关系均无法从固定 revision 解决（[固定 README](https://github.com/leafiy/xhs_web_crawler/blob/8a7d1b6ec90d9c3d25f3d731cd83a15f8ab08c50/README.md#L160-L166)）。

结论：**只借鉴行为/架构，clean-room 独立实现；不复制、链接或分发其源码。** 项目改为 B 级不改变这一复用边界。

### 8.3 供应链与维护证据

- Python 仅导入标准库；扩展没有 npm/远端 runtime 依赖。
- tracked tree 没有测试、CI、lockfile、release 配置、SBOM、provenance 或安全政策。
- Manifest 版本固定 `1.0`，README/源码也没有兼容版本矩阵。
- 仓库仅 6 个可见提交、无 tag；当前 HEAD 的提交日期为 2025-02-06。这里仅说明审查快照，不据此推断当前页面仍兼容。

## 9. 评级与采用边界

**建议总评级：B（值得研究，局部组件或边界参考）。**

| 研究面 | 建议 |
|---|---|
| 点击—关闭—滚动的浏览器交互状态机 | B：作为少量详情 fallback 参考，需换稳定主键、条件等待、预算和 checkpoint |
| userscript → Chrome Extension 分层 | B：popup/content/service-worker/storage 的职责拆分值得专项设计 |
| 列表发现策略 | 以现有 userscript 为主，本项目仅补充 DOM/点击 fallback |
| HAR 与离线解析分离 | B/C：边界概念有价值；全量 HAR 默认流程不可采用 |
| 当前 Manifest/background/CDP 代码 | 不通过采用门；需独立重写而非修补复制 |
| “不会触发反爬” | 未知/无证据；不得进入产品承诺或可靠性判断 |
| 源码复用 | 禁止，直到权利人提供可核验且无冲突的许可证文本 |

调整评级的理由不是忽略缺陷，而是把“项目整体能否直接采用”和“其局部行为是否值得研究”分开。此前 D 级描述“仅剩 HAR 离线解析概念”过窄，遗漏了真实存在的 DOM 遍历状态机及其对现有 userscript 插件化的参考价值。

## 10. 未知项与验证边界

本次没有动态运行，以下必须保留为未知：

- 当前小红书搜索、收藏、点赞页面是否仍使用这些 selector/`data-index`；
- 点击详情实际触发的 endpoint、响应结构和是否含完整正文/媒体；
- 收藏/点赞列表能否完整滚到底、排序和 cursor 语义；
- 2000+ 条长任务的内存、页面虚拟化、登录和暂停表现；
- 点击间隔与账号/平台风险之间是否存在任何可重复关系；
- HAR 在当前 Chrome 版本导出的具体敏感字段集合；
- 作者是否愿意补充一致的许可证。

这些未知项不能通过静态阅读推断为“可用”或“安全”。如果未来进入 Stage 4，只能在既有专用 profile、低频、可暂停、先产脱敏 schema 的门内做小样本验证；本笔记不改变 Stage 3 完全离线边界。

## 11. 固定源码证据索引

- [README](https://github.com/leafiy/xhs_web_crawler/blob/8a7d1b6ec90d9c3d25f3d731cd83a15f8ab08c50/README.md)
- [Manifest](https://github.com/leafiy/xhs_web_crawler/blob/8a7d1b6ec90d9c3d25f3d731cd83a15f8ab08c50/chrome_extension/manifest.json)
- [popup.js](https://github.com/leafiy/xhs_web_crawler/blob/8a7d1b6ec90d9c3d25f3d731cd83a15f8ab08c50/chrome_extension/popup.js)
- [content.js](https://github.com/leafiy/xhs_web_crawler/blob/8a7d1b6ec90d9c3d25f3d731cd83a15f8ab08c50/chrome_extension/content.js)
- [background.js](https://github.com/leafiy/xhs_web_crawler/blob/8a7d1b6ec90d9c3d25f3d731cd83a15f8ab08c50/chrome_extension/background.js)
- [extract-content.py](https://github.com/leafiy/xhs_web_crawler/blob/8a7d1b6ec90d9c3d25f3d731cd83a15f8ab08c50/extract-content.py)
