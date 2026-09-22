import { randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { parseCampaignLedger, serializeCampaignLedger, type CampaignLedger } from "../campaign/index.ts";
import type { MonocarveConfig } from "../config.ts";
import { IoError, UsageError } from "../errors.ts";
import { tryGit } from "../util/git.ts";
import { relativeWorkspacePath, workspacePath } from "../util/paths.ts";

export interface LoadedCampaignLedger {
  readonly path: string;
  readonly contents: string;
  readonly campaign: CampaignLedger;
}

export function campaignLedgerPath(rootDir: string, config: MonocarveConfig, input: string): string {
  const path = relativeWorkspacePath(rootDir, input);
  const campaignDir = relativeWorkspacePath(rootDir, config.campaignDir);
  if (path !== campaignDir && !path.startsWith(`${campaignDir}/`)) {
    throw new UsageError(`campaign ledger ${path} must live beneath configured campaignDir ${campaignDir}`);
  }
  if (tryGit({ cwd: rootDir }, "check-ignore", "-q", "--", path) === null)
    throw new UsageError(`campaign ledger ${path} must be git-ignored operational state`);
  return path;
}

export function loadCampaignLedger(rootDir: string, config: MonocarveConfig, input: string): LoadedCampaignLedger {
  const path = campaignLedgerPath(rootDir, config, input);
  let contents: string;
  try {
    contents = readFileSync(workspacePath(rootDir, path), "utf8");
  } catch (error) {
    throw new IoError(`could not read campaign ledger ${path}: ${reason(error)}`);
  }
  return { path, contents, campaign: parseCampaignLedger(contents, path) };
}

export interface CampaignLedgerWriteIo {
  readonly writeFile: (path: string, contents: string, encoding: "utf8") => void;
  readonly rename: (from: string, to: string) => void;
  readonly remove: (path: string) => void;
  /** Test seam at the mutation boundary, after the old target is privately owned. */
  readonly afterOwnershipAcquired?: (target: string, backup: string) => void;
}

const WRITE_IO: CampaignLedgerWriteIo = { writeFile: writeFileSync, rename: renameSync, remove: (path) => rmSync(path, { force: true }) };

/** Ownership-transfer CAS: never overwrite a concurrent replacement. */
export function writeCampaignLedgerAtomically(rootDir: string, path: string, expected: string, contents: string, io: CampaignLedgerWriteIo = WRITE_IO): void {
  const target = workspacePath(rootDir, path);
  const temporary = temporaryPath(target, "update");
  const backup = temporaryPath(target, "owned");
  const lock = `${target}.lock`;
  let ownsLock = false;
  let ownsBackup = false;
  try {
    mkdirSync(dirname(target), { recursive: true });
    acquireCampaignLock(target, lock, backup);
    ownsLock = true;
    io.writeFile(temporary, contents, "utf8");
    io.rename(target, backup);
    ownsBackup = true;
    io.afterOwnershipAcquired?.(target, backup);
    if (readFileSync(backup, "utf8") !== expected) {
      const restored = restoreOwnedBackup(target, backup);
      ownsBackup = !restored;
      throw new IoError(
        `campaign ledger ${path} changed while this command was gathering evidence; refusing to overwrite it${restored ? "" : `; prior ledger retained at ${backup}`}`,
      );
    }
    try {
      linkSync(temporary, target);
    } catch (error) {
      const restored = restoreOwnedBackup(target, backup);
      ownsBackup = !restored;
      throw new IoError(
        `campaign ledger ${path} was concurrently replaced before publication; replacement preserved${restored ? "" : `; prior ledger retained at ${backup}`}: ${reason(error)}`,
      );
    }
    rmSync(backup, { force: true });
    ownsBackup = false;
  } catch (error) {
    io.remove(temporary);
    if (error instanceof IoError) throw error;
    const restored = ownsBackup ? restoreOwnedBackup(target, backup) : true;
    throw new IoError(`could not atomically persist campaign ledger ${path}${restored ? "" : `; prior ledger retained at ${backup}`}: ${reason(error)}`);
  } finally {
    io.remove(temporary);
    if (ownsLock) rmSync(lock, { force: true });
  }
}

/** Exclusive creation is the negative proof that init cannot overwrite a ledger. */
export function createCampaignLedgerFile(rootDir: string, path: string, ledger: CampaignLedger, afterPublish: () => void = () => {}): void {
  const target = workspacePath(rootDir, path);
  const temporary = temporaryPath(target, "init");
  const lock = `${target}.lock`;
  let ownsLock = false;
  let publishedIdentity: ReturnType<typeof identity> | undefined;
  try {
    mkdirSync(dirname(target), { recursive: true });
    acquireCampaignLock(target, lock);
    ownsLock = true;
    writeFileSync(temporary, serializeCampaignLedger(ledger), { encoding: "utf8", flag: "wx" });
    // Linking publishes a complete inode and fails atomically when target exists.
    linkSync(temporary, target);
    publishedIdentity = identity(target);
    afterPublish();
  } catch (error) {
    let residue = "";
    if (publishedIdentity !== undefined) {
      if (sameIdentity(target, publishedIdentity)) unlinkSync(target);
      else residue = "; concurrent replacement preserved at the campaign path";
    }
    throw new IoError(`could not create campaign ledger ${path} without overwriting an existing file${residue}: ${reason(error)}`);
  } finally {
    rmSync(temporary, { force: true });
    if (ownsLock) rmSync(lock, { force: true });
  }
}

export function persistCampaignLedger(rootDir: string, loaded: LoadedCampaignLedger, campaign: CampaignLedger): void {
  writeCampaignLedgerAtomically(rootDir, loaded.path, loaded.contents, serializeCampaignLedger(campaign));
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function temporaryPath(target: string, operation: string): string {
  return join(dirname(target), `.${basename(target)}.${process.pid}.${operation}.${randomUUID()}.tmp`);
}

function restoreOwnedBackup(target: string, backup: string): boolean {
  try {
    linkSync(backup, target);
    rmSync(backup, { force: true });
    return true;
  } catch {
    // A create-if-absent failure means a concurrent replacement owns target.
    return false;
  }
}

function identity(path: string): { readonly dev: bigint; readonly ino: bigint } {
  const stat = statSync(path, { bigint: true });
  return { dev: stat.dev, ino: stat.ino };
}

function sameIdentity(path: string, expected: ReturnType<typeof identity>): boolean {
  try {
    const actual = identity(path);
    return actual.dev === expected.dev && actual.ino === expected.ino;
  } catch {
    return false;
  }
}

function acquireCampaignLock(target: string, lock: string, backup?: string): void {
  const contents = `${JSON.stringify({ pid: process.pid, ...(backup === undefined ? {} : { backup }) })}\n`;
  try {
    writeFileSync(lock, contents, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (!recoverStaleCampaignLedgerLock(target, lock)) throw error;
    writeFileSync(lock, contents, { encoding: "utf8", flag: "wx" });
  }
}

/** Recover only a dead writer's ownership marker; a live or unparseable lock remains authoritative. */
export function recoverStaleCampaignLedgerLock(target: string, lock = `${target}.lock`): boolean {
  let state: { readonly pid?: unknown; readonly backup?: unknown };
  try {
    state = JSON.parse(readFileSync(lock, "utf8")) as typeof state;
  } catch {
    return false;
  }
  if (!Number.isInteger(state.pid) || (state.pid as number) <= 0 || processAlive(state.pid as number)) return false;
  const backup = typeof state.backup === "string" ? state.backup : undefined;
  if (backup !== undefined && !isOwnedBackupPath(target, backup, state.pid as number)) return false;
  if (!existsSync(target) && backup !== undefined && existsSync(backup)) {
    linkSync(backup, target);
    rmSync(backup, { force: true });
  }
  unlinkSync(lock);
  return true;
}

function isOwnedBackupPath(target: string, backup: string, pid: number): boolean {
  const prefix = `.${basename(target)}.${pid}.owned.`;
  const name = basename(backup);
  return (
    dirname(resolve(backup)) === dirname(resolve(target)) &&
    name.startsWith(prefix) &&
    name.endsWith(".tmp") &&
    /^[0-9a-f-]{36}$/u.test(name.slice(prefix.length, -4))
  );
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
