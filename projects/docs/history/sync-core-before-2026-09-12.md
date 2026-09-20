> 状态：**历史快照，已被替代。** 本文保留 2026-09-12 重构前的实现规格；其中单账号、整页事务、合并、节流和编译规则不再是现行要求。当前行为只见 [Core 实现契约](../sync-core.md)。

# Rednote Sync Core 实现规格（历史实施 Stage 3）

状态：**已实现契约**。本文中的历史实施 Stage 3 与历史实施 Stage 4 均指旧研发阶段，不对应当前三个产品功能阶段。

本规格沿用插件逆向得到的单账号工作流，并在实现时把关系所属、列表采集和详情采集简化为同一个 `account`。这个限制仍是现行事实；未来多身份概念见[账号身份概念模型](../../../docs/design/account-identity-model.md)，本文不据此改变任何规范类型或行为。

状态：历史实施 Stage 3（3A、3B、3C）已完成并通过独立审查；暂停在历史实施 Stage 4 之前
日期：2026-08-12
运行时：Node.js 26；零第三方依赖；使用内置 `node:sqlite`

## 1. 目的与规范用语

本规格定义一个独立、本地优先的 TypeScript 同步核心和 CLI。它把用户主动提供的点赞、收藏、发布及收藏专辑数据转换为可重复使用的本地知识库，不复刻两个商业客户端的 UI、许可证或远端服务。

“必须”“禁止”是实现和验收条件。“待动态验证”表示旧客户端静态证据不足以证明当前在线行为；历史实施 Stage 3 不得把这些事实硬编码为已验证协议。

历史实施 Stage 3 只实现离线 fixture/import adapter。浏览器登录、Cookie、页面签名和真实 API 属于历史实施 Stage 4，并且必须再次取得用户明确授权。

## 2. MVP、非目标与安全边界

### 2.1 历史实施 Stage 3 MVP

- Node 26 可直接运行的 TypeScript CLI；
- 确定性 fixture adapter 和用户导出 JSON import adapter；
- `posted`、`collected`、`liked`、`collected_album` 统一模型；
- 每次 `sync` 最多读取一页、详情/媒体并发度 1、低频、可暂停；
- account + host + target + 可选 board 的严格状态隔离；
- SQLite 中唯一 canonical state 与 ACID 命令事务；
- 内容寻址、不可变 JSON/Markdown/media object store；
- 可重建的 notes、assets、index、failures、run JSONL 派生视图；
- 媒体部分失败、失败重试、人工跳过、幂等和异常终止测试。

### 2.2 非目标

历史实施 Stage 3 禁止：

- 商业客户端的许可证、授权码、设备绑定、到期或免费额度逻辑；
- 作者 Supabase、`notionify.net`、Notion API 或任何其他远端服务；
- Cookie/账号/代理/设备池、自动换号、反检测或限流规避；
- 签名算法破解、`xsec_token` 生成或转换；
- AI 分类、OCR、转写、评论全量、向量数据库或 GUI；
- 后台无限循环、高频抓取、多目标并行；
- 把 note ID 当作服务端 cursor；
- 历史实施 Stage 3 中的任何网络请求或浏览器控制。

### 2.3 数据与操作边界

- 只处理用户自己的点赞、收藏、发布内容或用户主动提供的导出文件。
- 不得读取工作区根下的 `prototypes/test-cookie.txt`、`prototypes/xsec_token.txt` 或同类凭据文件；从本文档所在位置看，对应路径为 `../../../prototypes/test-cookie.txt` 和 `../../../prototypes/xsec_token.txt`。
- 历史实施 Stage 3 不得导入 `node:http`、`node:https`、`node:http2`、`node:net`、`node:tls`、`node:dns`，不得调用全局 `fetch`。
- Cookie、`web_session`、`a1`、`xsec_token`、Notion Secret、AI key、授权码、Supabase key 都是 secret，不得进入 SQLite、object、派生视图、日志、异常、stdout/stderr 或路径。
- 用户输入只读；不得复制原始导出到知识库。
- SQLite 与通过 hash 验证的 object store 是唯一 source of truth；所有稳定人类可读文件都是可重建视图。

## 3. 架构与提交边界

```text
CLI
  -> SyncEngine
       -> HostAdapter
       -> SessionAdapter
       -> RednoteClient / RetrySource
       -> SqliteStateStore (node:sqlite DatabaseSync)
       -> ContentAddressedObjectStore
       -> Exporter[]
       -> DerivedViewProjector[]

canonical:
  state/rednote-sync.sqlite
  objects/sha256/<prefix>/<sha256>

derived:
  accounts/<accountDigest>/notes
  accounts/<accountDigest>/assets
  accounts/<accountDigest>/data/index.{json,csv}
  accounts/<accountDigest>/data/failures.json
  accounts/<accountDigest>/logs/export-runs.jsonl
```

核心规则：

1. accounts、普通/专辑 progress、note manifests、target tasks、failures、runs、view generation 全在同一个 SQLite 数据库。
2. 所有会改变 canonical 数据的命令必须先 `BEGIN IMMEDIATE`，在一个事务中提交全部结果；第二 writer 立即得到 busy 并退出 8。
3. JSON、Markdown 和媒体先写为 hash 命名的不可变 object；SQLite 事务只引用已存在且重新验证过的 object。
4. 更新 note 永不覆盖旧 object。事务回滚只可能留下未引用 orphan；旧 DB 版本仍引用完整旧 object。
5. stable notes/assets/index/failures/run JSONL 是 derived view，不是 cursor durable 条件。缺失、陈旧或短暂超前都从 DB/object 重建，不等于 canonical integrity failure。
6. progress tuple 只在完整成功页的同一 SQLite commit 中转换。失败、暂停和 blocker 页可持久化 note/task/failure/run outcome，但必须逐字段保留原 progress tuple。
7. 进程异常终止时依赖 SQLite ACID 回滚和 OS 自动释放数据库锁；hard crash 不承诺留下 run audit，只承诺 DB 不出现半事务。

## 4. 统一类型

实现不得使用运行时 TypeScript `enum`；使用字符串联合、`as const` 和 runtime decoder。

```ts
type Brand<T, Name extends string> = T & { readonly __brand: Name };

type HostId = "xhs" | "rednote";
type AccountId = Brand<string, "AccountId">;
type AccountKey = Brand<string, "AccountKey">;
type NoteId = Brand<string, "NoteId">;
type BoardId = Brand<string, "BoardId">;
type ServerCursor = Brand<string, "ServerCursor">;
type IsoDateTime = Brand<string, "IsoDateTime">;
type Sha256 = Brand<string, "Sha256">;
type RelativePath = Brand<string, "RelativePath">;

type SyncTarget = "posted" | "collected" | "liked" | "collected_album";
type OrdinarySyncTarget = Exclude<SyncTarget, "collected_album">;

interface OrdinaryScope {
  readonly accountId: AccountId;
  readonly hostId: HostId;
  readonly target: OrdinarySyncTarget;
  readonly boardId: null;
}

interface AlbumScope {
  readonly accountId: AccountId;
  readonly hostId: HostId;
  readonly target: "collected_album";
  readonly boardId: BoardId;
}

type PartitionScope = OrdinaryScope | AlbumScope;

interface AccountPartition {
  readonly accountId: AccountId;
  readonly hostId: HostId;
}

type SourceMembership =
  | {
      readonly target: OrdinarySyncTarget;
      readonly boardId: null;
      readonly boardName: null;
      readonly observedAt: IsoDateTime;
    }
  | {
      readonly target: "collected_album";
      readonly boardId: BoardId;
      readonly boardName: string | null;
      readonly observedAt: IsoDateTime;
    };

type TaskStatus = "pending" | "paused" | "done" | "partial" | "failed" | "skipped";
type InMemoryTaskStatus = TaskStatus | "running";

type ErrorCategory =
  | "INVALID_INPUT"
  | "AUTH_REQUIRED"
  | "RATE_LIMITED"
  | "NETWORK"
  | "PROTOCOL"
  | "DETAIL"
  | "MEDIA"
  | "EXPORT"
  | "STATE"
  | "DERIVED_VIEW"
  | "PAUSED"
  | "BUSY"
  | "INTERNAL";

interface Account {
  readonly schemaVersion: 1;
  readonly accountId: AccountId;
  readonly hostId: HostId;
  readonly displayName: string | null;
  readonly firstSeenAt: IsoDateTime;
  readonly lastSeenAt: IsoDateTime;
}

interface Author {
  readonly id: string | null;
  readonly name: string | null;
  readonly publicUrl: string | null;
}

interface Metrics {
  readonly liked: number | null;
  readonly collected: number | null;
  readonly commented: number | null;
  readonly shared: number | null;
}

interface ListItem {
  readonly noteId: NoteId;
  readonly publicUrl: string;
  readonly titleHint: string | null;
  readonly authorHint: Author | null;
  readonly membership: SourceMembership;
  readonly capturedAt: IsoDateTime;
}

type MediaKind = "cover" | "image" | "video";
type MediaStatus = "stored" | "failed" | "skipped";

interface MediaSlot {
  readonly kind: MediaKind;
  readonly ordinal: number;
}

interface ObjectRef {
  readonly sha256: Sha256;
  readonly byteLength: number;
  readonly mimeType: string;
}

interface Media {
  readonly mediaId: string;
  readonly kind: MediaKind;
  readonly ordinal: number;
  readonly status: MediaStatus;
  readonly extension: string | null;
  readonly object: ObjectRef | null;
}

interface Note {
  readonly schemaVersion: 1;
  readonly accountId: AccountId;
  readonly hostId: HostId;
  readonly noteId: NoteId;
  readonly publicUrl: string;
  readonly title: string | null;
  readonly body: string;
  readonly noteType: "text" | "image" | "video" | "mixed" | "unknown";
  readonly author: Author;
  readonly publishedAt: IsoDateTime | null;
  readonly updatedAt: IsoDateTime | null;
  readonly capturedAt: IsoDateTime;
  readonly tags: readonly string[];
  readonly metrics: Metrics;
  readonly memberships: readonly SourceMembership[];
  readonly media: readonly Media[];
  readonly contentHash: Sha256;
}

interface SourceRank {
  readonly revisionAt: IsoDateTime | null;
  readonly payloadSha256: Sha256;
}

declare const VALIDATED_SOURCE_RANK: unique symbol;
interface ValidatedSourceRank extends SourceRank {
  readonly [VALIDATED_SOURCE_RANK]: true;
}

interface MediaSlotState {
  readonly slot: MediaSlot;
  readonly sourceRank: SourceRank;
  readonly media: Media | null;
  readonly tombstone: boolean;
}

type CatchupStop =
  | { readonly kind: "frontier"; readonly noteIds: readonly [NoteId, ...NoteId[]] }
  | { readonly kind: "service_end" };

interface SyncProgress {
  readonly phase: "backfill" | "head" | "catchup";
  readonly cursor: ServerCursor | null;
  readonly cursorSource: "response.nextCursor" | null;
  readonly reachedEnd: boolean;
  readonly headFrontier: readonly NoteId[];
  readonly catchupStop: CatchupStop | null;
  readonly pendingHeadFrontier: readonly NoteId[];
}

interface SyncState extends OrdinaryScope {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly progress: SyncProgress;
  readonly stopReason: "AUTH_REQUIRED" | "RATE_LIMITED" | "PROTOCOL" | null;
  readonly lastAttemptAt: IsoDateTime | null;
  readonly lastSuccessfulAt: IsoDateTime | null;
  readonly nextAllowedAt: IsoDateTime | null;
}

interface AlbumState extends AlbumScope {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly boardName: string | null;
  readonly progress: SyncProgress;
  readonly stopReason: "AUTH_REQUIRED" | "RATE_LIMITED" | "PROTOCOL" | null;
  readonly lastAttemptAt: IsoDateTime | null;
  readonly lastSuccessfulAt: IsoDateTime | null;
  readonly nextAllowedAt: IsoDateTime | null;
}

interface FailureRecord {
  readonly schemaVersion: 1;
  readonly failureId: string;
  readonly scope: PartitionScope;
  readonly noteId: NoteId;
  readonly mediaSlot: MediaSlot | null;
  readonly sourceRank: SourceRank | null;
  readonly category: ErrorCategory;
  readonly stage: "detail" | "media" | "export";
  readonly safeMessage: string;
  readonly retryable: boolean;
  readonly attemptCount: number;
  readonly firstOccurredAt: IsoDateTime;
  readonly lastOccurredAt: IsoDateTime;
  readonly retryAt: IsoDateTime | null;
  readonly resolvedAt: IsoDateTime | null;
  readonly resolvedReason: "repaired" | "skipped" | null;
}

interface TaskRecord {
  readonly schemaVersion: 1;
  readonly scope: PartitionScope;
  readonly noteId: NoteId;
  readonly status: TaskStatus;
  readonly attemptCount: number;
  readonly failureIds: readonly string[];
  readonly skipReason: string | null;
  readonly skippedAt: IsoDateTime | null;
  readonly firstSeenAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
}

interface NoteArtifacts {
  readonly json: ObjectRef;
  readonly markdown: ObjectRef;
}

interface NoteManifest {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly accountId: AccountId;
  readonly hostId: HostId;
  readonly noteId: NoteId;
  readonly canonicalNote: Note;
  readonly semanticSourceRank: SourceRank;
  readonly mediaSlots: readonly MediaSlotState[];
  readonly artifacts: NoteArtifacts;
  readonly indexEntrySha256: Sha256;
  readonly csvRowSha256: Sha256;
}

type RunOutcome =
  | "committed"
  | "committed_with_warnings"
  | "not_due"
  | "paused"
  | "blocked"
  | "failed";

interface RunRecordBase {
  readonly runId: string;
  readonly outcome: RunOutcome;
  readonly startedAt: IsoDateTime;
  readonly finishedAt: IsoDateTime;
  readonly safeErrorCategory: ErrorCategory | null;
  readonly listed: number;
  readonly done: number;
  readonly partial: number;
  readonly failed: number;
  readonly skipped: number;
}

type RunRecord =
  | (RunRecordBase & {
      readonly command: "sync" | "retry" | "skip" | "ack";
      readonly account: AccountPartition;
      readonly scope: PartitionScope;
    })
  | (RunRecordBase & {
      readonly command: "repair_views";
      readonly account: AccountPartition;
      readonly scope: null;
    });

interface SchemaMigrationRecord {
  readonly migrationId: string;
  readonly command: "init_schema" | "migrate_schema";
  readonly fromVersion: number | null;
  readonly toVersion: number;
  readonly startedAt: IsoDateTime;
  readonly finishedAt: IsoDateTime;
  readonly outcome: "committed";
  readonly safeErrorCategory: null;
}
```

### 4.1 类型与状态不变量

- `PartitionScope`、`SourceMembership`、list request、task 和 failure 都是 discriminated union：普通目标 board 必须为 null；专辑目标 board 必须非空。
- Note 稳定 key 是 `(hostId, accountId, noteId)`；scope key 再加入 target/board。所有 key 用 canonical JSON 后 SHA-256 生成，不用下划线拼接。
- `AccountKey=sha256(canonicalJson([hostId,accountId]))`。业务 RunRecord的 account必须逐字段等于其 scope account；`repair_views` RunRecord必须 scope=null且只带 AccountPartition。
- `NoteId` 与 `ServerCursor` 是不同 brand。cursor 只能由 list response 独立 `nextCursor` decoder 构造，禁止从 note ID、最后成功项或文件名转换。
- `Media` 不含 failure ID。failure 只由 SQLite failures 行和 task-failure 关系表达。
- `TaskStatus="running"` 禁止持久化；running 只存在当前进程内。SQLite 只保存 final `done/partial/failed/skipped/paused/pending`。
- `partial` 必须有至少一个未解决、完整 scope、同 note 的 failure 关系；`done` 不得引用未解决 failure；`skipped` 必须有 `skipReason/skippedAt`。
- `phase=head` 时 cursor=null、reachedEnd=true、catchupStop=null；`backfill/catchup` 时 reachedEnd=false；`catchup` 必须有非空 cursor、non-null stop 和 pending head frontier。
- `CatchupStop.frontier` 在类型和 runtime decoder 中强制 non-empty；空 frontier 必须使用 `service_end`。
- 所有时间 UTC ISO-8601；计数非负安全整数或 null；0 不代表未知。

## 5. 私有 transient 与 secret 边界

### 5.1 Private access factory

```ts
declare const PRIVATE_NOTE_ACCESS: unique symbol;

interface PrivateNoteAccess {
  readonly [PRIVATE_NOTE_ACCESS]: true;
  use<T>(consumer: (secret: string | null) => T): T;
  toJSON(): never;
}

interface TransientListItem {
  readonly item: ListItem;
  readonly access: PrivateNoteAccess;
}

interface TransientNote {
  readonly note: Omit<Note, "media" | "contentHash">;
  readonly mediaSources: readonly TransientMediaSource[];
  readonly sourceRank: ValidatedSourceRank;
  readonly mediaSetComplete: boolean;
}
```

`PRIVATE_NOTE_ACCESS` 是模块内唯一 `unique symbol`，禁止 `Symbol.for`，不得导出 symbol。模块只导出 factory、predicate 和 client 受控 consumer。secret 存在模块私有 `WeakMap`；marker、`use`、`toJSON` 都不可枚举，实例冻结。`toJSON` 固定抛边界错误；含函数的实例不可 structured clone。logger、SQLite binder、object exporter、derived projector、error normalizer 和 `util.inspect` formatter 都先递归调用 predicate 拒绝该对象。

### 5.2 URL 和动态 secret registry

输入边界必须：

1. 验证 note/board/account ID，不直接 cast brand。
2. 输入 URL只用于确认 host/note ID；公开 URL由 HostAdapter 重建，删除全部 query、fragment、userinfo。
3. 每发现一个 secret 字段、token 或 tokenized URL，把原始 secret value 注册进仅内存 `MemorySecretRegistry`，随后丢弃或封装。registry 不可持久化，进程结束即消失。
4. 每次 SQLite bind、object 写入、derived 输出、path、stdout/stderr 前调用统一 `assertPersistenceSafe(value, registry)`，检查 private marker、敏感字段名、已注册 value、URL query、synthetic canary 和 token-like 值。
5. safe error 只用固定模板与安全 ID；禁止复制原始 Error message、request/response、headers、URL 或 stack。

CLI `--reason` 限 1–80 个 Unicode 字符，禁止 URL、控制字符、`= % &` 和连续 16+ 位 base64/hex/字母数字 token-like 片段，并经过同一 registry/canary 扫描。

## 6. 接口契约

### 6.1 HostAdapter

```ts
interface HostAdapter {
  readonly hostId: HostId;
  readonly webOrigin: string;
  parseNoteId(value: unknown): NoteId;
  parseBoardId(value: unknown): BoardId;
  publicNoteUrl(noteId: NoteId): string;
  sanitizeImportedUrl(value: string, expectedNoteId: NoteId): string;
  normalizeAuthorPublicUrl(value: string | null): string | null;
}
```

纯函数、无 I/O。只接受精确 HTTPS origin；拒绝相似域、userinfo、非默认端口。返回 public URL必须无 query/fragment。旧客户端中的 host/origin/路径当前有效性是**待动态验证**。

### 6.2 SessionAdapter

```ts
interface SessionHandle {
  readonly hostId: HostId;
  readonly opaqueSessionBrand: symbol;
}

interface SessionAdapter {
  readonly mode: "fixture" | "import" | "browser";
  open(host: HostAdapter, signal: AbortSignal): Promise<SessionHandle>;
  identify(handle: SessionHandle, signal: AbortSignal): Promise<Account>;
  close(handle: SessionHandle): Promise<void>;
}
```

handle 不可序列化、不得传给 SQLite/exporter/logger。`identify` 必须和 CLI scope 的 host/account 精确一致；不一致不自动迁移状态。历史实施 Stage 3 只实现 fixture/import。

### 6.3 RednoteClient 与 RetrySource

```ts
interface ListPageRequest {
  readonly scope: PartitionScope;
  readonly cursor: ServerCursor | null;
  readonly limit: number;
}

interface TransientListPage {
  readonly scope: PartitionScope;
  readonly requestCursor: ServerCursor | null;
  readonly items: readonly TransientListItem[];
  readonly hasMore: boolean;
  readonly nextCursor: ServerCursor | null;
}

interface RednoteClient {
  listPage(session: SessionHandle, request: ListPageRequest, signal: AbortSignal): Promise<TransientListPage>;
  getDetail(session: SessionHandle, item: TransientListItem, signal: AbortSignal): Promise<TransientNote>;
}

interface RetrySource {
  load(
    scope: PartitionScope,
    noteId: NoteId,
    inputFile: string,
    signal: AbortSignal,
  ): Promise<TransientNote>;
}
```

- `runPage` 最多调用一次 `listPage`；limit 默认 5，允许 1–10；详情串行。
- 返回 page 的 scope/requestCursor 必须逐字段等于请求。
- `nextCursor` 只能来自 fixture/response 的独立 cursor 字段。
- RetrySource 从本轮显式 `--input` 按完整 scope+noteId 唯一查找；retry 调用 `listPage` 必须为 0，不扫描目录、不从旧日志恢复 private access。
- endpoint、方法、字段、排序、`has_more`、cursor、token 和签名全部**待动态验证**；历史实施 Stage 3 client 不含在线实现。

### 6.4 SQLite StateStore 与 AccountStore

```ts
interface SqliteReadSnapshot {
  readonly snapshotBrand: symbol;
  readonly kind: "read" | "write";
  readonly connectionIdentity: symbol;
  enumerateAccountsWithGenerations(): Iterable<AccountGenerationRecord>;
  enumerateViewGenerations(accountKey: AccountKey): readonly ViewGenerationRecord[];
  accountGeneration(account: AccountPartition): number;
  loadState(scope: PartitionScope): SyncState | AlbumState | null;
  loadManifest(account: AccountPartition, noteId: NoteId): NoteManifest | null;
  loadTask(scope: PartitionScope, noteId: NoteId): TaskRecord | null;
  enumerateAccountManifests(account: AccountPartition): Iterable<NoteManifest>;
  enumerateAccountTasks(account: AccountPartition): Iterable<TaskRecord>;
  enumerateUnresolvedFailures(account: AccountPartition): Iterable<FailureRecord>;
  enumerateRuns(account: AccountPartition): Iterable<RunRecord>;
  enumerateObjectRefs(account: AccountPartition): Iterable<ObjectRef>;
  retryCandidates(scope: PartitionScope, limit: number): readonly FailureRecord[];
  close(): void;
}

interface AccountGenerationRecord {
  readonly account: AccountPartition;
  readonly accountKey: AccountKey;
  readonly canonicalGeneration: number;
  readonly viewsDirty: boolean;
}

interface ViewGenerationRecord {
  readonly accountKey: AccountKey;
  readonly projectorId: ProjectorId;
  readonly generation: number;
  readonly complete: boolean;
  readonly receipts: readonly DerivedViewReceipt[];
  readonly safeError: string | null;
}

interface SqliteWriteSnapshot extends SqliteReadSnapshot {
  readonly kind: "write";
  readonly transactionIdentity: symbol;
  readonly intent: MutationIntent;
}

type MutationIntent =
  | { readonly command: "sync" | "retry" | "skip" | "ack"; readonly scope: PartitionScope }
  | { readonly command: "repair_views"; readonly account: AccountPartition };

interface SqliteSchemaTransaction {
  readonly transactionBrand: symbol;
  readonly command: "init_schema" | "migrate_schema";
}

interface CanonicalMutation {
  readonly scope: PartitionScope;
  readonly expectedStateRevision: number;
  readonly expectedManifestRevisions: Readonly<Record<string, number | null>>;
  readonly nextState: SyncState | AlbumState;
  readonly manifests: readonly NoteManifest[];
  readonly tasks: readonly TaskRecord[];
  readonly failures: readonly FailureRecord[];
}

interface AccountFinalization {
  readonly accountKey: AccountKey;
  readonly plannedGeneration: number;
  readonly projectionOutcomes: readonly [
    ProjectionOutcome & { readonly projectorId: "notes" },
    ProjectionOutcome & { readonly projectorId: "assets" },
    ProjectionOutcome & { readonly projectorId: "index" },
    ProjectionOutcome & { readonly projectorId: "failures" },
    ProjectionOutcome & { readonly projectorId: "runs" },
  ];
  readonly finalRun: RunRecord;
}

interface StateStore {
  openReadSnapshot(): SqliteReadSnapshot;
  beginImmediate(intent: MutationIntent): SqliteWriteSnapshot;
  beginSchemaImmediate(command: SqliteSchemaTransaction["command"]): SqliteSchemaTransaction;
  putCanonicalMutation(tx: SqliteWriteSnapshot, mutation: CanonicalMutation): void;
  finalizeAccount(tx: SqliteWriteSnapshot, finalization: AccountFinalization): void;
  putSchemaMigration(tx: SqliteSchemaTransaction, record: SchemaMigrationRecord): void;
  commit(tx: SqliteWriteSnapshot | SqliteSchemaTransaction): void;
  rollback(tx: SqliteWriteSnapshot | SqliteSchemaTransaction): void;
}

interface AccountStore {
  load(snapshot: SqliteReadSnapshot, hostId: HostId, accountId: AccountId): Account | null;
  upsert(tx: SqliteWriteSnapshot, account: Account): void;
}
```

`enumerateAccountsWithGenerations()` 按 accountKey bytes确定性排序并返回完整 generation/viewsDirty map；`enumerateViewGenerations(accountKey)` 固定按 notes/assets/index/failures/runs排序，返回每个 projector 的 generation/complete/receipts/safeError。verify、writer stale检测和repair都只能使用这些正式查询能力，禁止 hidden SQL。其余枚举器按 account key过滤并稳定排序，`retryCandidates` 再按完整 scope、retryAt/firstOccurredAt/failureId 取前 `limit` 条。`SqliteWriteSnapshot` 只能由持有 `BEGIN IMMEDIATE` 的同一个 `DatabaseSync` facade 创建；其 `connectionIdentity+transactionIdentity` 绑定所有 prepared statement。projector、store 或 commit 收到 read snapshot、另一连接 snapshot、已 close/commit snapshot时必须拒绝。

`CanonicalMutation` 是 runtime-validated command object，必须一次携带相关 state、manifest、media slot、artifact refs、tasks和failures；不能提供绕过 scope/foreign-key 检查的通用 SQL 字符串入口。`finalizeAccount` 是唯一 finalization API：在同一 tx内验证 accountKey/plannedGeneration、五项固定顺序 outcome和 finalRun account/scope，failure省略的receipts规范化为[]，再原子插入最终 RunRecord、五行 view generation并设置 account generation/views_dirty；任一不一致整体拒绝。`repair_views` 也必须通过该 API推进 G+1。projector不得执行 SQL、写 snapshot或借 hidden side channel持久化结果。

Account upsert 也必须确定性 merge：`firstSeenAt=min`、`lastSeenAt=max`；displayName 对所有非空候选先 NFC/trim，再取 UTF-8 bytes 较大的值，null 永不覆盖非空值。名称不借用合并后的 `lastSeenAt` 排名，避免丢失名称自身的观察时间而产生顺序依赖。该规则满足交换律、结合律、幂等律。

### 6.5 ContentAddressedObjectStore 与 MediaStore

```ts
interface ContentAddressedObjectStore {
  put(bytes: AsyncIterable<Uint8Array>, suggestedMimeType: string | null, signal: AbortSignal): Promise<ObjectRef>;
  verify(ref: ObjectRef): Promise<boolean>;
  open(ref: ObjectRef): Promise<ReadableStream<Uint8Array>>;
}

interface TransientMediaSource {
  readonly slot: MediaSlot;
  readonly suggestedMimeType: string | null;
  open(signal: AbortSignal): Promise<ReadableStream<Uint8Array>>;
}

interface MediaStore {
  put(source: TransientMediaSource, signal: AbortSignal): Promise<Media>;
  verify(media: Media): Promise<boolean>;
}
```

object path 固定为 `objects/sha256/{hash[0:2]}/{hash}`。写入流程：祖先 no-follow 检查；同目录随机 temp 以 `O_CREAT|O_EXCL|O_NOFOLLOW` 打开；流式 hash/长度；fsync temp；用不覆盖的原子 publish（同文件系统 hard-link/no-clobber）发布 hash path；fsync 目录；删除 temp。目标已存在时 no-follow 打开并重新验证 hash/长度后复用，绝不覆盖。SQLite 只引用验证成功 object。

canonical MIME 只由完整写入 bytes 的 magic-byte detector 推导，不信 suggested MIME、URL、输入文件名或第一次见到的 metadata；未知格式固定为 `application/octet-stream`/`.bin`。suggested MIME 仅可用于“不一致”诊断，不能进入 ObjectRef、hash选择或 merge排序。同一 bytes 在任何输入声明下必须得到同一 MIME/extension。媒体读取仅限经验证的 input root 普通文件，所有祖先不得是 symlink。

### 6.6 Exporter 与 DerivedViewProjector

```ts
interface Exporter {
  readonly id: "note-json" | "note-markdown";
  render(note: Note): AsyncIterable<Uint8Array>;
}

type ProjectorId = "notes" | "assets" | "index" | "failures" | "runs";

interface DerivedViewReceipt {
  readonly projectorId: ProjectorId;
  readonly accountKey: AccountKey;
  readonly generation: number;
  readonly relativePath: RelativePath;
  readonly sha256: Sha256;
  readonly byteLength: number;
}

type ProjectionOutcome =
  | {
      readonly projectorId: ProjectorId;
      readonly accountKey: AccountKey;
      readonly generation: number;
      readonly complete: true;
      readonly receipts: readonly DerivedViewReceipt[];
      readonly safeError: null;
    }
  | {
      readonly projectorId: ProjectorId;
      readonly accountKey: AccountKey;
      readonly generation: number;
      readonly complete: false;
      readonly receipts?: readonly DerivedViewReceipt[];
      readonly safeError: string;
    };

interface ProjectionContext {
  readonly plannedGeneration: number;
  readonly pendingRun: RunRecord | null;
}

interface DerivedViewProjector {
  readonly id: ProjectorId;
  project(
    snapshot: SqliteWriteSnapshot,
    account: AccountPartition,
    context: ProjectionContext,
  ): Promise<ProjectionOutcome>;
}
```

- Exporter 只接收安全 canonical Note；JSON/Markdown bytes 进入 immutable object store，DB manifest 引用 object hash。
- projector 必须返回上述 discriminated outcome：success必有 receipts/`complete:true`/`safeError:null`；failure必有固定安全错误/`complete:false`，receipts可省略。结果及每个 receipt的 account/id/generation必须与调用参数一致。不得把共享 index 整文件 hash 当逐-note artifact receipt。
- `indexEntrySha256/csvRowSha256` 是单 note 规范 entry/row digest；共享 index 是从 DB manifests 重建的 view。
- projectors 只接受绑定当前同一 `DatabaseSync` writer transaction 的 query-only `SqliteWriteSnapshot`，并只枚举传入 account；禁止 projector执行SQL或改变 snapshot。前四个 projector 的 `pendingRun=null`；runs projector唯一接收已确定但尚未入DB的 `pendingRun=finalRun`，将它作为只读 overlay与 snapshot旧runs合并渲染。每个 stable 文件用 temp+fsync+rename，projector generation marker最后原子发布；中途中断使 marker不匹配。
- projector 对目标文件先按 receipt hash/长度校验；bytes相同不得替换文件，因此相同 canonical content 重投影不改变 note/asset/index mtime。generation marker可更新，不计入内容幂等断言。
- view projection失败不改变 canonical 正确性。事务按 `(accountKey,projectorId)` 记录 generation、`complete=false` 和安全错误；命令可提交 canonical 数据并以 warning 退出。下一次操作该 account 的 writer按7.4只检测旧状态，并在含本次mutation的最终 generation做一次全量投影；只读verify仅校验并报告，显式`repair-views`负责整account重建。

## 7. SQLite schema 与事务规范

### 7.1 启动配置

数据库固定为 `state/rednote-sync.sqlite`。创建 root/state 时要求目录归当前 uid、mode 0700；新 DB mode 0600。打开前后逐级 `lstat` root/state/DB，并检查可能存在的 `-wal/-shm`，拒绝任一 symlink、非普通 DB 文件、非当前用户或 group/world writable state目录。`DatabaseSync` 不能从已 `O_NOFOLLOW` 的 fd直接构造，因此“检查后到 SQLite 打开前被同一用户并发换链”是个人本地威胁模型下明确保留的 TOCTOU 风险；历史实施 Stage 3 不声称消除此风险。

每个连接必须：

```sql
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 0;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
```

普通业务/read命令打开后立即检查 SQLite version、foreign key实际开启、WAL、路径权限和**完整** required schema/version，再允许创建 snapshot；失败是 `STATE`/exit6，不降级到JSON state。`init_schema` 是唯一允许完整schema尚不存在的入口，按7.3的bootstrap顺序执行。

### 7.2 规范化表

实现至少包含：

- `meta(schema_version)`；
- `schema_migrations(migration_id PK, command, from_version, to_version, times, outcome, safe_error_category)`；
- `accounts(account_key PK, host_id, account_id, display_name, first_seen_at, last_seen_at)`；
- `account_generations(account_key PK, canonical_generation, views_dirty, FOREIGN KEY account_key)`；
- `sync_states(scope_key PK, host_id, account_id, target, progress_json, stop_reason, attempt/success/next times, revision)`；
- `album_states(scope_key PK, host_id, account_id, target CHECK collected_album, board_id, board_name, progress_json, stop_reason, times, revision)`；
- `note_manifests(note_key PK, host_id, account_id, note_id, canonical_note_json, semantic_rank_json, content_hash, json_object_hash, markdown_object_hash, entry_hash, csv_hash, revision)`；
- `media_slots(note_key, kind, ordinal, source_rank_json, status, object_hash, extension, tombstone, PRIMARY KEY(note_key,kind,ordinal))`；
- `target_tasks(scope_key, note_key, status, attempt_count, skip_reason, skipped_at, first_seen_at, updated_at, PRIMARY KEY(scope_key,note_key))`；
- `failures(failure_id PK, scope_key, note_key, media_kind, media_ordinal, source_rank_json, category, stage, retryable, attempts, times, resolved fields)`；
- `task_failures(scope_key, note_key, failure_id, PRIMARY KEY(...), FOREIGN KEY...)`；
- `objects(hash PK, byte_length, mime_type, first_seen_at)`；
- `runs(run_id PK, account_key, scope_key NULL, command, outcome, times, safe category, counts)`；业务命令 scope非空，`repair_views` scope必须为 null；
- `view_generations(account_key, projector_id, generation, complete, receipts_json, safe_error, PRIMARY KEY(account_key,projector_id))`。

scope/note/account key 都由 canonical tuple digest 生成，同时保留原字段并在每次加载时复核。CHECK 必须强制普通/album board 规则、task 不允许 running、media ordinal>0、resolved fields 成对、partial/skip 关系由 transaction validator 二次检查。

缺失 scope state 在第一次 writer transaction 内初始化：revision=0；phase=backfill；cursor/cursorSource=null；reachedEnd=false；headFrontier=[]；catchupStop/pendingHeadFrontier为空；stop/times为空。AlbumState 的 boardId 独立列存，禁止和 cursor 组合编码。

### 7.3 schema transaction 与 account generation

`init_schema/migrate_schema` 是 global schema command，不创建、不伪造 `PartitionScope` 或业务 RunRecord：

1. `init_schema` 对缺失/空DB先只做路径权限、SQLite/foreign-key/WAL和事务能力的最小检查；随后 `BEGIN IMMEDIATE`，按固定DDL顺序创建v1全部表/索引/meta，写 committed SchemaMigrationRecord，执行完整schema/foreign-key检查，最后commit。完整检查失败整体rollback；除SQLite创建的空容器外无可见半schema。
2. `migrate_schema` 由显式 `migrate --root` 调用，不得在其他命令中自动执行。当前只接受结构与指纹精确匹配的v0，在一个独立 `BEGIN IMMEDIATE` 中执行v0→v1；modified、future和current-v1都拒绝。每一步写唯一 migration ID，最终执行当前版本完整schema检查后一次commit；失败整体rollback，命令不创建独立备份。
3. 失败只输出内存固定安全诊断，DB不留失败记录；`SQLITE_BUSY`立即exit8。除这两个discriminated schema commands外，任何命令面对空库、半schema或旧版本都必须在创建业务snapshot前拒绝。

canonical generation 按 account隔离。每个 account初始 generation=0；该 account任一 canonical account/state/manifest/task/failure/run mutation在一个 commit中只令 generation `G→G+1` 一次，其他 account generation不变。`view_generations(accountKey,projectorId)` 只有 `generation=G && complete=true && receipts通过` 才是当前；`account_generations.views_dirty` 是事务内派生布尔值：任一必需 projector行不满足上述当前且完整条件则为1，否则为0。只读 verify发现磁盘 receipt损坏只能报告，不能回写 dirty。

业务 `beginImmediate` 在 `BEGIN IMMEDIATE` 成功后、发出 `SqliteWriteSnapshot` 前立即建立模块私有 attempt SAVEPOINT。schema transaction不使用该attempt；普通业务commit/rollback自动结束它。SAVEPOINT只服务于7.4的 projection-time pause恢复，不是公开回滚点，也不能由command、projector或外部调用者命名、释放或重用。

`repair-views` 的粒度固定为完整 account，不接受 target/board伪范围。它从当前G读取整account，确定planned `G+1`，用pending Run overlay重建全部projectors，再由`finalizeAccount`同时写account-scoped RunRecord和最终generation；一次命令只推进一次。账号A的mutation/repair不得改变账号B的generation、marker、receipts或mtime。

### 7.4 所有业务 mutating command 的统一事务

`sync`、`retry-failures`、`task skip`、`acknowledge-stop`、`repair-views` 遵循：

1. 打开 DatabaseSync，执行 `BEGIN IMMEDIATE`，立即建立模块私有attempt SAVEPOINT，再创建绑定此连接/事务的 `SqliteWriteSnapshot`；`SQLITE_BUSY` 不等待，立即 rollback/close并退出8。SAVEPOINT创建失败时顶层rollback，绝不返回snapshot。
2. 通过 `enumerateAccountsWithGenerations/enumerateViewGenerations` 读取 account generation和旧 view状态，再读取scope/account/manifest/task/failure。若旧view stale/incomplete，只记录内存 `preexistingViewWarning`，**不得**先对G执行一轮projector，也不得因此阻止基于DB/object source of truth的业务mutation。
3. 执行命令；task running只在内存。所有 object先发布并验证，再把 object ref写入事务。page progress只在完整成功页写 next tuple；失败/暂停/blocker逐字段保留旧 tuple。
4. 写 canonical account/state/manifest/task/failure变更并计算该 account planned generation `G+1`。正常 no-op若仅需 RunRecord，该 run本身仍使 account generation推进一次。
5. 仅对planned G+1以固定顺序投影 `notes → assets → index → failures`，收集四个 `ProjectionOutcome`；一个失败不跳过后续 projector。旧warning若被本轮success覆盖则不进入最终RunRecord。
6. 仅根据本轮前四个outcome和业务结果确定 finalRun；随后以`pendingRun=finalRun`执行runs projector并取得第五个outcome。runs失败不递归改写 finalRun。
7. 恰好调用一次 `finalizeAccount(tx,{accountKey,plannedGeneration,projectionOutcomes:[5],finalRun})`，由其原子写run、五行view generation、account generation/views_dirty，然后COMMIT。任一最终outcome失败则dirty=1、CLI exit9；五项均成功则旧warning已修复、dirty=0。`repair-views`也只执行这一次G+1投影/finalization。
8. canonical validation/SQL/object ref错误整体 ROLLBACK。已发布但未引用 object是安全 orphan；既有 DB refs和旧 object保持完整。

projection阶段发现 pause/SIGINT 时使用专门恢复协议；它与item阶段已知pause后提交已完成项的路径不同：

1. 对**同一个**仍active的 `SqliteWriteSnapshot` 执行 `ROLLBACK TO` 内部attempt SAVEPOINT，不释放顶层 `BEGIN IMMEDIATE`，因此SQLite writer lock从原attempt到paused commit连续持有，不存在rollback→重新BEGIN窗口。
2. snapshot保留相同connection/transaction identity，但轮换模块私有epoch并重置mutation/business/finalization latch。旧 `CanonicalWritePlan`、`BusinessResult`、`ProjectionBatch` 全部因epoch不匹配失效；不得在paused replay复用或rebase旧capability。
3. 在writer lock仍持有时按10节逆序恢复本轮derived footprint。恢复失败则顶层ROLLBACK并固定归类为安全state/integrity错误；不能带着半恢复view提交paused结果。
4. replay从SAVEPOINT时的committed-old DB重新读取account。已有account逐字段保留，绝不再次upsert/merge本轮session account；只有首次运行、old DB中account不存在时才插入经验证的最小session account。
5. 在同一snapshot的新epoch中重新签发零mutation、零counter、`outcome=paused` 的business result，从old DB完整重投影，忽略仍存在的pause control以避免递归，重新finalize并COMMIT。原attempt的state/progress/manifest/task/failure变更全部回滚；最终canonical只新增paused Run并推进该account generation，五个view rows/markers随该old-DB投影更新，progress保持old tuple逐字段相同。

若进程在 project 后、COMMIT 前终止，stable view可能显示未提交新 snapshot，但 SQLite回滚。下一次操作该 account的 writer检测旧状态后直接在其planned generation全量覆盖；只读verify只报告stale，`repair-views`显式重建。超前/缺失view是recoverable stale view，不是canonical integrity conflict。

hard crash可能没有 runs行，因为 run outcome与其他 canonical数据同事务；不得另建独立审计真相。正常 no-op、paused、failure、blocker、warning必须有 committed RunRecord。各 projector失败必须被独立捕获、参数化测试，并遵守固定顺序。

### 7.5 pause control 例外

用户 `pause`/`resume` 使用 `control/{scopeDigest}.pause` 安全小文件，以便另一个进程在 writer transaction 运行时请求停止；它不包含 canonical data。创建用 no-follow/O_EXCL，读取核对内部完整 scope，路径只含 digest。engine 在 item/object/projector 边界检查；检测后把已完成 note/task/failure 和 `outcome=paused` 在当前 DB transaction 提交，progress tuple 原样保持。resume 只删除精确 scope control 文件，不清 DB stopReason。

## 8. Canonical merge、hash 与失败关系

### 8.1 确定性 merge

merge 必须满足交换律、结合律、幂等律；target A→B 与 B→A 最终 bytes/hash 相同。

`SourceRank`：有效 revisionAt 较新优先；null 最低；时间相同按候选 semantic payload SHA-256 bytes 较大者优先。不能用“最后写入”。

fixture/import/retry里的 SourceRank字段全部不可信。`VALIDATED_SOURCE_RANK` 是 rank模块私有 `unique symbol`，禁止导出或 `Symbol.for`；factory同时把冻结实例登记到模块私有 WeakSet。公开字符串brand、同形对象、复制symbol属性、JSON/structuredClone都不能取得 provenance。adapter runtime decoder必须严格解析真实 UTC ISO时间（无效/溢出/非规范字符串拒绝），从去除 capturedAt、access、输入 rank/hash等非语义字段后的规范 semantic payload重新计算 `payloadSha256`，再由factory创建 `ValidatedSourceRank`。输入若自带payloadSha256，必须与重算值恒定时间比较；不匹配以 INVALID_INPUT拒绝整条。canonical mutation/merge边界必须再次以 WeakSet predicate验证；伪造对象零mutation。

- key/public URL：key 精确一致；URL从 HostAdapter 重建。
- title/body/type/author/published/updated：按较高 rank 整组选择；NFC、换行规范化后排名。
- capturedAt：DB provenance 取最小值，不进入 public JSON/Markdown/index/contentHash。
- tags：规范后集合并集，UTF-8 bytes 排序。
- metrics：每个非空值取最大；真实下降语义**待动态验证**。
- memberships：唯一键 `[target,boardId]`，稳定排序。专辑 rename 选 observedAt 最大的非空名称，同时间按 bytes 较大者；observedAt 不进 public projection/hash。
- media：slot=`[kind,ordinal]`，kind 顺序 cover/image/video。stored 候选只有 object 验证后才可按 rank 接受；失败不覆盖 last-known-good。`mediaSetComplete=true` 且 rank 不低于旧 slot 时，未出现 slot 才能写 tombstone；普通缺省不是删除。相等 rank stored 按 object hash bytes 选择。tombstone 阻止旧输入复活。

### 8.2 contentHash projection

对以下固定键序、NFC、UTF-8 canonical JSON 做 SHA-256：

```text
{
  schemaVersion, hostId, accountId, noteId, publicUrl,
  title, body, noteType, author, publishedAt, updatedAt,
  tags, metrics,
  memberships: [{target, boardId, boardName}],
  media: [{kind, ordinal, status, extension,
           object: {sha256, byteLength, mimeType} | null}]
}
```

排除 contentHash 自身、captured/observed/run/attempt/failure 时间、failure IDs/messages、task status、source ranks 和 view receipts。JSON/Markdown/index 只序列化该 public projection。仅 runtime 捕获时间变化不得改 object hash或 stable view mtime。

### 8.3 FailureRecord、rank 与跨 target 修复

- failure ID=`sha256(canonicalJson([scope,noteId,stage,mediaSlot,category]))`；同全键重复失败复用 ID，attempt+1、first 保留、last 更新。resolve 操作必须同时带完整 scope/note/slot/stage/category 和当前 DB transaction snapshot，不得只凭 ID。
- media failure 必须保存产生失败的 `sourceRank`；detail/export failure 的 rank 为 null。
- 同 failure ID再次出现 media失败时，持久 sourceRank取 `max(existing.sourceRank,candidate.sourceRank)`；不能被后来的低 rank失败降级。detail/export始终保存 null，derived failures输出明确写 `sourceRank:null`。
- 成功/tombstone 只有先被 canonical slot merge 接受，并且 accepted rank `>= failure.sourceRank`，才可解决该 slot failure。低 rank success 即使 object 有效也不能清除高 rank failure。
- target B 的 accepted 高 rank media 可在同一 DB transaction 中解决 target A/B 同 note+slot 且 rank不高于它的 failures，删除相应 task relation，并把不再有 unresolved failure 的 partial task变为 done。
- skip 在同一 writer transaction 中写 `skipped/skipReason/skippedAt`，以 `resolvedReason=skipped` 解决该完整 scope 的相关 failures。仍被其他 scope引用的 media failure不得错误全局解决。
- `failures.json` 只从未解决 DB rows 重建，不是 source of truth。

## 9. 单页同步状态机

### 9.1 全局约束

- 一次 CLI 只操作一个完整 scope；一次 `sync` 最多一页；listPage 调用≤1。
- limit 默认 5、范围 1–10；详情、media、export并发度固定 1。
- 默认最小运行间隔 10 分钟。fixture test可注入 clock/零间隔；未来 browser adapter不得用参数规避平台限制。
- 每个 mutating command 从 `BEGIN IMMEDIATE` 到 COMMIT/ROLLBACK 持有单 writer transaction；第二 writer exit 8。
- 该“client/object/projector均在长 writer transaction内”的设计只允许历史实施 Stage 3 离线 fixture/import：engine记录安全的 elapsed/progress计数，并在每个 item/object/projector边界检查 pause。历史实施 Stage 4 接浏览器前必须另立规格和审查门，改为事务外低频预取/下载，再用短 `BEGIN IMMEDIATE` 对 expected account/state/manifest revisions、输入 rank和已验证 object refs重新校验后提交；本规格不承诺当前长事务可直接上线。

### 9.2 runPage 顺序

1. 验证 CLI/input/output/scope，创建安全 run ID。
2. `BEGIN IMMEDIATE`；读取当前 committed state。pause control存在则提交 paused RunRecord，progress 不变，exit 7。
3. 未到 nextAllowedAt 则提交 not_due RunRecord，零 client调用，exit 0。
4. 打开离线 session、核对 account/host。
5. cursor：backfill/catchup 使用 progress.cursor；head 使用 null。
6. 调用一次 listPage，验证 page provenance、item唯一性、cursor来源。
7. 按响应顺序串行处理：读取 DB task/manifest；验证过的 terminal task为 duplicate；否则在内存标 running，取详情、写 immutable objects、merge manifest，最后在事务中写 final task/failure/artifacts。
8. 媒体失败可形成 durable partial；detail/export失败形成 blocker。成功 note 与 blocker failure 在同一事务保存。
9. 计算 page transition。只有所有 item 是 verified done/partial/skipped 时改变 progress；否则完整复制旧 progress tuple。
10. 按 7.4 固定顺序投影、确定最终 RunRecord、写 account generation状态，COMMIT。
11. close session。退出码按结果表；view warning或media partial为 9。

### 9.3 普通页面边界

| 结果 | 行为 |
|---|---|
| head请求 + hasMore=false | 成功页；转/保持 head，`headFrontier=当前页 IDs`（空页为[]），cursor=null、reachedEnd=true。 |
| empty + hasMore=true + 新且不同 nextCursor | backfill/catchup 推进；head按 9.4 决定 catchup。 |
| hasMore=true 但 nextCursor 缺失/等于请求 cursor | PROTOCOL stop；progress逐字段不变。 |
| 少于 limit 且全 duplicate | receipt/object/task验证后仍是成功页，不依赖 duplicate 数等于 batch。 |
| 任一 detail/export blocker | 保存成功项与失败；progress不变；exit 5/6。 |
| media partial，无其他 blocker | 保存 failure/task/manifest并允许成功 transition；exit 9。 |
| backfill/catchup + hasMore=false 的成功页 | 转 head，cursor=null；backfill使用首次首页保存的 frontier，catchup使用 pending frontier；不得保存响应 cursor。 |

### 9.4 head → catchup 与 frontier

1. 初始 backfill 的 cursor=null 首页成功后保存该页 IDs 为 `headFrontier`；继续一次一页直到 service end，转 head。
2. head 首页中的“new ID”指当前 scope 没有 terminal task 的 ID。
3. head 首页只要有任意 new ID 且 `hasMore=true`，**必须**转 catchup并保存 response cursor，即使同页已经出现旧 frontier（例如旧置顶项）。当前首页 IDs 成为 `pendingHeadFrontier`。
4. catchup stop 选择：
   - 旧 frontier 非空且本次 head 首页未出现它：`{kind:"frontier",noteIds:旧frontier}`；
   - 旧 frontier 为空，或旧 frontier 已在含新项的 head 首页出现：`{kind:"service_end"}`。后者防止旧置顶项让跨第二页的新内容被提前截断。
5. head 无 new ID但未命中旧 frontier且 hasMore=true，也保守进入 `service_end` catchup，并先保存 `pendingHeadFrontier=当前页 IDs`（空页允许 `[]`），处理删除/重排。
6. catchup 每次仍只读一页。frontier stop 在 catchup页命中任一 note ID后，本页成功即回 head；service_end只在 hasMore=false回 head。frontier一直未命中但先到 service end也回 head。
7. 回 head 时 cursor=null、reachedEnd=true、headFrontier=pendingHeadFrontier、stop/pending清空。任何 blocker使整个旧 progress原样保留。

该算法假设列表大体新到旧、cursor链稳定；删除、置顶和排序语义全部**待动态验证**。历史实施 Stage 4 验证失败时必须停用在线增量，不能承诺无遗漏。

### 9.5 错误、暂停和恢复

- AUTH_REQUIRED：保存 stopReason、progress不变、exit 3；修正 session 后用完整 scope `acknowledge-stop --reason AUTH_REQUIRED`。
- RATE_LIMITED：progress不变；可信 retryAt写 nextAllowedAt，否则保持 stop；仅 acknowledge-stop 可清，exit 4。真实 code/恢复时间**待动态验证**。
- PROTOCOL：progress不变并 stop；仅完整 scope/reason匹配的 acknowledge-stop 可清，exit 5。
- DETAIL/NETWORK：完整 failure+attempt+run outcome同事务保存，progress不变，exit 5。
- MEDIA：partial；后续 retry不调用 list、不改 progress。
- DERIVED_VIEW：canonical transaction可提交，DB标 view incomplete；exit 9；下一 writer或显式 repair-views重建，verify只报告。
- user pause/SIGINT：若在item/object安全边界、进入projection前已知pause，则提交已完成 mutation与 paused outcome，progress不变，exit 7。若在任一projector/render/stable-file边界首次检测，则按7.4对同一snapshot执行SAVEPOINT rewind，撤销本轮canonical changes和derived attempt，再从old DB提交零counter paused Run，exit 7。
- projection pause replay：writer lock在`ROLLBACK TO`、derived restore、account存在性检查、old-DB重投影和paused COMMIT之间从不释放；已有account不merge，首次缺失account才创建。旧plan/business/batch因epoch失效，不能跨replay复活。
- hard crash：SQLite回滚整个未提交事务并释放 writer锁；object orphan和超前view可重建/清理，不影响旧 canonical版本。derived undo backup可能留下严格内部隐藏残留，部分undo也可能留下不在旧receipt中的新建notes/assets文件；下一次持writer lock的account projection在开始新attempt前安全清理backup，并在各动态projector树内按完整期望集合删除未跟踪的合法派生文件。两类残留都不改变SQLite或object source of truth。

## 10. Object store 与 derived view布局

```text
rednote-knowledge/
  state/
    rednote-sync.sqlite
  objects/
    sha256/ab/abcdef...
  control/
    {scopeDigest}.pause
  accounts/
    {accountDigest}/
      account.json
      notes/{noteKeyDigest}.md
      assets/{noteKeyDigest}/{kind}-{ordinal}.{ext}
      data/notes/{noteKeyDigest}.json
      data/index.json
      data/index.csv
      data/failures.json
      logs/export-runs.jsonl
      .views/{projectorId}.generation.json
```

- accountDigest=`sha256([hostId,accountId])`；noteKeyDigest=`sha256([hostId,accountId,noteId])`；scopeDigest包括 target/board。原始 ID只进安全内容，不进磁盘名。
- notes/data JSON由对应 immutable object以普通 copy materialize；所有 derived output都不得链接回 object store。derived assets **绝对禁止** hardlink 到 canonical object，也禁止 symlink或任何 inode共享；assets projector必须把已验证 object bytes普通 copy到 derived目录的 `O_CREAT|O_EXCL|O_NOFOLLOW` temp，fsync后rename。修改、truncate、chmod后写入任一 derived asset都只能损坏该 view；canonical object及同 object派生出的其他 note assets必须逐 byte不变，repair后可恢复。object store内部 temp→hash 的 no-clobber hardlink publication仅用于发布不可变 canonical object，不适用于 derived view。
- index按 `(hostId,accountId,noteId)` bytes排序；CSV RFC4180固定列。failures按完整 scope/note/slot/stage/category排序。run JSONL按 committed run完成时间/runId排序。
- projector marker写在所有本 projector outputs成功后；marker含 account key、projector ID、该 account generation、多 receipts。marker缺失/旧/超前/receipt不符时从 DB/object重建。
- projection attempt维护模块私有可逆footprint，且只记录真实磁盘变化：bytes/hash/length相同返回`unchanged`并保持mtime、不记动作；新文件记`created`；替换记`replaced`；stale file删除记`deleted`。`created`在rewind时安全删除；`replaced`先为旧derived普通文件建立同目录、随机隐藏名、当前uid、mode 0600、nofollow核验的内部backup；`deleted`用同目录安全rename到backup代替不可逆unlink。内部replacement backup可短暂hardlink到**旧derived文件**以保留原inode/mode/mtime，但绝不链接canonical object，也不是公开stable view或receipt。
- pause rewind按动作逆序恢复：删除created、用backup恢复replaced/deleted，因此旧derived bytes、inode、mode和mtime保持。成功COMMIT后settle删除全部backup并fsync目录；COMMIT之后的remove、fsync、backup安全校验、ENOENT或observer任一失败都必须重新封装为固定、无路径的`DERIVED_VIEW`，使CLI exit9，不能向外泄漏`STATE`/`SECURITY_BOUNDARY`或内部路径，但已经COMMIT的SQLite/object与有效view不得回滚或伪报未提交。下一次account projection在任何新动作前只枚举固定合法backup目录：account root、`notes/`、`data/`、`data/notes/`、`logs/`、`.views/`和一层`assets/{noteKeyDigest}/`；不得递归未知目录。扫描必须先完整预检再删除；lstat与nofollow-open后的fstat都核对regular、当前uid、0600、nlink=1、dev+ino，未知manual目录、symlink、hardlink、跨账户或指向state/object inode一律安全失败且本轮零删除。notes/assets动态树另按当前完整期望集合清理合法namespace内未跟踪的普通派生文件，以覆盖SIGKILL发生在created undo之前的情况；不扫描或修改`state/`、`objects/`。
- DB引用 object缺失或 hash错误是 canonical integrity error/exit 6；derived file缺失或错误只触发重建，不应报告不可恢复损坏。
- orphan object GC不属于历史实施 Stage 3；不得自动删除未引用 object。
- 所有 input/output/object/derived路径从可信 root逐级 lstat ancestors，拒绝 symlink、NUL、`..`、绝对子路径、Unicode/case identity碰撞。最终输入/object用 `O_NOFOLLOW`并 fstat普通文件，核对 open前后 device/inode。

## 11. CLI 与退出码

入口：`node src/cli.ts <command>`。stdout一行安全 JSON；诊断stderr；两者都过 secret scanner。

```text
rednote-sync init --root <dir>

rednote-sync sync --root <dir>
  --adapter fixture|import-json --input <file>
  --host xhs|rednote --account <id>
  --target posted|collected|liked|collected_album
  [--board-id <id>] [--limit 1..10]

rednote-sync retry-failures --root <dir>
  --adapter fixture|import-json --input <file>
  --host <id> --account <id> --target <target> [--board-id <id>]
  [--limit 1..10]

rednote-sync task skip --root <dir>
  --host <id> --account <id> --target <target> [--board-id <id>]
  --note-id <id> --reason <safe-text>

rednote-sync acknowledge-stop --root <dir>
  --host <id> --account <id> --target <target> [--board-id <id>]
  --reason AUTH_REQUIRED|RATE_LIMITED|PROTOCOL

rednote-sync pause|resume --root <dir>
  --host <id> --account <id> --target <target> [--board-id <id>]

rednote-sync repair-views --root <dir>
  --host <id> --account <id>

rednote-sync status --root <dir>
  [--host <id> --account <id> --target <target> --board-id <id>]

rednote-sync verify --root <dir>
rednote-sync --help
rednote-sync --version
```

规则：

- album必须 board；普通目标禁止 board。
- sync一次一 scope/一页；没有 `--all`、parallel或循环。
- retry limit默认5、1–10；从显式 input重建；listPage=0；progress永不改变。
- skip/ack/sync/retry和整 account repair在业务 `BEGIN IMMEDIATE`下串行；init/migration只走独立 global schema transaction。scope/reason不匹配零修改。
- pause/resume只操作精确 scope control文件，是唯一不申请 SQLite writer的 mutating例外。resume不清 DB stopReason。
- status与verify对 SQLite和文件系统都只读。status不做深度校验；verify不得调用 projector或写generation/marker/stable file。verify的WAL协议固定为：连接1开启read transaction，以`enumerateAccountsWithGenerations()`读取按key排序且包含viewsDirty的完整map G，并对每个account调用`enumerateViewGenerations(accountKey)`校验objects、五行view状态、markers和receipts；结束transaction并close。随后以**新连接/新read transaction**再次调用`enumerateAccountsWithGenerations()`得到完整map G2。仅当G2逐行等于G才可发布本轮结论；否则丢弃全部结果，最多重试一次（共2轮），再次变化则exit9。未提交writer对G不可见；扫描期间writer commit会使G2变化；projection incomplete或pre-commit超前view使canonical仍可读但产生partial/stale warning。verify和writer预检测均禁止hidden SQL。

| code | 含义 |
|---:|---|
| 0 | canonical提交成功、safe no-op、全部retry修复、read命令成功。 |
| 1 | 未分类内部缺陷。 |
| 2 | CLI/config/input/schema无效。 |
| 3 | auth/account不匹配。 |
| 4 | rate limited。 |
| 5 | list/detail/protocol blocker；progress未变。 |
| 6 | SQLite/object canonical integrity或持久化失败。 |
| 7 | 用户暂停/SIGINT安全停止。 |
| 8 | `BEGIN IMMEDIATE` 得到 SQLite busy；只表示第二 writer冲突。 |
| 9 | canonical仍可用，但有 media partial、derived view incomplete/stale，或只读 verify检测到持续并发 snapshot变化等 warning。 |

retry：无待办/全部修复0；剩余media partial 9；detail失败5；SQLite/object失败6；pause7；writer busy8。

## 12. Node 26 零依赖与本地制品策略

- `package.json`：`type=module`、`private=true`、`license=UNLICENSED`、`engines.node=>=26 <27`、`os=[darwin]`，dependencies/devDependencies均空。`0.0.0-stage3`仅标识阶段检查点，不代表稳定版或公共发布。
- 使用 Node 26 内置 `node:sqlite` 的 `DatabaseSync`，这是运行时内置依赖，不安装 npm包。
- 实际package bin是无TypeScript语法的最小JS入口；它先用纯decoder检查Node major 26和darwin，失败只输出固定安全JSON并退出6，成功后才动态import含`node:sqlite`的TypeScript CLI。`doctor`无root参数，在物理系统mkdtemp内验证uid、`node:sqlite`、`O_NOFOLLOW/O_DIRECTORY`、0700/0600、目录fsync、hardlink和no-clobber能力；它必须创建真实symlink并以`O_NOFOLLOW`打开，只有明确得到`ELOOP`才通过。清理后只输出14项聚合布尔结果。
- `.ts` 由 Node 26 type stripping直接运行；只用可擦除语法，禁止 enum/namespace/parameter property/decorator。
- import显式 `.ts`；tsconfig `NodeNext/ESNext/allowImportingTsExtensions/verbatimModuleSyntax/erasableSyntaxOnly/noEmit/strict` 仅编辑器契约。
- 必须明确：type stripping不执行类型检查，**不代表 TypeScript 类型安全已验证**。历史实施 Stage 3 用 runtime schema、assertNever测试、实际 import、`node --check`和零依赖静态脚本检查 forbidden network import/fetch、第三方 import、raw ID路径、noteId→cursor cast、非穷尽分支。未运行完整 `tsc` 是review剩余风险；安装前必须用户批准。
- 除 `node:sqlite` 外只用 fs/path/crypto/stream/util等内置非网络模块。
- Node 26拒绝在`node_modules`内type-strip `.ts`，因此本地安装包只携带可复现的`dist/*.js`，不携带`src/*.ts`。零依赖build以Node内置`stripTypeScriptTypes`在临时目录重建，再用受控lexer只改写静态import、side-effect import、export-from和单一普通引号字符串dynamic import的相对`.ts` module specifier；普通字符串（包括与specifier同值者）、注释、regex和template quasi静态文字必须逐字节保持。`${...}`表达式递归扫描真实token和nested template，带上限且unterminated fail-closed；为避免自制完整JS parser产生regex/brace逃逸，表达式中除comment起始以外的任何裸`/`（regex或division）均不在安全build子集并直接拒绝。concat、conditional、variable、template参数、comment组合、多参数等dynamic import形态也直接拒绝。变换后不得残留真实相对`.ts` specifier，并须通过语义import及已提交dist逐字节/权限核对；该API的experimental状态是当前Node 26绑定的一部分，不扩展支持矩阵。
- `files` 必须逐文件exact allowlist，只含dist运行文件、README、离线输入文档/Schema和完全合成样例；禁止glob，禁止打包 Core 项目的`src/`、`tests/`、`scripts/`、`docs/sync-core.md`、`schemas/offline-artifacts.json`、`tsconfig.json`和`.DS_Store`。工作区的原型、研究和逆向材料位于 Core 包根之外。共享release package policy同时精确固定顶层字段、private/UNLICENSED/engines/os/bin/files、空dependencies/devDependencies以及scripts全部键和值；static和pack gate都必须在任何npm命令前执行该policy，任何安装/打包/发布/version lifecycle脚本先独立拒绝，不能依赖`--ignore-scripts`提供主门禁。
- `pack:check`只能在物理mkdtemp与独立空npm cache中以offline/no-audit/no-fund连续执行两次真实`npm pack --json`；`--ignore-scripts`仅为纵深防御。tar parser必须对directory和file等每个entry先执行禁止路径规则，再拒绝所有directory/symlink/特殊entry、越界或未授权路径；还须从tar原始bytes解析`package/package.json`并再次执行同一release package policy。两个tarball须逐字节且inventory一致，再生成逐文件SHA-256 inventory和tarball SHA-256。随后只从第一份本地tgz安装到全新临时工程，验收bin、version/help/doctor/validate/init/sync/status/verify和包内文档/Schema/样例，最后删除tgz/cache/node_modules/root；不得publish。

## 13. 离线输入与在线待验证事实

fixture/import schema必须 versioned，page显式含完整 scope、requestCursor、nextCursor、hasMore、items、details和媒体相对路径。`retryItems` 每项显式含 scope、noteId、detail、sourceRank、mediaSetComplete、input-root内媒体路径；scope+noteId零条或多条匹配都 INVALID_INPUT。

fixtures只用合成账号、正文、cursor、媒体和secret canary，不复制真实账号数据。requestCursor必须等于当前 DB progress cursor。

以下全部**待动态验证**，历史实施 Stage 3 不实现：

- XHS/RedNote web/API origins和公开 URL路径；
- user/me、posted、collect、like、feed、board、comment endpoints及字段；
- notes/cursor/has_more/note_card结构；
- 列表排序、删除、置顶、空页和cursor链；
- token必要性/有效期/上下文；
- `window.mnsv2`、Cookie/localStorage及签名头；
- 461/406/300013/-100/-101含义；
- 安全page size、间隔、Retry-After、board分页、媒体codec。

历史实施 Stage 4 只能用专用browser profile、用户正常登录、page size≤5、一次一请求族、全程可暂停，先产脱敏schema；不实现签名破解或作者服务。

## 14. 测试矩阵

全部测试在系统临时目录，禁止网络和真实凭据。

| 类别 | 用例 | 断言 |
|---|---|---|
| node sqlite | 启动自检、foreign key、WAL、rollback | DatabaseSync可用；不降级；ACID行为符合。 |
| schema command | 缺失/空DB init、半schema、N→N+1→N+2、跳版/未来版、与writer竞争 | init最小检查后建v1并完整检查；migration严格升序单tx；其他命令空库即拒绝；无伪RunRecord；rollback/exit8正确。 |
| DB path | state/DB/WAL/SHM预置symlink、错误权限 | 打开前拒绝；新目录0700/DB0600；TOCTOU剩余风险有文档。 |
| schema/scope | 缺字段、多余字段、普通/album board错配 | INVALID_INPUT，零canonical mutation。 |
| cursor provenance | 独立nextCursor；尝试noteId→cursor | 只接受response cursor。 |
| private access | JSON/stringify/clone/inspect/logger | factory marker被拒，secret零泄漏。 |
| dynamic secret | secret复制到title/tag/reason/path/stdout/stderr | registry/token-like scanner全部阻断。 |
| partition | 多account/host/target/下划线board | SQLite key/task/failure/progress不串。 |
| account merge | 多种导入顺序、不同时间名称冲突、null名称 | first=min、last=max、非空名称按bytes max；最终account bytes一致。 |
| account generation | A/B各有views，先改A且一projector失败，再repair A | 只推进/重写A的`(account,projector)`；dirty在incomplete时1、整账号repair后0；B generation/receipt/mtime不变。 |
| snapshot capability | 全account generation/dirty、每account五view rows、manifest/task/failure/run/object refs、retry前N、错连接/closed | 正式接口稳定排序且字段完整；limit精确；verify/writer无hidden SQL；错误snapshot被拒。 |
| canonical order | A→B/B→A、board rename、tags冲突 | 最终Note/hash/object/index bytes一致。 |
| captured time | 只改captured/observed/run time | public object与stable mtime不变。 |
| media merge | incomplete缺省、complete删除、低rank失败、LKG | 缺省保留；高rank tombstone；失败不覆盖LKG。 |
| media rank failure | 高fail→低fail→低success；再来高rank success/tombstone | 重复failure rank取max，低rank不resolve；accepted rank>=failure才resolve。 |
| repeated failure | 同全键重复；detail/export重复 | ID复用、attempt+1、first保留；media rank不降级；detail/export rank恒null。 |
| source rank input | 无效revisionAt、伪造hash、公开字符串brand/同形对象/复制或clone marker | 只有私有symbol+WeakSet factory实例通过；canonical边界复验；伪造输入INVALID_INPUT且零mutation。 |
| magic MIME | 同bytes分别声明不同/未知MIME | magic bytes唯一决定ObjectRef MIME/extension/hash；未知固定octet-stream/bin。 |
| cross target | A partial，B提供accepted高rank slot | 同事务解决可覆盖failures并更新所有tasks。 |
| immutable update | 已有note更新正文/媒体 | DB commit前旧ref完整；commit后全新ref完整；旧objects不变。 |
| derived asset isolation | 两note引用同object；对一方asset修改、truncate、chmod+写 | derived inode不等于canonical/另一asset；canonical hash/bytes和另一asset不变；repair恢复。 |
| SQLite crash | object后、manifest/task/failure后、projection后、COMMIT边界kill -9 | COMMIT前DB全旧；COMMIT后DB全新；无mixed canonical rows。 |
| object orphan | object发布后事务rollback | 旧DB/objects可用；新object仅orphan，不被view引用。 |
| view ahead | project新view后DB前kill | DB rollback；verify只报告stale；下一writer/repair-views按该account generation重建旧view。 |
| view missing | 删除notes/assets/index/failures/run JSONL | verify只读报告可恢复缺失；repair-views重建且不报canonical corruption。 |
| verify WAL/uncommitted | writer扫描期间未commit并投影超前view | G2=G；verify不写文件，只把receipt不符报stale warning；canonical校验仍来自G。 |
| verify WAL/commit | writer在G扫描期间commit | 新连接G2≠G，丢弃整轮并重试；连续变化exit9。 |
| verify incomplete | DB已commit某projector complete=false | G2=G；canonical可用，verify稳定报告projection incomplete并exit9。 |
| verify/projector并发 | writer持BEGIN IMMEDIATE并project时启动verify | verify始终只读；不存在第二文件writer；遵守close+新连接G2协议。 |
| two writers | writer持BEGIN IMMEDIATE，第二sync/skip | 第二方立刻exit8；第一方不受影响。 |
| pause control | writer处理中另进程pause | control可写；writer提交已完成mutation+paused run，progress不变。 |
| projection pause rewind | sync/list blocker/empty retry在五个projector的before/after、render item、stable file边界触发pause或Abort | 同一snapshot `ROLLBACK TO`；writer lock不断；旧plan/business/batch拒绝；原canonical state/progress/task/failure逐字段不变；零counter paused Run/exit7。 |
| paused account replay | 已有account传入不同displayName/first/last；首次运行pause | existing account逐字段不merge；首次仅建立经验证account；两者均只推进paused generation。 |
| reversible view footprint | unchanged文件固定2001 mtime；实际note replacement、stale asset delete、marker replace、新文件publish后pause | restore后旧bytes/inode/mode/mtime一致；created消失；正常commit清backup；repair安全清严格内部abandoned backup。 |
| settle deletion failure | 对每个commit后backup删除点分别注入失败，并制造真实ENOENT、错误mode安全校验及SafeError | 全部固定归类DERIVED_VIEW/CLI exit9且输出无路径；SQLite/object保持已提交新版；只余严格内部backup；修复mode后下一次repair清理并通过verify。 |
| abandoned backup trust boundary | symlink、hardlink、错误mode、未知manual目录、跨账户、state inode、object inode；同时放置合法backup和两条仍期望note | 只枚举固定合法目录；任一恶意项使SECURITY_BOUNDARY且零删除；合法backup和两条note bytes/inode/mode/mtime均保留；纯合法场景只删backup。 |
| undo action SIGKILL | 对created/replaced/deleted/marker的每个逆序action完成后启动真实子进程SIGKILL，并固定unchanged文件元数据 | SQLite保持旧canonical、objects完整；只允许partial derived与严格backup；repair删除未跟踪created、清backup并恢复一致view；unchanged inode/mode/mtime不变。 |
| rewind writer race | projection pause完成`ROLLBACK TO`后、restore前启动真实第二CLI writer | 第二方exit8/BUSY；原pause稳定exit7；证明无释放writer lock窗口。 |
| task running | item处理时异常 | DB从不出现running；rollback或final失败状态。 |
| task skip/sync | sync与skip同时启动 | SQLite串行；无lost update；failure resolve与task原子。 |
| blocker page | 中间detail失败且前项成功 | 同事务保存成功note+完整failure+run；progress逐字段不变；failures view一致。 |
| media partial | 一成功一失败 | partial与failure同事务；页可进；无断链asset。 |
| empty/all duplicate | 空end、空continue、少于batch全重复 | 正确transition；无batch等值假设。 |
| head end frontier | head首页hasMore=false，分别有IDs/空页 | headFrontier精确等于当前IDs/[]；cursor/pending清空。 |
| head > limit | 新项超过limit，旧frontier第3页 | head转catchup；每调用一页；命中后回head，无漏项。 |
| pinned old + new | 首页含旧置顶frontier和新项，更多新项在第2页 | 仍进service_end catchup，不因旧置顶提前停止。 |
| empty frontier | headFrontier=[]且hasMore | stop=`service_end`，类型中无空frontier。 |
| conservative catchup | head无new、未命中旧frontier、hasMore，含IDs/空页 | service_end catchup且pendingHeadFrontier精确等于当前IDs/[]。 |
| frontier missing | 旧frontier删除 | catchup到service end回head。 |
| retry | detail/media按显式input，limit边界 | listPage=0；progress不变；exit 0/5/9。 |
| ack | scope/reason匹配与错配 | writer事务原子；错配零修改；普通resume无效。 |
| projector receipts | 每projector多文件、2+notes更新1条 | receipts含projector ID/generation；无逐note共享index hash。 |
| blocker projection | blocker新增failure | 同事务snapshot仍按notes/assets/index/failures→final run→runs顺序；commit后全部account views一致。 |
| projection outcome | 直接构造success/failure、错account/gen/order/缺safeError | discriminated decoder严格；failure receipts可省；错误输入使finalize零写入。 |
| atomic finalization | 直接调用finalizeAccount并在run/view/account各SQL边界注入失败 | finalRun、五outcomes、G+1/dirty全有或全无；repair同API；projector不能写DB。 |
| stale pre-repair | G已有stale，业务本轮最终投影成功/仍失败 | 不执行G预投影；只做一次G+1全量投影；成功清warning/dirty，失败commit warning/dirty且RunRecord一致。 |
| projection failure | notes/assets/index/failures/runs逐个参数化抛错 | 顺序固定且后续仍尝试；前四决定finalRun；runs失败不递归改Run；finalize记录failure outcome/dirty并exit9。 |
| offline long tx | 人工慢fixture/object/projector、过程中pause | 记录elapsed/progress且边界响应pause；未commit progress不前移；测试不宣称可用于Stage4在线。 |
| raw ID/path | Unicode NFC/NFD、case、路径字符、ancestor symlink | 磁盘只hash；内部字段复核；nofollow阻断。 |
| offline static | imports/fetch扫描 | 仅node:sqlite和非网络内置模块。 |
| CLI | 全命令/退出码/stdout/stderr | 符合契约且无secret。 |
| validate-input | fixture/import-json exact envelope、错误mode/account、敏感正文/ID/path | 不接收root、不打开SQLite、不写文件；复用FixtureSession runtime decoder/provenance；stdout只含安全聚合计数。 |
| offline demo | Node permission mode不给network、只写mkdtemp；真实CLI多页/重放/media/失败/retry/status/verify | stdout逐命令单JSON；Markdown/JSON/index/media存在；重放后稳定文件bytes/mtime不变；最终verify exit0。 |
| runtime doctor | 纯decoder注入old/new Node与非darwin；真实rootless doctor；真实symlink以`O_NOFOLLOW`打开 | 固定拒绝原因；仅`ELOOP`算symlink拒绝通过；成功聚合14项能力且不输出path/uid；mkdtemp已清理。 |
| explicit migrate | 真实子进程对exact v0、injected rollback、future、modified、current-v1、第二writer | 仅v0→v1 committed；失败不留半迁移；busy exit8；无自动迁移或备份。 |
| local package | 共享exact metadata/files/scripts policy；postinstall/prepare/prepack隔离canary；受控module-specifier lexer；真实npm pack/tar解析；全新离线安装 | lifecycle在npm启动前拒绝且canary不存在；普通literal/comment/template quasi不被改写，`${...}`和nested template真实specifier正确，unknown dynamic与template-expression slash fail-closed，语义import通过；禁止路径对file/directory均先判定且所有非regular entry拒绝；逐文件hash与tgz hash可重算；安装bin与8条离线命令通过；工作区零残留。 |

事件测试必须证明：`BEGIN IMMEDIATE -> immutable objects -> canonical account/state/manifest/task/failure rows -> notes/assets/index/failures outcomes -> determine finalRun -> runs outcome with overlay -> finalizeAccount(run+5 view rows+account generation/dirty) -> COMMIT`；每个object/view/DB边界异常终止后，DB只引用完整旧版或完整新版，不出现正文/媒体混合版本；失败页progress tuple逐字段与before相等；retry的listPage=0；一次sync的listPage≤1。

阶段3B已审查测试覆盖上述SAVEPOINT/epoch、account replay、五projector边界、可逆replacement/delete/create/unchanged、真实第二writer及object/canonical/projection/finalize/commit SIGKILL。阶段3C-1实现测试进一步穷举每个commit后settle backup删除点，并在每一个逆序undo action完成后对真实子进程执行SIGKILL；返修测试补充固定目录/two-phase backup扫描的恶意身份矩阵，以及真实ENOENT/安全校验/SafeError到无路径CLI exit9的错误面。测试同时验证严格backup残留、未跟踪created文件、multi-note合法文件、canonical SQLite/object、unchanged元数据和后续repair。原列出的两个P3故障注入缺口已补齐并通过独立审查。该结论不构成在线验证，也不放宽历史实施 Stage 4 审查门。

## 15. 历史实施 Stage 3 实现拆分与审查门

### 3A：types、安全、SQLite、objects、export

实现：

- branded types/discriminated scope/runtime decoders；
- PrivateNoteAccess/MemorySecretRegistry/safe logger/path resolver；
- `node:sqlite` schema、migration、BEGIN IMMEDIATE facade、Account/State/Manifest/Task/Failure/Run/View stores；
- immutable content-addressed object store与MediaStore；
- canonical merge/contentHash/media rank/tombstone/failure relation；
- JSON/Markdown Exporter与全部 DerivedViewProjector；
- 不实现SyncEngine/CLI orchestration。

3A门：

- [x] 空DB init/顺序migration、SQLite rollback/foreign key/busy、正式snapshot查询和atomic finalization接口测试通过。
- [x] 旧/新immutable object、orphan、magic MIME及derived asset inode隔离/破坏恢复测试通过。
- [x] account-partitioned generation、A/B隔离、多receipt、固定projector顺序和view超前重建测试通过。
- [x] canonical target顺序、Account merge、captured time、私有WeakSet rank provenance/重算防伪、failure max-rank、LKG/removal测试通过。
- [x] secret、digest路径、state/DB权限、ancestor nofollow、Unicode/case测试通过。
- [x] 独立reviewer对SQLite source-of-truth、object durability、merge和安全边界给出PASS；修改后复审。

### 3B：engine、CLI、head/catchup

只有3A PASS后实现：

- fixture/import Session/Client/RetrySource；
- 单页串行engine、低频、pause、skip、ack、retry；
- backfill/head/catchup状态机；
- 全CLI、exit code、verify/repair views；
- child-process crash和并发integration tests。

3B门：

- [x] 每轮一页、并发1、retry零list、失败progress完全不变。
- [x] head新增>limit、旧置顶+跨页新项、空frontier service_end全部通过。
- [x] object/view/DB COMMIT各边界kill测试证明canonical只全旧或全新。
- [x] 第二writer只因SQLite busy exit8；pause control例外正常。
- [x] blocker/partial/skip/ack/cross-target repair在单事务一致，views可重建。
- [x] verify G/close/new-connection G2在未提交writer、已commit和incomplete projection三类并发测试通过。
- [x] 慢离线fixture暴露elapsed/progress并在边界可暂停；Stage4在线长事务仍被明确禁止。
- [x] 独立reviewer对engine、transaction、head/catchup、CLI和离线边界给出PASS；修改后复审。

### 3C：离线加固与产品化

3C-1已实现并通过独立审查：

- commit后每个backup settle删除点的真实失败注入；
- 每个逆序undo action后的真实SIGKILL恢复；
- fixed-layout/two-phase abandoned backup身份矩阵与无路径exit9。

3C-2已实现并通过独立审查：

- 根README准确限定Node 26、当前macOS/POSIX已测范围、绝对`0700` root、全祖先no-symlink、每次一页、重复调用、退出码、输出布局和历史实施 Stage 4 禁入；标记命令块由`/bin/zsh`逐字执行，并验证`mktemp`目录经`cd`+`pwd -P`成为canonical physical root；
- `offline-input-v1` exact协议文档、解释性JSON Schema和完全合成的无媒体/media/失败+retry/import-json样例；受控的离线Schema contract evaluator验证所有样例，并用反例覆盖safe-integer上限、relativePath absolute/traversal/control限制和`additionalProperties`；
- artifact checker拥有固定text集合与前缀发现规则，在读取manifest前逐级`lstat`固定祖先/leaf并以`O_NOFOLLOW`打开；manifest路径只做严格NFC/relative/containment验证，不决定扫描范围。发现结果与manifest exact比较，门禁拒绝漏扫、symlink/外部逃逸、prototype凭据路径、JWT/credential字段和值、tokenized URL、非synthetic ID与占位符；真实临时镜像self-test覆盖正例及18个拒绝分支，并以不可读外部canary证明提前拒绝；
- rootless只读`validate-input`复用FixtureSession decoder/provenance，输出不含path/body/ID/secret；
- `test:offline-demo`在mkdtemp中用Node permission mode拒绝network，真实CLI执行validate→init→分页→幂等重放→media→失败/retry→import-json sync→局部/全局status→verify；逐次断言durable phase/cursor/reachedEnd，并检查warnings/exit及稳定文件bytes/mtime。

3C-2门：

- [x] 不安装依赖、不联网、不读取凭据、不实现或改动在线接口。
- [x] `fixture`与`import-json`均通过真实CLI验证；文档明确import-json不是通用JSON转换器。
- [x] 合成演示覆盖Markdown、JSON、index、media、失败和retry，不以tests helper代替用户命令。
- [x] `npm run check`（含artifact allowlist/credential门禁及临时镜像self-test）、定向测试、README逐字shell smoke、全量`npm test`与`npm run test:offline-demo`全部通过（该轮为定向24/24、全量144/144）后交独立审查。
- [x] 独立reviewer对schema/runtime一致性、无状态验证输出、演示可复制性、mtime幂等和历史实施 Stage 4 边界给出PASS；修改后复审。

3C-3已实现并通过独立终审：

- package保持private/UNLICENSED，以Node 26+darwin双重安装/运行门禁、可复现dist和逐文件allowlist形成未发布的本地制品边界；
- rootless `doctor`完成系统与文件系统能力preflight，包括真实symlink的`O_NOFOLLOW`/`ELOOP`探针；不读取业务root、不联网、不输出路径/uid；
- 显式`migrate --root`严格复用state store的exact v0→v1单事务，modified/future/current拒绝、失败rollback、第二writer exit8；不自动迁移、不创建备份；
- static与`pack:check`在npm前复用exact package policy并拒绝所有lifecycle；`pack:check`在临时目录执行真实pack、tar内package policy复核、对所有entry先做禁止路径检查、逐文件hash inventory和同一tgz全新离线安装验收，结束删除所有临时制品；
- README的前置警告、支持矩阵、doctor/migrate、本地pack/install、包内容与历史实施 Stage 4 边界均与实际命令一致，所有相对链接必须指向包内文件。

3C-3门：

- [x] exact package metadata/files allowlist在首次`npm pack`前落盘；零依赖、private、UNLICENSED、stage版本不变。
- [x] doctor与migrate定向实现测试通过；busy保留exit8，unsupported runtime由纯decoder覆盖。
- [x] 终审返修已补共享exact scripts policy与tar内package复核；postinstall/prepare/prepack三个隔离canary均在npm启动前拒绝且未写sentinel。受控specifier lexer覆盖static/side-effect/dynamic import、export-from、多行、同值ordinary literal、comment/template quasi保持、`${...}`和nested template递归及真实语义import；所有unknown dynamic import与template-expression裸slash均fail-closed。tar禁止路径对file/directory均先判定；doctor真实symlink只接受`O_NOFOLLOW`返回`ELOOP`。
- [x] `npm run check`、`npm run test:release`（21/21）、README smoke（7 commands）、offline demo（21 commands）和全量测试（165/165）全部通过。独立终审时的发布包为35 files、80,849 bytes tgz、404,240 bytes unpacked，tgz SHA-256=`8b548468a1eabf26fe8e2016fa1a0af2457c346571d99b9696ca325efe439c1d`，inventory SHA-256=`939808dcb58804245d2d50f624501a11e793bb91b14ccea1c6925b0252665c70`；状态回填后重新执行`npm run pack:check`，仍为35 files且2份tarball逐字节一致，更新为80,895 bytes tgz、404,338 bytes unpacked，tgz SHA-256=`5c9b6924d7baa54a312ff73773f68c73cba775cfff131d5cc394ee8e46f6dea7`，inventory SHA-256=`87b937dafdddbac47c37601047254e2455ed7ffee2c9ad57ea19ca05e683f6cb`；安装后8条命令通过且临时制品全部清理。
- [x] 独立reviewer对分发边界、tar解析、临时清理、迁移和文档给出PASS；返修后复审结论为PASS（P0/P1/P2/P3均为0）。历史实施 Stage 3C 至此完成，但不得自动进入历史实施 Stage 4。

## 16. 历史实施 Stage 3 总验收

- [x] `node:sqlite` DatabaseSync启动自检通过，零第三方依赖。
- [x] SQLite/object store是唯一 source of truth；无 canonical JSON状态旁路。
- [x] 所有 canonical mutating commands使用BEGIN IMMEDIATE；busy只映射exit8。
- [x] progress只在完整成功页改变；失败/暂停/blocker tuple逐字段保持。
- [x] object不可变、内容寻址、nofollow/fsync；更新不覆盖旧版本。
- [x] derived asset只普通copy，绝不与canonical object/其他asset共享inode；任意derived写坏不影响source of truth。
- [x] stable notes/assets/index/failures/run JSONL全部可从DB/object重建，不参与cursor durable条件。
- [x] account generation/view rows按account隔离；repair-views只接受整account；verify严格只读并执行G/G2协议。
- [x] head任意new+hasMore都进入catchup；旧置顶不截断跨页新项；空frontier使用service_end。
- [x] media failure带rank；仅accepted且rank足够的success/tombstone可resolve；Media无failureId。
- [x] 外部revision/hash均runtime验证并重算；MIME只由magic bytes canonical推导。
- [x] full-scope failure、RetrySource、ack、skip/retry limit、跨target repair通过。
- [x] canonical merge/hash与target顺序无关；captured time不改变public object。
- [x] 原ID不进路径；全部ancestor/no-follow；dynamic secret全通道零泄漏。
- [x] 每个manifest mutation和blocker都按notes/assets/index/failures→final run→runs投影；stale/ahead view可按account重建。
- [x] task running只在内存；normal no-op/paused/failure有DB RunRecord；hard crash只承诺ACID。
- [x] 3A与3B分别通过独立审查和修复复审。
- [x] 未联网、未读真实凭据、未实现作者服务/授权/签名破解/风控绕过。

历史实施 Stage 3 通过后仍不得自动进入历史实施 Stage 4。所有在线事实继续按“待动态验证”逐项、低频、用户授权验证。
