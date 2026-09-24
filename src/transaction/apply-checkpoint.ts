/**
 * Durable rollback checkpoint for a committing apply.
 *
 * The in-memory `RollbackPoint` dies with the process. A committing apply that
 * is SIGKILLed, loses its terminal, or crashes mid-journal would otherwise
 * leave a half-mutated checkout that `apply --commit` then refuses as dirty.
 * Before the first mutation, the exact same rollback point — pre-apply HEAD,
 * the tree object recording the pre-apply index, and the bytes/mode/link of
 * every snapshotted path — is written atomically beside the apply lock in the
 * git common dir. `apply-recover` restores it and verifies the restore; the
 * interrupt guard restores the in-memory copy on SIGINT/SIGTERM.
 */
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

import { PreflightError } from "../errors.ts";
import { git, tryGit } from "../util/git.ts";
import { MISSING, type FileState } from "../util/hash.ts";
import { errorText, systemProcessProbe, type ProcessProbe } from "./apply-owner.ts";
import { restoreSnapshot, snapshotMismatch, type Snapshot } from "./journal.ts";
import type { RollbackPoint } from "./rollback.ts";

export interface PersistedCheckpoint {
  readonly schema: "apply-checkpoint-v1";
  readonly ownerToken: string;
  readonly planId: string;
  /** Real path of the workspace root the snapshots are relative to. */
  readonly rootDir: string;
  readonly headCommit: string;
  readonly branch: string | null;
  readonly staged: boolean;
  readonly indexTree?: string;
  readonly snapshots: readonly PersistedSnapshot[];
  /**
   * States of snapshotted paths the apply observed at its own stage boundaries
   * (after the journal, after regeneration). Regenerated artifacts have no
   * declared result, so this is how recovery tells them from later user edits.
   */
  readonly observed?: Readonly<Record<string, readonly FileState[]>>;
}

interface PersistedSnapshot {
  readonly path: string;
  readonly kind: Snapshot["kind"];
  readonly state: FileState;
  readonly contentBase64?: string;
  readonly mode?: number;
  readonly linkTarget?: string;
  readonly absentAncestors: readonly string[];
}

export interface CheckpointRestoreResult {
  readonly ok: boolean;
  readonly residue: readonly string[];
  readonly restored: readonly string[];
  readonly message: string;
}

export function persistCheckpoint(
  path: string,
  identity: { ownerToken: string; planId: string; rootDir: string },
  point: RollbackPoint,
  observed?: Readonly<Record<string, readonly FileState[]>>,
): void {
  const record: PersistedCheckpoint = {
    schema: "apply-checkpoint-v1",
    ownerToken: identity.ownerToken,
    planId: identity.planId,
    rootDir: realpathSync(identity.rootDir),
    headCommit: point.headCommit,
    branch: point.branch,
    staged: point.staged,
    ...(point.indexTree === undefined ? {} : { indexTree: point.indexTree }),
    snapshots: [...point.snapshots].map(([snapshotPath, snapshot]) => persistedSnapshot(snapshotPath, snapshot)),
    ...(observed === undefined ? {} : { observed }),
  };
  writeDurably(path, `${JSON.stringify(record)}\n`);
}

function persistedSnapshot(path: string, snapshot: Snapshot): PersistedSnapshot {
  return {
    path,
    kind: snapshot.kind,
    state: snapshot.state,
    ...(snapshot.content === undefined ? {} : { contentBase64: Buffer.from(snapshot.content).toString("base64") }),
    ...(snapshot.mode === undefined ? {} : { mode: snapshot.mode }),
    ...(snapshot.linkTarget === undefined ? {} : { linkTarget: snapshot.linkTarget }),
    absentAncestors: snapshot.absentAncestors,
  };
}

/** Undefined when absent; throws when present but unusable, so a restore never runs on guesswork. */
export function readCheckpoint(path: string): PersistedCheckpoint | undefined {
  if (!existsSync(path)) return undefined;
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isPersistedCheckpoint(value)) throw new PreflightError(`unrecognized apply checkpoint at ${path}`);
  return value;
}

function isPersistedCheckpoint(value: unknown): value is PersistedCheckpoint {
  return (
    typeof value === "object" &&
    value !== null &&
    "schema" in value &&
    value.schema === "apply-checkpoint-v1" &&
    "snapshots" in value &&
    Array.isArray(value.snapshots) &&
    "headCommit" in value &&
    typeof value.headCommit === "string" &&
    "ownerToken" in value &&
    typeof value.ownerToken === "string"
  );
}

/** True when `value` is JSON recording `ownerToken` as its owner. */
function ownedBy(value: unknown, ownerToken: string): boolean {
  return typeof value === "object" && value !== null && "ownerToken" in value && value.ownerToken === ownerToken;
}

export function checkpointRollbackPoint(checkpoint: PersistedCheckpoint): RollbackPoint {
  const snapshots = new Map<string, Snapshot>(
    checkpoint.snapshots.map((snapshot): [string, Snapshot] => [
      snapshot.path,
      {
        exists: snapshot.kind !== "missing",
        kind: snapshot.kind,
        state: snapshot.kind === "missing" ? MISSING : snapshot.state,
        ...(snapshot.contentBase64 === undefined ? {} : { content: new Uint8Array(Buffer.from(snapshot.contentBase64, "base64")) }),
        ...(snapshot.mode === undefined ? {} : { mode: snapshot.mode }),
        ...(snapshot.linkTarget === undefined ? {} : { linkTarget: snapshot.linkTarget }),
        absentAncestors: snapshot.absentAncestors,
      },
    ]),
  );
  return {
    headCommit: checkpoint.headCommit,
    branch: checkpoint.branch,
    snapshots,
    staged: checkpoint.staged,
    ...(checkpoint.indexTree === undefined ? {} : { indexTree: checkpoint.indexTree }),
  };
}

/**
 * Synchronous twin of `rollback()`: same reset, index restore, and snapshot
 * restore, followed by an independent verification of HEAD, the index tree,
 * and every snapshotted path. Synchronous so a signal handler can finish it
 * before the interrupted flow could resume.
 */
export function restoreRollbackPoint(rootDir: string, point: RollbackPoint): CheckpointRestoreResult {
  const problems: string[] = [];
  if (point.staged) {
    try {
      git({ cwd: rootDir, quiet: true }, "reset", "--mixed", point.headCommit);
    } catch (error) {
      problems.push(`HEAD/index reset to ${point.headCommit} FAILED (${errorText(error)})`);
    }
    if (point.indexTree !== undefined) {
      try {
        git({ cwd: rootDir, quiet: true }, "read-tree", point.indexTree);
      } catch (error) {
        problems.push(`pre-apply index restore FAILED (${errorText(error)})`);
      }
    }
  }
  const restore = restoreSnapshot(rootDir, point.snapshots);
  const residue: string[] = [];
  for (const [path, snapshot] of point.snapshots) {
    try {
      const mismatch = snapshotMismatch(rootDir, path, snapshot);
      if (mismatch !== undefined) {
        residue.push(path);
        problems.push(`${path} still differs from its checkpoint (${mismatch})`);
      }
    } catch (error) {
      residue.push(path);
      problems.push(`${path} could not be verified (${errorText(error)})`);
    }
  }
  const head = tryGit({ cwd: rootDir }, "rev-parse", "HEAD");
  if (head !== point.headCommit) problems.push(`HEAD is ${head ?? "unreadable"}, expected ${point.headCommit}`);
  if (point.indexTree !== undefined) {
    const index = tryGit({ cwd: rootDir }, "write-tree");
    if (index !== point.indexTree) problems.push(`index tree is ${index ?? "unwritable"}, expected ${point.indexTree}`);
  }
  if (problems.length === 0) {
    return {
      ok: true,
      residue,
      restored: restore.restored,
      message: `checkpoint restored and verified: HEAD ${point.headCommit}, index ${point.indexTree ?? "reset to HEAD"}, ${point.snapshots.size} path(s) byte-identical`,
    };
  }
  return { ok: false, residue, restored: restore.restored, message: `CHECKPOINT RESTORE INCOMPLETE - manual recovery required: ${problems.join("; ")}` };
}

export function removeCheckpoint(path: string, ownerToken: string): void {
  if (!existsSync(path)) return;
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (ownedBy(value, ownerToken)) unlinkSync(path);
  } catch {
    /* A foreign or corrupt checkpoint is preserved for operator inspection. */
  }
}

/**
 * Atomic, durable replace. The temporary name carries this process's PID and
 * a random suffix, so a temporary left by a killed process whose PID was
 * later reused can never collide with a new write (`wx` would fail EEXIST).
 */
export function writeDurably(path: string, text: string): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, text);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
  const directory = openSync(resolve(dirname(path)), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

/**
 * Remove temporaries of `path` (`<path>.<pid>[.<suffix>].tmp`) whose writer
 * is provably gone. A temporary of a live or unverifiable process is kept: it
 * may be mid-write, and a leftover temporary is harmless with unique names.
 */
export function removeStaleTemporaries(path: string, probe: ProcessProbe = systemProcessProbe): string[] {
  const name = basename(path);
  const directory = dirname(path);
  const pattern = new RegExp(`^${escapeRegExp(name)}\\.(\\d+)(?:\\.[^/]+)?\\.tmp$`, "u");
  const removed: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return removed;
  }
  for (const entry of entries) {
    const pid = Number(pattern.exec(entry)?.[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid || probe.signal(pid) !== "missing") continue;
    try {
      unlinkSync(resolve(directory, entry));
      removed.push(entry);
    } catch {
      /* Already gone, or not ours to remove. */
    }
  }
  return removed;
}

function escapeRegExp(text: string): string {
  return text.replaceAll(/[$()*+.?[\\\]^{|}]/gu, String.raw`\$&`);
}
