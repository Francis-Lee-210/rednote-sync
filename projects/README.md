# Rednote Sync Core

状态：**已实现契约**。这是历史实施 Stage 3 交付的离线同步 Core；“历史实施 Stage 3”属于旧研发阶段，不是当前产品阶段三。包版本 `0.0.0-stage3` 保持不变。

2026-09-12 已重构本地处理内核：列表检查点与逐帖任务分离，媒体流式保存，导出在数据库提交后进行。关系所属账号、列表采集账号与内容采集账号可分别记录，支持用另一份离线输入补全失败项并保留尝试来源。现行实现细节见仓库中的 `projects/docs/sync-core.md`。

严格离线、以 SQLite 和不可变对象为事实源的小红书导出同步核心；当前阶段用于验证本地输入、状态机、Markdown/JSON/media 投影和本地安装制品，不连接真实账号。

> 重要：此包保持 `private: true`、`license: UNLICENSED`，没有发布到 npm，也未授予再分发许可。版本 `0.0.0-stage3` 是阶段检查点，不代表稳定版或正式发布。只支持 Node.js 26 和 macOS；Windows、Linux、其他 Node 主版本均会被安装元数据和 CLI 运行时门禁拒绝。历史实施 Stage 4 的浏览器登录、Cookie、签名、真实 API 和在线验收尚未开始，也不得由这里的命令隐式启用。

## 支持矩阵

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| Node.js 26 | 支持 | `engines` 固定为 `>=26 <27`，CLI 启动时再次检查 |
| macOS (`darwin`) | 支持 | 当前唯一完成文件系统与安装验证的平台 |
| Windows / Linux | 不支持 | 安装和运行均拒绝，不声称兼容 |
| 网络或浏览器账号 | 不支持 | 本阶段没有在线适配器，也不读取登录会话 |
| npm 公共发布 | 未发布 | `private: true`、`UNLICENSED`，只做本机 tarball 验证 |

## 快速开始

以下命令从 `projects/` Core 项目目录运行，只使用已提交的合成数据。示例中的 ID 和规范 URL 都是人为构造的测试值；`synthetic.gif` 只是以 `GIF89a` 开头、用于触发 MIME 检测的合成字节，不是可展示图片。

```bash
node --version
npm run test:offline-demo
```

第一次同步连续处理两页，随后两次命令验证幂等重放：

<!-- offline-demo-smoke:start -->
```bash
set -eu
PROJECT_ROOT="$(pwd -P)"
DEMO_PARENT="$(cd "${TMPDIR:-/tmp}" && pwd -P)"
DEMO_ROOT="$(mktemp -d "$DEMO_PARENT/rednote-sync-demo.XXXXXX")"
DEMO_ROOT="$(cd "$DEMO_ROOT" && pwd -P)"
chmod 700 "$DEMO_ROOT"

node "$PROJECT_ROOT/src/bin.js" validate-input --adapter fixture --input "$PROJECT_ROOT/examples/offline-v1/no-media-success.json" --host xhs --account synthetic-demo-account
node "$PROJECT_ROOT/src/bin.js" init --root "$DEMO_ROOT"

node "$PROJECT_ROOT/src/bin.js" sync --root "$DEMO_ROOT" --adapter fixture --input "$PROJECT_ROOT/examples/offline-v1/no-media-success.json" --host xhs --account synthetic-demo-account --target liked --limit 1 --minimum-interval-ms 0
node "$PROJECT_ROOT/src/bin.js" sync --root "$DEMO_ROOT" --adapter fixture --input "$PROJECT_ROOT/examples/offline-v1/no-media-success.json" --host xhs --account synthetic-demo-account --target liked --limit 1 --minimum-interval-ms 0
node "$PROJECT_ROOT/src/bin.js" sync --root "$DEMO_ROOT" --adapter fixture --input "$PROJECT_ROOT/examples/offline-v1/no-media-success.json" --host xhs --account synthetic-demo-account --target liked --limit 1 --minimum-interval-ms 0

node "$PROJECT_ROOT/src/bin.js" status --root "$DEMO_ROOT" --host xhs --account synthetic-demo-account --target liked
node "$PROJECT_ROOT/src/bin.js" verify --root "$DEMO_ROOT"
```
<!-- offline-demo-smoke:end -->

`DEMO_ROOT` 在 `mktemp` 后立即通过 `cd` + `pwd -P` 转为物理规范绝对路径，以满足 root identity 检查；示例不会自动删除它，便于检查输出。

离线默认 `--minimum-interval-ms 0`，连续调用无需等待。调用方可显式设置更长间隔；该参数不提供在线适配器。

## 安全边界和运行要求

- 运行时必须是 Node.js 26；安装包无运行依赖。开发和构建先运行 `npm ci --ignore-scripts`，固定开发依赖与完整依赖树记录在 `package.json` 和 `package-lock.json`。
- `--root` 必须是规范化绝对路径，最终目录归当前用户所有且权限严格为 `0700`。路径的任何祖先或输入文件都不能是符号链接；大小写或 Unicode 身份碰撞会被拒绝。
- `validate-input` 不接收 `--root`，不打开或创建 SQLite，也不写知识库。它复用运行时 exact decoder 和 account provenance 校验，只输出计数；媒体文件字节会在实际 `sync` 使用对应详情时才读取。
- 所有历史实施 Stage 3 命令均严格离线。代码静态检查禁止网络内置模块和 `fetch`；离线演示还在 Node permission mode 下不给子进程网络权限。
- 一次 `sync` 连续处理当前输入中可用的页面，在列表结束、追到已有前沿或遇到停止条件时结束。详情和媒体逐帖处理；普通详情失败不阻止后续帖子，未完成项可以单独重试。没有后台循环或并行目标。
- 不要把 Cookie、会话、token 或其他秘密值写入 envelope、参数、root 或路径。正文中的普通 URL、查询参数、校验码和媒体注释可以保留；内容不会仅因形似凭据而被拒绝。

## 检查本机能力

从 Core 项目目录或本地安装后运行 rootless preflight：

```bash
node ./src/bin.js doctor
# 本地安装后也可以运行：rednote-sync doctor
```

`doctor` 只在系统临时目录创建一个私有 `mkdtemp` 探针并在返回前删除。它验证 Node 26、darwin、POSIX uid、`node:sqlite`、`O_NOFOLLOW`、`O_DIRECTORY`、物理临时路径、`0700`/`0600`、目录 `fsync`、hardlink 和 no-clobber 创建能力；还会创建真实符号链接并要求以 `O_NOFOLLOW` 打开时得到 `ELOOP` 拒绝。14 项结果都只报告布尔值；命令不接收 `--root`，不访问网络，也不输出探针路径或 uid。

## 显式迁移旧状态

迁移不会在 `init`、`sync` 或 `status` 时自动执行：

```bash
rednote-sync migrate --root "$DEMO_ROOT"
```

当前只接受结构和指纹均精确匹配的 schema v0，并在一个 `BEGIN IMMEDIATE` 事务内迁移到 v1。future schema、modified schema、current v1 和第二个 writer 会被拒绝；迁移失败会回滚。命令不会另建备份，因此在迁移前是否制作独立备份由操作者决定。

## 在本机打包和安装

打包检查保留私有包、受支持运行环境、无运行依赖和无安装生命周期脚本等要求。包内容以 `package.json` 的产物目录和文档列表为准，新增运行模块无需同步多份文件名清单。检查先验证编译输出和合成离线样例，再在临时目录运行 `npm pack`，将本地 tarball 安装到另一个临时工程并执行 CLI 验收；npm 子进程使用独立空 cache、offline 和 ignore-scripts。
```bash
npm run pack:check
```

该命令连续执行两次 pack 并要求两个 tarball 逐字节相同。每次都直接解析 tar entry：所有路径先过禁止规则，directory、symlink 和特殊 entry 一律拒绝；tar 内 `package/package.json` 也须满足同一安装约束。命令只输出一行 JSON，其中包含 tarball SHA-256、包内逐文件 SHA-256 inventory、文件数与大小；临时 tarball、cache、安装目录和同步 root 在结束时删除，不会在 Core 项目目录留下安装测试的 `node_modules` 或 `.tgz`；开发依赖目录保留。它不发布包。

如需保留一份仅供本机安装的 tarball，应在 Core 项目目录显式选择私有输出目录：

```bash
LOCAL_PACK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/rednote-local-pack.XXXXXX")"
npm run build:check
npm pack --json --offline --ignore-scripts --no-audit --no-fund --pack-destination "$LOCAL_PACK_DIR" .
```

然后在目标 macOS/Node 26 工程中，从上一步 JSON 返回的本地 `.tgz` 路径执行：

```bash
npm install --offline --ignore-scripts --no-audit --no-fund --package-lock=false /absolute/path/to/rednote-sync-core-0.0.0-stage3.tgz
./node_modules/.bin/rednote-sync doctor
```

安装包只含 `README.md`、`package.json`、标准 TypeScript 编译生成的 `dist/` 运行文件、[离线输入文档](docs/offline-input-v1.md)、[离线输入 Schema](schemas/offline-input-v1.schema.json)和完全合成的 `examples/offline-v1/`。`tsconfig.build.json` 使用 `rewriteRelativeImportExtensions` 将相对 TypeScript 模块路径转换为 JavaScript 路径；`npm run build:check` 在临时目录重新编译并逐文件核对 `dist`，编译失败不会覆盖既有输出。新增、删除或移动源文件由编译器发现，不维护第二份模块清单。TypeScript、Node 类型和 Ajv 仅供开发检查，安装包运行时不加载这些依赖。原型、研究、抓包、凭据和浏览器 profile 不进入分发制品。

## 验证和同步离线输入

`fixture` 和 `import-json` 使用同一个 `offline-input-v1` exact envelope。`import-json` 只表示“已经规范化成该 envelope 的导入数据”，不是把任意 JSON 转换成知识库的通用转换器。

```bash
node ./src/bin.js validate-input \
  --adapter import-json \
  --input "$PWD/examples/offline-v1/import-json-success.json" \
  --host xhs \
  --account synthetic-import-account
```

完整字段、不变量、失败形式和 provenance 规则见 [offline-input-v1 文档](docs/offline-input-v1.md)，机器可读说明见 [JSON Schema](schemas/offline-input-v1.schema.json)。运行时 `FixtureSession` decoder 始终是权威；JSON Schema 不能替代跨字段和规范 URL 校验。

Core 项目开发时，`npm run check` 会先按脚本内固定规则发现离线文档、Schema 和全部样例，再与项目内部的离线产物 allowlist exact 比较；manifest 不决定读取范围。门禁逐级拒绝符号链接和 Core 项目目录逃逸，并拒绝漏扫产物、credential 字段/值、tokenized URL、非 synthetic ID 和占位符。Ajv 按 JSON Schema 2020-12 检查全部 JSON 样例，URI 格式由 ajv-formats 校验；不修改输入，也不替代运行时 decoder。检查脚本和内部 manifest 不进入本地安装包。

已提交的完全合成样例：

| 文件 | 用途 |
| --- | --- |
| `examples/offline-v1/no-media-success.json` | 两页、无媒体成功，并支持首页幂等重放 |
| `examples/offline-v1/media-success.json` | 成功存储合成 GIF magic bytes |
| `examples/offline-v1/failure.json` | 产生可重试的 `DETAIL` 失败 |
| `examples/offline-v1/retry-success.json` | 用显式 `retryItems` 修复上述失败，且不调用 list page |
| `examples/offline-v1/import-json-success.json` | 已规范化的 `import-json` envelope |

## 理解输出

canonical 数据：

```text
<root>/state/rednote-sync.sqlite
<root>/objects/sha256/<前两位>/<sha256>
```

可重建派生视图：

```text
<root>/accounts/<accountDigest>/account.json
<root>/accounts/<accountDigest>/notes/<noteDigest>.md
<root>/accounts/<accountDigest>/assets/<noteDigest>/<kind>-<ordinal>.<ext>
<root>/accounts/<accountDigest>/data/notes/<noteDigest>.json
<root>/accounts/<accountDigest>/data/index.json
<root>/accounts/<accountDigest>/data/index.csv
<root>/accounts/<accountDigest>/data/failures.json
<root>/accounts/<accountDigest>/logs/export-runs.jsonl
```

原始 account/note ID 不参与磁盘路径；目录名是稳定 SHA-256 digest。SQLite 和 immutable objects 是唯一事实源，`accounts/` 下的文件可由 `repair-views` 重建。`verify` 只读检查 canonical 引用和派生视图收据。

每个 CLI 命令只向 stdout 写一行 JSON。成功为 `ok: true`；非零退出（包括带警告的已提交结果）为 `ok: false`。安全诊断只写 stderr，且不回显输入路径、正文或 ID。

| 退出码 | 含义 |
| ---: | --- |
| 0 | 成功，或同步因最小间隔尚未到而安全 `not_due` |
| 1 | 未分类的内部失败 |
| 2 | 参数、JSON、exact schema 或 provenance 输入无效 |
| 3 | 需要认证；历史实施 Stage 3 只会重放合成失败，不执行登录 |
| 4 | 被限流；历史实施 Stage 3 只会重放合成失败 |
| 5 | 网络/协议/详情类阻塞或仍有未解决详情失败 |
| 6 | export、state 或内部持久化失败 |
| 7 | 已暂停 |
| 8 | 另一个 writer 正在持有 SQLite 写锁 |
| 9 | 媒体部分失败或派生视图不完整/陈旧 |

## 开发验证与阶段边界

```bash
npm ci --ignore-scripts
npm run typecheck
npm run build:dist
npm run check
npm run build:check
npm run test:release
npm test
npm run pack:check
npm run test:offline-artifact
npm run test:offline-demo
npm run test:readme-smoke
```

工作区另有历史实施阶段一至三的内部设计与审查材料，但这些材料不进入本地安装包，避免把逆向报告或研究材料混入分发制品。

历史实施 Stage 3（包括 3C 离线加固与产品化）已经全部完成并通过独立终审。在当时的实施路线中，真实网站行为、登录会话、浏览器适配器、签名环境、限流和账号端到端验证被留给历史实施 Stage 4；这项旧边界不构成当前产品账号路线的禁令。当前工作状态以仓库中的 `docs/design/roadmap.md`为准。
