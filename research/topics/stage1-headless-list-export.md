# 产品阶段一：无头浏览器导出帖子列表的可行性

> 状态：**研究证据／候选方案，尚未采纳**。核查日期：2026-09-14（Pacific/Auckland）。本轮仅核对公开官方文档、现有列表脚本与已有项目研究，没有启动浏览器、访问小红书、读取真实会话或执行第三方项目；不构成线上验收。产品范围以[产品设计](../../docs/design/product-design.md#产品阶段一帖子列表导出)为准，当前进度见[路线图](../../docs/design/roadmap.md)。

## 结论

**机制可行，值得做小范围验证。** Playwright 提供 Cookie 注入、交互登录后的状态保存与恢复、无头启动及页面网络响应观察；可以组织成“建立会话 → 后台打开点赞／收藏页 → 滚动加载 → 收集列表 → 写入本地文件”的流程。已有[Playwright 研究](../projects/playwright/review.md#先读这里身份验证与帖子详情获取)确认这些是通用能力，小红书身份核验、分页结束条件和完整性仍需自行实现。

这里的无头模式仍运行真实浏览器进程，只是不显示窗口。官方区分默认 Chromium headless shell 与 `channel: 'chromium'` 的新 headless 模式，行为可能不同；对照实验应固定浏览器版本与 channel。这些模式说明没有提供小红书登录成功、账号安全或风控通过保证。[官方浏览器说明](https://playwright.dev/docs/browsers#chromium-new-headless-mode)

## 最小验收建议

1. 分别验证 Cookie 注入和交互登录；记录是否得到预期账号身份，不能只判断存在 Cookie 或页面有“我”。
2. 用同一浏览器版本和 channel，关闭再无头重开；复核账号、点赞与收藏首批数据及至少一次分页。
3. 用少量已知帖子对照导出内容，验证来源关系、去重、增量落盘和中断后的恢复行为。
4. 然后才验证 2000 多条完整扫描；区分列表结束、加载停滞、接口失败和登录失效。短暂无新响应只记为停滞或部分完成，不能当作全部导出完成。
5. 遇到需要人工登录或验证的页面时暂停并保留进度；恢复后重新核验账号和列表位置。

以上是候选验证顺序，没有选定依赖版本或实现方式；本轮不能证明小红书在目标账号上接受无头会话，也未验证完整性、恢复或导出成功率。

## 两种会话入口

| 入口 | 可组织的流程 | 验证边界 |
|---|---|---|
| 用户输入 Cookie | 将用户提供的材料转换成 Cookie 对象，写入浏览器 context，访问站点验证会话，再开始列表扫描 | 注入成功不等于站点接受，更不等于登录了预期账号 |
| 弹出窗口手动登录 | 以 `headless: false` 启动专用浏览器，用户完成登录，程序核验账号并保存；关闭后以 `headless: true` 重开 | 登录、关闭重开后的身份、列表可见性分别验证 |

`addCookies()` 接受 `name`、`value`，并要求 `url` 或 `domain` + `path`；还支持有效期、`httpOnly`、`secure`、`sameSite` 等属性。[Cookie API](https://playwright.dev/docs/api/class-browsercontext#browser-context-add-cookies)

普通请求头形式的 `a=b; c=d` 只包含名称和值，不能还原 Cookie 原来的 domain/path/expiry/Secure/HttpOnly 属性。因此“粘贴字符串”和“恢复浏览器原生 Cookie 数组”不是等价输入；补上默认值只是在构造新材料，不能宣称保真恢复。[RFC 6265 §4.2.2](https://www.rfc-editor.org/rfc/rfc6265#section-4.2.2)

交互登录可减少用户手动获取 Cookie 的操作，也减少字符串转换这一变量；这属于工程建议，并非成功率更高的实测结论。既有[Cookie 登录研究](cookie-login-implementations.md#2-cookie-登录并不是一种实现)区分了这两条路径；一种入口的结果不能替代另一种入口的验证。

## 手动登录后怎样继续无头运行

- **状态快照：** 登录流程确认完成后保存 `storageState`，后续新建 context 时载入。官方示例等待成功页面或元素后才保存。[认证说明](https://playwright.dev/docs/auth#basic-shared-account-in-all-tests)
- **保存范围：** Cookie、localStorage 可随状态恢复；IndexedDB 需显式 `indexedDB: true`。这不是完整浏览器 profile，不能假定所有运行状态均被复制。[状态 API](https://playwright.dev/docs/api/class-browsercontext#browser-context-storage-state)
- **sessionStorage：** 不随 `storageState` 自动持久化；如果目标站点确实依赖它，需要单独设计保存／初始化，否则重开后可能失去相关状态。[官方边界](https://playwright.dev/docs/auth#session-storage)
- **专用持久目录：** `launchPersistentContext(userDataDir)` 可复用磁盘会话；同一目录不能同时启动多个浏览器，官方也不支持直接自动化日常 Chrome 默认 profile。[持久 context](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context)
- **窗口切换：** `headless` 是启动选项；此候选流程应关闭后重启并重新核验身份，不把运行中的有头浏览器“热切换”为无头浏览器。[启动参数](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-option-headless)

状态文件与 profile 都是登录材料；拟议实现应保存到专用本地位置并排除版本控制。任何模式下，“文件存在”都不能替代重开后的账号核验。[官方认证注意事项](https://playwright.dev/docs/auth#introduction)

## 列表如何导出

候选流程如下；列表归属必须对应用户想导出的账号，不能由任意另一个已登录账号代替。

```text
输入 Cookie／窗口登录 → 确认账号 → 保存会话 → 无头恢复并复核
    → 先注册 response 监听 → 打开个人页、切换点赞或收藏 → 滚动加载
    → 校验列表响应、保留来源关系、去重并持续落盘 → 确认结束 → 导出
```

在 `goto`、切换标签和滚动之前注册 `page.on('response', ...)`；单次等待用 `waitForResponse` 时也应先建立等待再触发动作。这样才能接到首批数据，后注册的监听不会补回已发生的事件。[官方网络事件示例](https://playwright.dev/docs/network#network-events)

监听器可用 `response.json()` 读取页面实际收到的列表 JSON，无需先导出 HAR；返回是否成功、属于哪个列表、字段和分页是否有效仍要校验。[响应 JSON API](https://playwright.dev/docs/api/class-response#response-json)

这条候选路线由网页的正常导航、点击和滚动触发请求。`context.request`／`page.request` 则是 HTTP API 客户端，虽然共享 Cookie，却不能据此推定执行了网页 JavaScript 或平台签名逻辑；不能把两者的成功或失败互相替代。[APIRequestContext](https://playwright.dev/docs/api/class-apirequestcontext)

## 当前脚本的迁移起点

本轮复核的[点赞 JSON 脚本](../../prototypes/tampermonkey/xiaohongshu-like-export-json.user.js)按明确的 `note/(like|liked)/page` 请求筛选列表响应，再按 `note_id` 去重；[收藏脚本](../../prototypes/tampermonkey/xiaohongshu-collection-export.user.js)监听 `note/collect/page`，同样从响应提取列表字段。这些脚本通过定时滚动触发加载，记录保存在内存；`localStorage` 保存的是面板位置，没有持久化扫描游标或完成证明。原型范围与既有回归说明见[原型目录](../../prototypes/README.md)。

工程上可把列表解析和去重逻辑提取到导出器，用浏览器响应监听与本地文件写入代替脚本注入和导出面板，并补齐账号归属、分页完成判据与持久进度；这是迁移建议，尚未实现。同一帖子若既点赞又收藏，两个来源关系都应保留，不能仅按帖子 ID 合并后丢掉来源。列表条目中的作者 `user_id` 也不能充当列表所属账号。
