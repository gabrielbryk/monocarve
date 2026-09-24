/** Deterministic compilation of one eligible portfolio candidate. */
import { statSync } from "node:fs";
import { createPackageManagerAdapter, createTaskRunnerAdapter } from "../adapters/registry.ts";
import { GENERATOR } from "../branding.ts";
import {
  applicationOwner,
  getApplication,
  packageNameMatcher,
  packageNameOf,
  renderExtractionProfile,
  resolveExtractionProfile,
  triggeredArtifacts,
  triggeredPostJournalPreparers,
  type MonocarveConfig,
  type PublicSurfaceConfig,
} from "../config.ts";
import { sccId } from "../graph/components.ts";
import type { DependencyGraph } from "../graph/model.ts";
import type { PortfolioCandidate } from "../portfolio/types.ts";
import { byCodeUnit, hashText, stableStringify, type Sha256 } from "../util/hash.ts";
import { renderTemplate } from "../util/template.ts";
import { boundaryBaselineOf } from "./boundary-baseline.ts";
import {
  appendConsumerOperations,
  appendStaticFsReferenceOperations,
  consumerApplications,
  escapeRewritesFor,
  evaluationEffectsFor,
  selectExtractionSources,
} from "./build-phases.ts";
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
import { collectDependencyEvidence } from "./dependency-evidence.ts";
import { composeDonorDependencyPruning, donorDependencyPruningCandidates } from "./donor-pruning.ts";
import { formatGeneratedText } from "./format-generated.ts";
import { PLAN_SCHEMA_VERSION, type EscapeRewrite, type ExtractionManifest, type PlanOperation, type PostJournalPreparerRecord } from "./manifest.ts";
import { assertCompiledOperationInvariants, projectedArtifactEvidence } from "./projected-workspace.ts";
import { buildPlanProvenance } from "./provenance.ts";
import { sourceExportsFromFile, type ExportSurface } from "./public-surface.ts";
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
export async function buildPlan(options: BuildPlanOptions): Promise<ExtractionManifest> {
  return buildPlanSync(options);
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

interface BuildState {
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
  const pruningCandidates = donorDependencyPruningCandidates({
    context: state.context,
    donorRoot: applicationOwner(state.application),
    movedSources: selection.sources,
    dependencies,
  });
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
  const commitVars = {
    package: state.packageName,
    packageRoot: state.packageRoot,
    app: state.application.name,
    project: state.projectId,
    planId: profilePlanId(state.candidate.id, state.profile.name),
    fileCount: String(selection.sources.length + selection.assets.length),
  };
  const lockOperation = operations.find(
    (operation): operation is Extract<PlanOperation, { kind: "lockfile-importer" }> =>
      operation.kind === "lockfile-importer" && operation.packageRoot === state.packageRoot,
  );
  const currentLockHash = state.context.exists(state.packageManager.lockfileName)
    ? state.packageManager.lockfileImporterHash(state.context.text(state.packageManager.lockfileName), state.packageRoot)
    : undefined;
  const applicationLines = state.graph.paths
    .filter((path) => state.graph.nodes.get(path)?.application === state.candidate.application)
    .reduce((total, path) => total + (state.graph.nodes.get(path)?.lineCount ?? 0), 0);
  const movedLines = selection.production.reduce((total, path) => total + (state.graph.nodes.get(path)?.lineCount ?? 0), 0);
  const provenance = {
    ...buildPlanProvenance({
      config: state.config,
      profileGates: state.profile.gates,
      scaffoldTemplates: state.templates,
      packageManager: state.packageManager,
      taskRunner: state.taskRunner,
      ...(state.context.exists("package.json") ? { rootPackageJson: state.context.text("package.json") } : {}),
    }),
    ...(state.options.evacuationProvenance === undefined ? {} : { evacuation: state.options.evacuationProvenance }),
  };
  return {
    schemaVersion: PLAN_SCHEMA_VERSION,
    planId: profilePlanId(state.candidate.id, state.profile.name),
    createdAt: state.baseline.committedAt,
    generator: { ...GENERATOR },
    provenance,
    baselineCommit: state.baseline.commit,
    graphDigest: graphDigest(state.graph),
    application: state.candidate.application,
    ...(state.candidate.recommendation === undefined
      ? {}
      : {
          assessment: {
            status: state.candidate.recommendation.status,
            cohesion: state.candidate.recommendation.cohesion,
            reasons: state.candidate.recommendation.reasons,
            compatibilityShims: (state.candidate.compatibilityShims ?? []).map(
              ({ path, packageName, replacementSpecifier, productionConsumers, testConsumers }) => ({
                path,
                packageName,
                replacementSpecifier,
                productionConsumers,
                testConsumers,
              }),
            ),
            targetOptions: state.candidate.recommendation.targetOptions,
            selectedTarget: {
              packageName: state.packageName,
              packageRoot: state.packageRoot,
              action: state.graph.workspace.owners.includes(state.packageRoot) ? ("extend" as const) : ("create" as const),
            },
          },
        }),
    ...(state.options.modulePromotion === undefined ? {} : { modulePromotion: state.options.modulePromotion }),
    boundaryBaseline: boundaryBaselineOf({
      config: state.config,
      rootDir: state.options.rootDir,
      files: state.context.repositorySources(),
      referencesOf: (file) => state.context.moduleReferences(file),
    }),
    target: {
      packageName: state.packageName,
      packageRoot: state.packageRoot,
      entrypoint: state.templates.entrypoint,
      projectId: state.projectId,
      ...(state.targetSubpath === undefined ? {} : { targetSubpath: state.targetSubpath }),
      ...(state.profile.name === undefined ? {} : { profile: { name: state.profile.name, candidateName: state.candidateName } }),
      ...(state.options.publicSurface === undefined ? {} : { publicSurface: state.options.publicSurface }),
      requiredExports:
        selection.publicModules.length > 0
          ? []
          : dedupeExports(selection.production.flatMap((source) => sourceExportsFromFile(state.context.absolute(source), source))),
      ...(selection.publicModules.length > 0 ? { publicModules: selection.publicModules } : {}),
    },
    source: {
      files: selection.production,
      tests: selection.tests,
      ...(selection.assets.length > 0 ? { assets: selection.assets } : {}),
      sccs: productionSccs(state.candidate.sccs, selection.production),
    },
    dependencies,
    dependencyDecisions,
    projectedArtifacts: projectedArtifactEvidence(operations),
    ...(pruningCandidates.length === 0 ? {} : { donorDependencyPruning: { mode: state.config.dependencyPruning.mode, candidates: pruningCandidates } }),
    sourceBlobs,
    operations,
    ...(state.pathMigrationNoops.length === 0
      ? {}
      : { pathMigrationNoops: [...state.pathMigrationNoops].toSorted((left, right) => byCodeUnit(left.path, right.path)) }),
    consumers: consumers.map((consumer) => ({
      file: consumer.file,
      owner: consumer.package,
      expectedImporter: consumer.expectedImporter,
      specifiers: consumer.rewrites,
      external: state.graph.nodes.get(consumer.file)?.application !== state.candidate.application,
      dependencySection: sections.get(consumer.package) ?? "runtime",
    })),
    generatedFiles,
    ...(postJournalPreparers.length === 0 ? {} : { postJournalPreparers }),
    changedFiles: [
      ...new Set([
        ...operations.flatMap(operationPathsOf),
        ...generatedFiles.filter((generated) => generated.regenerateOnApply).map((generated) => generated.path),
        ...postJournalPreparers.flatMap((preparer) => preparer.outputs),
      ]),
    ].toSorted(),
    ...(lockOperation
      ? { lockfileImporter: { packageRoot: state.packageRoot, hash: hashText(lockOperation.block) } }
      : currentLockHash
        ? { lockfileImporter: { packageRoot: state.packageRoot, hash: currentLockHash } }
        : {}),
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
    metrics: {
      movedFiles: selection.sources.length + selection.assets.length,
      movedLines,
      applicationLinesBefore: applicationLines,
      applicationLinesAfter: Math.max(0, applicationLines - movedLines),
      consumers: consumers.length,
    },
    commits: {
      plan: { subject: renderTemplate(state.config.commitTemplates.plan, commitVars), ...trailer(state.config, commitVars) },
      move: { subject: renderTemplate(state.config.commitTemplates.move, commitVars), ...trailer(state.config, commitVars) },
      wiring: { subject: renderTemplate(state.config.commitTemplates.wiring, commitVars), ...trailer(state.config, commitVars) },
    },
    gates: renderGates(state.config, state.profile.gates, { ...commitVars, consumerOwners, taskRunner: state.taskRunner, rootDir: state.options.rootDir }),
  };
}

function productionSccs(
  candidateSccs: readonly { readonly id: string; readonly members: readonly string[] }[],
  production: readonly string[],
): Record<string, readonly string[]> {
  const selected = new Set(production);
  const result = new Map<string, readonly string[]>();
  for (const scc of candidateSccs) {
    const members = scc.members.filter((member) => selected.has(member));
    if (members.length > 0) result.set(scc.id, members);
  }
  for (const source of production) {
    if (![...result.values()].some((members) => members.includes(source))) result.set(sccId([source]), [source]);
  }
  return Object.fromEntries(result);
}

function generatorOwnedOutputs(config: MonocarveConfig, production: readonly string[], operations: readonly PlanOperation[]): ReadonlySet<string> {
  const documents = operations
    .filter((operation): operation is Extract<PlanOperation, { kind: "rewrite-path-reference" }> => operation.kind === "rewrite-path-reference")
    .map((operation) => operation.file);
  return new Set(triggeredPostJournalPreparers(config, [...production, ...documents]).flatMap((preparer) => preparer.outputs));
}

function postJournalRecordsFor(
  config: MonocarveConfig,
  context: WorkspaceContext,
  operations: readonly PlanOperation[],
  triggers: readonly string[],
): PostJournalPreparerRecord[] {
  const journalPaths = new Set(operations.flatMap(operationPathsOf));
  const generatedPaths = new Set(triggeredArtifacts(config, triggers).map((artifact) => artifact.path));
  const records = triggeredPostJournalPreparers(config, triggers).map((preparer): PostJournalPreparerRecord => {
    const replacements = preparer.replacements?.map((item) => ({
      path: item.path,
      before: item.before,
      after: item.after,
      ...(item.prefix === undefined ? {} : { prefix: item.prefix }),
      ...(item.suffix === undefined ? {} : { suffix: item.suffix }),
    }));
    const creates = preparer.creates?.map((item) => ({ ...item, mode: item.mode ?? 0o644 }));
    const declarativePaths = [...new Set([...(replacements?.map((item) => item.path) ?? []), ...(creates?.map((item) => item.path) ?? [])])];
    const collision = declarativePaths.find((path) => journalPaths.has(path));
    if (collision !== undefined)
      throw new PlanningError(`post-journal preparer ${preparer.id} declarative path collides with a journal operation: ${collision}`);
    const generatedCollision = declarativePaths.find((path) => generatedPaths.has(path));
    if (generatedCollision !== undefined)
      throw new PlanningError(`post-journal preparer ${preparer.id} declarative path collides with a generated artifact: ${generatedCollision}`);
    const emittedCollision = declarativePaths.find((path) => preparer.emittedModuleSpecifiers.some((item) => item.source === path));
    if (emittedCollision !== undefined)
      throw new PlanningError(`post-journal preparer ${preparer.id} declarative path collides with emitted module specifier rewriting: ${emittedCollision}`);
    const mutations = declarativePaths
      .map((path) => {
        const create = creates?.find((item) => item.path === path);
        if (create !== undefined)
          return {
            path,
            preconditionHash: "missing" as const,
            preconditionMode: "missing" as const,
            resultHash: hashText(create.contents),
            resultMode: create.mode,
          };
        if (!context.exists(path)) throw new PlanningError(`post-journal replacement path does not exist at baseline: ${path}`);
        const before = context.text(path);
        let after = before;
        const chain = replacements ?? [];
        for (const [index, replacement] of chain.entries())
          if (replacement.path === path) after = applyExactReplacement(after, replacement, chain, index, preparer.id);
        const mode = statSync(context.absolute(path)).mode & 0o111 ? 0o755 : 0o644;
        return { path, preconditionHash: hashText(before), preconditionMode: mode, resultHash: hashText(after), resultMode: mode };
      })
      .toSorted((left, right) => byCodeUnit(left.path, right.path));
    const outputs = [...new Set([...preparer.outputs, ...(creates?.map((item) => item.path) ?? [])])].toSorted(byCodeUnit);
    return {
      id: preparer.id,
      ...(preparer.command === undefined ? {} : { command: preparer.command }),
      outputs,
      ...(replacements === undefined ? {} : { replacements }),
      ...(creates === undefined ? {} : { creates }),
      mutations,
      emittedModuleSpecifiers: preparer.emittedModuleSpecifiers.map((item) => ({ ...item })),
      ...(preparer.verify === undefined ? {} : { verify: preparer.verify }),
    };
  });
  return records.sort((left, right) => byCodeUnit(left.id, right.id));
}

function applyExactReplacement(
  contents: string,
  replacement: { readonly path: string; readonly before: string; readonly after: string; readonly prefix?: string; readonly suffix?: string },
  all: readonly { readonly path: string; readonly before: string; readonly after: string; readonly prefix?: string; readonly suffix?: string }[],
  index: number,
  id: string,
): string {
  const framed = (text: string) => `${replacement.prefix ?? ""}${text}${replacement.suffix ?? ""}`;
  const before = framed(replacement.before);
  const first = contents.indexOf(before);
  if (first >= 0) {
    if (contents.indexOf(before, first + before.length) >= 0)
      throw new PlanningError(`post-journal preparer ${id} replacement ${index + 1} before text is ambiguous in ${replacement.path}`);
    return `${contents.slice(0, first)}${framed(replacement.after)}${contents.slice(first + before.length)}`;
  }
  let terminal = replacement.after;
  for (const candidate of all.slice(index + 1))
    if (
      candidate.path === replacement.path &&
      candidate.prefix === replacement.prefix &&
      candidate.suffix === replacement.suffix &&
      candidate.before === terminal
    )
      terminal = candidate.after;
  const states = [framed(replacement.after), framed(terminal)];
  if (
    states.some((state) => {
      const at = contents.indexOf(state);
      return at >= 0 && contents.indexOf(state, at + state.length) < 0;
    })
  )
    return contents;
  throw new PlanningError(`post-journal preparer ${id} replacement ${index + 1} matched neither before nor after text in ${replacement.path}`);
}
function dependencyDecisionsFor(
  state: BuildState,
  sources: readonly string[],
  dependencies: ReturnType<typeof dependenciesFor>,
  pruning: readonly { name: string }[],
) {
  const evidence = collectDependencyEvidence(state.context, state.graph, sources, state.packageName);
  const target = [
    ...Object.keys(dependencies.runtime).map((name) => ({ name, decision: "target-runtime" as const })),
    ...Object.keys(dependencies.dev).map((name) => ({ name, decision: "target-dev" as const })),
  ].map(({ name, decision }) => {
    const demand = [...(evidence.sources.get(name) ?? [])].toSorted(byCodeUnit);
    const reasons = [
      ...new Set(
        demand.map((source) =>
          !state.context.isProductionSource(source)
            ? ("test-import" as const)
            : decision === "target-dev"
              ? ("type-only-import" as const)
              : ("production-import" as const),
        ),
      ),
    ].toSorted(byCodeUnit);
    if (reasons.length === 0) reasons.push(decision === "target-dev" ? "type-only-import" : "production-import");
    return { name, decision, sources: demand, reasons };
  });
  const donorDecision = state.config.dependencyPruning.mode === "apply" ? ("donor-remove" as const) : ("donor-review" as const);
  return [
    ...target,
    ...pruning.map(({ name }) => ({ name, decision: donorDecision, sources: [] as string[], reasons: ["no-retained-consumer" as const] })),
  ].toSorted((left, right) => byCodeUnit(left.name, right.name) || byCodeUnit(left.decision, right.decision));
}
function sourceBlobsFor(context: WorkspaceContext, paths: readonly string[]): Record<string, Sha256> {
  const blobs: Record<string, Sha256> = {};
  for (const path of paths) {
    const state = context.state(path);
    if (state === "missing") throw new PlanningError(`selected source does not exist: ${path}`);
    blobs[path] = state;
  }
  return blobs;
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
    case "delete-file":
      return [operation.path];
    case "lockfile-importer":
      return [operation.lockfile];
    case "migrate-path-keys":
      return [operation.path];
  }
}
function donorTargetsOf(selection: ReturnType<typeof selectExtractionSources>): Map<string, string> {
  const map = new Map<string, string>();
  selection.sources.forEach((source, index) => map.set(source, selection.targets[index]!));
  selection.assets.forEach((asset, index) => map.set(asset, selection.assetTargets[index]!));
  return map;
}
function dedupeExports(entries: readonly ExportSurface[]): ExportSurface[] {
  const seen = new Set<string>();
  return entries
    .filter((entry) => {
      if (seen.has(entry.name)) return false;
      seen.add(entry.name);
      return true;
    })
    .toSorted((left, right) => byCodeUnit(left.name, right.name));
}
function trailer(config: MonocarveConfig, vars: Record<string, string>): { body?: string } {
  return config.commitTemplates.trailer ? { body: renderTemplate(config.commitTemplates.trailer, vars) } : {};
}
function profileCandidateName(config: MonocarveConfig, suggested: string): string {
  return config.packageScope !== "" && suggested.startsWith(config.packageScope) ? suggested.slice(config.packageScope.length) : suggested;
}
function profilePlanId(candidateId: string, profile: string | undefined): string {
  return profile === undefined ? candidateId : `${candidateId}--${profile}`;
}
export { derivePackageRoot, donorOwner } from "./build-support.ts";
export { generatedFilesFor, graphDigest, moveOperation, pathMigrationOperations, renderGates } from "./build-support.ts";
export function serializeManifest(manifest: ExtractionManifest): string {
  return `${stableStringify(manifest, 2)}\n`;
}
export function parseManifest(text: string, source = "<inline>"): ExtractionManifest {
  try {
    return JSON.parse(text) as ExtractionManifest;
  } catch (error) {
    throw new PlanningError(`could not parse manifest ${source}: ${(error as Error).message}`);
  }
}
