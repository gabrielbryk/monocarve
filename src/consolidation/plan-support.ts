/**
 * Helper functions for `buildConsolidationPlan` (see `plan.ts`).
 *
 * These are pulled out purely to keep `buildConsolidationPlan` within the
 * complexity gate's budget. Every function here is a verbatim extraction of
 * code that used to live inline in that function, in the same order it used
 * to execute in: no logic, ordering, or error message was changed. Treat any
 * behavioral difference from this split as a bug in the split, not an
 * intended improvement.
 */

import { createPackageManagerAdapter, createTaskRunnerAdapter } from "../adapters/registry.ts";
import { getApplication, packageNameMatcher, type ApplicationConfig, type MonocarveConfig } from "../config.ts";
import type { DependencyGraph } from "../graph/model.ts";
import { appendConsumerOperations } from "../plan/build-phases.ts";
import type { Consumer } from "../plan/consumers.ts";
import { PlanningError, WorkspaceContext } from "../plan/context.ts";
import { inferDependencies, type InferredDependencies } from "../plan/dependencies.ts";
import type { PlanOperation, PublicModule } from "../plan/manifest.ts";
import { sourceExportsFromFile } from "../plan/public-surface.ts";
import { consumerWiringOperations, packageOperations } from "../plan/scaffold.ts";
import { resolveCommit } from "../util/git.ts";
import type { Sha256 } from "../util/hash.ts";
import type { ConsolidationCandidate } from "./candidate.ts";

export { applyConsolidationDonorRetirement } from "./donor-retirement.ts";

type PackageManagerAdapter = ReturnType<typeof createPackageManagerAdapter>;
type TaskRunnerAdapter = ReturnType<typeof createTaskRunnerAdapter>;

interface ConsolidationTarget {
  readonly packageName: string;
  readonly packageRoot: string;
  readonly application: ApplicationConfig;
  readonly projectId: string;
}

/** Validate the target package name and resolve its root/application/project id. */
function resolveConsolidationTarget(input: {
  readonly config: MonocarveConfig;
  readonly candidate: ConsolidationCandidate;
  readonly packageRootOverride: string | undefined;
  readonly taskRunner: TaskRunnerAdapter;
}): ConsolidationTarget {
  const { config, candidate, taskRunner } = input;
  const packageName = candidate.target.name;
  if (!packageNameMatcher(config).test(packageName)) {
    throw new PlanningError(`package name ${JSON.stringify(packageName)} does not match the configured pattern`);
  }

  const packageRoot = input.packageRootOverride ?? candidate.target.root;
  // Use the application that owns the first donor's files.
  const firstDonorFile = candidate.files[0];
  const applicationName = firstDonorFile
    ? (config.applications.find((app) => app.sourceRoot && firstDonorFile.startsWith(app.sourceRoot))?.name ?? config.applications[0]!.name)
    : config.applications[0]!.name;
  const application = getApplication(config, applicationName);
  const projectId = taskRunner.projectIdFor(packageName, packageRoot);
  return { packageName, packageRoot, application, projectId };
}

interface DonorPathResolver {
  readonly donorFor: (filePath: string) => { root: string; slug: string } | undefined;
  readonly relativePath: (filePath: string) => string;
}

/**
 * Namespace every donor beneath the target package. This preserves each
 * donor's relative imports while making same-named files (especially the
 * several src/index.ts barrels) unambiguous and publicly addressable.
 */
function createDonorPathResolver(candidate: ConsolidationCandidate): DonorPathResolver {
  // Compute the relative path from each donor root to the file.
  const donorRoots = new Set(candidate.donors.map((d) => d.root));

  const donorFor = (filePath: string): { root: string; slug: string } | undefined => {
    for (const donorRoot of donorRoots) {
      const stripped = donorRoot.replace(/\/+$/, "");
      if (filePath.startsWith(`${stripped}/`)) return { root: stripped, slug: donorSlug(candidate.donors.find((donor) => donor.root === donorRoot)!.name) };
    }
    return undefined;
  };

  const relativePath = (filePath: string): string => {
    const donor = donorFor(filePath);
    if (!donor) throw new PlanningError(`consolidation source is outside every donor: ${filePath}`);
    return `src/${donor.slug}/${filePath.slice(donor.root.length + 1)}`;
  };

  return { donorFor, relativePath };
}

interface ConsolidationPublicModules {
  readonly publicModules: PublicModule[];
  readonly publicSpecifierFor: ReadonlyMap<string, string>;
}

function buildConsolidationPublicModules(input: {
  readonly context: WorkspaceContext;
  readonly candidate: ConsolidationCandidate;
  readonly resolver: DonorPathResolver;
  readonly packageRoot: string;
  readonly packageName: string;
}): ConsolidationPublicModules {
  const { context, candidate, resolver, packageRoot, packageName } = input;
  const publicModules: PublicModule[] = candidate.files.map((file) => {
    const target = `${packageRoot}/${resolver.relativePath(file)}`;
    // Resolved once and guarded, rather than called twice with `?.` and then
    // `!`. The non-null assertion bypassed the check `relativePath` makes for
    // the same lookup, so a source outside every donor produced a raw
    // TypeError on `.slug` instead of this PlanningError.
    const donor = resolver.donorFor(file);
    if (!donor) throw new PlanningError(`consolidation source is outside every donor: ${file}`);
    const donorRelative = file.slice(donor.root.length + 1);
    const exported = `${donor.slug}/${donorRelative.replace(/^src\//u, "").replace(/\.[cm]?[jt]sx?$/u, "")}`;
    return {
      source: file,
      target,
      specifier: `${packageName}/${exported}`,
      exportKey: `./${exported}`,
      exportTarget: `./${resolver.relativePath(file)}`,
      requiredExports: sourceExportsFromFile(context.absolute(file), file),
    };
  });
  const publicSpecifierFor = new Map(publicModules.map((module) => [module.source, module.specifier]));
  return { publicModules, publicSpecifierFor };
}

function selectConsolidationTests(context: WorkspaceContext, candidate: ConsolidationCandidate): string[] {
  return context
    .repositorySources()
    .filter((path) => candidate.donors.some((donor) => path.startsWith(`${donor.root}/`)) && context.isTest(path))
    .toSorted();
}

/** Push move operations for every donor file, test, and asset onto `operations`/`sourceBlobs`. */
function buildConsolidationMoveOperations(input: {
  readonly context: WorkspaceContext;
  readonly candidate: ConsolidationCandidate;
  readonly resolver: DonorPathResolver;
  readonly packageRoot: string;
  readonly tests: readonly string[];
  readonly operations: PlanOperation[];
  readonly sourceBlobs: Record<string, Sha256>;
}): void {
  const { context, candidate, resolver, packageRoot, tests, operations, sourceBlobs } = input;

  for (const file of candidate.files) {
    const targetFile = `${packageRoot}/${resolver.relativePath(file)}`;
    const preconditionHash = context.state(file);
    if (preconditionHash === "missing") {
      throw new PlanningError(`consolidation source does not exist: ${file}`);
    }
    sourceBlobs[file] = preconditionHash;
    operations.push({ kind: "move", source: file, target: targetFile, preconditionHash, resultHash: preconditionHash });
  }

  // Move tests.
  for (const test of tests) {
    const targetTest = `${packageRoot}/${resolver.relativePath(test)}`;
    const preconditionHash = context.state(test);
    if (preconditionHash === "missing") continue;
    sourceBlobs[test] = preconditionHash;
    operations.push({ kind: "move", source: test, target: targetTest, preconditionHash, resultHash: preconditionHash });
  }

  // Move assets.
  for (const asset of candidate.assets) {
    const targetAsset = `${packageRoot}/${resolver.relativePath(asset)}`;
    const preconditionHash = context.state(asset);
    if (preconditionHash === "missing") continue;
    sourceBlobs[asset] = preconditionHash;
    operations.push({ kind: "move", source: asset, target: targetAsset, preconditionHash, resultHash: preconditionHash });
  }
}

export interface InitializedConsolidationPlan {
  readonly context: WorkspaceContext;
  readonly packageManager: PackageManagerAdapter;
  readonly taskRunner: TaskRunnerAdapter;
  readonly packageName: string;
  readonly packageRoot: string;
  readonly application: ApplicationConfig;
  readonly projectId: string;
  readonly baselineCommitHash: string;
  readonly committedAt: string;
}

/**
 * Set up the workspace context and adapters, resolve the validated target,
 * and resolve the baseline commit. Bundled purely to keep
 * buildConsolidationPlan's own body within the method-length budget.
 */
export function initializeConsolidationPlan(input: {
  readonly config: MonocarveConfig;
  readonly rootDir: string;
  readonly candidate: ConsolidationCandidate;
  readonly packageRootOverride: string | undefined;
  readonly baselineCommit: string;
}): InitializedConsolidationPlan {
  const { config, rootDir, candidate, packageRootOverride, baselineCommit } = input;
  const context = new WorkspaceContext(config, rootDir);
  const packageManager = createPackageManagerAdapter(config);
  const taskRunner = createTaskRunnerAdapter(config);

  const { packageName, packageRoot, application, projectId } = resolveConsolidationTarget({ config, candidate, packageRootOverride, taskRunner });

  // Resolve baseline.
  const { commit: baselineCommitHash, committedAt } = resolveCommit(rootDir, baselineCommit);

  return { context, packageManager, taskRunner, packageName, packageRoot, application, projectId, baselineCommitHash, committedAt };
}

export interface PreparedConsolidationSources {
  readonly publicModules: PublicModule[];
  readonly publicSpecifierFor: ReadonlyMap<string, string>;
  readonly tests: string[];
}

/**
 * Resolve donor-relative paths, compute public modules and travelling
 * tests, and push the file/test/asset move operations onto `operations`.
 * Bundles what plan.ts otherwise did as four separate calls, purely to
 * keep buildConsolidationPlan's own body within the method-length budget.
 */
export function prepareConsolidationSources(input: {
  readonly context: WorkspaceContext;
  readonly candidate: ConsolidationCandidate;
  readonly packageRoot: string;
  readonly packageName: string;
  readonly operations: PlanOperation[];
  readonly sourceBlobs: Record<string, Sha256>;
}): PreparedConsolidationSources {
  const { context, candidate, packageRoot, packageName, operations, sourceBlobs } = input;
  const resolver = createDonorPathResolver(candidate);
  const { publicModules, publicSpecifierFor } = buildConsolidationPublicModules({ context, candidate, resolver, packageRoot, packageName });
  const tests = selectConsolidationTests(context, candidate);
  buildConsolidationMoveOperations({ context, candidate, resolver, packageRoot, tests, operations, sourceBlobs });
  return { publicModules, publicSpecifierFor, tests };
}

export interface ResolvedConsumers {
  readonly dependencies: InferredDependencies;
  readonly consumers: Consumer[];
  readonly consumerSections: Map<string, "runtime" | "dev">;
}

export function resolveConsumers(input: {
  readonly context: WorkspaceContext;
  readonly graph: DependencyGraph;
  readonly candidate: ConsolidationCandidate;
  readonly packageName: string;
  readonly publicSpecifierFor: ReadonlyMap<string, string>;
  readonly operations: PlanOperation[];
  readonly tests: readonly string[];
}): ResolvedConsumers {
  const { context, graph, candidate, packageName, publicSpecifierFor, operations, tests } = input;

  // Infer dependencies.
  const dependencies = inferDependencies(context, graph, candidate.files, packageName);

  const consumerAnalysis = appendConsumerOperations({
    context,
    sources: [...candidate.files, ...tests, ...candidate.assets],
    packageName,
    publicSpecifierFor,
    operations,
    includeDonorFiles: true,
  });
  const consumers: Consumer[] =
    consumerAnalysis.consumers.length > 0
      ? consumerAnalysis.consumers
      : candidate.consumers.map((consumer) => ({
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

  return { dependencies, consumers, consumerSections };
}

/** Build and push consumer-wiring and package-scaffold operations onto `operations`. */
export function buildConsolidationWiringOperations(input: {
  readonly context: WorkspaceContext;
  readonly config: MonocarveConfig;
  readonly application: ApplicationConfig;
  readonly packageManager: PackageManagerAdapter;
  readonly taskRunner: TaskRunnerAdapter;
  readonly packageName: string;
  readonly packageRoot: string;
  readonly projectId: string;
  readonly candidate: ConsolidationCandidate;
  readonly tests: readonly string[];
  readonly dependencies: InferredDependencies;
  readonly publicModules: PublicModule[];
  readonly consumers: readonly Consumer[];
  readonly operations: PlanOperation[];
}): void {
  const {
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
  } = input;

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
}

/**
 * Consumer rewrites must run while donor paths still exist: the codemod
 * resolves each donor's baseline module to identify the exact declaration
 * span. Extraction plans already establish this ordering; consolidation
 * assembles its operations manually, so make the invariant explicit.
 */
export function reorderConsolidationOperations(operations: PlanOperation[]): void {
  const rewrites = operations.filter((operation) => operation.kind === "rewrite-import");
  const moves = operations.filter((operation) => operation.kind === "move" || operation.kind === "move-with-rewrite");
  const remainder = operations.filter(
    (operation) => operation.kind !== "rewrite-import" && operation.kind !== "move" && operation.kind !== "move-with-rewrite",
  );
  operations.splice(0, operations.length, ...rewrites, ...moves, ...remainder);
}

export function operationPathsOf(operation: PlanOperation): string[] {
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
    case "delete-file":
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
