import { randomUUID } from "node:crypto";
/** Durable ownership and recovery evidence for a committing extraction. */
import { closeSync, existsSync, linkSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { APPLY_LOCK_FILENAME, APPLY_STATE_FILENAME, TOOL_NAME } from "../branding.ts";
import { PreflightError } from "../errors.ts";
import type { ExtractionManifest } from "../plan/manifest.ts";
import { git, headCommit, tryGit } from "../util/git.ts";
import {
  checkpointRollbackPoint,
  persistCheckpoint,
  readCheckpoint,
  removeCheckpoint,
  restoreRollbackPoint,
  type CheckpointRestoreResult,
  type PersistedCheckpoint,
} from "./apply-checkpoint.ts";
import { errorText, errnoCode, ownerLiveness, systemProcessProbe, type ProcessProbe } from "./apply-owner.ts";
import type { RollbackPoint } from "./rollback.ts";

export type ApplyPhase = "simulating" | "applying" | "move-committed" | "wiring-committed";

/** Flag that explicitly accepts responsibility for discarding an unparseable apply lock. */
export const FORCE_CORRUPT_LOCK_FLAG = "force-corrupt-lock" as const;

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
}

export interface ApplyTransactionHandle {
  readonly state: ApplyTransactionState;
  update(phase: ApplyPhase, moveCommit?: string): void;
  /** Durably record the pre-mutation rollback point; must precede the first mutation. */
  checkpoint(point: RollbackPoint): void;
  complete(): void;
  release(): void;
}

export interface RecoverOptions {
  /** Discard an apply lock that is verifiably unparseable. Refused for a readable lock. */
  readonly forceCorruptLock?: boolean;
  /** Process-table seam for owner liveness; tests only. */
  readonly probe?: ProcessProbe;
}

export interface RecoverResult {
  readonly state?: ApplyTransactionState;
  readonly next: readonly string[];
  /** Present when an interrupted `applying` transaction was restored from its durable checkpoint. */
  readonly restored?: { readonly headCommit: string; readonly indexTree?: string; readonly paths: number; readonly message: string };
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
  const lockTemporary = `${paths.lock}.${process.pid}.${ownerToken}.tmp`;
  try {
    const descriptor = openSync(lockTemporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(initial)}\n`, "utf8");
    closeSync(descriptor);
    linkSync(lockTemporary, paths.lock);
  } catch (error) {
    if (errnoCode(error) !== "EEXIST") throw error;
    const active = readApplyTransactionState(rootDir);
    if (active === undefined && existsSync(paths.lock) && readState(paths.lock) === undefined) throw corruptLockError(paths.lock, manifestPath);
    const detail = active === undefined ? "an apply lock exists without readable transaction state" : statusDetail(active);
    throw new PreflightError(
      `${detail}; run ${TOOL_NAME} apply-status, then ${TOOL_NAME} apply-recover --plan ${JSON.stringify(manifestPath)} after confirming the owner stopped`,
    );
  } finally {
    if (existsSync(lockTemporary)) unlinkSync(lockTemporary);
  }
  writeState(paths.state, initial);
  let current = initial;
  let completed = false;
  return {
    get state() {
      return current;
    },
    update: (phase, moveCommit) => {
      current = { ...current, phase, ...(moveCommit === undefined ? {} : { moveCommit }) };
      writeState(paths.state, current);
    },
    checkpoint: (point) => {
      persistCheckpoint(paths.checkpoint, { ownerToken, planId: manifest.planId, rootDir }, point);
    },
    complete: () => {
      completed = true;
    },
    release: () => {
      removeOwned(paths.lock, ownerToken);
      if (completed) {
        removeOwned(paths.state, ownerToken);
        removeCheckpoint(paths.checkpoint, ownerToken);
      }
    },
  };
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
 * so recovery can be retried after manual repair.
 */
export function recoverApplyTransaction(rootDir: string, manifest: ExtractionManifest, options: RecoverOptions = {}): RecoverResult {
  const paths = statePaths(rootDir);
  const force = options.forceCorruptLock === true;
  const lockCorrupt = existsSync(paths.lock) && readState(paths.lock) === undefined;
  if (force) assertForceApplies(paths.lock, lockCorrupt);
  const state = readApplyTransactionState(rootDir);
  if (state === undefined) {
    if (!lockCorrupt) throw new PreflightError("no recoverable apply transaction state exists");
    if (!force) throw corruptLockError(paths.lock, "<plan>");
    return recoverCorruptLock(rootDir, manifest, paths);
  }
  if (lockCorrupt && !force) throw corruptLockError(paths.lock, state.manifestPath);
  if (state.planId !== manifest.planId) throw new PreflightError(`active transaction belongs to plan ${state.planId}, not ${manifest.planId}`);
  assertOwnerStopped(state, options.probe);
  const checkpoint = ownedCheckpoint(paths.checkpoint, state.ownerToken);
  const restored = state.phase === "applying" && checkpoint !== undefined ? restoreCheckpoint(rootDir, manifest, checkpoint) : undefined;
  if (lockCorrupt) unlinkSync(paths.lock);
  else removeOwned(paths.lock, state.ownerToken);
  removeOwned(paths.state, state.ownerToken);
  removeCheckpoint(paths.checkpoint, state.ownerToken);
  if (restored !== undefined) return { state, next: [TOOL_NAME, "apply", "--plan", state.manifestPath, "--commit"], restored };
  return { state, next: nextAfterRelease(rootDir, manifest, state) };
}

function assertForceApplies(lock: string, lockCorrupt: boolean): void {
  if (!existsSync(lock)) throw new PreflightError(`--${FORCE_CORRUPT_LOCK_FLAG} refused: no apply lock exists at ${lock}`);
  if (!lockCorrupt)
    throw new PreflightError(`--${FORCE_CORRUPT_LOCK_FLAG} refused: the apply lock at ${lock} is readable; run ${TOOL_NAME} apply-recover without it`);
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
function recoverCorruptLock(rootDir: string, manifest: ExtractionManifest, paths: StatePaths): RecoverResult {
  let checkpoint: PersistedCheckpoint | undefined;
  try {
    checkpoint = readCheckpoint(paths.checkpoint);
  } catch {
    checkpoint = undefined;
  }
  if (checkpoint !== undefined && checkpoint.planId !== manifest.planId)
    throw new PreflightError(`the apply checkpoint belongs to plan ${checkpoint.planId}, not ${manifest.planId}; recover with that plan`);
  const restored = checkpoint === undefined ? undefined : restoreCheckpoint(rootDir, manifest, checkpoint);
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

function restoreCheckpoint(rootDir: string, manifest: ExtractionManifest, checkpoint: PersistedCheckpoint): NonNullable<RecoverResult["restored"]> {
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
  const result: CheckpointRestoreResult = restoreRollbackPoint(rootDir, checkpointRollbackPoint(checkpoint));
  if (!result.ok) throw new PreflightError(`apply-recover could not restore the interrupted apply: ${result.message}; transaction files kept for retry`);
  return {
    headCommit: checkpoint.headCommit,
    ...(checkpoint.indexTree === undefined ? {} : { indexTree: checkpoint.indexTree }),
    paths: checkpoint.snapshots.length,
    message: result.message,
  };
}

function ownedCheckpoint(path: string, ownerToken: string): PersistedCheckpoint | undefined {
  let checkpoint: PersistedCheckpoint | undefined;
  try {
    checkpoint = readCheckpoint(path);
  } catch (error) {
    throw new PreflightError(`the apply checkpoint at ${path} is unreadable (${errorText(error)}); inspect it before recovering`);
  }
  return checkpoint?.ownerToken === ownerToken ? checkpoint : undefined;
}

export function applyTransactionStatus(
  rootDir: string,
  probe: ProcessProbe = systemProcessProbe,
): { active: boolean; ownerAlive: boolean; state?: ApplyTransactionState; next?: readonly string[]; corruptLock?: string; checkpointed?: true } {
  const paths = statePaths(rootDir);
  const state = readApplyTransactionState(rootDir);
  const lockCorrupt = existsSync(paths.lock) && readState(paths.lock) === undefined;
  if (state === undefined) {
    if (!lockCorrupt) return { active: false, ownerAlive: false };
    return { active: true, ownerAlive: false, corruptLock: paths.lock, next: [TOOL_NAME, "apply-recover", "--plan", "<plan>", `--${FORCE_CORRUPT_LOCK_FLAG}`] };
  }
  const ownerAlive = ownerLiveness(state.ownerPid, state.ownerStart, probe) !== "dead";
  const next = ownerAlive ? undefined : [TOOL_NAME, "apply-recover", "--plan", state.manifestPath, ...(lockCorrupt ? [`--${FORCE_CORRUPT_LOCK_FLAG}`] : [])];
  const checkpointed = state.phase === "applying" && existsSync(paths.checkpoint);
  return {
    active: true,
    ownerAlive,
    state,
    ...(next === undefined ? {} : { next }),
    ...(lockCorrupt ? { corruptLock: paths.lock } : {}),
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

function corruptLockError(lock: string, manifestPath: string): PreflightError {
  return new PreflightError(
    `the apply lock at ${lock} is unreadable or corrupt, so its owner cannot be identified; after confirming no ${TOOL_NAME} apply is running, ` +
      `run ${TOOL_NAME} apply-recover --plan ${JSON.stringify(manifestPath)} --${FORCE_CORRUPT_LOCK_FLAG}`,
  );
}

function writeState(path: string, state: ApplyTransactionState): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
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
  return `apply transaction ${state.planId} is ${state.phase} under process ${state.ownerPid}`;
}
