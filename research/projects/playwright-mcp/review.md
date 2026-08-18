# Playwright MCP 专项源码审查

> 状态：**研究证据**。本文只对记录的固定 revision 和审查范围负责；评级、排除项、历史实施阶段边界和账号限制不自动成为当前产品决策。

状态：专项静态审查完成；独立复审通过
审查日期：2026-08-13
固定 revision：[`7e0457a7cbf88823bf0146d12c46ae12c6818247`](https://github.com/microsoft/playwright-mcp/tree/7e0457a7cbf88823bf0146d12c46ae12c6818247)

> 本报告只描述固定 revision 的 tracked 静态证据，不证明已发布 npm/Docker 制品、在线兼容性、运行可靠性、平台许可或账号安全。未安装依赖，未执行项目、测试、浏览器或 MCP 服务，也未读取任何用户 Cookie、token、profile、HAR、storage state、日志或个人数据。tracked 测试证书只登记为公开测试材料，不复制其私钥内容。

## 1. 范围、来源与方法

- 来源、revision、tree 与静态清点见 [`provenance.json`](provenance.json)，中断恢复状态见 [`checkpoint.json`](checkpoint.json)。
- 只通过 `git ls-files` 审查根仓库的 34 个 tracked paths；README/项目声明、源码/配置事实、测试意图（未运行）、静态推断和未知项分别标记。
- 根仓库明确说明核心实现已迁到 Playwright monorepo的 `packages/playwright-core/src/tools/mcp` 与 `backend`；本快照的 `index.js`/`cli.js`只委托给固定 npm alpha 的 core bundle。[迁移说明](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/CONTRIBUTING.md#L18-L48) [入口](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/index.js#L18-L19) [CLI](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/cli.js#L18-L32)
- 为理解设计，报告只把已有 [`Playwright 专项报告`](../playwright/review.md)及其固定 monorepo revision `bcb3563…` 当**相邻实现证据**；它晚于依赖的 `1.63.0-alpha-2026-08-05`，不能冒充精确 npm 制品源码。
- 不研究或迁移验证码求解、stealth、签名绕过、代理/账号轮换、指纹伪装、隐藏自动化或平台限制绕过；相关开关只登记能力、风险与未知项。

## 2. 结论摘要

### 核心结论：

- **最终建议 B：适合作为 Agent 浏览器探索工具与能力边界参考，不适合作为 Rednote Sync 生产同步 Provider。** 最值得借鉴的是 profile 模式显式化、固定README的tool schema/Read-only标记、Host检查、输出预算、客户端断开清理和把任意代码工具直接标为`unsafe/RCE-equivalent`；相邻实现会再把tool type映射为MCP hints。但项目没有小红书发现、详情、媒体、cursor、checkpoint、幂等或账号身份契约。[配置面](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/config.d.ts#L19-L164) [工具说明](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/README.md#L1043-L1051) [相邻hint映射](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/tools/utils/mcp/tool.ts#L29-L40)
- **固定源码与实际运行实现之间有明确 provenance 缺口。** 根包精确依赖 `playwright`/`playwright-core 1.63.0-alpha-2026-08-05`，但不包含 core 实现；现有相邻 monorepo 快照是 `1.63.0-next`。未下载 npm tarball、tag或发布证明，因此报告不能把相邻源码的每个细节断言为该 alpha 制品事实。[依赖](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/package.json#L39-L46)
- 默认 core 工具不是只读采集面：点击、输入、导航、上传、页面 evaluate 和 `browser_run_code_unsafe` 均可改变页面或本机状态；后者由项目明确称为在 MCP server 进程执行任意 JavaScript、等同 RCE。storage能力还能读取明文 Cookie、修改 Cookie/localStorage并导入导出 storage state。[core工具](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/README.md#L869-L1109) [storage工具](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/README.md#L1198-L1353)
- 固定README的Read-only标记只表达浏览器/页面语义；相邻实现会据此设置`readOnlyHint/destructiveHint`，但它仍不等于“无本地写、无秘密读取”：截图、网络详情和storage-state等read-only工具可把产物写到文件；Cookie、localStorage、sessionStorage、请求/响应headers与body可进入MCP结果。Rednote必须另建`remoteRead/localRead/localWrite/secretRead/platformWrite`多维能力模型，不能只信一个布尔值。[网络详情](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/README.md#L1002-L1022) [storage state](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/README.md#L1338-L1353) [相邻hint映射](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/tools/utils/mcp/tool.ts#L29-L40)
- profile、isolated context、storage state、extension/CDP与 shared context 提供了清楚的会话形态，但没有 `expectedAccountId`、profile owner、任务互斥或每轮身份校验。persistent profile按 workspace hash持久化登录态，extension直接复用现有浏览器登录态；shared context还会跨HTTP客户端共享浏览器上下文。[profile](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/README.md#L458-L507) [shared context](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/config.d.ts#L139-L154)
- HTTP/SSE模式的固定文档没有认证或TLS配置，只提供默认 localhost、Host allowlist/DNS rebinding检查；README也明确声明 Playwright MCP 不是安全边界。若服务被暴露、代理放行或操作者使用宽泛Host配置，任意客户端即可获得完整浏览器工具面；Host校验不能代替调用方认证。[Host配置](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/config.d.ts#L112-L128) [安全声明](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/README.md#L798-L800)
- 网络 origin allow/block默认允许全部，项目明确说它们不是安全边界且不影响 redirects；文件根限制也被声明为防止 LLM误操作的便利 guardrail，可被有意绕过。Rednote不能用这两层代替精确 host/path/provider allowlist、服务器端文件 broker和OS沙箱。[网络边界](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/README.md#L409-L412) [文件边界](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/config.d.ts#L238-L244)
- MCP logical session、浏览器 profile和 Rednote同步 checkpoint必须分开：固定根项目没有操作ID、结果journal、cursor水位、逐资产状态或崩溃恢复协议；persistent profile与可选session transcript只是浏览器/诊断状态，不能成为 canonical进度。动作超时或连接中断后的页面副作用可能未知，生产同步器不得盲重试。
- 供应链有明确正面信号：npm lock的97个非根节点均有registry URL和integrity，GitHub npm发布工作流配置了`id-token: write`并意图使用OIDC，发布前会跑lint/Chromium测试，Docker最终以非root用户运行。实际npm Trusted Publisher绑定与provenance未动态核验。[发布](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/.github/workflows/publish.yml#L9-L62) [Docker](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/Dockerfile#L49-L67)
- 仍有不可忽略的供应链缺口：19个GitHub Action引用均为可变tag，MCP Registry发布会下载`latest`二进制并直接解压执行、无固定版本或hash；Docker base无digest且ENTRYPOINT禁用Chromium sandbox。Azure alpha链用可变`refs/tags/release`模板，只执行本仓库的no-op build后打包，未运行根测试。[registry发布](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/.github/workflows/publish.yml#L64-L109) [Azure链](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/.azure-pipelines/publish.yml#L6-L14) [build脚本](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/package.json#L18-L30)
- 真实浏览器、persistent profile、CDP、extension、slow typing、延迟或隐藏自动化标志都不是风控有效性或账号安全证明。历史实施 Stage 3 继续完全离线；历史实施 Stage 4 若获得明确授权，也应实现窄化只读Adapter，而不是把通用Playwright MCP直接暴露给同步任务。

## 3. 架构、包装层与实现来源

```text
MCP Client
  ├─ stdio（默认）
  └─ HTTP/SSE（--port）
       → @playwright/mcp cli.js / index.js
       → playwright-core/lib/coreBundle.tools
       → BrowserBackend / tool registry（位于 Playwright monorepo）
       → persistent / isolated / CDP / extension / remote browser
       → page、network、files、storage、trace、video
```

- `[源码事实]` 根 `index.js` 只导出 core bundle的 `createConnection`；`cli.js` 只把 `install-browser` 映射到 Playwright install或装饰MCP命令，核心业务不在本仓库。[index.js](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/index.js#L18-L19) [cli.js](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/cli.js#L18-L32)
- `[配置事实]` package自身版本是`0.0.79`，核心依赖是精确alpha；package声明Node `>=18`，但lock中的`playwright-core`声明Node`>=20`，故实际有效下限至少受core的`>=20`约束。根元数据的`>=18`会误导部署兼容性。[package](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/package.json#L1-L16) [lock中的core engine](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/package-lock.json#L958-L969)
- `[项目声明]` README把MCP定位为需要persistent state、丰富页面结构审查与长循环的探索工具；这支持把它放在研究/调试面，而不是证明它具备生产同步状态机。[README](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/README.md#L1-L12)
- `[相邻源码证据]` Playwright `bcb3563…` 的MCP server为每个连接延迟创建 backend，HTTP断开后清理，并用heartbeat关闭失联客户端；这些是会话生命周期设计参考，但精确alpha是否完全相同未知。[server.ts](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/tools/utils/mcp/server.ts#L55-L179)

## 4. 浏览器、会话、profile 与状态

| 模式 | 固定项目证据 | 适配判断 |
|---|---|---|
| persistent（默认） | 登录态保存在按channel/workspace hash区分的profile；同一profile只允许一个browser实例 | 可借鉴`profileId + lease`，但workspace hash不是账号ID或owner |
| isolated | 关闭browser后storage state丢失，可显式导入storage state | 适合临时研究；storage state是高敏感材料，不是同步checkpoint |
| extension | 连接现有Chrome/Edge tabs并复用登录态 | 生产D；可能接触用户日常会话，缺expected account gate |
| CDP/remote | 接收endpoint、headers、timeout等连接材料 | 生产D；endpoint/header属于secret/control capability |
| shared context | 所有HTTP clients复用同一个browser context | 生产D；跨client共享Cookie、页面和写操作状态 |

固定依据见 [README profile说明](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/README.md#L458-L519) 与 [配置声明](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/config.d.ts#L37-L110)。

- `[相邻源码证据]` persistent模式在启动前检查profile lock，并从client workspace路径生成短hash目录；isolated模式可在共享browser process内为每个client创建context。[browserFactory.ts](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/tools/mcp/browserFactory.ts#L34-L184) [program.ts](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/tools/mcp/program.ts#L105-L167)
- 没有稳定平台账号ID、`expectedAccountId`、account/profile绑定、跨进程job lease、恢复后身份重检或账号变化停止条件。Rednote未来应建立`ProfileLease + SessionBinding(hostId, expectedAccountId, profileId, owner)`，并在每批及resume后fail closed验证身份。
- profile persistence只能证明浏览器状态可能留存；不能证明token有效、账号正确或任务已完成。storage state导出包含Cookie/local storage，应进入SecretStore/0600临时区且有明确销毁策略。

## 5. 工具能力、网络、文件与输出

### 5.1 能力面

- 固定README生成了69个公开tool schema，其中27个标read-only、42个非read-only；默认core+tab共24项。生成脚本从已安装core bundle读取schema，因此这些计数是固定根文件事实，但不是精确alpha源码逐行证明。[生成脚本](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/update-readme.js#L23-L54) [测试意图](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/tests/capabilities.spec.ts#L17-L78)
- 默认core含导航、tab、点击、输入、拖放、上传、evaluate、network details、截图和unsafe run-code。生成工具表把network/storage/config/pdf/vision/devtools/testing标为附加capability，但CLI `--caps`说明只列vision/pdf/devtools，类型声明又列出完整集合；其余capability的精确CLI可达性未运行验证。固定公开配置仍没有逐工具减法allowlist，不能把默认core裁成生产只读子集。[默认工具](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/README.md#L860-L1131) [生成工具表](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/README.md#L1132-L1599) [CLI caps](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/README.md#L413-L418) [类型集合](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/config.d.ts#L19-L31)
- 工具`Read-only`标记对页面动作有用，但无法表达local write或secret read：`browser_storage_state`标read-only却会保存Cookie/localStorage文件，截图、snapshot、console、network response、trace、video与PDF也能写产物。
- `browser_run_code_unsafe`明确是server进程RCE级能力；`--init-page`也执行本地TypeScript并持有page对象，`--init-script`则在每页脚本前运行。它们只能属于开发者显式配置/探索工具，绝不能进入Agent可控的生产只读Provider。[unsafe tool](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/README.md#L1043-L1051) [initial state](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/README.md#L511-L536)

### 5.2 网络与文件

- allowed/blocked origins默认允许全部，且固定文档明确不覆盖redirect、不是安全边界。即使配置allowlist，也不能据此证明redirect/private-network/DNS变化被完整限制。[README](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/README.md#L409-L412)
- `browser_navigate`接受任意URL，network detail工具可回传request/response headers和body。若通用MCP暴露给不可信Agent或网络客户端，就形成条件性server-network访问与秘密外泄面；本次未运行或做PoC。
- 文件上传/drag接受绝对路径，storage state可读写文件，unsafe code可从文件加载。默认workspace/output根只是一层误操作guardrail，固定类型声明明确说不能当安全边界。[文件配置](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/config.d.ts#L238-L244) [file upload](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/README.md#L913-L944)
- `outputMaxSize`默认未设置；相邻实现此时完全不回收。即使设置，也只在单次response序列化后运行、跳过当前response写入的文件，并递归删除该output目录内最旧的其他文件；既没有单文件/单响应上限，共享目录还可能清理非本次运行产物。未来Rednote应使用专属run目录，并设置逐响应、逐文件、逐运行和磁盘总量四级预算。[相邻实现](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/tools/backend/response.ts#L239-L267)

## 6. 安全、秘密、控制面与风险边界

| ID | 严重性 | 固定证据与静态判断 | Rednote边界 |
|---|---|---|---|
| MCP-01 | 高（服务暴露时） | HTTP/SSE配置只声明host/port/allowedHosts，README明确server不是安全边界；没有固定文档证据表明内置用户认证、能力token或TLS。[配置](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/config.d.ts#L112-L128) [安全声明](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/README.md#L798-L800) | 默认stdio或loopback；若必须IPC，外层强认证、客户端身份、mTLS/Unix socket与精确tool allowlist |
| CAP-01 | 高 | 默认工具可输入/点击/导航/上传/evaluate；unsafe tool由项目明示RCE-equivalent。[工具](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/README.md#L869-L1109) | 生产Provider不注册通用MCP工具；只暴露固定的list/detail/media descriptor |
| SECRET-01 | 高 | storage capability读取明文Cookie、local/session storage并导出state；network详情返回headers/body；extension复用现有登录态。[storage](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/README.md#L1198-L1353) [network](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/README.md#L1002-L1022) | 原始秘密不得进入LLM、stdout、session log、普通artifact；只提供用途限定SecretRef |
| SESSION-01 | 高 | persistent/extension/CDP/shared context均无账号身份断言；shared context按定义跨HTTP client共享状态。[配置](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/config.d.ts#L37-L154) | 专用profile、单账号owner/lease、expectedAccountId、恢复后校验；禁止日常浏览器与跨client context |
| NETWORK-01 | 高（不可信调用者时） | 任意导航+网络body读取；origin规则默认all且不覆盖redirect，也不是安全边界。[README](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/README.md#L409-L412) | Provider层精确HTTPS host/path allowlist、每跳重验、拒绝private/loopback/link-local；不向Agent开放原始navigate |
| LOCAL-01 | 高 | 文件上传、drop、storage state、unsafe file/code和产物写入组成local read/write面；项目自己说明file guardrail可被有意绕过。[config](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/config.d.ts#L238-L244) | OS sandbox+独立文件broker+allowed roots/realpath/no-follow；remote read与local write分权 |
| LOCAL-02 | 高（暴露HTTP且不可信客户端时） | 相邻实现会采用MCP client声明的首个root作为`clientInfo.cwd`，继而成为workspace/output和文件guardrail基准；无root才回退server cwd。故client roots不能作为服务端文件授权来源。[server.ts](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/tools/utils/mcp/server.ts#L118-L137) [root解析](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/tools/utils/mcp/server.ts#L205-L228) [文件基准](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/tools/backend/context.ts#L390-L423) | server固定workspace/allowed roots；客户端root只作显示或更窄请求，永不扩大OS/服务端授权 |
| CONNECT-01 | 中高 | 固定配置可grant browser permissions、忽略HTTPS错误、设置proxy、连接CDP/remote endpoint并携带headers；remote options还声明可转发`exposeNetwork`。这些会扩大设备、TLS、秘密和网络拓扑能力。[README](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/README.md#L416-L440) [config.d.ts](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/config.d.ts#L69-L102) | 生产默认禁止；确有需要时固定endpoint/CA/permissions/egress并以SecretRef注入headers，不允许Agent覆盖 |
| STATE-01 | 中高 | 固定根没有operation ID、journal、unknown-outcome或幂等重放协议；HTTP session和profile都不是业务checkpoint | 动作断连/超时标unknown，不盲重试；Core持久化cursor/task/asset receipt |
| DOCKER-01 | 高（长驻暴露时） | 官方示例以`0.0.0.0`长驻并说明任何MCP client可连接；镜像ENTRYPOINT关闭Chromium sandbox。[README](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/README.md#L805-L830) [Dockerfile](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/Dockerfile#L49-L67) | D级；不沿用长驻无认证通用服务或`--no-sandbox`默认 |
| RISK-01 | 中高 | 项目没有XHS账号风险状态机、验证码停止、限速/Retry-After、账号熔断或人工resume checkpoint | 浏览器/CDP/延迟不是风控证明；CAPTCHA/AUTH/429/安全限制必须全局暂停并人工恢复 |

- `[项目声明]` secrets只用于把匹配明文从tool response替换掉，类型声明明确称它是便利功能、不是安全机制。[config.d.ts](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/config.d.ts#L149-L154)
- `[相邻源码证据]` 当前相邻实现会对文本response做精确字符串替换，但可选session log会原样写parsed tool args；仅result已走response redaction。Cookie/network/config中未登记的secret、tool args、截图/图片、PDF、trace、video、download及其他二进制artifact都不能由精确字符串替换完整保护。精确alpha行为仍未知。[response.ts](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/tools/backend/response.ts#L214-L223) [browserBackend.ts](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/tools/backend/browserBackend.ts#L84-L105) [sessionLog.ts](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/tools/backend/sessionLog.ts#L39-L65)
- `[相邻源码证据]` 相邻版本对Chromium默认加入`AutomationControlled`相关启动标志。它只能登记为隐藏自动化痕迹的实现存在，不能视为有效、合规或账号安全证明，Rednote明确排除采用。[config.ts](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/tools/mcp/config.ts#L176-L241)

## 7. 状态、checkpoint、失败恢复与诊断

| 审查面 | 固定/相邻证据 | 结论 |
|---|---|---|
| MCP transport session | 相邻实现以随机session ID保存在进程内map，连接关闭即删除 | 连接隔离机制，不是durable checkpoint |
| browser profile | persistent保存登录状态；isolated默认关闭即丢失 | secret/session state，不是canonical同步进度 |
| save session | 配置可把tool call/result写入output dir | 人工诊断artifact，不是事务journal，且可能含敏感输入 |
| timeout/cancel | action/navigation有timeout，MCP signal传给tool | 不证明页面副作用被回滚；超时结果可能unknown |
| output budget | 默认无预算；可选阈值在response后清理旧artifact | 只借鉴概念，不替代单响应/单任务/磁盘配额 |
| Rednote cursor/assets | 项目无domain model | 完全由历史实施 Stage 3 Core继续独占 |

相邻实现的HTTP session与heartbeat证据见 [http.ts](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/tools/utils/mcp/http.ts#L42-L175) 与 [server.ts](https://github.com/microsoft/playwright/blob/bcb3563aa73d7ac71ac8cb877433201b1b97b7da/packages/playwright-core/src/tools/utils/mcp/server.ts#L55-L179)。Rednote不得从`saveSession`、storage state、profile存在或MCP session存活推导note/media已完成。

## 8. 依赖、测试、CI、制品与许可证

### 8.1 依赖与可追溯性

- package-lock v3包含98个package entry（含根）与97个非根节点；静态清点97个resolved与97个integrity，全部来自npm registry，是依赖内容完整性的正面信号。只有可选`fsevents`节点标记install script。未执行SCA，不能推导无CVE或许可证兼容。
- `playwright`、`playwright-core`和`@playwright/test`固定到同一alpha；`@modelcontextprotocol/sdk`与`@types/node`在manifest是范围，但lock固定解析结果。根package实际运行代码来自core bundle，因此未来采用必须固定已发布tag/tarball，核对integrity、源码revision、browser revisions、ThirdPartyNotices与构建provenance。
- `roll.js`在不传版本时查询`playwright@next`并执行`npm install`，随后从任意相邻`../playwright`工作树复制config并重生成README，却未验证该工作树与所选alpha的`gitHead`一致；这是维护脚本，不是可复现release来源映射。项目自己的release说明也明确说可靠边界应由已发布alpha的npm `gitHead`确定，本轮没有联网取得它。[roll.js](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/roll.js#L1-L49) [release说明](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/.claude/skills/release.md#L24-L39)
- `index.d.ts`的返回类型直接引用MCP SDK，但SDK只列为devDependency，不是runtime/peer dependency。普通CLI包装层不直接导入它；TypeScript programmatic consumer是否必须自行安装SDK属于消费端依赖契约未知。[类型声明](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/index.d.ts#L17-L21) [manifest](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/package.json#L39-L46)
- 固定`config.d.ts`在包根仍使用monorepo内部相对导入`../../..`；`roll.js`只尝试替换旧的`'playwright-core'`字面值，因此本次复制不会修正该相对导入。`.npmignore`又明确把config声明纳入发布包。TypeScript consumer实际如何解析尚未编译验证，应登记为类型制品漂移，而不是断言必然失败。[config.d.ts](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/config.d.ts#L17-L18) [roll.js](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/roll.js#L5-L14) [.npmignore](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/.npmignore#L1-L6)

### 8.2 测试与CI

- 根仓库有5个tracked spec文件、8个静态test声明；capability test核对工具名，其他只覆盖install-browser help、navigate、click与CommonJS加载。项目说明主要MCP源码/测试已迁入Playwright monorepo，因此根测试不是完整能力或安全回归门。[根测试意图](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/tests/capabilities.spec.ts#L17-L78) [迁移说明](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/CONTRIBUTING.md#L58-L83)
- manifest定义`ftest`/`wtest`项目，但固定`playwright.config.ts`只声明`chrome`与条件性`chromium-docker`，属于静态配置漂移；未执行，不能断言具体失败表现。[scripts](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/package.json#L18-L30) [projects](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/playwright.config.ts#L21-L37)
- GitHub CI在pull request/push运行README一致性、三OS测试和Docker测试，是正面覆盖；本轮未运行，不能写成通过。该workflow没有显式workflow/job级`permissions`，其`GITHUB_TOKEN`权限取决于仓库/组织默认值；虽未见secrets传入，也不能推定它已固定为`contents: read`。[ci.yml](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/.github/workflows/ci.yml#L1-L73)
- 2个GitHub workflows共有19个外部`uses`，全部是major/version tag而非完整commit SHA。Azure模板也使用可变`refs/tags/release`。这些是供应链输入漂移，不表示已经被篡改。
- GitHub npm发布workflow配置`id-token: write`且注释意图使用OIDC，并在publish前运行lint与Chromium测试；MCP Registry与Docker Azure登录也配置OIDC，Docker job还指定environment。实际Trusted Publisher、npm provenance、registry attestation、environment审批和branch protection结果均未动态核验。[publish.yml](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/.github/workflows/publish.yml#L9-L155)
- npm release job由GitHub release事件触发，但没有显式核对release tag与`package.json/server.json`；版本一致性检查只在后续Registry job。属于发布正确性门缺口，不证明实际发生错发。[publish.yml](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/.github/workflows/publish.yml#L46-L109)
- Registry job从GitHub `latest` URL下载publisher并直接pipe到`tar`，无版本/hash/signature校验。Azure alpha链虽用ESRP managed identity/审批字段，但Build只跑`npm ci`和no-op `npm run build`，不运行lint/test，再打包发布test dist-tag。[registry](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/.github/workflows/publish.yml#L100-L109) [Azure](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/.azure-pipelines/publish.yml#L24-L124)
- README有21处`@playwright/mcp@latest`，Docker示例使用`--pull=always`；适合快速体验，不应进入Rednote固定供应链。固定树也没有`.dockerignore`，不能用`.gitignore`推定Docker build context中的本地秘密或runtime文件被排除。[安装示例](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/README.md#L28-L45) [Docker示例](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/README.md#L803-L835)

### 8.3 Docker与许可证

- Docker四个FROM都源自同一个`node:22-bookworm-slim` tag、未固定digest；build使用lock安装依赖并下载Chromium，最终使用非root`node`是正面边界，但ENTRYPOINT固定`--no-sandbox`。[Dockerfile](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/Dockerfile#L1-L67)
- Playwright浏览器下载制品的revision与下载逻辑属于core依赖；此前 [`Playwright专项报告`](../playwright/review.md) 已记录固定revision和浏览器制品完整性未知。本项目不能用npm lock integrity替代浏览器二进制hash/signature/provenance。
- 根LICENSE与package metadata均为Apache-2.0；源码再分发需履行许可证、版权与修改声明，并在上游制品包含NOTICE时保留相关NOTICE。根树本身没有NOTICE；lock的97个非根节点虽都有许可证字符串，但这不是许可证正文/义务审计。实际core tarball、ThirdPartyNotices、浏览器二进制和依赖许可材料未核验，根Apache不能替代第三方清单。[LICENSE](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/LICENSE#L1-L20) [package](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/package.json#L1-L16)
- tracked test TLS private key是公开fixture且`.npmignore`默认排除tests；本轮未检查实际npm tarball，故不能断言任何已发布制品内容。[npmignore](https://github.com/microsoft/playwright-mcp/blob/7e0457a7cbf88823bf0146d12c46ae12c6818247/.npmignore#L1-L6)

## 9. 对 Rednote Sync 的具体参考价值

### 9.1 可clean-room借鉴的设计

1. 为浏览器运行显式建模persistent/isolated/CDP/extension/remote，不把这些模式隐含在单一session字符串里。
2. `ProfileLease`在启动前fail closed检查并发占用；再补`expectedAccountId + owner + generation`。
3. 固定tool schema声明read-only/action；相邻实现映射为`readOnlyHint/destructiveHint/openWorldHint`。Rednote应进一步扩展为remote/local/secret/platform多维capability与默认deny allowlist。
4. HTTP Host检查只作为DNS rebinding局部防护；认证、调用者身份与tool authorization另层实现。
5. 客户端断开/heartbeat清理browser资源；未知结果与业务checkpoint由Core另行持久化。
6. 输出目录、自动命名、oldest-first预算和secret redaction可作为diagnostic artifact设计起点，但需要默认启用的单文件/运行预算、0600、retention与字段级scrub。
7. accessibility snapshot/network/DOM可用于**人工监督的适配器探索**；发现事实进入版本化decoder前不得成为canonical数据。

### 9.2 必须独立实现或排除

- 不以通用Playwright MCP作为历史实施 Stage 4 Provider；只实现`listPage/getDetail/getMediaDescriptor`窄接口。
- 不注册`browser_run_code_unsafe`、evaluate、upload/drop、cookie/storage、raw network body、route、init script、extension、shared context或任意navigate给生产Agent。
- 不把固定Read-only标记或相邻实现的`readOnlyHint`等同无本地写/无secret/无平台副作用；每个tool显式列能力与审批要求。
- 不连接用户日常浏览器；专用profile、单账号互斥、ExpectedAccountId及每轮/恢复后的身份验证。
- 不用MCP session、profile或session transcript接管[`sync-core.md`](../../../projects/rednote-sync-core/docs/sync-core.md)中的SQLite canonical state、cursor、task/failure和逐资产receipt。
- CAPTCHA、AUTH变化、429、安全限制、cursor/schema drift立即全局暂停并保存checkpoint，等待人工显式恢复；不自动换profile/代理/账号继续。

### 9.3 阶段边界

- **历史实施 Stage 3 不改变：** 继续完全离线；本仓库、Playwright、浏览器、Cookie、CDP和MCP服务均不进入Core。
- **历史实施 Stage 4 另立规格和授权门：** Playwright MCP最多作为研究/诊断工具；生产Adapter应使用更窄的受审浏览器库/sidecar，具固定版本、专用profile、只读allowlist、SecretRef、审计和人工停止/恢复。

## 10. 采用分级与排除项

| 等级 | 对象 | 结论 |
|---|---|---|
| A | 无端到端生产组件 | 不存在可直接接入Rednote同步链的组件 |
| B | profile模式与lease词汇、tool schema/注解、Host检查、生命周期清理、输出预算、accessibility/network探索 | clean-room借鉴；仅研究/诊断或窄化实现 |
| C | programmatic MCP connection、HTTP/SSE session、trace/video/PDF、storage工具 | 通用自动化背景资料，不进入同步MVP |
| D | 通用MCP生产集成、HTTP暴露、unsafe/evaluate/upload/raw network/storage、extension/shared context、`--no-sandbox` Docker、stealth/隐藏自动化、现有制品链直接继承 | 排除直接采用 |

总体评级：**B（Agent探索与架构局部参考）；生产同步器直接集成D。** Apache-2.0本身不阻止按条款复用，但core provenance、权限面、安全边界与阶段目标使clean-room窄化实现更合适。

## 11. 未知项、证据等级与独立复审

### 11.1 未知项

- 未运行项目、测试、浏览器或MCP；实际tool schema、HTTP行为、性能、兼容性和安全属性未知。
- 未取得`1.63.0-alpha-2026-08-05` npm tarball/source-map/tag/build provenance；相邻`bcb3563…`源码与alpha的精确差异未知。
- 已发布npm/MCP Registry/Docker制品是否与固定commit一致、是否含provenance/SBOM/签名/完整许可证材料未知。
- 固定`config.d.ts`的`../../..`相对类型导入和`index.d.ts`对dev-only MCP SDK类型的依赖，在真实消费者项目中的TypeScript解析结果未知。
- README的CLI capability枚举、生成工具表和`config.d.ts`集合不一致；`config.d.ts`还称默认userDataDir为临时目录，而README说明MCP默认persistent profile。它们是固定文档/声明漂移，精确runtime行为需对alpha tarball验证。
- HTTP反向代理、TLS、认证、branch protection、Azure/GitHub environment审批和仓库外策略未知。
- GitHub CI未显式收紧`permissions`时的实际默认token权限，以及npm发布的Trusted Publisher/OIDC绑定和实际provenance未知。
- allowedHosts/origins、file guardrail、output budget、secret redaction、session log和shared context的精确alpha实现未知；相邻源码只支持设计判断。
- 浏览器下载制品hash/signature/license、97个依赖CVE/许可证/可达性、Docker image内容均未核验。
- 任何真实XHS成功率、验证码率、风控/封禁变化和账号安全均未知；没有官方证据证明浏览器、CDP、extension、slow typing或自动化隐藏措施降低风险。

### 11.2 证据等级

1. **A级：** 固定根commit的tracked源码、配置、lock、workflow、Dockerfile、LICENSE。
2. **B级：** 固定根README/生成工具清单与未运行测试意图。
3. **C级：** 已有Playwright monorepo `bcb3563…`的相邻源码；只能支持设计与风险方向，不能证明精确alpha行为。
4. **D级：** 静态数据流推断和部署条件；均保留前提，不声称已发生攻击、泄漏或平台副作用。

### 11.3 独立复审

- **证据与链接复审：PASS。** 88 个固定 GitHub blob 链接、全部本地 Markdown 链接、revision/tree/34 个 tracked 文件和静态计数均已复核；固定根与相邻实现的证据等级没有混用。
- **安全复审：PASS。** HTTP/Host、客户端 roots、工具权限/RCE、secret/二进制产物、profile/CDP/extension/shared context、输出预算、Docker sandbox 与风控停止边界均已闭环。
- **供应链、许可证与适配复审：PASS。** npm lock、CI/release、Docker、类型依赖、Apache-2.0 条件义务、B/D 分级及 历史实施 Stage 3 与历史实施 Stage 4 边界均已复核。
- 最终未关闭 finding：**P0–P3 均为 0**。
