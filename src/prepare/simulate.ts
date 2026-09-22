/** Replay a preparation plan in a disposable worktree before it is applied. */
import { readFileSync } from "node:fs";

import { createPackageManagerAdapter, createTaskRunnerAdapter } from "../adapters/registry.ts";
import { configDigest, renderPreparationPolicy, type MonocarveConfig, type PreparationPolicyRenderInput, packageContainerRoots } from "../config.ts";
import { MonocarveError } from "../errors.ts";
import { scanDependencyGraph } from "../graph/cruiser.ts";
import { graphDigest } from "../plan/build.ts";
import { type GateResult, runGateTiers } from "../transaction/simulate.ts";
import { createWorktree } from "../transaction/worktree.ts";
import { fileState } from "../util/files.ts";
import { git, headCommit } from "../util/git.ts";
import { byCodeUnit, hashJson, type FileState } from "../util/hash.ts";
import { workspacePath } from "../util/paths.ts";
import type { PreparationFreshGraphEvidence } from "./audit-types.ts";
import { auditPreparationSync, type PreparationAuditReport } from "./audit.ts";
import { executePreparationJournal, finalizeCompletedPreparationJournal, verifyPreparationOperations, type PreparationFilesystemOperation } from "./journal.ts";
import type { PreparationFileMutation, PreparationManifest } from "./manifest-types.ts";
import { assertPreparationManifestValid, preparationOperationPaths } from "./manifest.ts";
import { runPreparationPostJournalPreparers } from "./post-journal.ts";

export class PreparationSimulationError extends MonocarveError {
  override readonly name = "PreparationSimulationError";
}

export interface PreparationSimulationResult {
  readonly ok: boolean;
  readonly planId: string;
  readonly operationsApplied: number;
  readonly gates: readonly GateResult[];
  /** Structured evidence for the authoritative failed gate. */
  readonly failedGate?: GateResult;
  /** Fresh graph evidence scanned from the immutable preparation baseline. */
  readonly baselineGraph: PreparationFreshGraphEvidence;
  readonly audit?: PreparationAuditReport;
  readonly worktreePath?: string;
  readonly failure?: string;
}

export interface SimulatePreparationOptions {
  readonly config: MonocarveConfig;
  readonly rootDir: string;
  readonly manifest: PreparationManifest;
  /** For fast diagnosis only; never accepted by committed application. */
  readonly skipGates?: boolean;
  /** Run declared gates even if normal simulation gates are disabled. */
  readonly runGates?: boolean;
  /**
   * Optional test/host boundary for a baseline graph scan. Its result is bound
   * to the worktree HEAD before it is trusted, so an old or post-apply graph
   * cannot authorize a preparation manifest.
   */
  readonly baselineGraphScanner?: PreparationBaselineGraphScanner;
}

export interface PreparationBaselineGraphScanInput {
  readonly config: MonocarveConfig;
  readonly rootDir: string;
  readonly baselineCommit: string;
}

export type PreparationBaselineGraphScanner = (input: PreparationBaselineGraphScanInput) => Promise<PreparationFreshGraphEvidence>;

/** Native scanner: no cached or caller-supplied graph can authorize an apply. */
export async function scanPreparationBaselineGraph(input: PreparationBaselineGraphScanInput): Promise<PreparationFreshGraphEvidence> {
  const before = headCommit(input.rootDir);
  if (before !== input.baselineCommit) {
    throw new PreparationSimulationError(`baseline graph scan expected ${input.baselineCommit}, found ${before}`);
  }
  const graph = await scanDependencyGraph({ config: input.config, rootDir: input.rootDir, noCache: true });
  const after = headCommit(input.rootDir);
  if (after !== before || graph.commit !== before) {
    throw new PreparationSimulationError("checkout changed while scanning the preparation baseline graph");
  }
  return { commit: before, digest: graphDigest(graph) };
}

/**
 * Reconstruct the manifest's immutable graph evidence without replaying it.
 * This is the audit/CLI path: it scans a disposable baseline worktree, never
 * the post-preparation checkout whose graph is intentionally different.
 */
export async function scanPreparationManifestBaseline(options: {
  readonly config: MonocarveConfig;
  readonly rootDir: string;
  readonly manifest: PreparationManifest;
}): Promise<PreparationFreshGraphEvidence> {
  const packageManager = createPackageManagerAdapter(options.config);
  const worktree = await createWorktree({
    rootDir: options.rootDir,
    commit: options.manifest.baseline.commit,
    worktreeRoot: options.config.transaction.worktreeRoot,
    packageRoots: packageContainerRoots(options.config),
    nodeModules: options.config.transaction.nodeModules,
    installCommand: packageManager.installCommand(),
    label: options.manifest.planId,
  });
  try {
    const evidence = await scanPreparationBaselineGraph({
      config: options.config,
      rootDir: worktree.workspacePath,
      baselineCommit: options.manifest.baseline.commit,
    });
    if (evidence.digest !== options.manifest.graphDigest) {
      throw new PreparationSimulationError("preparation manifest graph digest does not match the fresh baseline graph");
    }
    return evidence;
  } finally {
    await worktree.dispose();
  }
}

/** Convert rendered manifest operations into the deliberately tiny journal language. */
export function preparationFilesystemOperations(manifest: PreparationManifest): readonly PreparationFilesystemOperation[] {
  return manifest.operations.flatMap(preparationFilesystemOperationsFor);
}

function preparationFilesystemOperationsFor(operation: PreparationManifest["operations"][number]): readonly PreparationFilesystemOperation[] {
  if (operation.kind === "write-file" || operation.kind === "rewrite-module-specifier" || operation.kind === "adopt-generated-source") {
    return [writeOperation(operation.file, operation.contents)];
  }
  if (operation.kind === "delete-module" || operation.kind === "delete-generated-source-generator") {
    // A deletion has no rendered bytes: the journal's tiny language only
    // needs the precondition to prove the shim it removes is exactly the one
    // this manifest was compiled against.
    return [
      {
        kind: "delete" as const,
        path: operation.file.path,
        preconditionHash: operation.file.preconditionHash,
        preconditionMode: operation.file.preconditionMode,
      },
    ];
  }
  return [writeOperation(operation.donor, operation.donorContents), writeOperation(operation.target, operation.targetContents)];
}

function writeOperation(file: PreparationFileMutation, contents: string): PreparationFilesystemOperation {
  return {
    kind: "write" as const,
    path: file.path,
    contents,
    preconditionHash: file.preconditionHash,
    preconditionMode: file.preconditionMode,
    resultHash: file.resultHash,
    resultMode: file.resultMode,
  };
}

/**
 * The application-owned donors a preparation's repository policy is rendered
 * from, in deterministic order.
 *
 * A type extraction anchors on its donor and the new type module it points at.
 * A boundary preparation has no extraction at all — it rewrites a specifier, or
 * retires a shim — so it anchors on the rewritten application module and the
 * package specifier it now imports. Written files (a generated contract, an app
 * adapter) are deliberately not anchors: they are outputs, they may land outside
 * every configured application, and `renderPreparationPolicy` refuses a donor it
 * cannot attribute to one. A deletion is likewise not an anchor, because the
 * rewrites that made the shim retirable are already in the same manifest and
 * carry the specifier the policy needs.
 */
function policyAnchors(manifest: PreparationManifest): PreparationPolicyRenderInput[] {
  if (manifest.policyAnchor !== undefined) return [manifest.policyAnchor];
  return manifest.operations.flatMap((operation): PreparationPolicyRenderInput[] => {
    if (operation.kind === "extract-type-declarations") {
      return [{ sourcePath: operation.donor.path, targetPath: operation.target.path, targetModuleSpecifier: operation.moduleSpecifier }];
    }
    if (operation.kind === "adopt-generated-source")
      return [{ sourcePath: operation.file.path, targetPath: operation.file.path, targetModuleSpecifier: operation.policySpecifier }];
    if (operation.kind !== "rewrite-module-specifier") return [];
    return [...new Set(operation.rewrites.map((rewrite) => rewrite.to))]
      .sort(byCodeUnit)
      .map((specifier) => ({ sourcePath: operation.file.path, targetPath: operation.file.path, targetModuleSpecifier: specifier }));
  });
}

/** Refuse a hand-edited manifest that omits or changes repository-owned gates. */
export function assertPreparationPolicy(config: MonocarveConfig, manifest: PreparationManifest): void {
  assertGeneratedSourceAdoptionPolicyAnchor(config, manifest);
  const anchors = policyAnchors(manifest);
  if (anchors.length === 0) {
    throw new PreparationSimulationError(
      "a preparation policy requires at least one application-owned donor: a type-declaration extraction or a rewritten module specifier",
    );
  }
  const policies = anchors.map((anchor) => renderPreparationPolicy(config, anchor));
  const commit = policies[0]!.commit;
  if (policies.some((policy) => hashJson(policy.commit) !== hashJson(commit)))
    throw new PreparationSimulationError("multi-file preparation members render different commit metadata");
  const union = (tier: "package" | "project" | "workspace") => [...new Set(policies.flatMap((policy) => policy.gates[tier]))].sort();
  const expected = { commit, gates: { package: union("package"), project: union("project"), workspace: union("workspace") } };
  if (hashJson(expected) !== hashJson({ commit: manifest.commits.prepare, gates: manifest.gates }))
    throw new PreparationSimulationError("preparation manifest policy differs from the exact gates or commit metadata rendered by the resolved configuration");
}

function assertGeneratedSourceAdoptionPolicyAnchor(config: MonocarveConfig, manifest: PreparationManifest): void {
  const specifiers = [
    ...new Set(
      manifest.operations
        .filter(
          (operation): operation is Extract<PreparationManifest["operations"][number], { kind: "adopt-generated-source" }> =>
            operation.kind === "adopt-generated-source",
        )
        .map((operation) => operation.policySpecifier),
    ),
  ];
  if (specifiers.length === 0) return;
  if (specifiers.length !== 1 || !specifiers[0]!.startsWith("adopt:"))
    throw new PreparationSimulationError("generated-source adoption operations must share one configured policy identity");
  const id = specifiers[0]!.slice("adopt:".length);
  const adoption = config.generatedSourceAdoptions.find((item) => item.id === id);
  if (adoption === undefined) throw new PreparationSimulationError(`generated-source adoption policy refers to unknown configuration ${JSON.stringify(id)}`);
  const sourcePath = adoption.policyAnchor ?? adoption.artifacts[0]!.path;
  const expected = { sourcePath, targetPath: sourcePath, targetModuleSpecifier: specifiers[0]! };
  if (manifest.policyAnchor === undefined || hashJson(manifest.policyAnchor) !== hashJson(expected)) {
    throw new PreparationSimulationError("generated-source adoption policy anchor differs from the compiler-selected configured anchor");
  }
}

export async function simulatePreparation(options: SimulatePreparationOptions): Promise<PreparationSimulationResult> {
  const { config, manifest, rootDir } = options;
  assertPreparationManifestValid(manifest);
  assertPreparationPolicy(config, manifest);
  if (manifest.baseline.configDigest !== configDigest(config)) {
    throw new PreparationSimulationError("preparation manifest was compiled with a different resolved configuration");
  }
  const packageManager = createPackageManagerAdapter(config);
  const worktree = await createWorktree({
    rootDir,
    commit: manifest.baseline.commit,
    worktreeRoot: config.transaction.worktreeRoot,
    packageRoots: packageContainerRoots(config),
    nodeModules: config.transaction.nodeModules,
    installCommand: packageManager.installCommand(),
    label: manifest.planId,
  });
  const gates: GateResult[] = [];
  let keep = false;
  try {
    assertPreparationManifestValid(manifest, livePreparationEvidence(worktree.workspacePath, manifest));
    const baselineGraph = await scanFreshBaselineGraph(options, worktree.workspacePath);
    const operations = preparationFilesystemOperations(manifest);
    verifyPreparationOperations(worktree.workspacePath, operations);
    const journal = executePreparationJournal({ rootDir: worktree.workspacePath, operations });
    const preparation = runPreparationPostJournalPreparers(config, worktree.workspacePath, manifest);
    if (!preparation.ok) {
      finalizeCompletedPreparationJournal(journal.recovery);
      keep = !config.transaction.cleanup;
      return failed(
        manifest,
        journal.applied.length,
        gates,
        baselineGraph,
        preparation.failure ?? "post-journal preparer failed",
        undefined,
        keep ? worktree.path : undefined,
      );
    }
    const audit = auditPreparationSync({
      config,
      rootDir: worktree.workspacePath,
      manifest,
      freshGraph: baselineGraph,
      regeneratedArtifacts: preparation.hashes as Readonly<Record<string, import("../util/hash.ts").Sha256>>,
    });
    if (!audit.passed) {
      finalizeCompletedPreparationJournal(journal.recovery);
      keep = !config.transaction.cleanup;
      return failed(
        manifest,
        journal.applied.length,
        gates,
        baselineGraph,
        `audit failed in simulation: ${audit.failures.join("; ")}`,
        audit,
        keep ? worktree.path : undefined,
      );
    }
    if (!options.skipGates && (options.runGates ?? config.transaction.simulateGates)) {
      commitPreparationScope(worktree.workspacePath, manifest, true);
      const taskRunner = createTaskRunnerAdapter(config);
      const wrapCommand =
        preparation.changed && taskRunner.id === "moon"
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
        finalizeCompletedPreparationJournal(journal.recovery);
        keep = !config.transaction.cleanup;
        return failed(
          manifest,
          journal.applied.length,
          gates,
          baselineGraph,
          `gate failed (${gateRun.failure.tier}): ${gateRun.failure.command}`,
          audit,
          keep ? worktree.path : undefined,
          gateRun.failure,
        );
      }
    }
    finalizeCompletedPreparationJournal(journal.recovery);
    return {
      ok: true,
      planId: manifest.planId,
      operationsApplied: journal.applied.length,
      gates,
      baselineGraph,
      audit,
      ...(config.transaction.cleanup ? {} : { worktreePath: worktree.path }),
    };
  } catch (error) {
    keep = !config.transaction.cleanup;
    throw new PreparationSimulationError(`preparation simulation failed: ${(error as Error).message}`);
  } finally {
    if (config.transaction.cleanup && !keep) await worktree.dispose();
  }
}

async function scanFreshBaselineGraph(options: SimulatePreparationOptions, rootDir: string): Promise<PreparationFreshGraphEvidence> {
  const before = headCommit(rootDir);
  if (before !== options.manifest.baseline.commit) {
    throw new PreparationSimulationError(`baseline graph scan expected ${options.manifest.baseline.commit}, found ${before}`);
  }
  const scan = options.baselineGraphScanner ?? scanPreparationBaselineGraph;
  const evidence = await scan({ config: options.config, rootDir, baselineCommit: before });
  if (headCommit(rootDir) !== before) throw new PreparationSimulationError("checkout changed while scanning the preparation baseline graph");
  if (evidence.commit !== before) throw new PreparationSimulationError("baseline graph scanner returned evidence for a different commit");
  if (evidence.digest !== options.manifest.graphDigest) {
    throw new PreparationSimulationError("preparation manifest graph digest does not match the fresh baseline graph");
  }
  return evidence;
}

function livePreparationEvidence(
  rootDir: string,
  manifest: PreparationManifest,
): { readonly currentFiles: Readonly<Record<string, FileState>>; readonly currentContents: Readonly<Record<string, string>> } {
  return {
    currentFiles: Object.fromEntries(manifest.changedFiles.map((path) => [path, fileState(workspacePath(rootDir, path))])),
    currentContents: Object.fromEntries(
      [...new Set(manifest.declarations.map((group) => group.sourcePath))].map((path) => [path, readFileSync(workspacePath(rootDir, path), "utf8")]),
    ),
  };
}

/**
 * Stage and commit exactly the files declared by the preparation manifest.
 *
 * A failure here means a staging bug or an outside write is present; it must
 * not become a plausible, broad source commit.
 */
export function commitPreparationScope(rootDir: string, manifest: PreparationManifest, inertHooks: boolean, afterStage?: () => void): void {
  git({ cwd: rootDir, quiet: true }, "add", "-A", "--", ...manifest.changedFiles);
  const staged = git({ cwd: rootDir }, "diff", "--cached", "--name-only", "--").split("\n").filter(Boolean);
  const allowed = new Set(manifest.changedFiles);
  const mandatory = new Set(manifest.operations.flatMap(preparationOperationPaths));
  const outside = staged.filter((path) => !allowed.has(path));
  const missing = [...mandatory].filter((path) => !staged.includes(path));
  if (outside.length > 0 || missing.length > 0) {
    throw new PreparationSimulationError(`preparation commit scope differs: outside [${outside.join(", ")}], missing operation paths [${missing.join(", ")}]`);
  }
  afterStage?.();
  const args = inertHooks ? ["-c", "core.hooksPath=/dev/null"] : [];
  git(
    { cwd: rootDir, quiet: true },
    ...args,
    "commit",
    "--no-verify",
    "-m",
    manifest.commits.prepare.subject,
    ...(manifest.commits.prepare.body ? ["-m", manifest.commits.prepare.body] : []),
  );
}

function failed(
  manifest: PreparationManifest,
  operationsApplied: number,
  gates: readonly GateResult[],
  baselineGraph: PreparationFreshGraphEvidence,
  failure: string,
  audit: PreparationAuditReport | undefined,
  worktreePath: string | undefined,
  failedGate?: GateResult,
): PreparationSimulationResult {
  return {
    ok: false,
    planId: manifest.planId,
    operationsApplied,
    gates,
    baselineGraph,
    ...(audit === undefined ? {} : { audit }),
    failure,
    ...(failedGate === undefined ? {} : { failedGate }),
    ...(worktreePath === undefined ? {} : { worktreePath }),
  };
}
