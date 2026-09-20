import { constants } from "node:fs";
import { chmod, link, lstat, mkdtemp, open, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SafeError, normalizeSafeError } from "./errors.ts";
import { currentRuntimeSupport } from "./runtime.js";

export interface DoctorChecks {
  readonly nodeMajor26: true;
  readonly darwin: true;
  readonly uid: true;
  readonly nodeSqlite: true;
  readonly oNofollow: true;
  readonly symlinkNofollow: true;
  readonly oDirectory: true;
  readonly tempPhysical: true;
  readonly rootMode0700: true;
  readonly fileMode0600: true;
  readonly directoryFsync: true;
  readonly hardlink: true;
  readonly noClobber: true;
  readonly cleanup: true;
}

export interface DoctorReport {
  readonly supported: true;
  readonly checks: DoctorChecks;
}

function requireCapability(condition: unknown, message: string): asserts condition {
  if (!condition) throw new SafeError("STATE", message);
}

function sqliteCheck(): void {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("PRAGMA foreign_keys=ON; CREATE TABLE doctor_probe(value INTEGER); BEGIN IMMEDIATE; INSERT INTO doctor_probe VALUES(1); ROLLBACK;");
    const row = database.prepare("SELECT count(*) AS n FROM doctor_probe").get() as { readonly n?: unknown };
    requireCapability(Number(row.n) === 0, "SQLite rollback capability unavailable");
  } finally {
    database.close();
  }
}

export async function runDoctor(): Promise<DoctorReport> {
  const runtime = currentRuntimeSupport();
  requireCapability(runtime.supported && runtime.nodeMajor === 26, "unsupported Node runtime");
  requireCapability(process.platform === "darwin", "unsupported operating system");
  requireCapability(typeof process.getuid === "function", "POSIX uid capability unavailable");
  requireCapability(Number.isInteger(constants.O_NOFOLLOW), "O_NOFOLLOW capability unavailable");
  requireCapability(Number.isInteger(constants.O_DIRECTORY), "O_DIRECTORY capability unavailable");
  sqliteCheck();

  const uid = process.getuid();
  const physicalParent = await realpath(tmpdir());
  requireCapability(path.isAbsolute(physicalParent), "temporary directory is not absolute");
  let probeRoot: string | null = null;
  let cleanup = false;
  try {
    probeRoot = await mkdtemp(path.join(physicalParent, "rednote-sync-doctor-"));
    await chmod(probeRoot, 0o700);
    const physicalRoot = await realpath(probeRoot);
    requireCapability(physicalRoot === probeRoot, "temporary root is not physical");
    const rootInfo = await lstat(probeRoot);
    requireCapability(rootInfo.isDirectory() && !rootInfo.isSymbolicLink() && rootInfo.uid === uid && (rootInfo.mode & 0o777) === 0o700, "temporary root permissions unavailable");

    const primary = path.join(probeRoot, "capability-file");
    const linked = path.join(probeRoot, "capability-hardlink");
    const symbolic = path.join(probeRoot, "capability-symlink");
    const handle = await open(primary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile("doctor\n", { encoding: "utf8" });
      await handle.sync();
    } finally {
      await handle.close();
    }
    const primaryInfo = await lstat(primary);
    requireCapability(primaryInfo.isFile() && !primaryInfo.isSymbolicLink() && primaryInfo.uid === uid && (primaryInfo.mode & 0o777) === 0o600, "private file permissions unavailable");

    let noClobber = false;
    try {
      const duplicate = await open(primary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await duplicate.close();
    } catch (error) {
      noClobber = (error as NodeJS.ErrnoException).code === "EEXIST";
    }
    requireCapability(noClobber, "exclusive no-clobber create unavailable");

    await symlink(primary, symbolic);
    let symlinkNofollow = false;
    try {
      const followed = await open(symbolic, constants.O_RDONLY | constants.O_NOFOLLOW);
      await followed.close();
    } catch (error) {
      symlinkNofollow = (error as NodeJS.ErrnoException).code === "ELOOP";
    }
    requireCapability(symlinkNofollow, "O_NOFOLLOW did not reject a symbolic link");

    await link(primary, linked);
    const [afterLink, linkInfo] = await Promise.all([lstat(primary), lstat(linked)]);
    requireCapability(afterLink.isFile() && linkInfo.isFile() && afterLink.dev === linkInfo.dev && afterLink.ino === linkInfo.ino && afterLink.nlink === 2 && linkInfo.nlink === 2, "hardlink capability unavailable");

    const directory = await open(probeRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    throw normalizeSafeError(error, "STATE", "doctor capability check failed");
  } finally {
    if (probeRoot !== null) {
      try {
        await rm(probeRoot, { recursive: true, force: true });
        cleanup = await lstat(probeRoot).then(() => false, (error: NodeJS.ErrnoException) => error.code === "ENOENT");
      } catch {
        throw new SafeError("STATE", "doctor cleanup failed");
      }
    }
  }
  requireCapability(cleanup, "doctor cleanup failed");
  return Object.freeze({
    supported: true,
    checks: Object.freeze({
      nodeMajor26: true,
      darwin: true,
      uid: true,
      nodeSqlite: true,
      oNofollow: true,
      symlinkNofollow: true,
      oDirectory: true,
      tempPhysical: true,
      rootMode0700: true,
      fileMode0600: true,
      directoryFsync: true,
      hardlink: true,
      noClobber: true,
      cleanup: true,
    }),
  });
}
