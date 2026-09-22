/**
 * Consolidation plan builder: generate an ExtractionManifest for merging
 * multiple packages into a target domain package.
 *
 * This is the inverse of extraction. Instead of using the portfolio/candidate
 * pipeline (which is designed for app→package moves), consolidation builds
 * a plan directly from validated donors and target.
 */

import type { MonocarveConfig } from "../config.ts";
import type { DependencyGraph } from "../graph/model.ts";
import type { Sha256 } from "../util/hash.ts";
import type { ExtractionManifest, PlanOperation } from "../plan/manifest.ts";
import type { ConsolidationCandidate } from "./candidate.ts";
import {
  applyConsolidationDonorRetirement,
  buildConsolidationWiringOperations,
  initializeConsolidationPlan,
  prepareConsolidationSources,
  reorderConsolidationOperations,
  resolveConsumers,
} from "./plan-support.ts";
import { buildConsolidationManifest } from "./plan-manifest.ts";

export interface BuildConsolidationPlanOptions {
  readonly config: MonocarveConfig;
  readonly rootDir: string;
  readonly graph: DependencyGraph;
  readonly candidate: ConsolidationCandidate;
  readonly baselineCommit: string;
  readonly packageRoot?: string;
  readonly retireDonors?: boolean;
}

export function buildConsolidationPlan(options: BuildConsolidationPlanOptions): ExtractionManifest {
  const { config, graph, candidate, baselineCommit, rootDir } = options;
  const { context, packageManager, taskRunner, packageName, packageRoot, application, projectId, baselineCommitHash, committedAt } = initializeConsolidationPlan({
    config,
    rootDir,
    candidate,
    packageRootOverride: options.packageRoot,
    baselineCommit,
  });

  // Build move operations for each file.
  const operations: PlanOperation[] = [];
  const sourceBlobs: Record<string, Sha256> = {};

  const { publicModules, publicSpecifierFor, tests } = prepareConsolidationSources({
    context,
    candidate,
    packageRoot,
    packageName,
    operations,
    sourceBlobs,
  });

  const { dependencies, consumers, consumerSections } = resolveConsumers({
    context,
    graph,
    candidate,
    packageName,
    publicSpecifierFor,
    operations,
    tests,
  });

  buildConsolidationWiringOperations({
    context,
    config,
    application,
    packageManager,
    taskRunner,
    packageName,
    packageRoot,
    projectId,
    candidate,
    tests,
    dependencies,
    publicModules,
    consumers,
    operations,
  });

  if (options.retireDonors) {
    applyConsolidationDonorRetirement({ context, packageManager, candidate, packageRoot, operations });
  }

  reorderConsolidationOperations(operations);

  return buildConsolidationManifest({
    config,
    rootDir,
    graph,
    candidate,
    context,
    packageManager,
    taskRunner,
    application,
    packageName,
    packageRoot,
    projectId,
    baselineCommitHash,
    committedAt,
    publicModules,
    tests,
    dependencies,
    sourceBlobs,
    operations,
    consumers,
    consumerSections,
  });
}
