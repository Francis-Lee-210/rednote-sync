# offline-input-v1 离线输入协议

状态：**已实现契约**。本协议保持单一顶层 `account`，并要求列表、详情和 scope 使用同一账号身份；这是历史实施 Stage 3 的简化假设，不表示未来产品三条账号路线必须如此。

未来需要区分关系所属、列表采集、详情采集和写回账号，但当前尚未定义字段或迁移方案，见[账号身份概念模型](../../../docs/design/account-identity-model.md)。

`offline-input-v1` 是 `fixture` 和 `import-json` 共用的严格 envelope。它描述一组可按 scope + request cursor 精确重放的页面，以及显式失败重试数据。

> `src/offline-input.ts` 中的 `FixtureSession` runtime decoder 是唯一权威。`schemas/offline-input-v1.schema.json` 是机器可读说明，不表达全部跨记录 provenance、Unicode 规范化、规范 URL、内容摘要和唯一性规则。

测试通过 `scripts/json-schema-contract.mjs` 离线执行该 Schema。这个零依赖 evaluator 会拒绝它不认识的 Schema 关键字，只覆盖本文件实际使用的 2020-12 子集；用途是防止说明与样例漂移，不参与 CLI 生产解码。

## 创建和验证 envelope

顶层必须恰好包含以下五个字段；任何额外或缺失字段都会被拒绝。

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| `schemaVersion` | number | 必须为 `1` |
| `mode` | string | `fixture` 或 `import-json`，并必须等于 CLI `--adapter` |
| `account` | object | 下面定义的 exact account；必须等于 CLI `--host` + `--account` |
| `pages` | array | 页面按 scope + `requestCursor` 唯一 |
| `retryItems` | array | 重试条目按 scope + `noteId` 唯一 |

```bash
node ./src/cli.ts validate-input \
  --adapter fixture \
  --input "$PWD/examples/offline-v1/no-media-success.json" \
  --host xhs \
  --account synthetic-demo-account
```

验证输出只含 version、mode 和聚合计数；不会输出输入路径、正文、URL、account/note/media/board ID 或 secret。此命令不接收 root、不打开 SQLite、不写文件。它验证媒体相对路径的语法，但媒体文件身份、大小和字节在对应详情被 `sync` 实际读取时再进行 no-follow 校验。

`import-json` 不会猜测第三方字段，也不会把任意 JSON 转换为本协议。调用者必须先生成完整、规范化且 exact 的 envelope；区别仅是 `mode: "import-json"` 的 provenance 标签。

## Envelope 字段

### Account 和 scope

Account 必须恰好包含：

| 字段 | 类型 |
| --- | --- |
| `schemaVersion` | 固定 `1` |
| `hostId` | `xhs` 或 `rednote` |
| `accountId` | safe ID |
| `displayName` | string 或 `null` |
| `firstSeenAt` | UTC ISO 时间 |
| `lastSeenAt` | UTC ISO 时间，不能早于 `firstSeenAt` |

每个 scope 必须恰好包含 `hostId`、`accountId`、`target`、`boardId`：

- 普通 `posted`、`collected`、`liked` scope 的 `boardId` 必须为 `null`。
- `collected_album` scope 的 `boardId` 必须是 safe ID。
- 每个 page/retry scope 的 host/account 必须等于顶层 account。

safe ID 经 NFC、trim 后必须为 1–200 字符，不能包含控制字符、`/`、`\`，也不能为 `.` 或 `..`。UTC 时间必须使用精确的 `YYYY-MM-DDTHH:mm:ss.sssZ` 形式并能无损往返 JavaScript ISO 时间。

### Page

普通 page 必须恰好包含：

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| `scope` | scope | 账户 provenance 一致 |
| `requestCursor` | safe ID 或 `null` | 是查找键的一部分，不能由 note ID 推导 |
| `nextCursor` | safe ID 或 `null` | `hasMore: true` 时运行阶段要求非空且推进 |
| `hasMore` | boolean | 是否存在下一页 |
| `items` | array | 最多 10 项；每项 exact `{ "noteId": ... }`；页内唯一 |
| `details` | array | 必须与 items 中 note ID 一一对应且无重复 |

list failure page 额外且仅额外包含 `listFailure`。此时 `items` 和 `details` 必须为空；允许类别为 `AUTH_REQUIRED`、`RATE_LIMITED`、`NETWORK`、`PROTOCOL`。

同一 envelope 中 `(hostId, accountId, target, boardId, requestCursor)` 只能对应一个 page。一个 `FixtureSession` 只允许一次 `listPage` 调用；一次 CLI `sync` 最多消费一页。继续分页需要用同一 envelope 再次调用，让 durable cursor 选择下一页。

### Successful detail

成功 detail 必须恰好包含 `note`、`revisionAt`、`claimedPayloadSha256`、`mediaSetComplete`、`media`。

`note` 是不带 canonical `media` 和 `contentHash` 的输入 note，且必须恰好包含：

| 组 | 字段 |
| --- | --- |
| identity | `schemaVersion`, `hostId`, `accountId`, `noteId`, `publicUrl` |
| content | `title`, `body`, `noteType`, `tags` |
| author | exact `author: { id, name, publicUrl }` |
| time | `publishedAt`, `updatedAt`, `capturedAt` |
| metrics | exact `metrics: { liked, collected, commented, shared }` |
| membership | `memberships` |

约束：

- `schemaVersion` 为 `1`；`noteType` 为 `text|image|video|mixed|unknown`。
- `hostId/accountId` 必须等于 page/retry scope，`noteId` 必须等于 list/retry 条目。
- `publicUrl` 必须是当前 host adapter 对 note ID 生成的无 query/hash 规范 HTTPS URL；author URL 为 `null` 或同 host 的规范 HTTPS URL。
- 普通 membership 的 `boardId/boardName` 都为 `null`；专辑 membership 使用 safe board ID，name 可为 string/null。
- 至少一个 membership 必须精确匹配当前 scope。
- metrics 为非负安全整数或 `null`；`capturedAt` 非空，其余 note 时间可为 `null`。
- runtime 根据不含媒体结果的 semantic note 重算 source digest。`claimedPayloadSha256` 为 `null` 时不声明摘要；非空时必须为 64 位小写 SHA-256 且与重算值完全一致。

Page 中的详情失败使用 exact `{ "noteId", "failure" }`，允许 `AUTH_REQUIRED|RATE_LIMITED|NETWORK|PROTOCOL|DETAIL|EXPORT`。

### Media 和 retry

每个成功媒体条目是以下两个 exact 形态之一：

```json
{"kind":"image","ordinal":1,"mediaId":"synthetic-media","relativePath":"media/synthetic.gif"}
```

```json
{"kind":"image","ordinal":1,"mediaId":"synthetic-media","failure":{"category":"MEDIA","retryAt":null}}
```

`kind` 为 `cover|image|video`，`ordinal` 是 1 至 `Number.MAX_SAFE_INTEGER` 的安全整数，同一 detail 中 `(kind, ordinal)` 唯一。成功路径必须是 NFC 相对路径，不能是 POSIX/drive absolute，不能含空段、`.`、`..`、反斜杠或控制字符；读取时所有祖先、leaf identity 和 no-follow 条件会再次核对。MIME 与扩展名只由实际 magic bytes 推导，不信任文件名。

Retry item 必须恰好包含 `scope`、`noteId`、`detail`。`detail` 是成功 detail，或 exact `{ "failure": { ... } }`；失败类别与 page detail failure 相同。`retry-failures` 只读取与数据库未解决失败匹配的显式 retry item，`listPage` 调用次数必须为零，progress 不改变。

所有 failure 都恰好包含 `category` 和 `retryAt`。只有 `RATE_LIMITED` 可携带非空 UTC retry time；其他类别必须为 `null`。原始服务消息不属于协议，也不得进入日志或输出。

## 不变量和失败行为

- 所有 object 都是 exact record；额外字段不是向前兼容扩展，而是 exit 2 的无效输入。
- Envelope mode、CLI adapter、CLI account、顶层 account、page/retry scope、item/detail note 必须形成完整 provenance 链。
- Page 和 retry 查找必须唯一；details 必须与 items 精确覆盖；重复 ID 或 cursor key 被拒绝。
- Canonical URL、source rank 和 content hash 都由本地运行时规范化/重算，调用者不能注入 canonical hash。
- metrics 和 media ordinal 都受 `Number.MAX_SAFE_INTEGER` 上限约束；解释性Schema也编码同一上限。
- 输入 root 及其祖先、JSON、媒体祖先和 leaf 均拒绝 symlink、路径身份变化、Unicode/case 碰撞和越界。
- JSON 默认最大 16 MiB，单个媒体默认最大 512 MiB；这些是 `FixtureSession` capability 限制，不是网络下载额度。
- Decoder 成功仅说明离线 envelope 和声明 provenance 合法，不证明任何真实小红书 URL、账号、API、签名或在线行为有效。

## 运行合成失败与重试

```bash
node ./src/cli.ts sync --root "$DEMO_ROOT" --adapter fixture --input "$PWD/examples/offline-v1/failure.json" --host xhs --account synthetic-demo-account --target posted --minimum-interval-ms 0
node ./src/cli.ts retry-failures --root "$DEMO_ROOT" --adapter fixture --input "$PWD/examples/offline-v1/retry-success.json" --host xhs --account synthetic-demo-account --target posted
node ./src/cli.ts verify --root "$DEMO_ROOT"
```

第一条命令按设计 exit 5 并持久化安全失败；第二条用显式 retry item 修复，预期 exit 0。两者都不联网。
