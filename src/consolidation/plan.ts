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
import type { Sha256 } from "../util/hash.ts";
import { renderTemplate } from "../util/template.ts";
import { PlanningError, WorkspaceContext } from "../plan/context.ts";
import { inferDependencies } from "../plan/dependencies.ts";
import { PLAN_SCHEMA_VERSION, type ExtractionManifest, type PlanOperation } from "../plan/manifest.ts";
import { sourceExportsFromFile } from "../plan/public-surface.ts";
import { buildPlanProvenance } from "../plan/provenance.ts";
import { consumerWiringOperations, packageOperations } from "../plan/scaffold.ts";
import { appendConsumerOperations } from "../plan/build-phases.ts";
import type { PublicModule } from "../plan/manifest.ts";
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
  
  const donorFor = (filePath: string): { root: string; slug: string } | undefined => {
    for (const donorRoot of donorRoots) {
      const stripped = donorRoot.replace(/\/+$/, "");
      if (filePath.startsWith(`${stripped}/`)) return { root: stripped, slug: donorSlug(candidate.donors.find((donor) => donor.root === donorRoot)!.name) };
    }
    return undefined;
  };

  // Namespace every donor beneath the target package. This preserves each
  // donor's relative imports while making same-named files (especially the
  // several src/index.ts barrels) unambiguous and publicly addressable.
  const relativePath = (filePath: string): string => {
    const donor = donorFor(filePath);
    if (!donor) throw new PlanningError(`consolidation source is outside every donor: ${filePath}`);
    return `src/${donor.slug}/${filePath.slice(donor.root.length + 1)}`;
  };

  const publicModules: PublicModule[] = candidate.files.map((file) => {
    const target = `${packageRoot}/${relativePath(file)}`;
    const donorRelative = file.slice((donorFor(file)?.root.length ?? 0) + 1);
    const exported = `${donorFor(file)!.slug}/${donorRelative.replace(/^src\//u, "").replace(/\.[cm]?[jt]sx?$/u, "")}`;
    return {
      source: file,
      target,
      specifier: `${packageName}/${exported}`,
      exportKey: `./${exported}`,
      exportTarget: `./${relativePath(file)}`,
      requiredExports: sourceExportsFromFile(context.absolute(file), file),
    };
  });
  const publicSpecifierFor = new Map(publicModules.map((module) => [module.source, module.specifier]));
  const tests = context.repositorySources().filter((path) =>
    candidate.donors.some((donor) => path.startsWith(`${donor.root}/`)) && context.isTest(path),
  ).sort();

  for (const file of candidate.files) {
    const targetFile = `${packageRoot}/${relativePath(file)}`;
    const preconditionHash = context.state(file);
    if (preconditionHash === "missing") {
      throw new PlanningError(`consolidation source does not exist: ${file}`);
    }
    sourceBlobs[file] = preconditionHash;
    operations.push({ kind: "move", source: file, target: targetFile, preconditionHash, resultHash: preconditionHash });
  };

  // Move tests.
  for (const test of tests) {
    const targetTest = `${packageRoot}/${relativePath(test)}`;
    const preconditionHash = context.state(test);
    if (preconditionHash === "missing") continue;
    sourceBlobs[test] = preconditionHash;
    operations.push({ kind: "move", source: test, target: targetTest, preconditionHash, resultHash: preconditionHash });
  }

  // Move assets.
  for (const asset of candidate.assets) {
    const targetAsset = `${packageRoot}/${relativePath(asset)}`;
    const preconditionHash = context.state(asset);
    if (preconditionHash === "missing") continue;
    sourceBlobs[asset] = preconditionHash;
    operations.push({ kind: "move", source: asset, target: targetAsset, preconditionHash, resultHash: preconditionHash });
  }

  // Infer dependencies.
  const dependencies = inferDependencies(context, graph, candidate.files, packageName);

  const consumerAnalysis = appendConsumerOperations({
    context,
    sources: [...candidate.files, ...tests, ...candidate.assets],
    packageName,
    publicSpecifierFor,
    operations,
    excludedFiles: new Set(context.repositorySources().filter((path) => candidate.donors.some((donor) => path.startsWith(`${donor.root}/`)))),
  });
  const consumers = consumerAnalysis.consumers.length > 0 ? consumerAnalysis.consumers : candidate.consumers.map((consumer) => ({
    package: consumer.owner,
    file: consumer.file,
    expectedImporter: consumer.specifiers[0] ?? "",
    rewrites: consumer.specifiers.map((specifier) => ({ from: specifier, to: packageName, donor: candidate.files[0] ?? "" })),
    donors: [...candidate.files],
    dependencySection: "runtime" as const,
  }));
  const consumerSections = new Map<string, "runtime" | "dev">();
  for (const consumer of consumers) {
    const current = consumerSections.get(consumer.package);
    consumerSections.set(consumer.package, current === "runtime" || consumer.dependencySection === "runtime" ? "runtime" : "dev");
  }

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
    tests,
    assets: candidate.assets,
    dependencies,
    publicModules,
    consumerOwners: consumers
      .filter((consumer) => consumer.package !== packageRoot && !candidate.donors.some((donor) => consumer.package === donor.root))
      .map((consumer) => ({ owner: consumer.package, dependencySection: consumer.dependencySection })),
    lockfileText: context.exists(packageManager.lockfileName) ? context.text(packageManager.lockfileName) : "",
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
    tests,
    assets: candidate.assets,
    dependencies,
    publicModules,
    templates: config.scaffoldTemplates,
  });
  operations.push(...packageOps);

  // Consumer rewrites must run while donor paths still exist: the codemod
  // resolves each donor's baseline module to identify the exact declaration
  // span. Extraction plans already establish this ordering; consolidation
  // assembles its operations manually, so make the invariant explicit.
  const rewrites = operations.filter((operation) => operation.kind === "rewrite-import");
  const moves = operations.filter((operation) => operation.kind === "move" || operation.kind === "move-with-rewrite");
  const remainder = operations.filter((operation) => operation.kind !== "rewrite-import" && operation.kind !== "move" && operation.kind !== "move-with-rewrite");
  operations.splice(0, operations.length, ...rewrites, ...moves, ...remainder);

  // Build the manifest.
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
    sccs: Object.keys(candidate.sccs).length > 0
      ? Object.fromEntries(candidate.sccs.map((scc) => [scc.id, scc.members]))
      : { "scc-consolidation": candidate.files },
    },
    dependencies,
    sourceBlobs,
    operations,
    consumers: consumers
      .filter((consumer) => !candidate.donors.some((donor) => consumer.package === donor.root))
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

function donorSlug(name: string): string {
  return name.replace(/^@[^/]+\//u, "").replace(/[^a-zA-Z0-9_-]+/gu, "-");
}
