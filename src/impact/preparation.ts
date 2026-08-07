import { createPackageManagerAdapter } from "../adapters/registry.ts";
import type { MonocarveConfig } from "../config.ts";
import { scanDependencyGraph } from "../graph/cruiser.ts";
import { WorkspaceContext } from "../plan/context.ts";
import { buildPortfolio } from "../portfolio/rank.ts";
import type { Portfolio } from "../portfolio/types.ts";
import {
  executePreparationJournal,
  finalizeCompletedPreparationJournal,
  verifyPreparationOperations,
} from "../prepare/journal.ts";
import type { PreparationManifest } from "../prepare/manifest-types.ts";
import { runPreparationPostJournalPreparers } from "../prepare/post-journal.ts";
import { preparationFilesystemOperations, simulatePreparation } from "../prepare/simulate.ts";
import { createWorktree } from "../transaction/worktree.ts";

export interface PortfolioImpactSnapshot {
  readonly applicationLines: number;
  readonly candidates: number;
  readonly eligible: number;
  readonly recommended: number;
  readonly reviewRequired: number;
  readonly discouraged: number;
  readonly largestRecommendedLines: number;
}

export interface PreparationImpactReport {
  readonly schema: "preparation-impact";
  readonly planId: string;
  readonly before: PortfolioImpactSnapshot;
  readonly after: PortfolioImpactSnapshot;
  readonly delta: Record<keyof PortfolioImpactSnapshot, number>;
  readonly newlyRecommended: readonly string[];
  readonly noLongerRecommended: readonly string[];
}

/** Run a preparation and its repository gates, then measure its exact projected portfolio. */
export async function analyzePreparationImpact(options: {
  readonly config: MonocarveConfig;
  readonly rootDir: string;
  readonly manifest: PreparationManifest;
  readonly application?: string;
}): Promise<PreparationImpactReport> {
  const simulation = await simulatePreparation({ ...options, runGates: true });
  if (!simulation.ok) throw new Error(`preparation simulation failed: ${simulation.failure ?? "unknown failure"}`);
  const packageManager = createPackageManagerAdapter(options.config);
  const worktree = await createWorktree({
    rootDir: options.rootDir,
    commit: options.manifest.baseline.commit,
    worktreeRoot: options.config.transaction.worktreeRoot,
    nodeModules: options.config.transaction.nodeModules,
    installCommand: packageManager.installCommand(),
    label: `${options.manifest.planId}-impact`,
  });
  try {
    const baselineGraph = await scanDependencyGraph({ config: options.config, rootDir: worktree.workspacePath, noCache: true });
    const before = buildPortfolio({ config: options.config, graph: baselineGraph, context: new WorkspaceContext(options.config, worktree.workspacePath), ...(options.application ? { application: options.application } : {}) });
    const operations = preparationFilesystemOperations(options.manifest);
    verifyPreparationOperations(worktree.workspacePath, operations);
    const journal = executePreparationJournal({ rootDir: worktree.workspacePath, operations });
    const preparers = runPreparationPostJournalPreparers(options.config, worktree.workspacePath, options.manifest);
    if (!preparers.ok) throw new Error(preparers.failure ?? "post-journal preparer failed");
    finalizeCompletedPreparationJournal(journal.recovery);
    const projectedGraph = await scanDependencyGraph({ config: options.config, rootDir: worktree.workspacePath, noCache: true });
    const after = buildPortfolio({ config: options.config, graph: projectedGraph, context: new WorkspaceContext(options.config, worktree.workspacePath), ...(options.application ? { application: options.application } : {}) });
    return comparePortfolios(options.manifest.planId, baselineGraph.paths.map((path) => baselineGraph.nodes.get(path)!), projectedGraph.paths.map((path) => projectedGraph.nodes.get(path)!), before, after, options.application);
  } finally {
    await worktree.dispose();
  }
}

export function comparePortfolios(
  planId: string,
  beforeNodes: readonly { zone: string; application?: string; lineCount: number }[],
  afterNodes: readonly { zone: string; application?: string; lineCount: number }[],
  beforePortfolio: Portfolio,
  afterPortfolio: Portfolio,
  application?: string,
): PreparationImpactReport {
  const before = snapshot(beforeNodes, beforePortfolio, application);
  const after = snapshot(afterNodes, afterPortfolio, application);
  const keys = Object.keys(before) as (keyof PortfolioImpactSnapshot)[];
  const beforeRecommended = new Set(beforePortfolio.candidates.filter((candidate) => candidate.recommendation?.status === "recommended").map((candidate) => candidate.id));
  const afterRecommended = new Set(afterPortfolio.candidates.filter((candidate) => candidate.recommendation?.status === "recommended").map((candidate) => candidate.id));
  return {
    schema: "preparation-impact",
    planId,
    before,
    after,
    delta: Object.fromEntries(keys.map((key) => [key, after[key] - before[key]])) as Record<keyof PortfolioImpactSnapshot, number>,
    newlyRecommended: [...afterRecommended].filter((id) => !beforeRecommended.has(id)).sort(),
    noLongerRecommended: [...beforeRecommended].filter((id) => !afterRecommended.has(id)).sort(),
  };
}

function snapshot(nodes: readonly { zone: string; application?: string; lineCount: number }[], portfolio: Portfolio, application?: string): PortfolioImpactSnapshot {
  const candidates = portfolio.candidates;
  const recommended = candidates.filter((candidate) => candidate.recommendation?.status === "recommended");
  return {
    applicationLines: nodes.filter((node) => node.zone === "application" && (application === undefined || node.application === application)).reduce((sum, node) => sum + node.lineCount, 0),
    candidates: candidates.length,
    eligible: candidates.filter((candidate) => candidate.eligible).length,
    recommended: recommended.length,
    reviewRequired: candidates.filter((candidate) => candidate.recommendation?.status === "review-required").length,
    discouraged: candidates.filter((candidate) => candidate.recommendation?.status === "discouraged").length,
    largestRecommendedLines: Math.max(0, ...recommended.map((candidate) => candidate.lineCount)),
  };
}
