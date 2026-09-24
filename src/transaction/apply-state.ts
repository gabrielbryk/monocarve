import { randomUUID } from "node:crypto";
/** Durable ownership and recovery evidence for a committing extraction. */
import { closeSync, existsSync, linkSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { APPLY_LOCK_FILENAME, APPLY_STATE_FILENAME, TOOL_NAME } from "../branding.ts";
import { PreflightError } from "../errors.ts";
import type { ExtractionManifest } from "../plan/manifest.ts";
import { git, headCommit, tryGit } from "../util/git.ts";
import type { FileState } from "../util/hash.ts";
import {
  checkpointRollbackPoint,
  persistCheckpoint,
  readCheckpoint,
  removeCheckpoint,
  removeStaleTemporaries,
  restoreRollbackPoint,
  writeDurably,
  type CheckpointRestoreResult,
  type PersistedCheckpoint,
} from "./apply-checkpoint.ts";
import { currentPathState, postInterruptionEdits } from "./apply-edits.ts";
import { errorText, errnoCode, ownerLiveness, systemProcessProbe, type ProcessProbe } from "./apply-owner.ts";
import type { RollbackPoint } from "./rollback.ts";

type ApplyPhase = "simulating" | "applying" | "move-committed" | "wiring-committed";

/** Flag that explicitly accepts responsibility for discarding an unparseable apply lock. */
export const FORCE_CORRUPT_LOCK_FLAG = "force-corrupt-lock" as const;

/** Flag that lets apply-recover overwrite changes made after the interruption with the pre-apply state. */
export const DISCARD_CHANGES_FLAG = "discard-changes" as const;

export interface ApplyTransactionState {
  readonly schema: "apply-transaction-v1";
  readonly planId: string;
  readonly manifestPath: string;
  readonly baselineCommit: string;
  readonly startHead: string;
  readonly ownerPid: number;
  /** Kernel start identity of the owner; absent in state written before it was recorded. */
  readonly ownerStart?: string;
  readonly ownerToken: string;
  readonly phase: ApplyPhase;
  readonly moveCommit?: string;
  /**
   * The owner stopped without finishing and let go of the transaction: it
   * will never touch the checkout again, so recovery need not wait for its
   * process to exit. The lock, state, and checkpoint stay until apply-recover.
   */
  readonly released?: true;
}

export interface ApplyTransactionHandle {
  readonly state: ApplyTransactionState;
  update(phase: ApplyPhase, moveCommit?: string): void;
  /** Durably record the pre-mutation rollback point; must precede the first mutation. */
  checkpoint(point: RollbackPoint): void;
  /** Durably record every checkpointed path's current state as one this transaction produced. */
  observe(): void;
  complete(): void;
  /**
   * Completed: remove the checkpoint, state, and lock. Otherwise keep all
   * three and mark the state released, so apply-recover stays the only way
   * forward and no new apply can take over the unrecovered checkout.
   */
  release(): void;
}

export interface RecoverOptions {
  /** Discard an apply lock that is verifiably unparseable. Refused for a readable lock. */
  readonly forceCorruptLock?: boolean;
  /** Restore even over paths changed after the interruption; those changes are lost. */
  readonly discardChanges?: boolean;
  /** Process-table seam for owner liveness; tests only. */
  readonly probe?: ProcessProbe;
}

export interface RecoverResult {
  readonly state?: ApplyTransactionState;
  readonly next: readonly string[];
  /** Present when an interrupted `applying` transaction was restored from its durable checkpoint. */
  readonly restored?: {
    readonly headCommit: string;
    readonly indexTree?: string;
    readonly paths: number;
    readonly message: string;
    /** Post-interruption changes overwritten under --discard-changes. */
    readonly discarded?: readonly string[];
  };
  /** Present when --force-corrupt-lock moved unparseable transaction files aside. */
  readonly quarantined?: readonly string[];
}

export function beginApplyTransaction(rootDir: string, manifest: ExtractionManifest, manifestPath: string): ApplyTransactionHandle {
  const paths = statePaths(rootDir);
  const ownerToken = randomUUID();
  const ownerStart = systemProcessProbe.startIdentity(process.pid);
  const initial: ApplyTransactionState = {
    schema: "apply-transaction-v1",
    planId: manifest.planId,
    manifestPath,
    baselineCommit: manifest.baselineCommit,
    startHead: headCommit(rootDir),
    ownerPid: process.pid,
    ...(ownerStart === null ? {} : { ownerStart }),
    ownerToken,
    phase: "simulating",
  };
  acquireLock(paths, initial, manifestPath);
  try {
    assertNoPendingTransaction(paths, manifestPath);
    for (const path of [paths.lock, paths.state, paths.checkpoint]) removeStaleTemporaries(path);
    writeState(paths.state, initial);
  } catch (error) {
    removeOwned(paths.lock, ownerToken);
    throw error;
  }
  const identity = { ownerToken, planId: manifest.planId, rootDir };
  const observed: Record<string, FileState[]> = {};
  let current = initial;
  let completed = false;
  let point: RollbackPoint | undefined;
  return {
    get state() {
      return current;
    },
    update: (phase, moveCommit) => {
      current = { ...current, phase, ...(moveCommit === undefined ? {} : { moveCommit }) };
      writeState(paths.state, current);
    },
    checkpoint: (rollbackPoint) => {
      point = rollbackPoint;
      persistCheckpoint(paths.checkpoint, identity, rollbackPoint);
    },
    observe: () => {
      if (point === undefined) return;
      for (const path of point.snapshots.keys()) recordObserved(observed, path, currentPathState(rootDir, path));
      persistCheckpoint(paths.checkpoint, identity, point, observed);
    },
    complete: () => {
      completed = true;
    },
    release: () => {
      if (!completed) {
        current = { ...current, released: true };
        writeState(paths.state, current);
        return;
      }
      // Checkpoint first: a kill mid-cleanup must never leave a checkpoint
      // without the state that says whether it still needs restoring.
      removeCheckpoint(paths.checkpoint, ownerToken);
      removeOwned(paths.state, ownerToken);
      removeOwned(paths.lock, ownerToken);
    },
  };
}

function recordObserved(observed: Record<string, FileState[]>, path: string, state: FileState | undefined): void {
  if (state === undefined) return;
  const states = (observed[path] ??= []);
  if (!states.includes(state)) states.push(state);
}

function acquireLock(paths: StatePaths, initial: ApplyTransactionState, manifestPath: string): void {
  const lockTemporary = `${paths.lock}.${process.pid}.${initial.ownerToken}.tmp`;
  try {
    const descriptor = openSync(lockTemporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(initial)}\n`, "utf8");
    closeSync(descriptor);
    linkSync(lockTemporary, paths.lock);
  } catch (error) {
    if (errnoCode(error) !== "EEXIST") throw error;
    const active = readState(paths.state) ?? readState(paths.lock);
    if (active === undefined && existsSync(paths.lock) && readState(paths.lock) === undefined) throw corruptLockError(paths.lock, manifestPath);
    const detail = active === undefined ? "an apply lock exists without readable transaction state" : statusDetail(active);
    throw new PreflightError(
      `${detail}; run ${TOOL_NAME} apply-status, then ${TOOL_NAME} apply-recover --plan ${JSON.stringify(active?.manifestPath ?? manifestPath)}${active?.released === true ? "" : " after confirming the owner stopped"}`,
    );
  } finally {
    if (existsSync(lockTemporary)) unlinkSync(lockTemporary);
  }
}

/**
 * With the lock held, any state or checkpoint on disk belongs to an earlier
 * transaction that was never recovered. Overwriting it would orphan the only
 * record of how to restore that checkout, so the new apply refuses.
 */
function assertNoPendingTransaction(paths: StatePaths, manifestPath: string): void {
  if (existsSync(paths.state)) {
    const pending = readState(paths.state);
    if (pending === undefined) throw corruptLockError(paths.state, manifestPath);
    throw new PreflightError(
      `${statusDetail(pending)}; it was never recovered (its lock is gone, its state remains); ` +
        `run ${TOOL_NAME} apply-status, then ${TOOL_NAME} apply-recover --plan ${JSON.stringify(pending.manifestPath)}`,
    );
  }
  if (existsSync(paths.checkpoint)) {
    throw new PreflightError(
      `an apply checkpoint from an unrecovered transaction exists at ${paths.checkpoint}; ` +
        `run ${TOOL_NAME} apply-status, then ${TOOL_NAME} apply-recover --plan <that plan's manifest> to restore it ` +
        "(if that apply is known to have completed, inspect and delete the file instead)",
    );
  }
}

export function readApplyTransactionState(rootDir: string): ApplyTransactionState | undefined {
  const paths = statePaths(rootDir);
  return readState(paths.state) ?? readState(paths.lock);
}

function readState(path: string): ApplyTransactionState | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as ApplyTransactionState;
    return value.schema === "apply-transaction-v1" ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Release a stopped owner. An owner stopped in `applying` with a durable
 * checkpoint is first restored to its exact pre-apply HEAD, index, and paths;
 * the restore is verified and, if it cannot be, all transaction files are kept
 * so recovery can be retried after manual repair. A restore that would
 * overwrite changes made after the interruption is refused unless
 * `discardChanges` accepts losing them.
 */
export function recoverApplyTransaction(rootDir: string, manifest: ExtractionManifest, options: RecoverOptions = {}): RecoverResult {
  const paths = statePaths(rootDir);
  const force = options.forceCorruptLock === true;
  const corrupt = corruptTransactionFile(paths);
  if (force) assertForceApplies(paths, corrupt);
  const state = readApplyTransactionState(rootDir);
  if (state === undefined) {
    if (corrupt === undefined) return recoverOrphanedCheckpoint(rootDir, manifest, paths, options);
    if (!force) throw corruptLockError(corrupt, "<plan>");
    return recoverCorruptLock(rootDir, manifest, paths, options);
  }
  if (corrupt !== undefined && !force) throw corruptLockError(corrupt, state.manifestPath);
  if (state.planId !== manifest.planId) throw new PreflightError(`active transaction belongs to plan ${state.planId}, not ${manifest.planId}`);
  if (state.released !== true) assertOwnerStopped(state, options.probe);
  const checkpoint = ownedCheckpoint(paths.checkpoint, state.ownerToken);
  const restored =
    state.phase === "applying" && checkpoint !== undefined
      ? restoreCheckpoint(rootDir, manifest, checkpoint, { ...options, manifestPath: state.manifestPath })
      : undefined;
  // Checkpoint first, lock last: an interrupted cleanup is itself recoverable.
  removeCheckpoint(paths.checkpoint, state.ownerToken);
  removeStateFile(paths.state, state.ownerToken);
  if (corrupt === paths.lock) unlinkSync(paths.lock);
  else removeOwned(paths.lock, state.ownerToken);
  if (existsSync(paths.checkpoint))
    return { state, next: [TOOL_NAME, "apply-recover", "--plan", state.manifestPath], ...(restored === undefined ? {} : { restored }) };
  if (restored !== undefined) return { state, next: [TOOL_NAME, "apply", "--plan", state.manifestPath, "--commit"], restored };
  return { state, next: nextAfterRelease(rootDir, manifest, state) };
}

/**
 * A checkpoint with neither lock nor state: left by an earlier version that
 * let a retried apply overwrite the state of an unrecovered transaction. No
 * owner is recorded, but no apply can be running without holding the lock.
 */
function recoverOrphanedCheckpoint(rootDir: string, manifest: ExtractionManifest, paths: StatePaths, options: RecoverOptions): RecoverResult {
  if (options.forceCorruptLock === true || !existsSync(paths.checkpoint)) throw new PreflightError("no recoverable apply transaction state exists");
  const checkpoint = ownedCheckpoint(paths.checkpoint, undefined);
  if (checkpoint === undefined) throw new PreflightError("no recoverable apply transaction state exists");
  if (checkpoint.planId !== manifest.planId)
    throw new PreflightError(`the orphaned apply checkpoint belongs to plan ${checkpoint.planId}, not ${manifest.planId}; recover with that plan`);
  const restored = restoreCheckpoint(rootDir, manifest, checkpoint, { ...options, manifestPath: "<plan>" });
  removeCheckpoint(paths.checkpoint, checkpoint.ownerToken);
  return { next: [TOOL_NAME, "apply-status"], restored };
}

function assertForceApplies(paths: StatePaths, corrupt: string | undefined): void {
  if (!existsSync(paths.lock) && !existsSync(paths.state))
    throw new PreflightError(`--${FORCE_CORRUPT_LOCK_FLAG} refused: no apply lock exists at ${paths.lock}`);
  if (corrupt === undefined) {
    const readable = existsSync(paths.lock) ? `the apply lock at ${paths.lock}` : `the apply state at ${paths.state}`;
    throw new PreflightError(`--${FORCE_CORRUPT_LOCK_FLAG} refused: ${readable} is readable; run ${TOOL_NAME} apply-recover without it`);
  }
}

/**
 * The transaction file whose owner cannot be read: an unparseable lock, or an
 * unparseable state with no lock to name the owner instead.
 */
function corruptTransactionFile(paths: StatePaths): string | undefined {
  if (existsSync(paths.lock)) return readState(paths.lock) === undefined ? paths.lock : undefined;
  return existsSync(paths.state) && readState(paths.state) === undefined ? paths.state : undefined;
}

function assertOwnerStopped(state: ApplyTransactionState, probe: ProcessProbe | undefined): void {
  const liveness = ownerLiveness(state.ownerPid, state.ownerStart, probe);
  if (liveness === "dead") return;
  throw new PreflightError(
    liveness === "alive"
      ? `apply owner process ${state.ownerPid} is still running; recovery would race it`
      : `apply owner process ${state.ownerPid} cannot be proven stopped; recovery would race it`,
  );
}

function nextAfterRelease(rootDir: string, manifest: ExtractionManifest, state: ApplyTransactionState): readonly string[] {
  const subject = git({ cwd: rootDir }, "log", "-1", "--format=%s");
  const wiringLanded = state.phase === "wiring-committed" || subject === manifest.commits.wiring.subject;
  const moveLanded = state.phase === "move-committed" || subject === manifest.commits.move.subject;
  return wiringLanded
    ? [TOOL_NAME, "audit", "--plan", state.manifestPath]
    : [TOOL_NAME, "apply", "--plan", state.manifestPath, "--commit", ...(moveLanded ? ["--resume"] : [])];
}

/**
 * The lock (and state, if any) cannot be parsed, so the owner cannot be
 * identified. The operator's flag asserts it stopped; the files are moved
 * aside rather than deleted, and a checkpoint for this plan and checkout is
 * still restored because its bytes, unlike the lock's, are intact.
 */
function recoverCorruptLock(rootDir: string, manifest: ExtractionManifest, paths: StatePaths, options: RecoverOptions): RecoverResult {
  let checkpoint: PersistedCheckpoint | undefined;
  try {
    checkpoint = readCheckpoint(paths.checkpoint);
  } catch {
    checkpoint = undefined;
  }
  if (checkpoint !== undefined && checkpoint.planId !== manifest.planId)
    throw new PreflightError(`the apply checkpoint belongs to plan ${checkpoint.planId}, not ${manifest.planId}; recover with that plan`);
  const restored = checkpoint === undefined ? undefined : restoreCheckpoint(rootDir, manifest, checkpoint, { ...options, manifestPath: "<plan>" });
  const suffix = `.corrupt-${new Date().toISOString().replaceAll(":", "")}`;
  const quarantined: string[] = [];
  for (const path of [paths.lock, paths.state, ...(checkpoint === undefined && existsSync(paths.checkpoint) ? [paths.checkpoint] : [])]) {
    if (!existsSync(path)) continue;
    renameSync(path, `${path}${suffix}`);
    quarantined.push(`${path}${suffix}`);
  }
  if (checkpoint !== undefined) removeCheckpoint(paths.checkpoint, checkpoint.ownerToken);
  return { next: [TOOL_NAME, "apply-status"], quarantined, ...(restored === undefined ? {} : { restored }) };
}

function restoreCheckpoint(
  rootDir: string,
  manifest: ExtractionManifest,
  checkpoint: PersistedCheckpoint,
  options: RecoverOptions & { readonly manifestPath: string },
): NonNullable<RecoverResult["restored"]> {
  if (realpathSync(rootDir) !== checkpoint.rootDir)
    throw new PreflightError(`the interrupted apply ran in ${checkpoint.rootDir}; run ${TOOL_NAME} apply-recover from that checkout`);
  const branch = tryGit({ cwd: rootDir }, "rev-parse", "--abbrev-ref", "HEAD");
  if (checkpoint.branch !== null && branch !== checkpoint.branch)
    throw new PreflightError(
      `checkout is on ${branch ?? "an unreadable ref"}, but the interrupted apply ran on ${checkpoint.branch}; switch back before recovering`,
    );
  const head = headCommit(rootDir);
  const parent = tryGit({ cwd: rootDir }, "rev-parse", `${head}^`);
  const subject = git({ cwd: rootDir }, "log", "-1", "--format=%s");
  // Only the transaction's own move commit may sit between the checkpoint and
  // HEAD (a kill between that commit and the phase update). Anything else is
  // work done after the interruption and is never reset away.
  if (head !== checkpoint.headCommit && !(parent === checkpoint.headCommit && subject === manifest.commits.move.subject)) {
    throw new PreflightError(
      `HEAD moved to ${head} since the interrupted apply checkpointed ${checkpoint.headCommit}; refusing to reset it — inspect git log and restore manually`,
    );
  }
  const edits = postInterruptionEdits(rootDir, checkpoint, manifest);
  if (edits.length > 0 && options.discardChanges !== true) {
    throw new PreflightError(
      `refusing to restore the interrupted apply: ${edits.length} path(s) changed after it stopped and would be overwritten: ${edits.join(", ")}; ` +
        `save or commit those changes elsewhere and re-run, or run ${TOOL_NAME} apply-recover --plan ${JSON.stringify(options.manifestPath)} --${DISCARD_CHANGES_FLAG} to overwrite them with the pre-apply state`,
    );
  }
  const result: CheckpointRestoreResult = restoreRollbackPoint(rootDir, checkpointRollbackPoint(checkpoint));
  if (!result.ok) throw new PreflightError(`apply-recover could not restore the interrupted apply: ${result.message}; transaction files kept for retry`);
  return {
    headCommit: checkpoint.headCommit,
    ...(checkpoint.indexTree === undefined ? {} : { indexTree: checkpoint.indexTree }),
    paths: checkpoint.snapshots.length,
    message: result.message,
    ...(edits.length === 0 ? {} : { discarded: edits }),
  };
}

/** The checkpoint at `path` if `ownerToken` owns it (any owner when undefined); throws when it is unreadable. */
function ownedCheckpoint(path: string, ownerToken: string | undefined): PersistedCheckpoint | undefined {
  let checkpoint: PersistedCheckpoint | undefined;
  try {
    checkpoint = readCheckpoint(path);
  } catch (error) {
    throw new PreflightError(`the apply checkpoint at ${path} is unreadable (${errorText(error)}); inspect it before recovering`, { cause: error });
  }
  return ownerToken === undefined || checkpoint?.ownerToken === ownerToken ? checkpoint : undefined;
}

export interface ApplyTransactionStatus {
  readonly active: boolean;
  readonly ownerAlive: boolean;
  readonly state?: ApplyTransactionState;
  readonly next?: readonly string[];
  /** Unparseable lock (or, without a lock, unparseable state). */
  readonly corruptLock?: string;
  readonly checkpointed?: true;
  /** A checkpoint left without lock or state; apply-recover restores it. */
  readonly orphanedCheckpoint?: string;
}

export function applyTransactionStatus(rootDir: string, probe: ProcessProbe = systemProcessProbe): ApplyTransactionStatus {
  const paths = statePaths(rootDir);
  const state = readApplyTransactionState(rootDir);
  const corrupt = corruptTransactionFile(paths);
  if (state === undefined) {
    if (corrupt !== undefined)
      return { active: true, ownerAlive: false, corruptLock: corrupt, next: [TOOL_NAME, "apply-recover", "--plan", "<plan>", `--${FORCE_CORRUPT_LOCK_FLAG}`] };
    if (existsSync(paths.checkpoint))
      return {
        active: true,
        ownerAlive: false,
        checkpointed: true,
        orphanedCheckpoint: paths.checkpoint,
        next: [TOOL_NAME, "apply-recover", "--plan", "<plan>"],
      };
    return { active: false, ownerAlive: false };
  }
  // A released owner no longer acts on the checkout, whether or not its process has exited.
  const ownerAlive = state.released !== true && ownerLiveness(state.ownerPid, state.ownerStart, probe) !== "dead";
  const next = ownerAlive
    ? undefined
    : [TOOL_NAME, "apply-recover", "--plan", state.manifestPath, ...(corrupt === undefined ? [] : [`--${FORCE_CORRUPT_LOCK_FLAG}`])];
  const checkpointed = state.phase === "applying" && existsSync(paths.checkpoint);
  return {
    active: true,
    ownerAlive,
    state,
    ...(next === undefined ? {} : { next }),
    ...(corrupt === undefined ? {} : { corruptLock: corrupt }),
    ...(checkpointed ? { checkpointed: true as const } : {}),
  };
}

interface StatePaths {
  readonly lock: string;
  readonly state: string;
  readonly checkpoint: string;
}

function statePaths(rootDir: string): StatePaths {
  const common = git({ cwd: rootDir }, "rev-parse", "--git-common-dir");
  const directory = isAbsolute(common) ? common : resolve(rootDir, common);
  return {
    lock: resolve(directory, APPLY_LOCK_FILENAME),
    state: resolve(directory, APPLY_STATE_FILENAME),
    checkpoint: resolve(directory, `${TOOL_NAME}-apply-checkpoint.json`),
  };
}

function corruptLockError(file: string, manifestPath: string): PreflightError {
  const kind = file.endsWith(".lock") ? "lock" : "state";
  return new PreflightError(
    `the apply ${kind} at ${file} is unreadable or corrupt, so its owner cannot be identified; after confirming no ${TOOL_NAME} apply is running, ` +
      `run ${TOOL_NAME} apply-recover --plan ${JSON.stringify(manifestPath)} --${FORCE_CORRUPT_LOCK_FLAG}`,
  );
}

function writeState(path: string, state: ApplyTransactionState): void {
  writeDurably(path, `${JSON.stringify(state)}\n`);
}

/** Remove the owner's state; an unparseable state is removed too, because the caller proved ownership through the lock. */
function removeStateFile(path: string, token: string): void {
  if (existsSync(path) && readState(path) === undefined) unlinkSync(path);
  else removeOwned(path, token);
}

function removeOwned(path: string, token: string): void {
  if (!existsSync(path)) return;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as { ownerToken?: string };
    if (value.ownerToken === token) unlinkSync(path);
  } catch {
    /* Foreign or corrupt state is preserved for operator inspection. */
  }
}

function statusDetail(state: ApplyTransactionState): string {
  return state.released === true
    ? `apply transaction ${state.planId} stopped at phase ${state.phase} without restoring the checkout and awaits recovery`
    : `apply transaction ${state.planId} is ${state.phase} under process ${state.ownerPid}`;
}
