/** Deterministic compilation of one eligible portfolio candidate. */
import { createPackageManagerAdapter, createTaskRunnerAdapter } from "../adapters/registry.ts";
import { GENERATOR } from "../branding.ts";
import { applicationOwner, getApplication, packageNameMatcher, renderExtractionProfile, resolveExtractionProfile, type MonocarveConfig } from "../config.ts";
import type { DependencyGraph } from "../graph/model.ts";
import type { PortfolioCandidate } from "../portfolio/types.ts";
import { byCodeUnit, hashText, stableStringify, type Sha256 } from "../util/hash.ts";
import { renderTemplate } from "../util/template.ts";
import { consumerDependencyOwners } from "./consumers.ts";
import { PlanningError, WorkspaceContext } from "./context.ts";
import { inferDependencies } from "./dependencies.ts";
import { collectDependencyEvidence } from "./dependency-evidence.ts";
import { composeDonorDependencyPruning, donorDependencyPruningCandidates } from "./donor-pruning.ts";
import { consumerWiringOperations, packageOperations, projectedLockfile } from "./scaffold.ts";
import { PLAN_SCHEMA_VERSION, type EscapeRewrite, type ExtractionManifest, type PlanOperation } from "./manifest.ts";
import { sourceExportsFromFile, type ExportSurface } from "./public-surface.ts";
import { appendConsumerOperations, appendStaticFsReferenceOperations, consumerApplications, escapeRewritesFor, evaluationEffectsFor, selectExtractionSources } from "./build-phases.ts";
import { assertCompiledOperationInvariants, projectedArtifactEvidence } from "./projected-workspace.ts";
import { baselineOf, derivePackageRoot, generatedFilesFor, graphDigest, moveOperation, pathMigrationOperations, renderGates } from "./build-support.ts";

export interface BuildPlanOptions {
  readonly config: MonocarveConfig; readonly rootDir: string; readonly graph: DependencyGraph; readonly candidate: PortfolioCandidate;
  readonly baselineCommit: string; readonly packageName?: string; readonly packageRoot?: string; readonly profile?: string; readonly context?: WorkspaceContext;
}
export async function buildPlan(options: BuildPlanOptions): Promise<ExtractionManifest> { return buildPlanSync(options); }

export function buildPlanSync(options: BuildPlanOptions): ExtractionManifest {
  const state = prepareBuild(options);
  const selection = selectExtractionSources({ context: state.context, candidate: state.candidate, packageRoot: state.packageRoot, entrypoint: state.templates.entrypoint, packageName: state.packageName, publicSurface: state.templates.publicSurface });
  assertAssetImportersReachable(state.graph, selection.production, selection.assets);
  const rewrites = escapeRewritesFor(state.candidate);
  const operations = buildJournal(state, selection, rewrites);
  return buildManifest(state, selection, rewrites, operations);
}

interface BuildState {
  readonly options: BuildPlanOptions; readonly config: MonocarveConfig; readonly graph: DependencyGraph; readonly candidate: PortfolioCandidate;
  readonly baseline: ReturnType<typeof baselineOf>; readonly context: WorkspaceContext; readonly application: ReturnType<typeof getApplication>;
  readonly packageManager: ReturnType<typeof createPackageManagerAdapter>; readonly taskRunner: ReturnType<typeof createTaskRunnerAdapter>;
  readonly profile: ReturnType<typeof resolveExtractionProfile>; readonly templates: MonocarveConfig["scaffoldTemplates"];
  readonly candidateName: string; readonly packageName: string; readonly packageRoot: string; readonly projectId: string;
}
function prepareBuild(options: BuildPlanOptions): BuildState {
  const { config, graph, candidate } = options;
  const context = options.context ?? new WorkspaceContext(config, options.rootDir);
  const application = getApplication(config, candidate.application);
  const profile = resolveExtractionProfile(config, application, options.profile);
  if (profile.kind !== "library") throw new PlanningError(`production extraction requires a library profile; ${profile.name ?? "legacy"} is ${profile.kind}`);
  if (profile.name !== undefined && (options.packageName !== undefined || options.packageRoot !== undefined)) throw new PlanningError("--package-name and --package-root cannot override a selected extraction profile");
  const candidateName = profileCandidateName(config, candidate.suggestedPackageName);
  const rendered = renderExtractionProfile(config, application, profile, candidateName);
  const packageName = profile.name === undefined ? (options.packageName ?? candidate.suggestedPackageName) : rendered.packageName;
  if (!packageNameMatcher(config).test(packageName)) throw new PlanningError(`package name ${JSON.stringify(packageName)} does not match the configured pattern`);
  const packageRoot = profile.name === undefined ? (options.packageRoot ?? derivePackageRoot(config, graph, packageName)) : rendered.packageRoot;
  const taskRunner = createTaskRunnerAdapter(config);
  return { options, config, graph, candidate, baseline: baselineOf(options), context, application, packageManager: createPackageManagerAdapter(config), taskRunner, profile, templates: profile.scaffoldTemplates, candidateName, packageName, packageRoot, projectId: rendered.projectId ?? taskRunner.projectIdFor(packageName, packageRoot) };
}

function buildJournal(state: BuildState, selection: ReturnType<typeof selectExtractionSources>, rewrites: ReadonlyMap<string, readonly EscapeRewrite[]>): PlanOperation[] {
  const operations = selection.sources.map((source, index) => moveOperation(state.context, source, selection.targets[index]!, rewrites.get(source) ?? []));
  operations.push(...selection.assets.map((asset, index) => moveOperation(state.context, asset, selection.assetTargets[index]!, [])));
  const { consumers } = appendConsumerOperations({ context: state.context, sources: [...selection.sources, ...selection.assets], packageName: state.packageName, publicSpecifierFor: selection.publicSpecifierFor, operations });
  appendStaticFsReferenceOperations({ context: state.context, donorTargets: donorTargetsOf(selection), operations });
  const dependencies = dependenciesFor(state, selection.sources, rewrites);
  const input = { context: state.context, config: state.config, application: state.application, packageManager: state.packageManager, taskRunner: state.taskRunner, packageName: state.packageName, packageRoot: state.packageRoot, projectId: state.projectId, templates: state.templates, production: selection.production, tests: selection.tests, assets: selection.assets, dependencies, publicModules: selection.publicModules };
  const packageWiring = packageOperations(input);
  operations.push(...packageWiring, ...consumerWiringOperations({ ...input, consumerOwners: consumerDependencyOwners(consumers), lockfileText: projectedLockfile(state.context, state.packageManager, packageWiring) }));
  if (state.config.dependencyPruning.mode === "apply") {
    const composed = composeDonorDependencyPruning({
      context: state.context, donorRoot: applicationOwner(state.application),
      movedSources: selection.sources, dependencies, packageManager: state.packageManager, operations,
    });
    operations.splice(0, operations.length, ...composed);
  }
  operations.push(...pathMigrationOperations(state.config, state.context, operations));
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
    const retainedAssetImporters = importedAssets.flatMap((asset) => graph.incoming.get(asset) ?? [])
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
  for (const entries of rewrites.values()) for (const rewrite of entries) {
    const owner = state.graph.workspace.packageNames.get(rewrite.packageSpecifier);
    if (!owner) throw new PlanningError(`rewrite target is not a workspace package: ${rewrite.packageSpecifier}`);
    if (!dependencies.dev[rewrite.packageSpecifier]) dependencies.runtime[rewrite.packageSpecifier] = "workspace:*";
    if (!dependencies.packageReferences.includes(owner)) dependencies.packageReferences = [...dependencies.packageReferences, owner].sort();
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

function buildManifest(state: BuildState, selection: ReturnType<typeof selectExtractionSources>, rewrites: ReadonlyMap<string, readonly EscapeRewrite[]>, operations: PlanOperation[]): ExtractionManifest {
  const consumerSources = [...selection.sources, ...selection.assets];
  const consumers = appendConsumerOperations({ context: state.context, sources: consumerSources, packageName: state.packageName, publicSpecifierFor: selection.publicSpecifierFor, operations: [] }).consumers;
  const dynamicImportDelta = appendConsumerOperations({ context: state.context, sources: consumerSources, packageName: state.packageName, publicSpecifierFor: selection.publicSpecifierFor, operations: [] }).dynamicImportDelta;
  const dependencies = dependenciesFor(state, selection.sources, rewrites);
  const pruningCandidates = donorDependencyPruningCandidates({ context: state.context, donorRoot: applicationOwner(state.application), movedSources: selection.sources, dependencies });
  const dependencyDecisions = dependencyDecisionsFor(state, selection.sources, dependencies, pruningCandidates);
  const packageWiringStart = operations.findIndex((operation) => operation.kind === "write-file");
  const packageWiring = packageWiringStart < 0 ? [] : operations.slice(packageWiringStart);
  const generatedFiles = generatedFilesFor(state.config, state.context, selection.production, selection.targets);
  const sourceBlobs = sourceBlobsFor(state.context, [...selection.sources, ...selection.assets]);
  const consumerOwners = consumerApplications(state.context, consumers);
  const sections = new Map(consumerDependencyOwners(consumers).map((entry) => [entry.owner, entry.dependencySection]));
  const commitVars = { package: state.packageName, packageRoot: state.packageRoot, app: state.application.name, project: state.projectId, planId: profilePlanId(state.candidate.id, state.profile.name), fileCount: String(selection.sources.length + selection.assets.length) };
  const lockOperation = operations.find((operation): operation is Extract<PlanOperation, { kind: "lockfile-importer" }> => operation.kind === "lockfile-importer" && operation.packageRoot === state.packageRoot);
  const currentLockHash = state.context.exists(state.packageManager.lockfileName) ? state.packageManager.lockfileImporterHash(state.context.text(state.packageManager.lockfileName), state.packageRoot) : undefined;
  const applicationLines = state.graph.paths.filter((path) => state.graph.nodes.get(path)?.application === state.candidate.application).reduce((total, path) => total + (state.graph.nodes.get(path)?.lineCount ?? 0), 0);
  const movedLines = selection.production.reduce((total, path) => total + (state.graph.nodes.get(path)?.lineCount ?? 0), 0);
  return { schemaVersion: PLAN_SCHEMA_VERSION, planId: profilePlanId(state.candidate.id, state.profile.name), createdAt: state.baseline.committedAt, generator: { ...GENERATOR }, baselineCommit: state.baseline.commit, graphDigest: graphDigest(state.graph), application: state.candidate.application,
    target: { packageName: state.packageName, packageRoot: state.packageRoot, entrypoint: state.templates.entrypoint, projectId: state.projectId, ...(state.profile.name === undefined ? {} : { profile: { name: state.profile.name, candidateName: state.candidateName } }), requiredExports: selection.publicModules.length > 0 ? [] : dedupeExports(selection.production.flatMap((source) => sourceExportsFromFile(state.context.absolute(source), source))), ...(selection.publicModules.length > 0 ? { publicModules: selection.publicModules } : {}) },
    source: { files: selection.production, tests: selection.tests, ...(selection.assets.length > 0 ? { assets: selection.assets } : {}), sccs: Object.fromEntries(state.candidate.sccs.filter((scc) => scc.members.some((member) => selection.production.includes(member))).map((scc) => [scc.id, scc.members.filter((member) => selection.production.includes(member))])) }, dependencies, dependencyDecisions, projectedArtifacts: projectedArtifactEvidence(operations), ...(pruningCandidates.length === 0 ? {} : { donorDependencyPruning: { mode: state.config.dependencyPruning.mode, candidates: pruningCandidates } }), sourceBlobs, operations,
    consumers: consumers.map((consumer) => ({ file: consumer.file, owner: consumer.package, expectedImporter: consumer.expectedImporter, specifiers: consumer.rewrites, external: state.graph.nodes.get(consumer.file)?.application !== state.candidate.application, dependencySection: sections.get(consumer.package) ?? "runtime" })), generatedFiles,
    changedFiles: [...new Set([...operations.flatMap(operationPathsOf), ...generatedFiles.filter((generated) => generated.regenerateOnApply).map((generated) => generated.path)])].sort(), ...(lockOperation ? { lockfileImporter: { packageRoot: state.packageRoot, hash: hashText(lockOperation.block) } } : currentLockHash ? { lockfileImporter: { packageRoot: state.packageRoot, hash: currentLockHash } } : {}),
    expectedDynamicImportDelta: { added: dynamicImportDelta.added.sort(byCodeUnit), removed: dynamicImportDelta.removed.sort(byCodeUnit) }, evaluationEffects: evaluationEffectsFor({ config: state.config, context: state.context, graph: state.graph, production: selection.production, targets: selection.targets, rewrites, packageWiring, entrypointPath: selection.entrypointPath }), metrics: { movedFiles: selection.sources.length + selection.assets.length, movedLines, applicationLinesBefore: applicationLines, applicationLinesAfter: Math.max(0, applicationLines - movedLines), consumers: consumers.length }, commits: { plan: { subject: renderTemplate(state.config.commitTemplates.plan, commitVars), ...trailer(state.config, commitVars) }, move: { subject: renderTemplate(state.config.commitTemplates.move, commitVars), ...trailer(state.config, commitVars) }, wiring: { subject: renderTemplate(state.config.commitTemplates.wiring, commitVars), ...trailer(state.config, commitVars) } }, gates: renderGates(state.config, state.profile.gates, { ...commitVars, consumerOwners, taskRunner: state.taskRunner, rootDir: state.options.rootDir }) };
}
function dependencyDecisionsFor(state: BuildState, sources: readonly string[], dependencies: ReturnType<typeof dependenciesFor>, pruning: readonly { name: string }[]) {
  const evidence = collectDependencyEvidence(state.context, state.graph, sources, state.packageName);
  const target = [...Object.keys(dependencies.runtime).map((name) => ({ name, decision: "target-runtime" as const })), ...Object.keys(dependencies.dev).map((name) => ({ name, decision: "target-dev" as const }))]
    .map(({ name, decision }) => {
      const demand = [...(evidence.sources.get(name) ?? [])].sort(byCodeUnit);
      const reasons = [...new Set(demand.map((source) => !state.context.isProductionSource(source) ? "test-import" as const : decision === "target-dev" ? "type-only-import" as const : "production-import" as const))].sort(byCodeUnit);
      if (reasons.length === 0) reasons.push(decision === "target-dev" ? "type-only-import" : "production-import");
      return { name, decision, sources: demand, reasons };
    });
  const donorDecision = state.config.dependencyPruning.mode === "apply" ? "donor-remove" as const : "donor-review" as const;
  return [...target, ...pruning.map(({ name }) => ({ name, decision: donorDecision, sources: [] as string[], reasons: ["no-retained-consumer" as const] }))]
    .sort((left, right) => byCodeUnit(left.name, right.name) || byCodeUnit(left.decision, right.decision));
}
function sourceBlobsFor(context: WorkspaceContext, paths: readonly string[]): Record<string, Sha256> { const blobs: Record<string, Sha256> = {}; for (const path of paths) { const state = context.state(path); if (state === "missing") throw new PlanningError(`selected source does not exist: ${path}`); blobs[path] = state; } return blobs; }
function operationPathsOf(operation: PlanOperation): string[] { switch (operation.kind) { case "move": case "move-with-rewrite": return [operation.source, operation.target]; case "rewrite-import": case "rewrite-fs-reference": return [operation.file]; case "write-file": return [operation.path]; case "lockfile-importer": return [operation.lockfile]; case "migrate-path-keys": return [operation.path]; } }
function donorTargetsOf(selection: ReturnType<typeof selectExtractionSources>): Map<string, string> {
  const map = new Map<string, string>();
  selection.sources.forEach((source, index) => map.set(source, selection.targets[index]!));
  selection.assets.forEach((asset, index) => map.set(asset, selection.assetTargets[index]!));
  return map;
}
function dedupeExports(entries: readonly ExportSurface[]): ExportSurface[] { const seen = new Set<string>(); return entries.filter((entry) => { if (seen.has(entry.name)) return false; seen.add(entry.name); return true; }).sort((left, right) => byCodeUnit(left.name, right.name)); }
function trailer(config: MonocarveConfig, vars: Record<string, string>): { body?: string } { return config.commitTemplates.trailer ? { body: renderTemplate(config.commitTemplates.trailer, vars) } : {}; }
function profileCandidateName(config: MonocarveConfig, suggested: string): string { return config.packageScope !== "" && suggested.startsWith(config.packageScope) ? suggested.slice(config.packageScope.length) : suggested; }
function profilePlanId(candidateId: string, profile: string | undefined): string { return profile === undefined ? candidateId : `${candidateId}--${profile}`; }
export { derivePackageRoot, donorOwner } from "./build-support.ts";
export { generatedFilesFor, graphDigest, moveOperation, pathMigrationOperations, renderGates } from "./build-support.ts";
export function serializeManifest(manifest: ExtractionManifest): string { return `${stableStringify(manifest, 2)}\n`; }
export function parseManifest(text: string, source = "<inline>"): ExtractionManifest { try { return JSON.parse(text) as ExtractionManifest; } catch (error) { throw new PlanningError(`could not parse manifest ${source}: ${(error as Error).message}`); } }
