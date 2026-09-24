import { createPackageManagerAdapter } from "../adapters/registry.ts";
import { createTaskRunnerAdapter } from "../adapters/registry.ts";
import type { PackageManagerAdapter } from "../adapters/types.ts";
import { SIMULATION_GIT_IDENTITY } from "../branding.ts";
import { resetCodemodCaches } from "../codemod/imports.ts";
import type { MonocarveConfig } from "../config.ts";
import { packageContainerRoots } from "../config.ts";
import { MonocarveError } from "../errors.ts";
import type { ExtractionManifest } from "../plan/manifest.ts";
import { git } from "../util/git.ts";
import { compareAssetEmission, type AssetEmissionReport } from "./asset-emission.ts";
import { auditPlanSync } from "./audit.ts";
import { executeJournal, preflightJournal } from "./journal.ts";
import { verifyLockfile, type LockfileVerification } from "./lockfile-verify.ts";
import { auditRepositoryPostconditions, type RepositoryPostconditionReport } from "./postconditions.ts";
import type { ProjectedImporterVerification } from "./projected-importers.ts";
import { regenerateArtifacts, type RegenerationReport } from "./regenerate.ts";
// The gate-tier scheduler lives in its own module purely to keep this file
// under the line-count gate; re-exported here so every existing importer of
// `runGateTiers` from `simulate.ts` keeps working unchanged.
import { runGateTiers } from "./simulate-gates.ts";
import { createWorktree, installWorkspaceDependencies, linkPlannedPackage } from "./worktree.ts";

export { runGateTiers } from "./simulate-gates.ts";

class SimulationError extends MonocarveError {
  override readonly name = "SimulationError";
}
export interface GateResult {
  readonly command: string;
  readonly tier: "package" | "project" | "workspace";
  readonly exitCode: number;
  readonly durationMs: number;
  /** Tail of combined output, retained only on failure. */
  readonly output?: string;
  /** Opening context from the failed process's complete stdout and stderr. */
  readonly outputHead?: string;
  /** Final diagnostics from the failed process's complete stdout and stderr. */
  readonly outputTail?: string;
  /** Absolute path to the complete stdout/stderr log, outside the gated tree. */
  readonly logPath?: string;
  /** Persistence error, when the gate failed but its full log could not be written. */
  readonly logWriteFailure?: string;
  readonly attempts?: readonly { readonly exitCode: number; readonly durationMs: number; readonly output?: string }[];
}
export interface GateCommandOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}
/** Injectable process boundary for deterministic scheduler tests. */
export type GateCommandRunner = (command: readonly string[], options: { readonly cwd: string; readonly timeoutMs: number }) => Promise<GateCommandOutput>;

export interface SimulationResult {
  readonly ok: boolean;
  readonly planId: string;
  /** Worktree path, retained when cleanup is disabled or the run failed. */
  readonly worktreePath?: string;
  readonly operationsApplied: number;
  readonly gates: readonly GateResult[];
  /** Structured evidence for the authoritative failed gate. */
  readonly failedGate?: GateResult;
  readonly gateRetry?: { readonly cwd: string; readonly command: string };
  /**
   * Declared dependencies of the new package that resolve nowhere in the
   * worktree, so nothing links them. Omitted when empty, and only ever set once
   * gates are reached — every gate below it may be failing on this rather than
   * on the extraction.
   */
  readonly unlinkedDependencies?: readonly string[];
  readonly lockfileVerification?: LockfileVerification;
  readonly projectedImporterVerification?: ProjectedImporterVerification;
  readonly repositoryPostconditions?: RepositoryPostconditionReport;
  /**
   * What the declared generated artifacts did when they were regenerated in the
   * worktree, between the journal and the audit. Empty `artifacts` means the
   * plan declared none — no configured artifact's `triggers` matched a moved
   * path — not that regeneration was skipped.
   */
  readonly regeneration?: RegenerationReport;
  readonly assetEmission?: AssetEmissionReport;
  readonly failure?: string;
}

export interface SimulateOptions {
  readonly config: MonocarveConfig;
  readonly rootDir: string;
  readonly manifest: ExtractionManifest;
  readonly skipGates?: boolean;
  /**
   * Run the manifest's gates even when ordinary simulations are disabled in
   * config.  This is the explicit contract of the `doctor` command: an
   * operator asked to preflight the extraction environment wants the gates the
   * manifest declares, not a report about a configured shortcut.
   */
  readonly runGates?: boolean;
  /**
   * Regenerate the lockfile with the package manager and compare it to the one
   * the plan spliced. Costs a package-manager run, so it is opt-in; a mismatch
   * fails the simulation, and a package manager that is not there is an error
   * rather than a skip.
   *
   * Only runs when the plan actually splices the lockfile. With no
   * `lockfile-importer` operation there is no transform of this tool's to check,
   * and the comparison would report on the repository's own lockfile instead.
   */
  readonly verifyLockfile?: boolean;
}

export async function simulatePlan(options: SimulateOptions): Promise<SimulationResult> {
  const { config, manifest, rootDir } = options;
  const packageManager = createPackageManagerAdapter(config);
  const taskRunner = createTaskRunnerAdapter(config);
  const gates: GateResult[] = [];
  let unlinked: readonly string[] = [];

  const worktree = await createWorktree({
    rootDir,
    commit: manifest.baselineCommit,
    worktreeRoot: config.transaction.worktreeRoot,
    packageRoots: packageContainerRoots(config),
    nodeModules: config.transaction.nodeModules,
    installCommand: packageManager.installCommand(),
    label: manifest.planId,
  });

  // Everything below reads the worktree, a different tree from the checkout the
  // caller has been reading — and one whose files carry the same relative paths.
  resetCodemodCaches();

  let keep = false;
  try {
    preflightJournal(config, manifest, worktree.workspacePath);
    const journal = await executeJournal({ config, treeRoot: worktree.workspacePath, manifest });

    // Some repository-owned post-journal generators deliberately inventory the
    // Git index (for example, a source-duplicate ratchet). The journal writes
    // a faithful filesystem tree, but its moved targets are otherwise
    // untracked until the later gate setup. Commit that exact journal result
    // before generators run so each observes the same package boundaries that
    // the eventual gate will inspect. Generated outputs remain unstaged and
    // are still audited against their declared post-journal provenance below.
    commitSimulatedExtraction(worktree.workspacePath, manifest);

    // The baseline install cannot see the package/importer the journal creates;
    // install again against the landed plan, or materialize equivalent links,
    // before a post-journal generator imports the newly created package.
    if (config.transaction.nodeModules === "install") {
      installWorkspaceDependencies(worktree.workspacePath, packageManager.installCommand());
    } else if (config.transaction.nodeModules === "symlink") {
      unlinked = linkPlannedPackage(worktree.workspacePath, manifest);
    }

    const lockfileVerification = maybeVerifyLockfile(options, worktree.workspacePath, packageManager);
    if (lockfileVerification && !lockfileVerification.ok) {
      keep = !config.transaction.cleanup;
      return {
        ok: false,
        planId: manifest.planId,
        ...(keep ? { worktreePath: worktree.path } : {}),
        operationsApplied: journal.entries.length,
        gates,
        lockfileVerification,
        failure: `${lockfileVerification.lockfile} is not what \`${lockfileVerification.command}\` produces: ${(lockfileVerification.differences ?? []).join(
          "\n",
        )}`,
      };
    }

    // Before the audit, and therefore before the gates: generators run only
    // after package installation/linking and lockfile proof, so their imports
    // observe the same projected dependency graph as later compilation.
    const regeneration = regenerateArtifacts({ config, treeRoot: worktree.workspacePath, manifest });
    if (!regeneration.ok) {
      keep = !config.transaction.cleanup;
      return {
        ok: false,
        planId: manifest.planId,
        ...(keep ? { worktreePath: worktree.path } : {}),
        operationsApplied: journal.entries.length,
        gates,
        regeneration,
        ...(lockfileVerification === undefined ? {} : { lockfileVerification }),
        failure: regeneration.failure ?? "regeneration failed",
      };
    }

    const audit = auditPlanSync({
      config,
      rootDir: worktree.workspacePath,
      manifest,
      installedRoot: config.transaction.nodeModules === "install" ? worktree.workspacePath : rootDir,
      regeneratedArtifacts: Object.fromEntries(regeneration.artifacts.map((artifact) => [artifact.path, artifact.hash])),
    });
    if (!audit.passed) {
      keep = !config.transaction.cleanup;
      return {
        ok: false,
        planId: manifest.planId,
        ...(keep ? { worktreePath: worktree.path } : {}),
        operationsApplied: journal.entries.length,
        gates,
        regeneration,
        failure: `audit failed in the simulation worktree: ${audit.failures.join("; ")}`,
      };
    }

    const repositoryPostconditions = await auditRepositoryPostconditions({
      rootDir: worktree.workspacePath,
      adapter: packageManager,
      // auditPlanSync above already checks the exact planned hash of every
      // importer rewrite. Re-project only the root and the newly scaffolded
      // package: an existing consumer can legitimately have ambiguous peer
      // contexts that are unrelated to this extraction.
      packageRoots: [".", ...(manifest.target === undefined ? [] : [manifest.target.packageRoot])],
    });
    const projectedImporterVerification = repositoryPostconditions.importerVerification;
    if (!repositoryPostconditions.passed) {
      keep = !config.transaction.cleanup;
      return {
        ok: false,
        planId: manifest.planId,
        ...(keep ? { worktreePath: worktree.path } : {}),
        operationsApplied: journal.entries.length,
        gates,
        regeneration,
        projectedImporterVerification,
        repositoryPostconditions,
        failure: `repository postconditions failed: ${repositoryPostconditions.failures.join("; ")}`,
      };
    }
    let assetEmission: AssetEmissionReport | undefined;
    if (config.assetEmissionProofs.length > 0) {
      commitSimulatedExtraction(worktree.workspacePath, manifest);
      assetEmission = await compareAssetEmission({ config, rootDir, candidateRoot: worktree.workspacePath, manifest });
      if (!assetEmission.passed) {
        keep = !config.transaction.cleanup;
        const failures = assetEmission.checks
          .filter((check) => !check.passed)
          .map(
            (check) =>
              `${check.id}: ${check.failure ?? `missing selectors [${check.missingSelectors.join(", ")}]; changed declaration order [${check.changedDeclarationOrder.join(", ")}]`}`,
          );
        return {
          ok: false,
          planId: manifest.planId,
          ...(keep ? { worktreePath: worktree.path } : {}),
          operationsApplied: journal.entries.length,
          gates,
          regeneration,
          assetEmission,
          failure: `asset-emission proof failed: ${failures.join("; ")}`,
        };
      }
    }

    if (!options.skipGates && (options.runGates ?? config.transaction.simulateGates)) {
      commitSimulatedExtraction(worktree.workspacePath, manifest);
      // A post-journal preparer may repair a ratchet whose file is not listed
      // in Moon's task inputs. Reusing a cache entry computed before that
      // output existed would make the gate judge a stale tree (and can turn a
      // now-clean extraction into a false failure). Force Moon only when a
      // declared generator actually changed an output; every other simulation
      // keeps ordinary cache behaviour.
      const wrapCommand =
        regeneration.artifacts.some((artifact) => artifact.changed) && taskRunner.id === "moon"
          ? (command: string) => taskRunner.wrapGateCommand(`MOON_FORCE=true MOON_CONCURRENCY=1 ${command}`)
          : taskRunner.wrapGateCommand;
      const gateRun = await runGateTiers({
        gates: manifest.gates,
        maxConcurrency: config.gates.maxConcurrency,
        cwd: worktree.workspacePath,
        timeoutMs: config.gates.timeoutMs,
        retries: config.transaction.gateRetries,
        wrapCommand,
        diagnosticsDirectory: `${worktree.path}.diagnostics`,
      });
      gates.push(...gateRun.results);
      if (gateRun.failure) {
        keep = true;
        return {
          ok: false,
          planId: manifest.planId,
          ...(keep ? { worktreePath: worktree.path } : {}),
          operationsApplied: journal.entries.length,
          gates,
          failedGate: gateRun.failure,
          gateRetry: { cwd: worktree.workspacePath, command: gateRun.failure.command },
          regeneration,
          ...unlinkedField(unlinked),
          ...(lockfileVerification === undefined ? {} : { lockfileVerification }),
          // Also in the message, because `applyPlan` forwards this string and
          // nothing else: a gate that died on an unresolvable import would
          // otherwise read as the extraction's fault all the way up.
          failure: `gate failed (${gateRun.failure.tier}): ${gateRun.failure.command}${
            unlinked.length > 0 ? ` (unlinked dependencies: ${unlinked.join(", ")})` : ""
          }${gateRun.failure.output ? `\n${gateRun.failure.output.trimEnd()}` : ""}`,
        };
      }
    }

    return {
      ok: true,
      planId: manifest.planId,
      ...(config.transaction.cleanup ? {} : { worktreePath: worktree.path }),
      operationsApplied: journal.entries.length,
      gates,
      regeneration,
      ...(assetEmission === undefined ? {} : { assetEmission }),
      ...unlinkedField(unlinked),
      ...(lockfileVerification === undefined ? {} : { lockfileVerification }),
      projectedImporterVerification,
      repositoryPostconditions,
    };
  } catch (error) {
    keep = !config.transaction.cleanup;
    throw new SimulationError(`simulation failed: ${(error as Error).message}`);
  } finally {
    if (config.transaction.cleanup && !keep) await worktree.dispose();
  }
}

/**
 * Commit the replayed extraction in the simulation worktree, before the gates.
 *
 * A repository's checks are not all whole-tree: a real one asks git what
 * changed since `HEAD` and applies an obligation to the answer — "backend
 * source moved, so a durable doc must move with it", "these two artifacts move
 * together". Replaying the journal without committing leaves the entire
 * extraction sitting as uncommitted work, so every such check fires on a
 * finding that an apply would never produce: after `apply --commit` the same
 * diff is empty, because the extraction *is* HEAD.
 *
 * The simulation exists to answer "would the repository accept this after it
 * lands", so the tree it hands to the gates has to be the tree that lands. The
 * commit is confined to a disposable worktree and never reaches the real
 * repository — nothing here is pushed, and `dispose()` deletes it.
 *
 * Hooks are disabled outright rather than with `--no-verify`, and that is the
 * load-bearing part. A worktree shares `.git` with the repository that spawned
 * it — the same hook scripts, the same config file — so a `post-commit` hook,
 * which `--no-verify` does *not* suppress, would run here and could write into
 * state the real checkout then commits under. A bookkeeping commit in a
 * throwaway tree must be inert for the repository it borrowed `.git` from.
 */
export function commitSimulatedExtraction(workspacePath: string, manifest: ExtractionManifest): void {
  const inert = ["-c", "core.hooksPath=/dev/null", "-c", `user.name=${SIMULATION_GIT_IDENTITY.name}`, "-c", `user.email=${SIMULATION_GIT_IDENTITY.email}`];
  git({ cwd: workspacePath, quiet: true }, ...inert, "add", "-A");
  // A plan whose journal wrote nothing git can see would make `commit` fail on
  // an empty index; the gates are still worth running against the tree as-is.
  if (git({ cwd: workspacePath }, "diff", "--cached", "--name-only").length === 0) return;
  git({ cwd: workspacePath, quiet: true }, ...inert, "commit", "--no-verify", "-m", `simulate ${manifest.planId}`);
}

/**
 * The verification, when it was asked for and there is something of this tool's
 * to verify. The command is the adapter's, and it runs in the worktree rather
 * than the checkout because that is the only tree a package manager may rewrite.
 */
function maybeVerifyLockfile(options: SimulateOptions, workspacePath: string, packageManager: PackageManagerAdapter): LockfileVerification | undefined {
  if (!options.verifyLockfile) return undefined;
  const splices = options.manifest.operations.some((operation) => operation.kind === "lockfile-importer");
  if (!splices) return undefined;
  return verifyLockfile({
    workspacePath,
    lockfileName: packageManager.lockfileName,
    command: packageManager.lockfileOnlyCommand(),
    timeoutMs: options.config.gates.timeoutMs,
  });
}

/** Absent rather than empty: every successful simulation would carry `[]`. */
function unlinkedField(unlinked: readonly string[]): { unlinkedDependencies?: readonly string[] } {
  return unlinked.length > 0 ? { unlinkedDependencies: unlinked } : {};
}
