import { applyEscapeRewrites } from "../codemod/imports.ts";
import { applicationOwner, getApplication, triggeredArtifacts, triggeredPathMigrations, type MonocarveConfig } from "../config.ts";
import type { DependencyGraph } from "../graph/model.ts";
import { generatedProvenance } from "../graph/workspace.ts";
import { resolveCommit, type ResolvedCommit } from "../util/git.ts";
import { byCodeUnit, hashJson, hashText, type Sha256 } from "../util/hash.ts";
import { renderTemplate } from "../util/template.ts";
import { readUtf8Artifact, runPathMigrationCommand } from "../transaction/path-migrations.ts";
import { PlanningError, WorkspaceContext } from "./context.ts";
import type { BuildPlanOptions } from "./build.ts";
import type { EscapeRewrite, ExtractionManifest, GeneratedFileRecord, MigratePathKeysOperation, PathMove, PlanOperation } from "./manifest.ts";

export function baselineOf(options: BuildPlanOptions): ResolvedCommit {
  try { return resolveCommit(options.rootDir, options.baselineCommit); }
  catch (error) {
    throw new PlanningError(
      `cannot compile a plan against ${JSON.stringify(options.baselineCommit)}: a plan records the commit its blobs came from, so the revision has to exist — ${(error as Error).message}`,
    );
  }
}

export function moveOperation(context: WorkspaceContext, source: string, target: string, rewrites: readonly EscapeRewrite[]): PlanOperation {
  const preconditionHash = context.state(source);
  if (preconditionHash === "missing") throw new PlanningError(`cannot move a file that does not exist: ${source}`);
  if (rewrites.length === 0) return { kind: "move", source, target, preconditionHash, resultHash: preconditionHash };
  const rewritten = applyEscapeRewrites(
    context.text(source), context.absolute(source), rewrites, context.rootDir, context.config.moduleSpecifierCalls, context.config.assetExtensions, context.config.cssImportExtensions,
  );
  return { kind: "move-with-rewrite", source, target, rewrites: [...rewrites], preconditionHash, resultHash: hashText(rewritten) };
}

export function generatedFilesFor(config: MonocarveConfig, context: WorkspaceContext, production: readonly string[], targets: readonly string[]): GeneratedFileRecord[] {
  const declared = production.flatMap((source, index): GeneratedFileRecord[] => {
    const provenance = generatedProvenance(config, context.rootDir, source);
    if (provenance === null) return [];
    if (provenance.source === null || provenance.regenerate === null) throw new PlanningError(`generated source declares no provenance to carry: ${source}`);
    const state = context.state(source);
    return [{ path: targets[index]!, source: provenance.source, regenerate: provenance.regenerate, ...(state === "missing" ? {} : { expectedHash: state }) }];
  });
  const triggered = triggeredArtifacts(config, production).map((artifact): GeneratedFileRecord => ({
    path: artifact.path, source: artifact.source, regenerate: artifact.regenerate, regenerateOnApply: true,
    exemptReason: artifact.exemptReason ?? "declared generated artifact: this extraction changes its inputs, so its post-move content is not knowable at plan time",
  }));
  const postJournal = config.postJournalPreparers.filter((preparer) =>
    preparer.triggers.length === 0 || production.some((path) => preparer.triggers.some((pattern) => new RegExp(pattern).test(path))),
  ).flatMap((preparer) => preparer.outputs.map((path): GeneratedFileRecord => ({
    path, source: targets[0] ?? path, regenerate: preparer.command, regenerateOnApply: true,
    exemptReason: "declared post-journal preparer output: result is proven by simulation and immediate audit",
    preparerId: preparer.id, ...(preparer.verify === undefined ? {} : { verify: preparer.verify }),
  })));
  return [...declared, ...triggered, ...postJournal].sort((left, right) => byCodeUnit(left.path, right.path));
}

export function pathMigrationOperations(config: MonocarveConfig, context: WorkspaceContext, operations: readonly PlanOperation[]): MigratePathKeysOperation[] {
  const moves: PathMove[] = operations.filter((operation) => operation.kind === "move" || operation.kind === "move-with-rewrite")
    .map((operation) => ({ source: operation.source, target: operation.target }))
    .sort((left, right) => byCodeUnit(left.source, right.source) || byCodeUnit(left.target, right.target));
  return triggeredPathMigrations(config, moves.map((move) => move.source)).map((artifact): MigratePathKeysOperation => {
    const preconditionHash = context.state(artifact.path);
    if (preconditionHash === "missing") throw new PlanningError(`path-keyed artifact does not exist: ${artifact.path}`);
    const contents = readUtf8Artifact(context.absolute(artifact.path), artifact.path);
    const shape = { path: artifact.path, command: artifact.command, moves };
    const resultHash = hashText(runPathMigrationCommand(context.rootDir, shape, contents, config.pathMigrations.timeoutMs));
    if (resultHash === preconditionHash) throw new PlanningError(`path migration for ${artifact.path} did not change the artifact`);
    return { kind: "migrate-path-keys", ...shape, preconditionHash, resultHash };
  }).sort((left, right) => byCodeUnit(left.path, right.path));
}

export function graphDigest(graph: DependencyGraph): Sha256 {
  return hashJson({
    nodes: graph.paths,
    edges: graph.edges.map((edge) => [edge.from, edge.to, edge.specifier, edge.kind]),
    unresolved: graph.unresolved.map((entry) => [entry.source, entry.specifier]),
    testKinds: [...graph.testKinds.entries()].sort(([left], [right]) => byCodeUnit(left, right)),
    testImporters: [...graph.testImporters.entries()].map(([target, importers]) => ({ target, importers: [...importers].sort(byCodeUnit) })).sort((left, right) => byCodeUnit(left.target, right.target)),
  });
}

interface GateVars extends Record<string, unknown> {
  readonly package: string; readonly packageRoot: string; readonly app: string; readonly project: string;
  readonly consumerOwners: readonly string[]; readonly taskRunner: { projectIdOf(rootDir: string, packageRoot: string): string }; readonly rootDir: string;
}
export function renderGates(config: MonocarveConfig, gates: MonocarveConfig["gates"], vars: GateVars): ExtractionManifest["gates"] {
  const base = { package: vars.package, packageRoot: vars.packageRoot, app: vars.app, owner: applicationOwner(getApplication(config, vars.app)), project: vars.project };
  const project = vars.consumerOwners.flatMap((owner) => gates.project.map((template) => renderTemplate(template, {
    ...base, app: applicationNameForOwner(config, owner), owner, project: vars.taskRunner.projectIdOf(vars.rootDir, owner),
  })));
  return { package: gates.package.map((template) => renderTemplate(template, base)), project: [...new Set(project)], workspace: gates.workspace.map((template) => renderTemplate(template, base)) };
}
function applicationNameForOwner(config: MonocarveConfig, owner: string): string {
  return config.applications.find((app) => applicationOwner(app) === owner)?.name ?? owner;
}
export function derivePackageRoot(config: MonocarveConfig, graph: DependencyGraph, packageName: string): string {
  const existing = graph.workspace.packageNames.get(packageName);
  if (existing) return existing;
  const bare = config.packageScope && packageName.startsWith(config.packageScope) ? packageName.slice(config.packageScope.length) : packageName;
  return `${config.packageRoots[0]}/${bare}`;
}
export function donorOwner(config: MonocarveConfig, application: string): string { return applicationOwner(getApplication(config, application)); }
