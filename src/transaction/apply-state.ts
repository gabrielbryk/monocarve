import { randomUUID } from "node:crypto";
/** Durable ownership and recovery evidence for a committing extraction. */
import { closeSync, existsSync, linkSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { APPLY_LOCK_FILENAME, APPLY_STATE_FILENAME, TOOL_NAME } from "../branding.ts";
import { PreflightError } from "../errors.ts";
import type { ExtractionManifest } from "../plan/manifest.ts";
import { git, headCommit } from "../util/git.ts";

export type ApplyPhase = "simulating" | "applying" | "move-committed" | "wiring-committed";

export interface ApplyTransactionState {
  readonly schema: "apply-transaction-v1";
  readonly planId: string;
  readonly manifestPath: string;
  readonly baselineCommit: string;
  readonly startHead: string;
  readonly ownerPid: number;
  readonly ownerToken: string;
  readonly phase: ApplyPhase;
  readonly moveCommit?: string;
}

export interface ApplyTransactionHandle {
  readonly state: ApplyTransactionState;
  update(phase: ApplyPhase, moveCommit?: string): void;
  complete(): void;
  release(): void;
}

export function beginApplyTransaction(rootDir: string, manifest: ExtractionManifest, manifestPath: string): ApplyTransactionHandle {
  const paths = statePaths(rootDir);
  const ownerToken = randomUUID();
  const initial: ApplyTransactionState = {
    schema: "apply-transaction-v1",
    planId: manifest.planId,
    manifestPath,
    baselineCommit: manifest.baselineCommit,
    startHead: headCommit(rootDir),
    ownerPid: process.pid,
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
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const active = readApplyTransactionState(rootDir);
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
    complete: () => {
      completed = true;
    },
    release: () => {
      removeOwned(paths.lock, ownerToken);
      if (completed) removeOwned(paths.state, ownerToken);
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

export function recoverApplyTransaction(rootDir: string, manifest: ExtractionManifest): { state: ApplyTransactionState; next: readonly string[] } {
  const paths = statePaths(rootDir);
  const state = readApplyTransactionState(rootDir);
  if (state === undefined) throw new PreflightError("no recoverable apply transaction state exists");
  if (state.planId !== manifest.planId) throw new PreflightError(`active transaction belongs to plan ${state.planId}, not ${manifest.planId}`);
  if (processAlive(state.ownerPid)) throw new PreflightError(`apply owner process ${state.ownerPid} is still running; recovery would race it`);
  removeOwned(paths.lock, state.ownerToken);
  removeOwned(paths.state, state.ownerToken);
  const subject = git({ cwd: rootDir }, "log", "-1", "--format=%s");
  const wiringLanded = state.phase === "wiring-committed" || subject === manifest.commits.wiring.subject;
  const moveLanded = state.phase === "move-committed" || subject === manifest.commits.move.subject;
  const next = wiringLanded
    ? [TOOL_NAME, "audit", "--plan", state.manifestPath]
    : [TOOL_NAME, "apply", "--plan", state.manifestPath, "--commit", ...(moveLanded ? ["--resume"] : [])];
  return { state, next };
}

export function applyTransactionStatus(rootDir: string): { active: boolean; ownerAlive: boolean; state?: ApplyTransactionState; next?: readonly string[] } {
  const state = readApplyTransactionState(rootDir);
  if (state === undefined) return { active: false, ownerAlive: false };
  const ownerAlive = processAlive(state.ownerPid);
  const next = ownerAlive ? undefined : [TOOL_NAME, "apply-recover", "--plan", state.manifestPath];
  return { active: true, ownerAlive, state, ...(next === undefined ? {} : { next }) };
}

function statePaths(rootDir: string): { lock: string; state: string } {
  const common = git({ cwd: rootDir }, "rev-parse", "--git-common-dir");
  const directory = isAbsolute(common) ? common : resolve(rootDir, common);
  return { lock: resolve(directory, APPLY_LOCK_FILENAME), state: resolve(directory, APPLY_STATE_FILENAME) };
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

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function statusDetail(state: ApplyTransactionState): string {
  return `apply transaction ${state.planId} is ${state.phase} under process ${state.ownerPid}`;
}
