/** Apply a reviewed preparation plan as one exact-scope source commit. */
import { readFileSync } from "node:fs";

import { isGuardedBranch, type MonocarveConfig } from "../config.ts";
import { PreflightError } from "../errors.ts";
import { disallowedDirtyPaths } from "../util/dirty-tree.ts";
import { fileState } from "../util/files.ts";
import { currentBranch, git, headCommit, showBaseline, tryGit } from "../util/git.ts";
import { hashJson } from "../util/hash.ts";
import { workspacePath } from "../util/paths.ts";
import { rollback } from "../transaction/rollback.ts";
import { snapshotPaths } from "../transaction/journal.ts";
import type { GateResult } from "../transaction/simulate.ts";
import { auditPreparationSync, type PreparationAuditReport } from "./audit.ts";
import type { PreparationBaselineGraphScanner } from "./simulate.ts";
import {
  executePreparationJournal,
  finalizeCompletedPreparationJournal,
  PreparationJournalError,
  rollbackCompletedPreparationJournal,
  type PreparationJournalRecovery,
} from "./journal.ts";
import { assertPreparationManifestValid, serializePreparationManifest } from "./manifest.ts";
import type { PreparationManifest } from "./manifest-types.ts";
import { assertPreparationPolicy, commitPreparationScope, preparationFilesystemOperations, simulatePreparation } from "./simulate.ts";
import { runPreparationPostJournalPreparers } from "./post-journal.ts";

export class PreparationApplyError extends Error {
  override readonly name = "PreparationApplyError";
  constructor(message: string, readonly residue: readonly string[] = []) {
    super(message);
  }
}

export interface ApplyPreparationOptions {
  readonly config: MonocarveConfig;
  readonly rootDir: string;
  readonly manifest: PreparationManifest;
  /** Workspace-relative path of the reviewed, committed preparation manifest. */
  readonly manifestPath?: string;
  /** Source mutation is deliberately opt-in. Without it this performs simulation only. */
  readonly commit?: boolean;
  /** Optional test/host boundary; production uses the native baseline scanner. */
  readonly baselineGraphScanner?: PreparationBaselineGraphScanner;
  /** Narrow fault-injection seam for rollback proofs; normal callers omit it. */
  readonly testHooks?: PreparationApplyTestHooks;
}

export interface PreparationApplyTestHooks {
  readonly beforeJournalOperation?: (index: number) => void;
  readonly beforeCommit?: () => void;
  /** Runs only after the exact preparation scope has entered the index. */
  readonly afterStage?: () => void;
  /** Runs after the source commit and before its mandatory immediate audit. */
  readonly afterCommit?: () => void;
}

export interface PreparationApplyResult {
  readonly ok: boolean;
  readonly planId: string;
  readonly prepareCommit?: string;
  readonly rolledBack: boolean;
  readonly audit?: PreparationAuditReport;
  /** Structured diagnostics from the authoritative simulated gate failure. */
  readonly failedGate?: GateResult;
  readonly failure?: string;
}

export async function applyPreparation(options: ApplyPreparationOptions): Promise<PreparationApplyResult> {
  assertPreparationManifestValid(options.manifest);
  if (!options.commit) return simulatedOnly(options);
  assertCommittedPreparationPreconditions(options);
  const simulation = await simulatePreparation({ ...options, runGates: true });
  if (!simulation.ok) {
    return {
      ok: false,
      planId: options.manifest.planId,
      rolledBack: false,
      ...(simulation.failedGate === undefined ? {} : { failedGate: simulation.failedGate }),
      ...(simulation.failure === undefined ? {} : { failure: simulation.failure }),
    };
  }
  return applyCommittedPreparation(options, simulation.baselineGraph);
}

async function simulatedOnly(options: ApplyPreparationOptions): Promise<PreparationApplyResult> {
  const simulation = await simulatePreparation(options);
  return {
    ok: simulation.ok,
    planId: options.manifest.planId,
    rolledBack: false,
    ...(simulation.audit === undefined ? {} : { audit: simulation.audit }),
    ...(simulation.failedGate === undefined ? {} : { failedGate: simulation.failedGate }),
    ...(simulation.failure === undefined ? {} : { failure: simulation.failure }),
  };
}

function assertCommittedPreparationPreconditions(options: ApplyPreparationOptions): void {
  const branch = currentBranch(options.rootDir);
  if (isGuardedBranch(options.config, branch)) {
    throw new PreflightError(`refusing to commit preparation on the guarded branch ${branch}; apply from a feature branch instead`);
  }
  assertPreparationPolicy(options.config, options.manifest);
  assertApprovedPreparationManifest(options);
  assertLivePreparationEvidence(options);
  const dirty = disallowedDirtyPaths(options.rootDir, options.config.transaction.allowDirtyPaths, [
    ...options.manifest.changedFiles,
    ...(options.manifestPath === undefined ? [] : [options.manifestPath]),
  ]);
  if (dirty.length > 0) {
    throw new PreflightError(`preparation apply requires a clean worktree: ${dirty.join(", ")}`);
  }
}

function assertLivePreparationEvidence(options: ApplyPreparationOptions): void {
  if (options.manifest.baseline.configDigest !== hashJson(options.config)) {
    throw new PreflightError("preparation manifest was compiled with a different resolved configuration");
  }
  const currentFiles = Object.fromEntries(
    options.manifest.changedFiles.map((path) => [path, fileState(workspacePath(options.rootDir, path))]),
  );
  const currentContents = Object.fromEntries(
    [...new Set(options.manifest.declarations.map((group) => group.sourcePath))].map((path) => [
      path,
      readFileSync(workspacePath(options.rootDir, path), "utf8"),
    ]),
  );
  assertPreparationManifestValid(options.manifest, { currentFiles, currentContents });
}

/**
 * The manifest must be the only change in a direct child of its baseline.
 * Otherwise a source change could be silently approved alongside an unrelated
 * commit, and the later exact-scope commit would not prove review provenance.
 */
function assertApprovedPreparationManifest(options: ApplyPreparationOptions): void {
  const path = options.manifestPath;
  if (!path) throw new PreflightError("applying a preparation requires the path of its committed manifest");
  const { rootDir, manifest } = options;
  const baseline = git({ cwd: rootDir }, "rev-parse", manifest.baseline.commit);
  const head = headCommit(rootDir);
  if (head === baseline) throw new PreflightError("the preparation manifest must be committed before apply");
  const parent = git({ cwd: rootDir }, "rev-parse", `${head}^`);
  if (parent !== baseline) throw new PreflightError("the approved preparation manifest commit must be directly atop the preparation baseline");
  const subject = git({ cwd: rootDir }, "log", "-1", "--format=%s");
  if (subject !== manifest.commits.prepare.subject) {
    throw new PreflightError("the approved preparation manifest commit must use the preparation's Conventional Commit subject");
  }
  const changed = git({ cwd: rootDir }, "diff", "--name-only", "--no-renames", `${baseline}..${head}`).split("\n").filter(Boolean);
  if (!sameSet(changed, [path])) throw new PreflightError("HEAD must contain exactly the approved preparation manifest over the baseline");
  const approvedBytes = showBaseline(rootDir, head, path);
  if (approvedBytes === null || approvedBytes !== serializePreparationManifest(manifest)) {
    throw new PreflightError("loaded preparation manifest bytes do not match the reviewed manifest committed at HEAD");
  }
}

async function applyCommittedPreparation(
  options: ApplyPreparationOptions,
  baselineGraph: Awaited<ReturnType<typeof simulatePreparation>>["baselineGraph"],
): Promise<PreparationApplyResult> {
  const { rootDir, manifest } = options;
  const indexTree = tryGit({ cwd: rootDir }, "write-tree");
  const recovery = {
    headCommit: headCommit(rootDir),
    branch: currentBranch(rootDir),
    // The preparation journal owns filesystem recovery. An empty snapshot set
    // makes this helper restore only HEAD/index, never overwrite concurrent
    // residue the journal deliberately preserved.
    snapshots: snapshotPaths(rootDir, [...(manifest.generatedArtifacts ?? []).map((item) => item.path), ...(manifest.postJournalPreparers ?? []).flatMap((item) => item.outputs)]),
    staged: true,
    ...(indexTree === null ? {} : { indexTree }),
  };
  let journalRecovery: PreparationJournalRecovery;
  try {
    journalRecovery = executePreparationJournal({
      rootDir,
      operations: preparationFilesystemOperations(manifest),
      ...(options.testHooks?.beforeJournalOperation === undefined
        ? {}
        : { beforeOperation: (index) => options.testHooks?.beforeJournalOperation?.(index) }),
    }).recovery;
  } catch (error) {
    const residue = error instanceof PreparationJournalError ? error.residue : [];
    throw new PreparationApplyError(`preparation journal failed: ${(error as Error).message}`, residue);
  }
  try {
    const preparation = runPreparationPostJournalPreparers(options.config, rootDir, manifest);
    if (!preparation.ok) throw new PreparationApplyError(preparation.failure ?? "post-journal preparer failed");
    options.testHooks?.beforeCommit?.();
    commitPreparationScope(rootDir, manifest, true, options.testHooks?.afterStage);
    options.testHooks?.afterCommit?.();
    const audit = auditPreparationSync({
      config: options.config,
      rootDir,
      manifest,
      freshGraph: baselineGraph,
      regeneratedArtifacts: preparation.hashes as Readonly<Record<string, import("../util/hash.ts").Sha256>>,
      ...(options.manifestPath === undefined ? {} : { approvedManifestPath: options.manifestPath }),
    });
    if (!audit.passed) throw new PreparationApplyError(`preparation audit failed: ${audit.failures.join("; ")}`);
    finalizeCompletedPreparationJournal(journalRecovery);
    return { ok: true, planId: manifest.planId, prepareCommit: headCommit(rootDir), rolledBack: false, audit };
  } catch (error) {
    return rollbackAndThrow(rootDir, recovery, journalRecovery, error);
  }
}

async function rollbackAndThrow(
  rootDir: string,
  recovery: Parameters<typeof rollback>[1],
  journalRecovery: PreparationJournalRecovery,
  error: unknown,
): Promise<never> {
  const gitRecovery = await rollback(rootDir, recovery);
  const fileRecovery = rollbackCompletedPreparationJournal(journalRecovery);
  const residue = [...new Set([...gitRecovery.residue, ...fileRecovery.residue])].sort();
  const recoveryMessage = [
    gitRecovery.message,
    fileRecovery.failures.length === 0
      ? `preparation journal rollback restored ${fileRecovery.restored.length} path(s)`
      : `PREPARATION JOURNAL ROLLBACK INCOMPLETE: ${fileRecovery.failures.map((failure) => `${failure.path} (${failure.message})`).join("; ")}`,
  ].join("; ");
  throw new PreparationApplyError(`preparation apply failed: ${(error as Error).message} [${recoveryMessage}]`, residue);
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  const first = [...new Set(left)].sort();
  const second = [...new Set(right)].sort();
  return first.length === second.length && first.every((entry, index) => entry === second[index]);
}
