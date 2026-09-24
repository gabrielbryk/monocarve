import { createPackageManagerAdapter } from "../adapters/registry.ts";
import { TOOL_NAME } from "../branding.ts";
/** Apply a reviewed extraction plan, or refuse before touching the checkout. */
import { resetCodemodCaches } from "../codemod/imports.ts";
import { isGuardedBranch, type MonocarveConfig } from "../config.ts";
import { PreflightError } from "../errors.ts";
import { manifestPaths, planSensitivePaths, regeneratedArtifactPaths, pureRenames } from "../plan/manifest.ts";
import { assertPlanValid } from "../plan/validate.ts";
import { disallowedDirtyPaths } from "../util/dirty-tree.ts";
import { currentBranch, git, headCommit, tryGit } from "../util/git.ts";
import { commitAppliedPlan } from "./apply-commit.ts";
import { beginApplyTransaction } from "./apply-state.ts";
import { ApplyError, type ApplyOptions, type ApplyResult, type ApplyState } from "./apply-types.ts";
import { inspectCommitChain } from "./commit-evidence.ts";
import { executeJournal, preflightJournal, snapshotPaths } from "./journal.ts";
import { auditRepositoryPostconditions, repositoryPostconditionPaths } from "./postconditions.ts";
import { regenerateArtifacts } from "./regenerate.ts";
import { rollback } from "./rollback.ts";
import { simulatePlan, type SimulationResult } from "./simulate.ts";
import { installWorkspaceDependencies, linkPlannedPackage } from "./worktree.ts";

export { assertExactMoveDiff, assertExactScope } from "./apply-commit.ts";
export { ApplyError, type ApplyOptions, type ApplyResult, type ApplyState } from "./apply-types.ts";

export async function applyPlan(options: ApplyOptions): Promise<ApplyResult> {
  if (!options.commit) return applyWithoutTransaction(options);
  if (!options.manifestPath) throw new PreflightError("applying a plan requires the path of its committed manifest");
  const transaction = beginApplyTransaction(options.rootDir, options.manifest, options.manifestPath);
  try {
    const result = await applyWithoutTransaction(options, transaction);
    transaction.complete();
    return result;
  } catch (error) {
    if (!(error instanceof ApplyError) || error.residue.length === 0) transaction.complete();
    throw error;
  } finally {
    transaction.release();
  }
}

async function applyWithoutTransaction(options: ApplyOptions, transaction?: ReturnType<typeof beginApplyTransaction>): Promise<ApplyResult> {
  assertPlanValid(options.manifest, { config: options.config, rootDir: options.rootDir });
  const state = verifyApplyStart(options);
  const simulated = await simulateBeforeApply(options);
  if (simulated !== undefined) return simulated;
  if (!options.commit) return { ok: true, planId: options.manifest.planId, rolledBack: false };
  transaction?.update("applying");
  return applyCommittedPlan(options, state, transaction);
}

function verifyApplyStart(options: ApplyOptions): ApplyState {
  if (options.commit && isGuardedBranch(options.config, currentBranch(options.rootDir))) {
    throw new PreflightError(`refusing to commit on the guarded branch ${currentBranch(options.rootDir)}; apply from a feature branch instead`);
  }
  const head = headCommit(options.rootDir);
  const state = options.commit || head !== options.manifest.baselineCommit ? approvedManifestState(options, head) : "pre-apply";
  if (options.commit) assertCommittedPreconditions(options);
  return state;
}

function assertCommittedPreconditions(options: ApplyOptions): void {
  preflightJournal(options.config, options.manifest, options.rootDir);
  if (options.resume) return;
  const dirty = uncleanForPlan(options);
  if (dirty.length > 0) {
    throw new PreflightError(
      `apply requires a clean worktree: ${dirty.join(", ")}\n` +
        "commit or stash these paths; transaction.allowDirtyPaths may name only unrelated paths (plan inputs, outputs, consumers, and regenerated artifacts are never allowed).",
    );
  }
}

async function simulateBeforeApply(options: ApplyOptions): Promise<ApplyResult | undefined> {
  if (options.skipSimulation) return undefined;
  const simulation = await simulatePlan({
    config: options.config,
    rootDir: options.rootDir,
    manifest: options.manifest,
    ...(options.skipGates ? { skipGates: true } : {}),
    ...(options.verifyLockfile ? { verifyLockfile: true } : {}),
  });
  return simulation.ok
    ? undefined
    : {
        ok: false,
        planId: options.manifest.planId,
        rolledBack: false,
        failure: simulationFailure(simulation),
        ...(simulation.failedGate === undefined ? {} : { failedGate: simulation.failedGate }),
        ...(simulation.worktreePath === undefined ? {} : { worktreePath: simulation.worktreePath }),
        ...(simulation.gateRetry === undefined ? {} : { gateRetry: simulation.gateRetry }),
        ...(simulation.repositoryPostconditions === undefined ? {} : { repositoryPostconditions: simulation.repositoryPostconditions }),
      };
}

async function applyCommittedPlan(options: ApplyOptions, state: ApplyState, transaction?: ReturnType<typeof beginApplyTransaction>): Promise<ApplyResult> {
  const { config, rootDir, manifest } = options;
  const packageManager = createPackageManagerAdapter(config);
  resetCodemodCaches();
  const indexTree = tryGit({ cwd: rootDir }, "write-tree");
  const recoveryPoint = {
    headCommit: headCommit(rootDir),
    branch: currentBranch(rootDir),
    snapshots: snapshotPaths(rootDir, [
      ...manifestPaths(manifest),
      ...regeneratedArtifactPaths(manifest),
      ...(await repositoryPostconditionPaths(rootDir, packageManager)),
    ]),
    staged: true,
    ...(indexTree === null ? {} : { indexTree }),
  };
  try {
    await executeJournal({ config, treeRoot: rootDir, manifest, useGitMv: true });
    const dependencyRefresh = refreshCommittedDependencies(config, rootDir);
    if (config.transaction.nodeModules === "symlink") linkPlannedPackage(rootDir, manifest);
    const regeneration = regenerateArtifacts({ config, treeRoot: rootDir, manifest });
    if (!regeneration.ok) throw new ApplyError(regeneration.failure ?? "regeneration failed");
    const commits = commitAppliedPlan(rootDir, manifest, state, (commit) => transaction?.update("move-committed", commit));
    if (commits.wiringCommit !== undefined) transaction?.update("wiring-committed");
    options.testHooks?.beforeRepositoryPostconditions?.();
    const repositoryPostconditions = await auditRepositoryPostconditions({
      rootDir,
      adapter: packageManager,
      // Journal audit proves every manifest-written importer by hash. Keep
      // projection focused on the root and the new package, whose dependency
      // resolution is introduced by this transaction.
      packageRoots: [".", ...(manifest.target === undefined ? [] : [manifest.target.packageRoot])],
    });
    if (!repositoryPostconditions.passed) throw new ApplyError(`repository postconditions failed: ${repositoryPostconditions.failures.join("; ")}`);
    return {
      ok: true,
      planId: manifest.planId,
      ...commits,
      rolledBack: false,
      repositoryPostconditions,
      ...(dependencyRefresh === undefined ? {} : { dependencyRefresh }),
    };
  } catch (error) {
    const recovery = await rollback(rootDir, recoveryPoint);
    throw new ApplyError(`apply failed: ${(error as Error).message} [${recovery.message}]`, recovery.residue);
  }
}

/** Refresh ignored install state only when the configured simulation policy installs it. */
export function refreshCommittedDependencies(
  config: MonocarveConfig,
  rootDir: string,
  install: (rootDir: string, command: readonly string[]) => void = installWorkspaceDependencies,
): ApplyResult["dependencyRefresh"] {
  if (config.transaction.nodeModules !== "install") return undefined;
  const command = createPackageManagerAdapter(config).installCommand();
  install(rootDir, command);
  return { mode: "install", command, completed: true };
}

function simulationFailure(simulation: SimulationResult): string {
  // Failed gate output is part of `failure` itself so every caller, including
  // those that do not inspect the gates array, receives the bounded excerpt.
  return simulation.failure ?? "simulation failed";
}

function approvedManifestState(options: ApplyOptions, head: string): ApplyState {
  const path = options.manifestPath;
  if (!path) throw new PreflightError("applying a plan requires the path of its committed manifest");
  const planSubject = options.manifest.commits.plan?.subject;
  const expectedApproval =
    planSubject === undefined
      ? "the manifest has no configured approval subject"
      : `expected manifest-only approval: git add -- ${path} && git commit -m ${JSON.stringify(planSubject)}`;
  const baseline = git({ cwd: options.rootDir }, "rev-parse", options.manifest.baselineCommit);
  const resolvedHead = git({ cwd: options.rootDir }, "rev-parse", head);
  if (baseline === resolvedHead) throw new PreflightError(`the plan manifest must be committed before apply; ${expectedApproval}`);
  const parent = git({ cwd: options.rootDir }, "rev-parse", `${resolvedHead}^`);
  const changed = changedPaths(options.rootDir, `${baseline}..${resolvedHead}`);
  const subject = git({ cwd: options.rootDir }, "log", "-1", "--format=%s");
  if (changed.length === 1 && changed[0] === path && planSubject !== undefined && subject === planSubject) {
    if (parent !== baseline) throw new PreflightError("the approved manifest commit must be directly atop the plan baseline");
    return "pre-apply";
  }
  if (isApprovedMoveResume(options, { baseline, parent, path, subject, changed, planSubject })) return "post-move";
  if (options.resume) {
    throw new PreflightError(
      `--resume found HEAD subject ${JSON.stringify(subject)} with ${changed.length} file(s) changed over baseline ` +
        `${options.manifest.baselineCommit}; resume accepts only the approved manifest or exact move commit; ` +
        "a plan whose wiring commit already landed is fully applied and cannot be re-applied",
    );
  }
  if (changed.length !== 1 || changed[0] !== path)
    throw new PreflightError(`HEAD must contain exactly the approved manifest over the baseline; ${expectedApproval}`);
  throw new PreflightError(`the approved manifest commit subject is ${JSON.stringify(subject)}; expected ${JSON.stringify(planSubject)}`);
}

function isApprovedMoveResume(
  options: ApplyOptions,
  state: {
    readonly baseline: string;
    readonly parent: string;
    readonly path: string;
    readonly subject: string;
    readonly changed: readonly string[];
    readonly planSubject: string | undefined;
  },
): boolean {
  const moves = pureRenames(options.manifest);
  if (
    !options.resume ||
    state.subject !== options.manifest.commits.move.subject ||
    !sameSet(state.changed, [state.path, ...moves.flatMap((move) => [move.source, move.target])])
  )
    return false;
  const manifestParent = git({ cwd: options.rootDir }, "rev-parse", `${state.parent}^`);
  const manifestSubject = git({ cwd: options.rootDir }, "log", "-1", "--format=%s", state.parent);
  return (
    manifestParent === state.baseline &&
    manifestSubject === state.planSubject &&
    sameSet(changedPaths(options.rootDir, `${state.baseline}..${state.parent}`), [state.path])
  );
}

function changedPaths(rootDir: string, range: string): string[] {
  return git({ cwd: rootDir }, "diff", "--name-only", "--no-renames", range).split("\n").filter(Boolean);
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  const first = [...new Set(left)].toSorted();
  const second = [...new Set(right)].toSorted();
  return first.length === second.length && first.every((value, index) => value === second[index]);
}

function uncleanForPlan(options: ApplyOptions): readonly string[] {
  return disallowedDirtyPaths(options.rootDir, options.config.transaction.allowDirtyPaths, [
    ...planSensitivePaths(options.manifest),
    ...(options.manifestPath === undefined ? [] : [options.manifestPath]),
  ]);
}

export async function preflight(options: ApplyOptions): Promise<string[]> {
  const blockers: string[] = [];
  try {
    assertPlanValid(options.manifest, { config: options.config, rootDir: options.rootDir });
  } catch (error) {
    blockers.push((error as Error).message);
  }
  try {
    preflightJournal(options.config, options.manifest, options.rootDir);
  } catch (error) {
    blockers.push((error as Error).message);
  }
  const branch = currentBranch(options.rootDir);
  if (isGuardedBranch(options.config, branch)) blockers.push(`current branch ${branch} is guarded`);
  const dirty = uncleanForPlan(options);
  if (dirty.length > 0) blockers.push(`working tree is not clean: ${dirty.join(", ")}`);
  if (headCommit(options.rootDir) !== options.manifest.baselineCommit) {
    const head = headCommit(options.rootDir);
    if (
      options.manifestPath !== undefined &&
      inspectCommitChain({ rootDir: options.rootDir, manifest: options.manifest, manifestPath: options.manifestPath, headCommit: head }).phase === "applied"
    ) {
      blockers.push(`plan ${options.manifest.planId} is already applied; run ${TOOL_NAME} audit --plan ${options.manifestPath}`);
    } else {
      try {
        approvedManifestState(options, head);
      } catch (error) {
        blockers.push((error as Error).message);
      }
    }
  }
  return blockers;
}

/** True only for the exact manifest-only approval boundary accepted by apply. */
export function hasApprovedManifestHead(options: ApplyOptions): boolean {
  if (!options.manifestPath || headCommit(options.rootDir) === options.manifest.baselineCommit) return false;
  try {
    return approvedManifestState({ ...options, resume: false }, headCommit(options.rootDir)) === "pre-apply";
  } catch {
    return false;
  }
}
