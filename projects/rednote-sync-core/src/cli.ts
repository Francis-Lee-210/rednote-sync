#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import path from "node:path";
import { acknowledgeStop, exitCodeForCategory, repairViews, skipTask } from "./commands.ts";
import { requestScopePause, resumeScope } from "./control.ts";
import { runDoctor } from "./doctor.ts";
import { SafeError } from "./errors.ts";
import { currentRuntimeSupport, unsupportedRuntimeRecord } from "./runtime.js";
import { MemorySecretRegistry, assertPersistenceSafe, assertSerializedPersistenceSafe, createSafeLogger, validateSafeReason } from "./secrets.ts";
import { SqliteStateStore } from "./state-store.ts";
import {
  decodeAccountId,
  decodeBoardId,
  decodeHostId,
  decodeNoteId,
  decodePartitionScope,
  type AccountPartition,
  type ErrorCategory,
  type NoteId,
  type PartitionScope,
  type SyncTarget,
} from "./types.ts";
import { readStatus, verifyRoot } from "./verify.ts";

export const CLI_VERSION = "0.0.0-stage3";

const HELP = Object.freeze([
  "rednote-sync doctor",
  "rednote-sync init --root <dir>",
  "rednote-sync migrate --root <dir>",
  "rednote-sync validate-input --adapter fixture|import-json --input <file> --host xhs|rednote --account <id>",
  "rednote-sync sync --root <dir> --adapter fixture|import-json --input <file> --host xhs|rednote --account <id> --target posted|collected|liked|collected_album [--board-id <id>] [--limit 1..10] [--minimum-interval-ms 0..86400000]",
  "rednote-sync retry-failures --root <dir> --adapter fixture|import-json --input <file> --host xhs|rednote --account <id> --target posted|collected|liked|collected_album [--board-id <id>] [--limit 1..10]",
  "rednote-sync task skip --root <dir> --host xhs|rednote --account <id> --target posted|collected|liked|collected_album [--board-id <id>] --note-id <id> --reason <safe-text>",
  "rednote-sync acknowledge-stop --root <dir> --host xhs|rednote --account <id> --target posted|collected|liked|collected_album [--board-id <id>] --reason AUTH_REQUIRED|RATE_LIMITED|PROTOCOL",
  "rednote-sync pause|resume --root <dir> --host xhs|rednote --account <id> --target posted|collected|liked|collected_album [--board-id <id>]",
  "rednote-sync repair-views --root <dir> --host xhs|rednote --account <id>",
  "rednote-sync status --root <dir> [--host xhs|rednote --account <id> --target posted|collected|liked|collected_album [--board-id <id>]]",
  "rednote-sync verify --root <dir>",
  "rednote-sync --help",
  "rednote-sync --version",
]);

export type OfflineAdapterName = "fixture" | "import-json";

interface RootRequest { readonly root: string }
interface ScopedRequest extends RootRequest { readonly scope: PartitionScope }

export type CliRequest =
  | { readonly command: "help" }
  | { readonly command: "version" }
  | { readonly command: "doctor" }
  | ({ readonly command: "init" } & RootRequest)
  | ({ readonly command: "migrate" } & RootRequest)
  | { readonly command: "validate_input"; readonly adapter: OfflineAdapterName; readonly input: string; readonly account: AccountPartition }
  | ({ readonly command: "sync"; readonly adapter: OfflineAdapterName; readonly input: string; readonly limit: number; readonly minimumIntervalMs?: number } & ScopedRequest)
  | ({ readonly command: "retry_failures"; readonly adapter: OfflineAdapterName; readonly input: string; readonly limit: number } & ScopedRequest)
  | ({ readonly command: "skip"; readonly noteId: NoteId; readonly reason: string } & ScopedRequest)
  | ({ readonly command: "ack"; readonly reason: "AUTH_REQUIRED" | "RATE_LIMITED" | "PROTOCOL" } & ScopedRequest)
  | ({ readonly command: "pause" | "resume" } & ScopedRequest)
  | ({ readonly command: "repair_views"; readonly account: AccountPartition } & RootRequest)
  | ({ readonly command: "status"; readonly scope?: PartitionScope } & RootRequest)
  | ({ readonly command: "verify" } & RootRequest);

export interface CliCommandResult {
  readonly exitCode: number;
  readonly output: unknown;
}

export interface CliDependencies {
  doctor(): Promise<unknown>;
  init(root: string): Promise<unknown>;
  migrate(root: string): Promise<unknown>;
  validateInput(request: Extract<CliRequest, { readonly command: "validate_input" }>): Promise<unknown>;
  sync(request: Extract<CliRequest, { readonly command: "sync" }>): Promise<CliCommandResult>;
  retryFailures(request: Extract<CliRequest, { readonly command: "retry_failures" }>): Promise<CliCommandResult>;
  skip(request: Extract<CliRequest, { readonly command: "skip" }>): Promise<CliCommandResult>;
  acknowledge(request: Extract<CliRequest, { readonly command: "ack" }>): Promise<CliCommandResult>;
  pause(request: Extract<CliRequest, { readonly command: "pause" }>): Promise<unknown>;
  resume(request: Extract<CliRequest, { readonly command: "resume" }>): Promise<unknown>;
  repairViews(request: Extract<CliRequest, { readonly command: "repair_views" }>): Promise<CliCommandResult>;
  status(request: Extract<CliRequest, { readonly command: "status" }>): Promise<unknown>;
  verify(request: Extract<CliRequest, { readonly command: "verify" }>): Promise<CliCommandResult>;
}

export interface CliIo {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

interface ParsedOptions { readonly values: ReadonlyMap<string, string> }

function fail(message: string): never { throw new SafeError("INVALID_INPUT", message); }

function parseOptions(argv: readonly string[], allowed: readonly string[]): ParsedOptions {
  const allowedSet = new Set(allowed);
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || !flag.startsWith("--") || flag.includes("=") || !allowedSet.has(flag)) fail("unknown or misplaced option");
    if (values.has(flag)) fail("duplicate option");
    if (value === undefined || value.startsWith("--")) fail("option requires one value");
    values.set(flag, value);
  }
  return Object.freeze({ values });
}

function required(options: ParsedOptions, flag: string): string {
  const value = options.values.get(flag);
  if (value === undefined) fail("required option is missing");
  if (value.length === 0 || value.includes("\0") || /[\u0001-\u001f\u007f]/u.test(value)) fail("invalid option value");
  return value;
}

function target(value: string): SyncTarget {
  if (value !== "posted" && value !== "collected" && value !== "liked" && value !== "collected_album") fail("invalid target");
  return value;
}

function scopeFrom(options: ParsedOptions): PartitionScope {
  const selectedTarget = target(required(options, "--target"));
  const boardValue = options.values.get("--board-id");
  if (selectedTarget === "collected_album" && boardValue === undefined) fail("album target requires board id");
  if (selectedTarget !== "collected_album" && boardValue !== undefined) fail("ordinary target forbids board id");
  return decodePartitionScope({
    hostId: decodeHostId(required(options, "--host")),
    accountId: decodeAccountId(required(options, "--account")),
    target: selectedTarget,
    boardId: boardValue === undefined ? null : decodeBoardId(boardValue),
  });
}

function limitFrom(options: ParsedOptions): number {
  const raw = options.values.get("--limit");
  if (raw === undefined) return 5;
  if (!/^(?:[1-9]|10)$/u.test(raw)) fail("limit must be 1..10");
  return Number(raw);
}

function minimumIntervalFrom(options: ParsedOptions): number | undefined {
  const raw = options.values.get("--minimum-interval-ms");
  if (raw === undefined) return undefined;
  if (!/^(?:0|[1-9][0-9]{0,7})$/u.test(raw)) fail("minimum interval must be 0..86400000 milliseconds");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > 86_400_000) fail("minimum interval must be 0..86400000 milliseconds");
  return value;
}

function adapterFrom(options: ParsedOptions): OfflineAdapterName {
  const value = required(options, "--adapter");
  if (value !== "fixture" && value !== "import-json") fail("invalid offline adapter");
  return value;
}

function rootFrom(options: ParsedOptions): string { return required(options, "--root"); }

function parseStatus(argv: readonly string[]): CliRequest {
  const options = parseOptions(argv, ["--root", "--host", "--account", "--target", "--board-id"]);
  const root = rootFrom(options);
  const hasScope = ["--host", "--account", "--target", "--board-id"].some((flag) => options.values.has(flag));
  if (!hasScope) return Object.freeze({ command: "status", root });
  return Object.freeze({ command: "status", root, scope: scopeFrom(options) });
}

export function parseCliArgs(argvInput: readonly string[], registry = new MemorySecretRegistry()): CliRequest {
  const argv = [...argvInput];
  if (argv.length === 1 && argv[0] === "--help") return Object.freeze({ command: "help" });
  if (argv.length === 1 && argv[0] === "--version") return Object.freeze({ command: "version" });
  const command = argv.shift();
  if (command === undefined || command.startsWith("--")) fail("command is required");
  if (command === "doctor") {
    parseOptions(argv, []);
    return Object.freeze({ command });
  }
  if (command === "task") {
    if (argv.shift() !== "skip") fail("invalid task command");
    const options = parseOptions(argv, ["--root", "--host", "--account", "--target", "--board-id", "--note-id", "--reason"]);
    return Object.freeze({ command: "skip", root: rootFrom(options), scope: scopeFrom(options), noteId: decodeNoteId(required(options, "--note-id")), reason: validateSafeReason(required(options, "--reason"), registry) });
  }
  if (command === "init") {
    const options = parseOptions(argv, ["--root"]);
    return Object.freeze({ command, root: rootFrom(options) });
  }
  if (command === "migrate") {
    const options = parseOptions(argv, ["--root"]);
    return Object.freeze({ command, root: rootFrom(options) });
  }
  if (command === "validate-input") {
    const options = parseOptions(argv, ["--adapter", "--input", "--host", "--account"]);
    return Object.freeze({
      command: "validate_input",
      adapter: adapterFrom(options),
      input: required(options, "--input"),
      account: Object.freeze({ hostId: decodeHostId(required(options, "--host")), accountId: decodeAccountId(required(options, "--account")) }),
    });
  }
  if (command === "sync" || command === "retry-failures") {
    const allowed = ["--root", "--adapter", "--input", "--host", "--account", "--target", "--board-id", "--limit", ...(command === "sync" ? ["--minimum-interval-ms"] : [])];
    const options = parseOptions(argv, allowed);
    const common = { root: rootFrom(options), adapter: adapterFrom(options), input: required(options, "--input"), scope: scopeFrom(options), limit: limitFrom(options) };
    if (command === "retry-failures") return Object.freeze({ command: "retry_failures", ...common });
    const minimumIntervalMs = minimumIntervalFrom(options);
    return Object.freeze({ command: "sync", ...common, ...(minimumIntervalMs === undefined ? {} : { minimumIntervalMs }) });
  }
  if (command === "acknowledge-stop") {
    const options = parseOptions(argv, ["--root", "--host", "--account", "--target", "--board-id", "--reason"]);
    const reason = required(options, "--reason");
    if (reason !== "AUTH_REQUIRED" && reason !== "RATE_LIMITED" && reason !== "PROTOCOL") fail("invalid acknowledgement reason");
    return Object.freeze({ command: "ack", root: rootFrom(options), scope: scopeFrom(options), reason });
  }
  if (command === "pause" || command === "resume") {
    const options = parseOptions(argv, ["--root", "--host", "--account", "--target", "--board-id"]);
    return Object.freeze({ command, root: rootFrom(options), scope: scopeFrom(options) });
  }
  if (command === "repair-views") {
    const options = parseOptions(argv, ["--root", "--host", "--account"]);
    const account = Object.freeze({ hostId: decodeHostId(required(options, "--host")), accountId: decodeAccountId(required(options, "--account")) });
    return Object.freeze({ command: "repair_views", root: rootFrom(options), account });
  }
  if (command === "status") return parseStatus(argv);
  if (command === "verify") {
    const options = parseOptions(argv, ["--root"]);
    return Object.freeze({ command, root: rootFrom(options) });
  }
  fail("unknown command");
}

function commandName(request: CliRequest): string { return request.command; }

function validExitCode(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 9;
}

async function dispatch(request: CliRequest, dependencies: CliDependencies): Promise<CliCommandResult> {
  if (request.command === "help") return { exitCode: 0, output: { usage: HELP } };
  if (request.command === "version") return { exitCode: 0, output: { version: CLI_VERSION } };
  if (request.command === "doctor") return { exitCode: 0, output: await dependencies.doctor() };
  if (request.command === "init") return { exitCode: 0, output: await dependencies.init(request.root) };
  if (request.command === "migrate") return { exitCode: 0, output: await dependencies.migrate(request.root) };
  if (request.command === "validate_input") return { exitCode: 0, output: await dependencies.validateInput(request) };
  if (request.command === "sync") return dependencies.sync(request);
  if (request.command === "retry_failures") return dependencies.retryFailures(request);
  if (request.command === "skip") return dependencies.skip(request);
  if (request.command === "ack") return dependencies.acknowledge(request);
  if (request.command === "pause") return { exitCode: 0, output: await dependencies.pause(request) };
  if (request.command === "resume") return { exitCode: 0, output: await dependencies.resume(request) };
  if (request.command === "repair_views") return dependencies.repairViews(request);
  if (request.command === "status") return { exitCode: 0, output: await dependencies.status(request) };
  return dependencies.verify(request);
}

function errorCategory(error: unknown): ErrorCategory | "INTERNAL" {
  if (error instanceof SafeError) {
    if (error.code === "INVALID_INPUT") return "INVALID_INPUT";
    if (error.code === "BUSY") return "BUSY";
    if (error.code === "DERIVED_VIEW") return "DERIVED_VIEW";
    return "STATE";
  }
  if (error !== null && typeof error === "object" && "category" in error) {
    const category = (error as { readonly category?: unknown }).category;
    if (typeof category === "string" && ["INVALID_INPUT", "AUTH_REQUIRED", "RATE_LIMITED", "NETWORK", "PROTOCOL", "DETAIL", "MEDIA", "EXPORT", "STATE", "DERIVED_VIEW", "PAUSED", "BUSY", "INTERNAL"].includes(category)) return category as ErrorCategory;
  }
  return "INTERNAL";
}

function exitForError(error: unknown): number {
  const category = errorCategory(error);
  return category === "INTERNAL" ? 1 : exitCodeForCategory(category);
}

function safeMessage(error: unknown): string {
  return error instanceof SafeError ? error.message : "internal failure";
}

function serializeLine(value: unknown, registry: MemorySecretRegistry): string {
  assertPersistenceSafe(value, registry);
  const line = JSON.stringify(value);
  if (line === undefined) throw new SafeError("STATE", "command result is not serializable");
  assertSerializedPersistenceSafe(line, registry);
  return line;
}

async function withCommandSignal<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const onInterrupt = () => controller.abort();
  process.once("SIGINT", onInterrupt);
  try { return await operation(controller.signal); }
  finally { process.off("SIGINT", onInterrupt); }
}

export async function runCli(argv: readonly string[], dependencies: CliDependencies, io: CliIo, registry = new MemorySecretRegistry()): Promise<number> {
  let request: CliRequest | null = null;
  try {
    request = parseCliArgs(argv, registry);
    const result = await dispatch(request, dependencies);
    if (!validExitCode(result.exitCode)) throw new SafeError("STATE", "command returned invalid exit code");
    const line = serializeLine({ ok: result.exitCode === 0, command: commandName(request), exitCode: result.exitCode, result: result.output }, registry);
    io.stdout(line);
    return result.exitCode;
  } catch (error) {
    const exitCode = exitForError(error);
    const category = errorCategory(error);
    const stdout = serializeLine({ ok: false, command: request === null ? null : commandName(request), exitCode, error: { category } }, registry);
    io.stdout(stdout);
    const logger = createSafeLogger(registry, io.stderr);
    try { logger.error("command_failed", { category, message: safeMessage(error) }); }
    catch { logger.error("command_failed", { category: "STATE", message: "safe diagnostic blocked" }); }
    return exitCode;
  }
}

export const defaultCliDependencies: CliDependencies = Object.freeze({
  async doctor() { return runDoctor(); },
  async init(root) {
    const store = await SqliteStateStore.init(root);
    store.close();
    return Object.freeze({ initialized: true });
  },
  async migrate(root) {
    const store = await SqliteStateStore.migrate(root);
    store.close();
    return Object.freeze({ migrated: true, fromVersion: 0, toVersion: 1, backupCreated: false });
  },
  async validateInput(request) {
    const { FixtureSession } = await import("./offline-input.ts");
    const input = path.resolve(request.input);
    const session = await FixtureSession.open({ inputRoot: path.dirname(input), inputFile: path.basename(input), mode: request.adapter, account: request.account });
    try { return session.summary; }
    finally { session.close(); }
  },
  async sync(request) {
    return withCommandSignal(async (signal) => {
      const [{ SyncEngine }, { FixtureSession }] = await Promise.all([import("./sync-engine.ts"), import("./offline-input.ts")]);
      const input = path.resolve(request.input);
      const session = await FixtureSession.open({ inputRoot: path.dirname(input), inputFile: path.basename(input), mode: request.adapter, account: { hostId: request.scope.hostId, accountId: request.scope.accountId } });
      try {
        const result = await new SyncEngine({ root: request.root, scope: request.scope, session, limit: request.limit, minimumIntervalMs: request.minimumIntervalMs }).runPage(signal);
        return { exitCode: result.exitCode, output: result };
      } finally { session.close(); }
    });
  },
  async retryFailures(request) {
    return withCommandSignal(async (signal) => {
      const [{ SyncEngine }, { FixtureSession }] = await Promise.all([import("./sync-engine.ts"), import("./offline-input.ts")]);
      const input = path.resolve(request.input);
      const session = await FixtureSession.open({ inputRoot: path.dirname(input), inputFile: path.basename(input), mode: request.adapter, account: { hostId: request.scope.hostId, accountId: request.scope.accountId } });
      try {
        const result = await new SyncEngine({ root: request.root, scope: request.scope, session, limit: request.limit }).retryFailures(signal);
        return { exitCode: result.exitCode, output: result };
      } finally { session.close(); }
    });
  },
  async skip(request) { const result = await skipTask(request.root, request.scope, request.noteId, request.reason); return { exitCode: result.exitCode, output: result }; },
  async acknowledge(request) { const result = await acknowledgeStop(request.root, request.scope, request.reason); return { exitCode: result.exitCode, output: result }; },
  async pause(request) { await requestScopePause(request.root, request.scope); return Object.freeze({ paused: true }); },
  async resume(request) { await resumeScope(request.root, request.scope); return Object.freeze({ paused: false }); },
  async repairViews(request) { const result = await repairViews(request.root, request.account); return { exitCode: result.exitCode, output: result }; },
  async status(request) { return readStatus(request.root, request.scope); },
  async verify(request) { const result = await verifyRoot(request.root); return { exitCode: result.exitCode, output: result }; },
});

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const io: CliIo = Object.freeze({
    stdout(line) { process.stdout.write(`${line}\n`); },
    stderr(line) { process.stderr.write(`${line}\n`); },
  });
  const support = currentRuntimeSupport();
  if (!support.supported) {
    io.stdout(JSON.stringify(unsupportedRuntimeRecord(support)));
    io.stderr('{"level":"error","event":"unsupported_runtime"}');
    process.exitCode = 6;
    return 6;
  }
  const exitCode = await runCli(argv, defaultCliDependencies, io);
  process.exitCode = exitCode;
  return exitCode;
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) void main();
