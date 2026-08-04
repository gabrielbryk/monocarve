/**
 * Transaction journal orchestration.
 *
 * Simulation and real apply call this exact runner with different roots. On a
 * failure it restores the complete pre-journal snapshot before rethrowing; a
 * journal therefore has no partial-success mode.
 */
import { rmSync } from "node:fs";

import { createPackageManagerAdapter } from "../adapters/registry.ts";
import type { MonocarveConfig } from "../config.ts";
import { FAIL_OPERATION_ENV } from "../branding.ts";
import { git } from "../util/git.ts";
import { MISSING, type FileState } from "../util/hash.ts";
import { isAnyMove, manifestPaths, operationPaths, type ExtractionManifest, type PlanOperation } from "../plan/manifest.ts";
import { JournalError } from "./journal-error.ts";
import { applyOperation } from "./journal-operation.ts";
import { restoreSnapshot, snapshotPaths, type RestoreReport } from "./journal-snapshot.ts";
import { isAtPrecondition, isCompleted, stateAt } from "./journal-state.ts";

export { JournalError } from "./journal-error.ts";
export { restoreSnapshot, snapshotMismatch, snapshotPaths, type RestoreFailure, type RestoreReport, type Snapshot } from "./journal-snapshot.ts";
export { isAtPrecondition, isCompleted, preflightJournal } from "./journal-state.ts";

export interface JournalEntry {
  readonly index: number;
  readonly operation: PlanOperation;
  readonly before: Readonly<Record<string, FileState>>;
  readonly durationMs: number;
}

export interface JournalResult {
  readonly entries: readonly JournalEntry[];
  readonly filesWritten: readonly string[];
  readonly filesRemoved: readonly string[];
  readonly skipped: number;
}

export interface ExecuteJournalOptions {
  readonly config: MonocarveConfig;
  readonly treeRoot: string;
  readonly manifest: ExtractionManifest;
  readonly dryRun?: boolean;
  readonly useGitMv?: boolean;
}

export async function executeJournal(options: ExecuteJournalOptions): Promise<JournalResult> {
  const adapter = createPackageManagerAdapter(options.config);
  const snapshots = snapshotPaths(options.treeRoot, manifestPaths(options.manifest));
  const result: { entries: JournalEntry[]; filesWritten: string[]; filesRemoved: string[]; skipped: number } = {
    entries: [],
    filesWritten: [],
    filesRemoved: [],
    skipped: 0,
  };
  try {
    for (const [index, operation] of options.manifest.operations.entries()) {
      applyJournalEntry({ options, adapter, index, operation, result });
    }
  } catch (error) {
    resetGitMoves(options);
    throw withRestoreOutcome(error, restoreSnapshot(options.treeRoot, snapshots), snapshots.size);
  }
  return result;
}

interface EntryContext {
  readonly options: ExecuteJournalOptions;
  readonly adapter: ReturnType<typeof createPackageManagerAdapter>;
  readonly index: number;
  readonly operation: PlanOperation;
  readonly result: { entries: JournalEntry[]; filesWritten: string[]; filesRemoved: string[]; skipped: number };
}

function applyJournalEntry({ options, adapter, index, operation, result }: EntryContext): void {
  if (process.env[FAIL_OPERATION_ENV] === String(index)) throw new JournalError(`injected operation failure ${index}`);
  if (isCompleted(adapter, operation, options.treeRoot)) {
    result.skipped += 1;
    return;
  }
  if (!isAtPrecondition(adapter, operation, options.treeRoot)) {
    throw new JournalError(`operation precondition failed at ${index}: ${operation.kind}`);
  }
  if (options.dryRun) return;
  const started = Date.now();
  const before = Object.fromEntries(operationPaths(operation).map((path) => [path, stateAt(options.treeRoot, path)]));
  applyOperation(options.config, adapter, operation, options.treeRoot, options.useGitMv === true);
  result.entries.push({ index, operation, before, durationMs: Date.now() - started });
  recordEffect(result, operation);
}

function recordEffect(result: EntryContext["result"], operation: PlanOperation): void {
  if (isAnyMove(operation)) {
    result.filesRemoved.push(operation.source);
    result.filesWritten.push(operation.target);
    return;
  }
  result.filesWritten.push(operation.kind === "lockfile-importer" ? operation.lockfile : operation.kind === "rewrite-import" ? operation.file : operation.path);
}

function resetGitMoves(options: ExecuteJournalOptions): void {
  if (!options.useGitMv) return;
  try {
    git({ cwd: options.treeRoot, quiet: true }, "reset", "--", ...manifestPaths(options.manifest));
  } catch {
    // A repository with no commits has no HEAD to reset against.
  }
}

function withRestoreOutcome(error: unknown, report: RestoreReport, total: number): unknown {
  const notes = [
    report.restored.length > 0 ? `journal restored ${report.restored.length} of ${total} path(s) to their pre-journal state` : undefined,
    report.failures.length > 0
      ? `JOURNAL RESTORE INCOMPLETE - ${report.failures.length} path(s) NOT restored: ${report.failures.map((failure) => `${failure.path} (${failure.message})`).join("; ")}`
      : undefined,
  ].filter((note): note is string => note !== undefined);
  if (notes.length > 0 && error instanceof Error) error.message = `${error.message} [${notes.join("; ")}]`;
  return error;
}

/** Undo only paths that did not exist before their recorded operation. */
export async function revertJournal(treeRoot: string, entries: readonly JournalEntry[]): Promise<void> {
  for (const entry of [...entries].reverse()) {
    for (const [path, state] of Object.entries(entry.before)) if (state === MISSING) rmSync(`${treeRoot}/${path}`, { force: true });
  }
}
