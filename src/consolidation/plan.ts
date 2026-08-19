/**
 * Consolidation plan builder: generate an ExtractionManifest for merging
 * multiple packages into a target domain package.
 *
 * This is the inverse of extraction. Instead of using the portfolio/candidate
 * pipeline (which is designed for app→package moves), consolidation builds
 * a plan directly from validated donors and target.
 */

import { createPackageManagerAdapter, createTaskRunnerAdapter } from "../adapters/registry.ts";
import { GENERATOR } from "../branding.ts";
import { getApplication, packageNameMatcher, type MonocarveConfig } from "../config.ts";
import type { DependencyGraph } from "../graph/model.ts";
import { byCodeUnit, type Sha256 } from "../util/hash.ts";
import { renderTemplate } from "../util/template.ts";
import { PlanningError, WorkspaceContext } from "../plan/context.ts";
import { inferDependencies } from "../plan/dependencies.ts";
import { PLAN_SCHEMA_VERSION, type ExtractionManifest, type PlanOperation } from "../plan/manifest.ts";
import { sourceExportsFromFile, type ExportSurface } from "../plan/public-surface.ts";
import { buildPlanProvenance } from "../plan/provenance.ts";
import { consumerWiringOperations, packageOperations } from "../plan/scaffold.ts";
import { graphDigest, renderGates } from "../plan/build-support.ts";
import { resolveCommit } from "../util/git.ts";
import type { ConsolidationCandidate } from "./candidate.ts";

export interface BuildConsolidationPlanOptions {
  readonly config: MonocarveConfig;
  readonly rootDir: string;
  readonly graph: DependencyGraph;
  readonly candidate: ConsolidationCandidate;
  readonly baselineCommit: string;
  readonly packageRoot?: string;
}

export function buildConsolidationPlan(options: BuildConsolidationPlanOptions): ExtractionManifest {
  const { config, graph, candidate, baselineCommit, rootDir } = options;
  const context = new WorkspaceContext(config, rootDir);
  const packageManager = createPackageManagerAdapter(config);
  const taskRunner = createTaskRunnerAdapter(config);

  const packageName = candidate.target.name;
  if (!packageNameMatcher(config).test(packageName)) {
    throw new PlanningError(`package name ${JSON.stringify(packageName)} does not match the configured pattern`);
  }

  const packageRoot = options.packageRoot ?? candidate.target.root;
  // Use the application that owns the first donor's files.
  const firstDonorFile = candidate.files[0];
  const applicationName = firstDonorFile ? config.applications.find((app) => app.sourceRoot && firstDonorFile.startsWith(app.sourceRoot))?.name ?? config.applications[0]!.name : config.applications[0]!.name;
  const application = getApplication(config, applicationName);
  const projectId = taskRunner.projectIdFor(packageName, packageRoot);

  // Resolve baseline.
  const { commit: baselineCommitHash, committedAt } = resolveCommit(rootDir, baselineCommit);

  // Build move operations for each file.
  const operations: PlanOperation[] = [];
  const sourceBlobs: Record<string, Sha256> = {};

  // Compute the relative path from each donor root to the file.
  const donorRoots = new Set(candidate.donors.map((d) => d.root));
  
  const relativePath = (filePath: string): string => {
    for (const donorRoot of donorRoots) {
      const stripped = donorRoot.replace(/\/+$/, "");
      if (filePath.startsWith(`${stripped}/`)) {
        return filePath.slice(stripped.length + 1);
      }
    }
    return filePath;
  };

  for (const file of candidate.files) {
    const rel = relativePath(file);
    const targetFile = `${packageRoot}/${rel}`;
    const preconditionHash = context.state(file);
    if (preconditionHash === "missing") {
      throw new PlanningError(`consolidation source does not exist: ${file}`);
    }
    sourceBlobs[file] = preconditionHash;
    operations.push({ kind: "move", source: file, target: targetFile, preconditionHash, resultHash: preconditionHash });
  }

  // Move tests.
  for (const test of candidate.tests) {
    const rel = relativePath(test);
    const targetTest = `${packageRoot}/${rel}`;
    const preconditionHash = context.state(test);
    if (preconditionHash === "missing") continue;
    operations.push({ kind: "move", source: test, target: targetTest, preconditionHash, resultHash: preconditionHash });
  }

  // Move assets.
  for (const asset of candidate.assets) {
    const rel = relativePath(asset);
    const targetAsset = `${packageRoot}/${rel}`;
    const preconditionHash = context.state(asset);
    if (preconditionHash === "missing") continue;
    operations.push({ kind: "move", source: asset, target: targetAsset, preconditionHash, resultHash: preconditionHash });
  }

  // Infer dependencies.
  const dependencies = inferDependencies(context, graph, candidate.files, packageName);

  // Build consumer rewrites.
  const consumerOps = consumerWiringOperations({
    context,
    config,
    application,
    packageManager,
    taskRunner,
    packageName,
    packageRoot,
    projectId,
    production: candidate.files,
    tests: candidate.tests,
    assets: candidate.assets,
    dependencies,
    publicModules: [],
    consumerOwners: candidate.consumers.map((c) => ({ owner: c.owner, dependencySection: "runtime" as const })),
    lockfileText: "",
  });
  operations.push(...consumerOps);

  // Build package operations (scaffold, lockfile, etc.).
  const packageOps = packageOperations({
    context,
    config,
    application,
    packageManager,
    taskRunner,
    packageName,
    packageRoot,
    projectId,
    production: candidate.files,
    tests: candidate.tests,
    assets: candidate.assets,
    dependencies,
    publicModules: [],
    templates: config.scaffoldTemplates,
  });
  operations.push(...packageOps);

  // Build the manifest.
  const consumerOwners = candidate.consumers.map((c) => c.owner);
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
    target: {
      packageName,
      packageRoot,
      entrypoint: config.scaffoldTemplates.entrypoint,
      requiredExports: dedupeExports(candidate.files.flatMap((source) => sourceExportsFromFile(context.absolute(source), source))),
    },
    source: {
      files: candidate.files,
      tests: candidate.tests,
      ...(candidate.assets.length > 0 ? { assets: candidate.assets } : {}),
      sccs: Object.fromEntries(candidate.sccs.map((scc) => [scc.id, scc.members])),
    },
    dependencies,
    sourceBlobs,
    operations,
    consumers: candidate.consumers.map((consumer) => ({
      file: consumer.file,
      owner: consumer.owner,
      expectedImporter: "",
      specifiers: consumer.specifiers.map((spec) => ({ from: spec, to: packageName })),
      external: false,
      dependencySection: "runtime",
    })),
    generatedFiles: [],
    changedFiles: [...new Set(operations.flatMap((op) => operationPathsOf(op)))].sort(),
    expectedDynamicImportDelta: { added: [], removed: [] },
    evaluationEffects: [],
    metrics: {
      movedFiles: candidate.files.length + candidate.tests.length + candidate.assets.length,
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

function operationPathsOf(operation: PlanOperation): string[] {
  switch (operation.kind) {
    case "move":
    case "move-with-rewrite":
      return [operation.source, operation.target];
    case "rewrite-import":
    case "rewrite-fs-reference":
    case "rewrite-path-reference":
      return [operation.file];
    case "write-file":
      return [operation.path];
    case "lockfile-importer":
      return [operation.lockfile];
    case "migrate-path-keys":
      return [operation.path];
  }
}

function dedupeExports(entries: readonly ExportSurface[]): ExportSurface[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.name)) return false;
    seen.add(entry.name);
    return true;
  }).sort((left, right) => byCodeUnit(left.name, right.name));
}
