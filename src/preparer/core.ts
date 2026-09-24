import { readFileSync } from "node:fs";

import { createPackageManagerAdapter } from "../adapters/registry.ts";
import { type MonocarveConfig, packageContainerRoots } from "../config.ts";
import { isGuardedBranch } from "../config.ts";
import type { ExtractionManifest } from "../plan/manifest.ts";
import { executePreparationJournal, finalizeCompletedPreparationJournal, rollbackCompletedPreparationJournal } from "../prepare/journal.ts";
import { runPreparationPostJournalPreparers } from "../prepare/post-journal.ts";
import { restoreSnapshot, snapshotPaths } from "../transaction/journal.ts";
import { createWorktree } from "../transaction/worktree.ts";
import { currentBranch, git, headCommit, repositoryPrefix, resolveCommit, showBaseline, statusEntries } from "../util/git.ts";
import { byCodeUnit, hashText, stableStringify } from "../util/hash.ts";
import { workspacePath } from "../util/paths.ts";
import { bindBootstrapConfig } from "./bootstrap-config.ts";
import { planPreparerCompilation, runPreparerCompilation } from "./core-compile.ts";
import { assertCommittedMutationsMatch, assertMutationsMatchState, unique, validatedPath } from "./core-support.ts";
import { assertPreparerManifestMatchesConfig, assertPreparerManifestShape } from "./core-validate.ts";
import { PreparerError } from "./error.ts";
import type { PreparerManifest } from "./manifest.ts";
import { runPreparerCommand } from "./run-command.ts";

export { PreparerError } from "./error.ts";

export interface CompilePreparerInput {
  readonly rootDir: string;
  readonly config: MonocarveConfig;
  readonly extraction: ExtractionManifest;
  readonly preparerId: string;
  /** Selects the reviewed move whose exact source/destination variables render policy. */
  readonly sourcePath: string;
}

export interface CompileStandalonePreparerInput {
  readonly rootDir: string;
  readonly config: MonocarveConfig;
  readonly baselineCommit: string;
  readonly preparerId: string;
  /** Repository-owned policy anchor exposed as both sourcePath and targetPath. */
  readonly sourcePath: string;
  /** Dirty configuration introduced by this transaction and committed with its manifest. */
  readonly bootstrapConfigPath?: string;
}

export async function compilePreparerManifest(input: CompilePreparerInput): Promise<PreparerManifest> {
  const plan = planPreparerCompilation(input);
  const adapter = createPackageManagerAdapter(input.config);
  const worktree = await createWorktree({
    rootDir: input.rootDir,
    commit: plan.resolved.commit,
    worktreeRoot: input.config.transaction.worktreeRoot,
    packageRoots: packageContainerRoots(input.config),
    nodeModules: input.config.transaction.nodeModules,
    installCommand: adapter.installCommand(),
    label: `prepare-${plan.policy.id}`,
  });
  try {
    return await runPreparerCompilation(input, plan, worktree.workspacePath);
  } finally {
    await worktree.dispose();
  }
}

/** Compile a declared-output preparer that is not coupled to an extraction move. */
export async function compileStandalonePreparerManifest(input: CompileStandalonePreparerInput): Promise<PreparerManifest> {
  const resolved = resolveCommit(input.rootDir, input.baselineCommit);
  const syntheticExtraction = {
    planId: `standalone-${resolved.commit}`,
    baselineCommit: resolved.commit,
    application: "standalone",
    target: { packageName: "standalone", packageRoot: "." },
    operations: [{ kind: "move", source: input.sourcePath, target: input.sourcePath }],
  } as unknown as ExtractionManifest;
  const manifest = await compilePreparerManifest({
    rootDir: input.rootDir,
    config: input.config,
    extraction: syntheticExtraction,
    preparerId: input.preparerId,
    sourcePath: input.sourcePath,
  });
  return input.bootstrapConfigPath === undefined
    ? manifest
    : bindBootstrapConfig(input.rootDir, manifest, validatedPath(input.rootDir, input.bootstrapConfigPath));
}

export function serializePreparerManifest(manifest: PreparerManifest): string {
  return `${stableStringify(manifest, 2)}\n`;
}

/**
 * Prove the operator reviewed these exact bytes in a manifest-only commit
 * directly atop the extraction baseline. No subject is prescribed because the
 * preparer policy deliberately has no commit metadata.
 */
export function assertApprovedPreparerManifest(rootDir: string, path: string, manifest: PreparerManifest): void {
  const baseline = manifest.baseline.commit;
  const head = headCommit(rootDir);
  if (head === baseline) throw new PreparerError("preparer manifest must be committed before apply");
  if (git({ cwd: rootDir }, "rev-parse", `${head}^`) !== baseline) {
    throw new PreparerError("approved preparer manifest commit must be directly atop the extraction baseline");
  }
  const changed = git({ cwd: rootDir }, "diff", "--name-only", "--no-renames", `${baseline}..${head}`).split("\n").filter(Boolean);
  const repositoryPath = `${repositoryPrefix(rootDir)}${path}`;
  const expectedPaths = [
    repositoryPath,
    ...(manifest.bootstrapConfig === undefined ? [] : [`${repositoryPrefix(rootDir)}${manifest.bootstrapConfig.path}`]),
  ].sort(byCodeUnit);
  if (changed.length !== expectedPaths.length || changed.sort(byCodeUnit).some((item, index) => item !== expectedPaths[index]))
    throw new PreparerError("approved preparer commit must contain exactly the manifest and its declared bootstrap config");
  const expected = serializePreparerManifest(manifest);
  const loaded = readFileSync(workspacePath(rootDir, path), "utf8");
  if (loaded !== expected || showBaseline(rootDir, head, path) !== expected) {
    throw new PreparerError("loaded preparer manifest bytes do not match the reviewed committed manifest");
  }
  if (manifest.bootstrapConfig !== undefined) {
    const committed = showBaseline(rootDir, head, manifest.bootstrapConfig.path);
    const parent = showBaseline(rootDir, baseline, manifest.bootstrapConfig.path);
    if (
      committed === null ||
      parent === null ||
      hashText(committed) !== manifest.bootstrapConfig.resultHash ||
      hashText(parent) !== manifest.bootstrapConfig.preconditionHash
    ) {
      throw new PreparerError("approved bootstrap config does not match reviewed preimage and result");
    }
  }
}

/** Safely replay captured bytes; a failed verify restores every output. */
export async function applyPreparerManifest(options: {
  readonly rootDir: string;
  readonly config: MonocarveConfig;
  readonly manifest: PreparerManifest;
  readonly verify?: boolean;
}): Promise<void> {
  assertPreparerManifest(options.config, options.manifest);
  const generatedPaths = new Set([
    ...options.manifest.generatedArtifacts.map((item) => item.path),
    ...options.manifest.postJournalPreparers.flatMap((item) => item.outputs),
  ]);
  // A captured output whose precondition already equals its reviewed result is
  // an idempotent no-op. Keep it in the manifest's post-apply byte proof, but
  // do not hand it to the journal: renaming and recreating an unchanged path
  // creates needless rollback state and can turn a later verifier failure into
  // residue when generated workspace tooling changes its ancestor topology.
  const operations = options.manifest.mutations
    .filter((item) => !generatedPaths.has(item.path) && (item.preconditionHash !== item.resultHash || item.preconditionMode !== item.resultMode))
    .map((item) => ({ kind: "write" as const, ...item }));
  const generatedSnapshots = snapshotPaths(options.rootDir, [...generatedPaths]);
  const journal = executePreparationJournal({ rootDir: options.rootDir, operations });
  try {
    const generation = runPreparationPostJournalPreparers(options.config, options.rootDir, options.manifest);
    if (!generation.ok) throw new PreparerError(generation.failure ?? "preparer generation failed");
    assertMutationsMatchState(options.rootDir, options.manifest.mutations);
    if (options.verify === true && options.manifest.preparer.verify !== undefined) {
      await runPreparerCommand(options.manifest.preparer.verify, options.rootDir, options.config.gates.timeoutMs, "preparer verify");
    }
    finalizeCompletedPreparationJournal(journal.recovery);
  } catch (error) {
    const generatedRestore = restoreSnapshot(options.rootDir, generatedSnapshots);
    const restored = rollbackCompletedPreparationJournal(journal.recovery);
    const failures = [...generatedRestore.failures, ...restored.failures];
    if (failures.length > 0) throw new PreparerError(`preparer apply failed and rollback was incomplete: ${failures.map((item) => item.path).join(", ")}`);
    throw error;
  }
}

export async function simulatePreparerManifest(options: {
  readonly rootDir: string;
  readonly config: MonocarveConfig;
  readonly manifest: PreparerManifest;
}): Promise<void> {
  assertPreparerManifest(options.config, options.manifest);
  const adapter = createPackageManagerAdapter(options.config);
  const worktree = await createWorktree({
    rootDir: options.rootDir,
    commit: options.manifest.baseline.commit,
    worktreeRoot: options.config.transaction.worktreeRoot,
    packageRoots: packageContainerRoots(options.config),
    nodeModules: options.config.transaction.nodeModules,
    installCommand: adapter.installCommand(),
    label: options.manifest.planId,
  });
  try {
    await applyPreparerManifest({ rootDir: worktree.workspacePath, config: options.config, manifest: options.manifest, verify: true });
  } finally {
    await worktree.dispose();
  }
}

export function assertPreparerManifest(config: MonocarveConfig, value: unknown): asserts value is PreparerManifest {
  assertPreparerManifestShape(value);
  assertPreparerManifestMatchesConfig(config, value);
}

/** Commit only an already-applied, byte- and mode-exact preparer result. */
export function commitPreparerOutputs(rootDir: string, config: MonocarveConfig, path: string, manifest: PreparerManifest): string {
  assertApprovedPreparerManifest(rootDir, path, manifest);
  const branch = currentBranch(rootDir);
  if (isGuardedBranch(config, branch)) throw new PreparerError(`refusing to commit preparer outputs on guarded branch ${branch}`);
  const declared = manifest.mutations
    .filter((item) => item.preconditionHash !== item.resultHash || item.preconditionMode !== item.resultMode)
    .map((item) => item.path)
    .sort(byCodeUnit);
  if (declared.length === 0) throw new PreparerError("preparer output commit has no effective mutations");
  assertMutationsMatchState(rootDir, manifest.mutations);
  const dirty = unique(statusEntries(rootDir).flatMap((entry) => entry.paths)).sort(byCodeUnit);
  if (dirty.length !== declared.length || dirty.some((item, index) => item !== declared[index])) {
    throw new PreparerError(`preparer output commit requires exactly the declared dirty paths; found: ${dirty.join(", ") || "(none)"}`);
  }
  git({ cwd: rootDir, quiet: true }, "add", "--", ...declared);
  const commit = manifest.preparer.commit;
  try {
    git(
      { cwd: rootDir, quiet: true },
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-m",
      commit.subject,
      ...(commit.body === undefined ? [] : ["-m", commit.body]),
      "--",
      ...declared,
    );
  } catch (error) {
    git({ cwd: rootDir, quiet: true }, "reset", "--", ...declared);
    throw error;
  }
  const result = headCommit(rootDir);
  const committed = git({ cwd: rootDir }, "diff-tree", "--no-commit-id", "--name-only", "-r", result).split("\n").filter(Boolean).sort(byCodeUnit);
  const expected = declared.map((item) => `${repositoryPrefix(rootDir)}${item}`).sort(byCodeUnit);
  if (committed.length !== expected.length || committed.some((item, index) => item !== expected[index]))
    throw new PreparerError("preparer output commit path verification failed");
  assertCommittedMutationsMatch(rootDir, result, manifest.mutations);
  return result;
}
