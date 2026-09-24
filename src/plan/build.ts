/** Deterministic compilation of one eligible portfolio candidate. */
import { createPackageManagerAdapter, createTaskRunnerAdapter } from "../adapters/registry.ts";
import { GENERATOR } from "../branding.ts";
import {
  applicationOwner,
  getApplication,
  packageNameMatcher,
  packageNameOf,
  renderExtractionProfile,
  resolveExtractionProfile,
  type MonocarveConfig,
  type PublicSurfaceConfig,
} from "../config.ts";
import type { DependencyGraph } from "../graph/model.ts";
import type { PortfolioCandidate } from "../portfolio/types.ts";
import { byCodeUnit, hashText, stableStringify } from "../util/hash.ts";
import {
  appendConsumerOperations,
  appendStaticFsReferenceOperations,
  consumerApplications,
  escapeRewritesFor,
  evaluationEffectsFor,
  selectExtractionSources,
} from "./build-phases.ts";
import {
  assessmentSection,
  boundaryBaselineSection,
  changedFilesFor,
  commitsSection,
  commitVarsFor,
  consumerRecords,
  dependencyDecisionsFor,
  lockfileImporterSection,
  metricsSection,
  pathMigrationNoopsSection,
  profilePlanId,
  provenanceSection,
  sourceBlobsFor,
  sourceSection,
  targetSection,
} from "./build-sections.ts";
import {
  baselineOf,
  derivePackageRoot,
  generatedFilesFor,
  graphDigest,
  moveOperation,
  pathMigrationOperations,
  pathReferenceRewriteOperations,
  renderGates,
} from "./build-support.ts";
import { consumerDependencyOwners } from "./consumers.ts";
import { PlanningError, WorkspaceContext } from "./context.ts";
import { inferDependencies } from "./dependencies.ts";
import { composeDonorDependencyPruning, donorDependencyPruningCandidates } from "./donor-pruning.ts";
import { formatGeneratedText } from "./format-generated.ts";
import { PLAN_SCHEMA_VERSION, type EscapeRewrite, type ExtractionManifest, type PlanOperation } from "./manifest.ts";
import { generatorOwnedOutputs, postJournalRecordsFor } from "./post-journal-records.ts";
import { assertCompiledOperationInvariants, projectedArtifactEvidence } from "./projected-workspace.ts";
import { consumerWiringOperations, packageOperations, projectedLockfile } from "./scaffold.ts";
import { normalizeTargetSubpath } from "./target-layout.ts";

export interface BuildPlanOptions {
  readonly config: MonocarveConfig;
  readonly rootDir: string;
  readonly graph: DependencyGraph;
  readonly candidate: PortfolioCandidate;
  readonly baselineCommit: string;
  readonly packageName?: string;
  readonly packageRoot?: string;
  readonly profile?: string;
  readonly context?: WorkspaceContext;
  readonly modulePromotion?: ExtractionManifest["modulePromotion"];
  readonly publicSurface?: PublicSurfaceConfig;
  /** Destination directory inside the target package for every moved file. */
  readonly targetSubpath?: string;
  readonly evacuationProvenance?: NonNullable<NonNullable<ExtractionManifest["provenance"]>["evacuation"]>;
}

export function buildPlanSync(options: BuildPlanOptions): ExtractionManifest {
  const state = prepareBuild(options);
  const selection = selectExtractionSources({
    context: state.context,
    candidate: state.candidate,
    packageRoot: state.packageRoot,
    entrypoint: state.templates.entrypoint,
    packageName: state.packageName,
    publicSurface: options.publicSurface ?? state.templates.publicSurface,
    ...(options.modulePromotion === undefined ? {} : { targetModule: options.modulePromotion.targetModule }),
    ...(state.targetSubpath === undefined ? {} : { targetSubpath: state.targetSubpath }),
  });
  assertAssetImportersReachable(state.graph, selection.production, selection.assets);
  const rewrites = escapeRewritesFor(state.candidate);
  const operations = buildJournal(state, selection, rewrites);
  return buildManifest(state, selection, rewrites, operations);
}

export interface BuildState {
  readonly options: BuildPlanOptions;
  readonly config: MonocarveConfig;
  readonly graph: DependencyGraph;
  readonly candidate: PortfolioCandidate;
  readonly baseline: ReturnType<typeof baselineOf>;
  readonly context: WorkspaceContext;
  readonly application: ReturnType<typeof getApplication>;
  readonly packageManager: ReturnType<typeof createPackageManagerAdapter>;
  readonly taskRunner: ReturnType<typeof createTaskRunnerAdapter>;
  readonly profile: ReturnType<typeof resolveExtractionProfile>;
  readonly templates: MonocarveConfig["scaffoldTemplates"];
  readonly candidateName: string;
  readonly packageName: string;
  readonly packageRoot: string;
  readonly projectId: string;
  readonly targetSubpath: string | undefined;
  readonly pathMigrationNoops: Array<NonNullable<ExtractionManifest["pathMigrationNoops"]>[number]>;
}
function prepareBuild(options: BuildPlanOptions): BuildState {
  const { config, graph, candidate } = options;
  const context = options.context ?? new WorkspaceContext(config, options.rootDir);
  const application = getApplication(config, candidate.application);
  const profile = resolveExtractionProfile(config, application, options.profile);
  if (profile.kind !== "library") throw new PlanningError(`production extraction requires a library profile; ${profile.name ?? "legacy"} is ${profile.kind}`);
  if (profile.name !== undefined && (options.packageName !== undefined || options.packageRoot !== undefined))
    throw new PlanningError("--package-name and --package-root cannot override a selected extraction profile");
  const candidateName = profileCandidateName(config, candidate.suggestedPackageName);
  const rendered = renderExtractionProfile(config, application, profile, candidateName);
  const packageName = profile.name === undefined ? (options.packageName ?? candidate.suggestedPackageName) : rendered.packageName;
  if (!packageNameMatcher(config).test(packageName))
    throw new PlanningError(`package name ${JSON.stringify(packageName)} does not match the configured pattern`);
  const packageRoot = profile.name === undefined ? (options.packageRoot ?? derivePackageRoot(config, graph, packageName)) : rendered.packageRoot;
  const taskRunner = createTaskRunnerAdapter(config);
  const templates = options.publicSurface === undefined ? profile.scaffoldTemplates : { ...profile.scaffoldTemplates, publicSurface: options.publicSurface };
  // Normalized here, once, so every later derivation — move targets, the
  // barrel, the public surface, the recorded target — reads the same value the
  // reviewer approved, and so an invalid subpath fails before any operation is
  // compiled from it.
  const targetSubpath = options.targetSubpath === undefined ? undefined : normalizeTargetSubpath(options.targetSubpath);
  if (targetSubpath !== undefined && !graph.workspace.owners.includes(packageRoot)) {
    throw new PlanningError(`--target-subpath applies only when extending an existing package; ${packageRoot} is created by this plan`);
  }
  return {
    options,
    config,
    graph,
    candidate,
    baseline: baselineOf(options),
    context,
    application,
    packageManager: createPackageManagerAdapter(config),
    taskRunner,
    profile,
    templates,
    candidateName,
    packageName,
    packageRoot,
    projectId: rendered.projectId ?? taskRunner.projectIdFor(packageName, packageRoot),
    targetSubpath,
    pathMigrationNoops: [],
  };
}

function buildJournal(
  state: BuildState,
  selection: ReturnType<typeof selectExtractionSources>,
  rewrites: ReadonlyMap<string, readonly EscapeRewrite[]>,
): PlanOperation[] {
  const operations = selection.sources.map((source, index) => moveOperation(state.context, source, selection.targets[index]!, rewrites.get(source) ?? []));
  operations.push(...selection.assets.map((asset, index) => moveOperation(state.context, asset, selection.assetTargets[index]!, [])));
  const promotion = state.options.modulePromotion;
  if (promotion !== undefined && !promotion.retireSource) {
    const specifier = promotion.targetModule === "index" ? state.packageName : `${state.packageName}/${promotion.targetModule.replace(/^\.\//, "")}`;
    const contents = formatGeneratedText(state.context.rootDir, promotion.source, `export * from ${JSON.stringify(specifier)};\n`);
    operations.push({
      kind: "write-file",
      path: promotion.source,
      contents,
      preconditionHash: "missing",
      resultHash: hashText(contents),
      generator: "module-promotion:compatibility-reexport",
    });
  }
  // Documents must be rewritten before any preparer or artifact regeneration
  // runs, because a post-journal preparer may itself read the rewritten
  // document (its trigger can match on the document path — `buildManifest`
  // reads the `rewrite-path-reference` operations landed here back off this
  // same `operations` array and feeds their `.file`s to `generatedFilesFor`'s
  // `documents` parameter). Emitting here, ahead of `write-file`/
  // `lockfile-importer` (from `packageOperations` below) and
  // `migrate-path-keys` (emitted last), guarantees the doc's on-disk bytes
  // are already correct by the time anything downstream depends on them.
  operations.push(...pathReferenceRewriteOperations(state.config, state.context, operations));
  const generatedOwners = generatorOwnedOutputs(state.config, selection.production, operations);
  const { consumers } = appendConsumerOperations({
    context: state.context,
    sources: [...selection.sources, ...selection.assets],
    packageName: state.packageName,
    publicSpecifierFor: selection.publicSpecifierFor,
    operations,
    excludedFiles: generatedOwners,
  });
  appendStaticFsReferenceOperations({ context: state.context, donorTargets: donorTargetsOf(selection), operations, excludedFiles: generatedOwners });
  const dependencies = dependenciesFor(state, selection.sources, rewrites);
  const input = {
    context: state.context,
    config: state.config,
    application: state.application,
    packageManager: state.packageManager,
    taskRunner: state.taskRunner,
    packageName: state.packageName,
    packageRoot: state.packageRoot,
    projectId: state.projectId,
    templates: state.templates,
    production: selection.production,
    tests: selection.tests,
    assets: selection.assets,
    dependencies,
    publicModules: selection.publicModules,
    ...(state.targetSubpath === undefined ? {} : { targetSubpath: state.targetSubpath }),
  };
  const packageWiring = packageOperations(input);
  operations.push(
    ...packageWiring,
    ...consumerWiringOperations({
      ...input,
      consumerOwners: consumerDependencyOwners(consumers),
      lockfileText: projectedLockfile(state.context, state.packageManager, packageWiring),
    }),
  );
  if (state.config.dependencyPruning.mode === "apply") {
    const composed = composeDonorDependencyPruning({
      context: state.context,
      donorRoot: applicationOwner(state.application),
      movedSources: selection.sources,
      dependencies,
      packageManager: state.packageManager,
      operations,
    });
    operations.splice(0, operations.length, ...composed);
  }
  operations.push(...pathMigrationOperations(state.config, state.context, operations, (proof) => state.pathMigrationNoops.push(proof)));
  assertCompiledOperationInvariants(state.context, state.packageManager, operations);
  return operations;
}

export function assertAssetImportersReachable(graph: DependencyGraph, production: readonly string[], assets: readonly string[]): void {
  const moved = new Set(production);
  const assetSet = new Set(assets);
  for (const importer of moved) {
    const importedAssets = (graph.outgoing.get(importer) ?? []).filter((path) => assetSet.has(path));
    if (importedAssets.length === 0) continue;
    const runtimeImporters = (graph.incoming.get(importer) ?? []).filter((path) => !graph.nodes.get(path)?.isTest);
    const retainedAssetImporters = importedAssets
      .flatMap((asset) => graph.incoming.get(asset) ?? [])
      .filter((path) => !moved.has(path) && !graph.nodes.get(path)?.isTest);
    if (runtimeImporters.length === 0 && retainedAssetImporters.length === 0) {
      throw new PlanningError(
        `asset side effect is not runtime-reachable before extraction: ${importer} imports ${importedAssets.join(", ")}; ` +
          "a generated package barrel alone cannot prove that a bundler will retain it",
      );
    }
  }
}
function dependenciesFor(state: BuildState, sources: readonly string[], rewrites: ReadonlyMap<string, readonly EscapeRewrite[]>) {
  const dependencies = inferDependencies(state.context, state.graph, sources, state.packageName);
  addAutomaticJsxRuntime(state, sources, dependencies);
  for (const entries of rewrites.values())
    for (const rewrite of entries) {
      const packageName = packageNameOf(rewrite.packageSpecifier);
      if (packageName === state.packageName) continue;
      const owner = state.graph.workspace.packageNames.get(packageName);
      if (!owner) throw new PlanningError(`rewrite target is not a workspace package: ${rewrite.packageSpecifier}`);
      if (!dependencies.dev[packageName]) dependencies.runtime[packageName] = "workspace:*";
      if (!dependencies.packageReferences.includes(owner)) dependencies.packageReferences = [...dependencies.packageReferences, owner].toSorted();
    }
  return dependencies;
}

function addAutomaticJsxRuntime(state: BuildState, sources: readonly string[], dependencies: ReturnType<typeof inferDependencies>): void {
  if (!state.application.compilerProfile.jsx || !sources.some((source) => source.endsWith(".tsx"))) return;
  if (!state.config.portfolio.frameworkPackages.includes("react")) return;
  const versions = new Set(sources.map((source) => state.context.declaredVersion(state.context.ownerOf(source), "react")).filter(Boolean));
  const rootVersion = state.context.declaredVersion("", "react");
  if (versions.size === 0 && rootVersion) versions.add(rootVersion);
  if (versions.size !== 1) {
    throw new PlanningError("the JSX runtime react must have one declared version across the donating owners or workspace root");
  }
  dependencies.runtime.react = [...versions][0]!;
  delete dependencies.dev.react;
}

function buildManifest(
  state: BuildState,
  selection: ReturnType<typeof selectExtractionSources>,
  rewrites: ReadonlyMap<string, readonly EscapeRewrite[]>,
  operations: PlanOperation[],
): ExtractionManifest {
  const consumerSources = [...selection.sources, ...selection.assets];
  const generatorOwned = generatorOwnedOutputs(state.config, selection.production, operations);
  const consumerAnalysis = appendConsumerOperations({
    context: state.context,
    sources: consumerSources,
    packageName: state.packageName,
    publicSpecifierFor: selection.publicSpecifierFor,
    operations: [],
    excludedFiles: generatorOwned,
  });
  const consumers = consumerAnalysis.consumers;
  const dynamicImportDelta = consumerAnalysis.dynamicImportDelta;
  const dependencies = dependenciesFor(state, selection.sources, rewrites);
  const pruningCandidates = pruningCandidatesFor(state, selection.sources, dependencies);
  const dependencyDecisions = dependencyDecisionsFor(state, selection.sources, dependencies, pruningCandidates);
  const packageWiringStart = operations.findIndex((operation) => operation.kind === "write-file");
  const packageWiring = packageWiringStart < 0 ? [] : operations.slice(packageWiringStart);
  // Read the rewritten document paths back off the already-compiled journal
  // (populated by `pathReferenceRewriteOperations` in `buildJournal`) rather
  // than recomputing them: `operations` is the single source of truth for
  // what actually landed in the manifest, so this can never drift from it or
  // duplicate the file-system scan.
  const rewrittenDocuments = operations
    .filter((operation): operation is Extract<PlanOperation, { kind: "rewrite-path-reference" }> => operation.kind === "rewrite-path-reference")
    .map((operation) => operation.file);
  const generatedFiles = generatedFilesFor(state.config, state.context, selection.production, selection.targets, rewrittenDocuments);
  const postJournalPreparers = postJournalRecordsFor(state.config, state.context, operations, [...selection.production, ...rewrittenDocuments]);
  const sourceBlobs = sourceBlobsFor(state.context, [...selection.sources, ...selection.assets]);
  const consumerOwners = consumerApplications(state.context, consumers);
  const sections = new Map(consumerDependencyOwners(consumers).map((entry) => [entry.owner, entry.dependencySection]));
  const commitVars = commitVarsFor(state, selection);
  const lockfileImporter = lockfileImporterSection(state, operations);
  const metrics = metricsSection(state, selection, consumers.length);
  const provenance = provenanceSection(state);
  return {
    schemaVersion: PLAN_SCHEMA_VERSION,
    planId: profilePlanId(state.candidate.id, state.profile.name),
    createdAt: state.baseline.committedAt,
    generator: { ...GENERATOR },
    provenance,
    baselineCommit: state.baseline.commit,
    graphDigest: graphDigest(state.graph),
    application: state.candidate.application,
    ...assessmentSection(state),
    ...(state.options.modulePromotion === undefined ? {} : { modulePromotion: state.options.modulePromotion }),
    boundaryBaseline: boundaryBaselineSection(state),
    target: targetSection(state, selection),
    source: sourceSection(state, selection),
    dependencies,
    dependencyDecisions,
    projectedArtifacts: projectedArtifactEvidence(operations),
    ...(pruningCandidates.length === 0 ? {} : { donorDependencyPruning: { mode: state.config.dependencyPruning.mode, candidates: pruningCandidates } }),
    sourceBlobs,
    operations,
    ...pathMigrationNoopsSection(state),
    consumers: consumerRecords(state, consumers, sections),
    generatedFiles,
    ...(postJournalPreparers.length === 0 ? {} : { postJournalPreparers }),
    changedFiles: changedFilesFor(operations, generatedFiles, postJournalPreparers),
    ...lockfileImporter,
    expectedDynamicImportDelta: { added: dynamicImportDelta.added.sort(byCodeUnit), removed: dynamicImportDelta.removed.sort(byCodeUnit) },
    evaluationEffects: evaluationEffectsFor({
      config: state.config,
      context: state.context,
      graph: state.graph,
      production: selection.production,
      targets: selection.targets,
      rewrites,
      packageWiring,
      entrypointPath: selection.entrypointPath,
    }),
    metrics,
    commits: commitsSection(state.config, commitVars),
    gates: renderGates(state.config, state.profile.gates, { ...commitVars, consumerOwners, taskRunner: state.taskRunner, rootDir: state.options.rootDir }),
  };
}

function pruningCandidatesFor(state: BuildState, sources: readonly string[], dependencies: ReturnType<typeof dependenciesFor>) {
  return donorDependencyPruningCandidates({ context: state.context, donorRoot: applicationOwner(state.application), movedSources: sources, dependencies });
}

function donorTargetsOf(selection: ReturnType<typeof selectExtractionSources>): Map<string, string> {
  const map = new Map<string, string>();
  selection.sources.forEach((source, index) => map.set(source, selection.targets[index]!));
  selection.assets.forEach((asset, index) => map.set(asset, selection.assetTargets[index]!));
  return map;
}
function profileCandidateName(config: MonocarveConfig, suggested: string): string {
  return config.packageScope !== "" && suggested.startsWith(config.packageScope) ? suggested.slice(config.packageScope.length) : suggested;
}
export { generatedFilesFor, graphDigest, moveOperation, pathMigrationOperations, renderGates } from "./build-support.ts";
export function serializeManifest(manifest: ExtractionManifest): string {
  return `${stableStringify(manifest, 2)}\n`;
}
export function parseManifest(text: string, source = "<inline>"): ExtractionManifest {
  try {
    return JSON.parse(text) as ExtractionManifest;
  } catch (error) {
    throw new PlanningError(`could not parse manifest ${source}: ${(error as Error).message}`, { cause: error });
  }
}
