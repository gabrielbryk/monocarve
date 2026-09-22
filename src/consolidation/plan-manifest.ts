/**
 * Final manifest assembly for `buildConsolidationPlan` (see `plan.ts`).
 *
 * Split out purely to keep `buildConsolidationPlan` within the complexity
 * gate's maxMethodLoc budget. This is a verbatim extraction of the object
 * literal that used to be that function's `return` statement: no field,
 * ordering, or default was changed.
 */

import { createPackageManagerAdapter, createTaskRunnerAdapter } from "../adapters/registry.ts";
import { GENERATOR } from "../branding.ts";
import type { ApplicationConfig, MonocarveConfig } from "../config.ts";
import type { DependencyGraph } from "../graph/model.ts";
import type { Sha256 } from "../util/hash.ts";
import { renderTemplate } from "../util/template.ts";
import type { WorkspaceContext } from "../plan/context.ts";
import type { InferredDependencies } from "../plan/dependencies.ts";
import type { Consumer } from "../plan/consumers.ts";
import { PLAN_SCHEMA_VERSION, type ExtractionManifest, type PlanOperation, type PublicModule } from "../plan/manifest.ts";
import { boundaryBaselineOf } from "../plan/boundary-baseline.ts";
import { buildPlanProvenance } from "../plan/provenance.ts";
import { graphDigest, renderGates } from "../plan/build-support.ts";
import type { ConsolidationCandidate } from "./candidate.ts";
import { operationPathsOf } from "./plan-support.ts";

export function buildConsolidationManifest(input: {
  readonly config: MonocarveConfig;
  readonly rootDir: string;
  readonly graph: DependencyGraph;
  readonly candidate: ConsolidationCandidate;
  readonly context: WorkspaceContext;
  readonly packageManager: ReturnType<typeof createPackageManagerAdapter>;
  readonly taskRunner: ReturnType<typeof createTaskRunnerAdapter>;
  readonly application: ApplicationConfig;
  readonly packageName: string;
  readonly packageRoot: string;
  readonly projectId: string;
  readonly baselineCommitHash: string;
  readonly committedAt: string;
  readonly publicModules: PublicModule[];
  readonly tests: readonly string[];
  readonly dependencies: InferredDependencies;
  readonly sourceBlobs: Record<string, Sha256>;
  readonly operations: PlanOperation[];
  readonly consumers: readonly Consumer[];
  readonly consumerSections: ReadonlyMap<string, "runtime" | "dev">;
}): ExtractionManifest {
  const { config, rootDir, graph, candidate, context, packageManager, taskRunner, application, packageName, packageRoot, projectId, baselineCommitHash, committedAt, publicModules, tests, dependencies, sourceBlobs, operations, consumers, consumerSections } = input;

  const consumerOwners = consumers.map((c) => c.package);
  const commitVars = {
    package: packageName,
    packageRoot,
    app: application.name,
    project: projectId,
    planId: candidate.id,
    fileCount: String(candidate.files.length),
  };

  const provenance = buildPlanProvenance({
    config,
    profileGates: config.gates,
    scaffoldTemplates: config.scaffoldTemplates,
    packageManager,
    taskRunner,
    ...(context.exists("package.json") ? { rootPackageJson: context.text("package.json") } : {}),
  });

  return {
    schemaVersion: PLAN_SCHEMA_VERSION,
    planId: candidate.id,
    createdAt: committedAt,
    generator: { ...GENERATOR },
    provenance,
    baselineCommit: baselineCommitHash,
    graphDigest: graphDigest(graph),
    application: application.name,
    boundaryBaseline: boundaryBaselineOf({ config, rootDir, files: context.repositorySources(), referencesOf: (file) => context.moduleReferences(file) }),
    target: {
      packageName,
      packageRoot,
      entrypoint: config.scaffoldTemplates.entrypoint,
      requiredExports: [],
      publicModules,
    },
    source: {
      files: candidate.files,
      tests,
      ...(candidate.assets.length > 0 ? { assets: candidate.assets } : {}),
    // `candidate.sccs` is an array; Object.keys would count its indices.
    sccs: candidate.sccs.length > 0
      ? Object.fromEntries(candidate.sccs.map((scc) => [scc.id, scc.members]))
      : { "scc-consolidation": candidate.files },
    },
    dependencies,
    sourceBlobs,
    operations,
    consumers: consumers
      .map((consumer) => ({
      file: consumer.file,
      owner: consumer.package,
      expectedImporter: consumer.expectedImporter,
      specifiers: consumer.rewrites.map((rewrite) => ({ from: rewrite.from, to: rewrite.to, donor: rewrite.donor })),
      external: false,
      dependencySection: consumerSections.get(consumer.package) ?? consumer.dependencySection,
    })),
    generatedFiles: [],
    changedFiles: [...new Set(operations.flatMap((op) => operationPathsOf(op)))].sort(),
    expectedDynamicImportDelta: { added: [], removed: [] },
    evaluationEffects: [],
    metrics: {
      movedFiles: candidate.files.length + tests.length + candidate.assets.length,
      movedLines: candidate.lineCount,
      applicationLinesBefore: 0,
      applicationLinesAfter: 0,
      consumers: candidate.consumers.length,
    },
    commits: {
      plan: { subject: renderTemplate(config.commitTemplates.plan, commitVars) },
      move: { subject: renderTemplate(config.commitTemplates.move, commitVars) },
      wiring: { subject: renderTemplate(config.commitTemplates.wiring, commitVars) },
    },
    gates: renderGates(config, config.gates, { ...commitVars, consumerOwners, taskRunner, rootDir }),
  };
}
