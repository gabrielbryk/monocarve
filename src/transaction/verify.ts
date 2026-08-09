/** Lifecycle-aware, observational verification of a reviewed extraction plan. */
import { createPackageManagerAdapter } from "../adapters/registry.ts";
import type { MonocarveConfig } from "../config.ts";
import type { ExtractionManifest } from "../plan/manifest.ts";
import { headCommit } from "../util/git.ts";
import { auditPlanSync } from "./audit.ts";
import { inspectCommitChain } from "./commit-evidence.ts";
import { regenerateArtifacts } from "./regenerate.ts";
import { createWorktree } from "./worktree.ts";

export interface AppliedVerification {
  readonly lifecycle: "applied";
  readonly chain: ReturnType<typeof inspectCommitChain>;
  readonly audit: ReturnType<typeof auditPlanSync>;
  readonly regeneration: ReturnType<typeof regenerateArtifacts>;
  readonly blockers: readonly string[];
}

/**
 * Verify an already-applied plan from its immutable commit chain and landed
 * tree. Pre-apply template derivation is intentionally absent: source paths no
 * longer exist after a successful move, while the approved manifest and exact
 * move/wiring commits are the durable evidence for what was reviewed.
 *
 * Repository generators run only in a disposable worktree at HEAD. This both
 * keeps verification observational and exposes commands whose declared output
 * set is incomplete.
 */
export async function verifyAppliedPlan(options: {
  readonly config: MonocarveConfig;
  readonly rootDir: string;
  readonly manifest: ExtractionManifest;
  readonly manifestPath: string;
}): Promise<AppliedVerification | undefined> {
  const commit = headCommit(options.rootDir);
  const chain = inspectCommitChain({ ...options, headCommit: commit });
  if (chain.phase !== "applied") return undefined;

  const audit = auditPlanSync(options);
  const packageManager = createPackageManagerAdapter(options.config);
  const worktree = await createWorktree({
    rootDir: options.rootDir,
    commit,
    worktreeRoot: options.config.transaction.worktreeRoot,
    nodeModules: options.config.transaction.nodeModules,
    installCommand: packageManager.installCommand(),
    label: `${options.manifest.planId}-verify`,
  });
  let regeneration: ReturnType<typeof regenerateArtifacts>;
  try {
    regeneration = regenerateArtifacts({ config: options.config, treeRoot: worktree.workspacePath, manifest: options.manifest });
  } finally {
    await worktree.dispose();
  }
  const blockers = [
    ...(chain.valid ? [] : chain.failures),
    ...(audit.passed ? [] : audit.failures),
    ...(regeneration.ok ? [] : [regeneration.failure ?? "generated-artifact verification failed"]),
  ];
  return { lifecycle: "applied", chain, audit, regeneration, blockers };
}
