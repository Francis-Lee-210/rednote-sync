import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { sha256Canonical } from "../src/canonical.ts";
import { SafeError } from "../src/errors.ts";
import { FixtureSession, ReadOnlyInputRoot } from "../src/offline-input.ts";
import { assertValidatedRankForNote, semanticNotePayload } from "../src/rank.ts";

const when = "2026-08-01T00:00:00.000Z";
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

async function root(): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), "rednote-offline-input-")));
}

function scope(accountId = "synthetic-account", hostId = "xhs") {
  return { accountId, hostId, target: "liked", boardId: null };
}

function note(accountId = "synthetic-account", hostId = "xhs", noteId = "synthetic-note") {
  return {
    schemaVersion: 1,
    accountId,
    hostId,
    noteId,
    publicUrl: `https://www.xiaohongshu.com/explore/${encodeURIComponent(noteId)}`,
    title: "Synthetic fixture",
    body: "Offline only",
    noteType: "image",
    author: { id: "synthetic-author", name: "Fixture Author", publicUrl: null },
    publishedAt: when,
    updatedAt: when,
    capturedAt: when,
    tags: ["fixture"],
    metrics: { liked: 1, collected: null, commented: 0, shared: null },
    memberships: [{ target: "liked", boardId: null, boardName: null, observedAt: when }],
  };
}

function detail(noteValue = note(), media: unknown[] = []) {
  const semanticNote = { ...noteValue, media: [], contentHash: "0".repeat(64) };
  return {
    note: noteValue,
    revisionAt: when,
    claimedPayloadSha256: sha256Canonical(semanticNotePayload(semanticNote as never)),
    mediaSetComplete: true,
    media,
  };
}

function envelope(options: {
  mode?: "fixture" | "import-json";
  accountId?: string;
  hostId?: string;
  requestCursor?: string | null;
  nextCursor?: string | null;
  detail?: ReturnType<typeof detail>;
  retryItems?: unknown[];
} = {}) {
  const accountId = options.accountId ?? "synthetic-account";
  const hostId = options.hostId ?? "xhs";
  const noteValue = options.detail?.note ?? note(accountId, hostId);
  const detailValue = options.detail ?? detail(noteValue);
  const pageScope = scope(accountId, hostId);
  return {
    schemaVersion: 1,
    mode: options.mode ?? "fixture",
    account: { schemaVersion: 1, accountId, hostId, displayName: "Synthetic", firstSeenAt: when, lastSeenAt: when },
    pages: [{
      scope: pageScope,
      requestCursor: options.requestCursor ?? null,
      nextCursor: options.nextCursor ?? "server-cursor-2",
      hasMore: true,
      items: [{ noteId: noteValue.noteId }],
      details: [detailValue],
    }],
    retryItems: options.retryItems ?? [{ scope: pageScope, noteId: noteValue.noteId, detail: detailValue }],
  };
}

async function fixtureFile(inputRoot: string, value: unknown, name = "fixture.json"): Promise<string> {
  await writeFile(path.join(inputRoot, name), JSON.stringify(value), { mode: 0o600 });
  return name;
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const item = await reader.read();
    if (item.done) return Buffer.concat(chunks);
    chunks.push(item.value);
  }
}

function safeCode(code: string) {
  return (error: unknown) => error instanceof SafeError && error.code === code;
}

test("fixture session exposes reusable provenance-bound pages, details, retry source, and no-follow media factories", async () => {
  const inputRoot = await root();
  await mkdir(path.join(inputRoot, "media"));
  await writeFile(path.join(inputRoot, "media", "synthetic.png"), png, { mode: 0o600 });
  const noteValue = note("synthetic-account", "xhs", "synthetic-note");
  const detailValue = detail(noteValue, [{ kind: "image", ordinal: 1, mediaId: "synthetic-media", relativePath: "media/synthetic.png" }]);
  const name = await fixtureFile(inputRoot, envelope({ detail: detailValue }));
  const expectedScope = scope() as never;
  const session = await FixtureSession.open({ inputRoot, inputFile: name, mode: "fixture", account: { accountId: "synthetic-account", hostId: "xhs" } as never });

  const retry = await session.retrySource.get(expectedScope, "synthetic-note" as never);
  assert.equal("contentHash" in retry.note, false, "transient note excludes caller-controlled contentHash");
  assert.equal("media" in retry.note, false, "transient note excludes caller-controlled media");
  assert.equal(retry.semanticNote.media.length, 0);
  assert.doesNotThrow(() => assertValidatedRankForNote(retry.sourceRank, retry.semanticNote));

  const page = await session.client.listPage(expectedScope, null, 5);
  assert.deepEqual(page.items, [{ noteId: "synthetic-note" }]);
  assert.equal(page.nextCursor, "server-cursor-2");
  const resolved = await session.client.getDetail(expectedScope, "synthetic-note" as never);
  assert.equal(resolved.mediaSources.length, 1);
  assert.deepEqual(await collect(await resolved.mediaSources[0]!.open(new AbortController().signal)), png);
  assert.deepEqual(await readFile(path.join(inputRoot, "media", "synthetic.png")), png, "input remains unchanged");

  assert.deepEqual((await session.client.listPage(expectedScope, null, 5)).items, page.items);
  session.close();
  await assert.rejects(session.retrySource.get(expectedScope, "synthetic-note" as never), safeCode("STATE"));
});

test("versioned exact decoders reject extra fields, malformed shapes, and account/scope provenance mismatches", async () => {
  const cases: Array<{ readonly mutate: (value: ReturnType<typeof envelope>) => void; readonly label: string }> = [
    { label: "future schema", mutate: (value) => { value.schemaVersion = 2; } },
    { label: "extra envelope field", mutate: (value) => { (value as Record<string, unknown>).extra = true; } },
    { label: "extra item field", mutate: (value) => { (value.pages[0]!.items[0] as Record<string, unknown>).cursor = "forbidden"; } },
    { label: "page account mismatch", mutate: (value) => { value.pages[0]!.scope.accountId = "other-account"; } },
    { label: "detail host mismatch", mutate: (value) => { value.pages[0]!.details[0]!.note.hostId = "rednote"; } },
    { label: "detail absent", mutate: (value) => { value.pages[0]!.details = []; } },
    { label: "duplicate item", mutate: (value) => { value.pages[0]!.items.push({ noteId: "synthetic-note" }); } },
    { label: "caller content hash forbidden", mutate: (value) => { (value.pages[0]!.details[0]!.note as Record<string, unknown>).contentHash = "f".repeat(64); } },
    { label: "caller media forbidden", mutate: (value) => { (value.pages[0]!.details[0]!.note as Record<string, unknown>).media = []; } },
  ];
  for (const entry of cases) {
    const inputRoot = await root();
    const value = envelope();
    entry.mutate(value);
    const name = await fixtureFile(inputRoot, value);
    await assert.rejects(
      FixtureSession.open({ inputRoot, inputFile: name, mode: "fixture", account: { accountId: "synthetic-account", hostId: "xhs" } as never }),
      safeCode("INVALID_INPUT"),
      entry.label,
    );
  }
});

test("claimed source digest is recomputed over semantic Note and cannot forge a validated rank", async () => {
  const inputRoot = await root();
  const value = envelope();
  value.pages[0]!.details[0]!.claimedPayloadSha256 = "0".repeat(64);
  value.retryItems = [];
  const name = await fixtureFile(inputRoot, value);
  await assert.rejects(
    FixtureSession.open({ inputRoot, inputFile: name, mode: "fixture", account: { accountId: "synthetic-account", hostId: "xhs" } as never }),
    safeCode("INVALID_INPUT"),
  );
});

test("page cursor provenance is request/response data, never derived from a note ID", async () => {
  const inputRoot = await root();
  const value = envelope({ requestCursor: "server-cursor-7", nextCursor: "server-cursor-8", retryItems: [] });
  const name = await fixtureFile(inputRoot, value);
  const expected = { accountId: "synthetic-account", hostId: "xhs" } as never;
  const wrong = await FixtureSession.open({ inputRoot, inputFile: name, mode: "fixture", account: expected });
  await assert.rejects(wrong.client.listPage(scope() as never, "synthetic-note" as never, 5), safeCode("INVALID_INPUT"));

  const session = await FixtureSession.open({ inputRoot, inputFile: name, mode: "fixture", account: expected });
  const page = await session.client.listPage(scope() as never, "server-cursor-7" as never, 5);
  assert.equal(page.requestCursor, "server-cursor-7");
  assert.equal(page.nextCursor, "server-cursor-8");
});

test("read-only input capability rejects root, fixture, ancestor, and media symlinks plus path escapes", async () => {
  const outer = await root();
  const actual = path.join(outer, "actual");
  await mkdir(actual);
  await fixtureFile(actual, envelope());
  const linkedRoot = path.join(outer, "linked-root");
  await symlink(actual, linkedRoot);
  await assert.rejects(
    FixtureSession.open({ inputRoot: linkedRoot, inputFile: "fixture.json", mode: "fixture", account: { accountId: "synthetic-account", hostId: "xhs" } as never }),
    safeCode("SECURITY_BOUNDARY"),
  );

  const inputRoot = await root();
  await fixtureFile(inputRoot, envelope(), "actual.json");
  await symlink("actual.json", path.join(inputRoot, "linked.json"));
  await assert.rejects(
    FixtureSession.open({ inputRoot, inputFile: "linked.json", mode: "fixture", account: { accountId: "synthetic-account", hostId: "xhs" } as never }),
    safeCode("SECURITY_BOUNDARY"),
  );

  const mediaRoot = await root();
  await writeFile(path.join(mediaRoot, "actual.png"), png);
  await symlink("actual.png", path.join(mediaRoot, "linked.png"));
  const mediaNote = note("synthetic-account", "xhs", "synthetic-note");
  const linkedDetail = detail(mediaNote, [{ kind: "image", ordinal: 1, mediaId: "synthetic-media", relativePath: "linked.png" }]);
  const mediaName = await fixtureFile(mediaRoot, envelope({ detail: linkedDetail, retryItems: [] }));
  const session = await FixtureSession.open({ inputRoot: mediaRoot, inputFile: mediaName, mode: "fixture", account: { accountId: "synthetic-account", hostId: "xhs" } as never });
  await session.client.listPage(scope() as never, null, 5);
  const transient = await session.client.getDetail(scope() as never, "synthetic-note" as never);
  await assert.rejects(async () => collect(await transient.mediaSources[0]!.open(new AbortController().signal)), safeCode("SECURITY_BOUNDARY"));

  const escaped = envelope({ detail: detail(mediaNote, [{ kind: "image", ordinal: 1, mediaId: "synthetic-media", relativePath: "../actual.png" }]), retryItems: [] });
  const escapedName = await fixtureFile(mediaRoot, escaped, "escaped.json");
  await assert.rejects(
    FixtureSession.open({ inputRoot: mediaRoot, inputFile: escapedName, mode: "fixture", account: { accountId: "synthetic-account", hostId: "xhs" } as never }),
    safeCode("INVALID_INPUT"),
  );
});

test("media read factory is lazy, accepts arbitrary source bytes, and honors abort", async () => {
  const inputRoot = await root();
  await writeFile(path.join(inputRoot, "media.png"), Buffer.from("different bytes"));
  const mediaNote = note("synthetic-account", "xhs", "synthetic-note");
  const detailValue = detail(mediaNote, [{ kind: "image", ordinal: 1, mediaId: "synthetic-media", relativePath: "media.png" }]);
  const name = await fixtureFile(inputRoot, envelope({ detail: detailValue, retryItems: [] }));
  const session = await FixtureSession.open({ inputRoot, inputFile: name, mode: "fixture", account: { accountId: "synthetic-account", hostId: "xhs" } as never });
  await session.client.listPage(scope() as never, null, 5);
  const transient = await session.client.getDetail(scope() as never, "synthetic-note" as never);
  assert.deepEqual(await collect(await transient.mediaSources[0]!.open(new AbortController().signal)), Buffer.from("different bytes"));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(transient.mediaSources[0]!.open(controller.signal), safeCode("STATE"));
});

test("media path/outcome changes do not alter the semantic rank for the same transient note revision", async () => {
  const inputRoot = await root();
  await writeFile(path.join(inputRoot, "one.bin"), Buffer.from("one"));
  await writeFile(path.join(inputRoot, "two.bin"), Buffer.from("two"));
  const noteValue = note();
  const firstDetail = detail(noteValue, [{ kind: "image", ordinal: 1, mediaId: "synthetic-media", relativePath: "one.bin" }]);
  const secondDetail = detail(noteValue, [{ kind: "image", ordinal: 1, mediaId: "synthetic-media", relativePath: "two.bin" }]);
  const firstName = await fixtureFile(inputRoot, envelope({ detail: firstDetail, retryItems: [] }), "first.json");
  const secondName = await fixtureFile(inputRoot, envelope({ detail: secondDetail, retryItems: [] }), "second.json");
  const expected = { accountId: "synthetic-account", hostId: "xhs" } as never;
  const first = await FixtureSession.open({ inputRoot, inputFile: firstName, mode: "fixture", account: expected });
  const second = await FixtureSession.open({ inputRoot, inputFile: secondName, mode: "fixture", account: expected });
  await first.client.listPage(scope() as never, null, 5);
  await second.client.listPage(scope() as never, null, 5);
  const a = await first.client.getDetail(scope() as never, "synthetic-note" as never);
  const b = await second.client.getDetail(scope() as never, "synthetic-note" as never);
  assert.equal(a.sourceRank.payloadSha256, b.sourceRank.payloadSha256);
  assert.equal(a.sourceRank.revisionAt, b.sourceRank.revisionAt);
});

test("input and session capabilities cannot be constructed without module-private issuance tokens", () => {
  assert.throws(() => new ReadOnlyInputRoot(Symbol("forged"), "/", []), safeCode("SECURITY_BOUNDARY"));
  assert.throws(() => new FixtureSession(Symbol("forged"), {} as never), safeCode("SECURITY_BOUNDARY"));
});

test("import-json mode is provenance-bound and retry source requires one exact scope+note match", async () => {
  const inputRoot = await root();
  const value = envelope({ mode: "import-json", retryItems: [] });
  value.pages[0]!.details[0]!.claimedPayloadSha256 = null as never;
  const name = await fixtureFile(inputRoot, value);
  await assert.rejects(
    FixtureSession.open({ inputRoot, inputFile: name, mode: "fixture", account: { accountId: "synthetic-account", hostId: "xhs" } as never }),
    safeCode("INVALID_INPUT"),
  );
  const session = await FixtureSession.open({ inputRoot, inputFile: name, mode: "import-json", account: { accountId: "synthetic-account", hostId: "xhs" } as never });
  assert.equal((await session.retrySource.get(scope() as never, "synthetic-note" as never)).note.noteId, "synthetic-note");

  const duplicateRoot = await root();
  const retryDetail = detail();
  const duplicate = envelope({ retryItems: [
    { scope: scope(), noteId: "synthetic-note", detail: retryDetail },
    { scope: scope(), noteId: "synthetic-note", detail: retryDetail },
  ] });
  const duplicateName = await fixtureFile(duplicateRoot, duplicate);
  await assert.rejects(
    FixtureSession.open({ inputRoot: duplicateRoot, inputFile: duplicateName, mode: "fixture", account: { accountId: "synthetic-account", hostId: "xhs" } as never }),
    safeCode("INVALID_INPUT"),
  );
});

test("legacy v1 leaves collectors unknown and optional collector identities never replace the owner", async () => {
  const inputRoot = await root();
  const owner = { hostId: "xhs", accountId: "synthetic-account" } as const;
  const known = { hostId: "xhs", accountId: "secondary-collector" } as const;
  const legacyName = await fixtureFile(inputRoot, envelope(), "legacy.json");
  const legacy = await FixtureSession.open({ inputRoot, inputFile: legacyName, mode: "fixture", account: owner as never });
  assert.equal(legacy.listCollector, null);
  assert.equal(legacy.contentCollector, null);
  assert.equal((await legacy.client.getDetail(scope() as never, "synthetic-note" as never)).contentCollector, null);
  legacy.close();
  const value = { ...envelope(), listCollector: owner, contentCollector: known };
  const name = await fixtureFile(inputRoot, value, "collectors.json");
  const session = await FixtureSession.open({ inputRoot, inputFile: name, mode: "fixture", account: owner as never });
  assert.equal(session.account.accountId, owner.accountId);
  assert.deepEqual(session.listCollector, owner);
  assert.deepEqual((await session.client.getDetail(scope() as never, "synthetic-note" as never)).contentCollector, known);
  session.close();
});

test("one parsed envelope supplies later pages after the input file is no longer readable JSON", async () => {
  const inputRoot = await root();
  const value = envelope();
  value.pages.push({ ...value.pages[0]!, requestCursor: "server-cursor-2" as never, nextCursor: null as never, hasMore: false });
  const name = await fixtureFile(inputRoot, value);
  const session = await FixtureSession.open({ inputRoot, inputFile: name, mode: "fixture", account: { hostId: "xhs", accountId: "synthetic-account" } as never });
  await writeFile(path.join(inputRoot, name), "not JSON anymore");
  assert.equal((await session.client.listPage(scope() as never, null, 100)).hasMore, true);
  assert.equal((await session.client.listPage(scope() as never, "server-cursor-2" as never, 100)).hasMore, false);
  session.close();
});
