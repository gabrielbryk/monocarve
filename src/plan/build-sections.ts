/** Manifest sections the plan compiler assembles once the journal is final. */
import { type MonocarveConfig } from "../config.ts";
import { sccId } from "../graph/components.ts";
import { byCodeUnit, hashText, type Sha256 } from "../util/hash.ts";
import { renderTemplate } from "../util/template.ts";
import { boundaryBaselineOf } from "./boundary-baseline.ts";
import type { selectExtractionSources } from "./build-phases.ts";
import type { BuildState } from "./build.ts";
import type { Consumer } from "./consumers.ts";
import { PlanningError, type WorkspaceContext } from "./context.ts";
import type { inferDependencies } from "./dependencies.ts";
import { collectDependencyEvidence } from "./dependency-evidence.ts";
import type { ExtractionManifest, PlanOperation, PostJournalPreparerRecord } from "./manifest.ts";
import { operationPathsOf } from "./post-journal-records.ts";
import { buildPlanProvenance } from "./provenance.ts";
import { sourceExportsFromFile, type ExportSurface } from "./public-surface.ts";

type Selection = ReturnType<typeof selectExtractionSources>;

export function profilePlanId(candidateId: string, profile: string | undefined): string {
  return profile === undefined ? candidateId : `${candidateId}--${profile}`;
}

export function commitVarsFor(state: BuildState, selection: Selection): Record<string, string> & GateCommitVars {
  return {
    package: state.packageName,
    packageRoot: state.packageRoot,
    app: state.application.name,
    project: state.projectId,
    planId: profilePlanId(state.candidate.id, state.profile.name),
    fileCount: String(selection.sources.length + selection.assets.length),
  };
}

interface GateCommitVars {
  readonly package: string;
  readonly packageRoot: string;
  readonly app: string;
  readonly project: string;
}

export function boundaryBaselineSection(state: BuildState): ReturnType<typeof boundaryBaselineOf> {
  return boundaryBaselineOf({
    config: state.config,
    rootDir: state.options.rootDir,
    files: state.context.repositorySources(),
    referencesOf: (file) => state.context.moduleReferences(file),
  });
}

export function pathMigrationNoopsSection(state: BuildState): Pick<ExtractionManifest, "pathMigrationNoops"> {
  if (state.pathMigrationNoops.length === 0) return {};
  return { pathMigrationNoops: [...state.pathMigrationNoops].toSorted((left, right) => byCodeUnit(left.path, right.path)) };
}

export function consumerRecords(
  state: BuildState,
  consumers: readonly Consumer[],
  sections: ReadonlyMap<string, ExtractionManifest["consumers"][number]["dependencySection"]>,
): ExtractionManifest["consumers"] {
  return consumers.map((consumer) => ({
    file: consumer.file,
    owner: consumer.package,
    expectedImporter: consumer.expectedImporter,
    specifiers: consumer.rewrites,
    external: state.graph.nodes.get(consumer.file)?.application !== state.candidate.application,
    dependencySection: sections.get(consumer.package) ?? "runtime",
  }));
}

export function changedFilesFor(
  operations: readonly PlanOperation[],
  generatedFiles: ExtractionManifest["generatedFiles"],
  postJournalPreparers: readonly PostJournalPreparerRecord[],
): string[] {
  return [
    ...new Set([
      ...operations.flatMap(operationPathsOf),
      ...generatedFiles.filter((generated) => generated.regenerateOnApply).map((generated) => generated.path),
      ...postJournalPreparers.flatMap((preparer) => preparer.outputs),
    ]),
  ].toSorted();
}

export function provenanceSection(state: BuildState): NonNullable<ExtractionManifest["provenance"]> {
  return {
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
}

export function assessmentSection(state: BuildState): Pick<ExtractionManifest, "assessment"> {
  const recommendation = state.candidate.recommendation;
  if (recommendation === undefined) return {};
  return {
    assessment: {
      status: recommendation.status,
      cohesion: recommendation.cohesion,
      reasons: recommendation.reasons,
      compatibilityShims: (state.candidate.compatibilityShims ?? []).map(({ path, packageName, replacementSpecifier, productionConsumers, testConsumers }) => ({
        path,
        packageName,
        replacementSpecifier,
        productionConsumers,
        testConsumers,
      })),
      targetOptions: recommendation.targetOptions,
      selectedTarget: {
        packageName: state.packageName,
        packageRoot: state.packageRoot,
        action: state.graph.workspace.owners.includes(state.packageRoot) ? ("extend" as const) : ("create" as const),
      },
    },
  };
}

export function targetSection(state: BuildState, selection: Selection): ExtractionManifest["target"] {
  return {
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
  };
}

export function sourceSection(state: BuildState, selection: Selection): ExtractionManifest["source"] {
  return {
    files: selection.production,
    tests: selection.tests,
    ...(selection.assets.length > 0 ? { assets: selection.assets } : {}),
    sccs: productionSccs(state.candidate.sccs, selection.production),
  };
}

/**
 * The lockfile importer hash the plan pins: the compiled importer block when the
 * journal writes one for the target, otherwise the baseline importer's hash.
 * Both are computed eagerly, in that order, as the compiler always has.
 */
export function lockfileImporterSection(state: BuildState, operations: readonly PlanOperation[]): Pick<ExtractionManifest, "lockfileImporter"> {
  const lockOperation = operations.find(
    (operation): operation is Extract<PlanOperation, { kind: "lockfile-importer" }> =>
      operation.kind === "lockfile-importer" && operation.packageRoot === state.packageRoot,
  );
  const currentLockHash = state.context.exists(state.packageManager.lockfileName)
    ? state.packageManager.lockfileImporterHash(state.context.text(state.packageManager.lockfileName), state.packageRoot)
    : undefined;
  if (lockOperation) return { lockfileImporter: { packageRoot: state.packageRoot, hash: hashText(lockOperation.block) } };
  return currentLockHash ? { lockfileImporter: { packageRoot: state.packageRoot, hash: currentLockHash } } : {};
}

export function metricsSection(state: BuildState, selection: Selection, consumers: number): ExtractionManifest["metrics"] {
  const lineCountOf = (path: string): number => state.graph.nodes.get(path)?.lineCount ?? 0;
  const applicationLines = state.graph.paths
    .filter((path) => state.graph.nodes.get(path)?.application === state.candidate.application)
    .reduce((total, path) => total + lineCountOf(path), 0);
  const movedLines = selection.production.reduce((total, path) => total + lineCountOf(path), 0);
  return {
    movedFiles: selection.sources.length + selection.assets.length,
    movedLines,
    applicationLinesBefore: applicationLines,
    applicationLinesAfter: Math.max(0, applicationLines - movedLines),
    consumers,
  };
}

export function commitsSection(config: MonocarveConfig, vars: Record<string, string>): ExtractionManifest["commits"] {
  return {
    plan: { subject: renderTemplate(config.commitTemplates.plan, vars), ...trailer(config, vars) },
    move: { subject: renderTemplate(config.commitTemplates.move, vars), ...trailer(config, vars) },
    wiring: { subject: renderTemplate(config.commitTemplates.wiring, vars), ...trailer(config, vars) },
  };
}

export function dependencyDecisionsFor(
  state: BuildState,
  sources: readonly string[],
  dependencies: ReturnType<typeof inferDependencies>,
  pruning: readonly { name: string }[],
) {
  const evidence = collectDependencyEvidence(state.context, state.graph, sources, state.packageName);
  const target = [
    ...Object.keys(dependencies.runtime).map((name) => ({ name, decision: "target-runtime" as const })),
    ...Object.keys(dependencies.dev).map((name) => ({ name, decision: "target-dev" as const })),
  ].map(({ name, decision }) => {
    const demand = [...(evidence.sources.get(name) ?? [])].toSorted(byCodeUnit);
    const reasons = [...new Set(demand.map((source) => demandReason(state.context, source, decision)))].toSorted(byCodeUnit);
    if (reasons.length === 0) reasons.push(decision === "target-dev" ? "type-only-import" : "production-import");
    return { name, decision, sources: demand, reasons };
  });
  const donorDecision = state.config.dependencyPruning.mode === "apply" ? ("donor-remove" as const) : ("donor-review" as const);
  return [
    ...target,
    ...pruning.map(({ name }) => ({ name, decision: donorDecision, sources: [] as string[], reasons: ["no-retained-consumer" as const] })),
  ].toSorted((left, right) => byCodeUnit(left.name, right.name) || byCodeUnit(left.decision, right.decision));
}

function demandReason(
  context: WorkspaceContext,
  source: string,
  decision: "target-runtime" | "target-dev",
): "test-import" | "type-only-import" | "production-import" {
  if (!context.isProductionSource(source)) return "test-import";
  return decision === "target-dev" ? "type-only-import" : "production-import";
}

export function sourceBlobsFor(context: WorkspaceContext, paths: readonly string[]): Record<string, Sha256> {
  const blobs: Record<string, Sha256> = {};
  for (const path of paths) {
    const state = context.state(path);
    if (state === "missing") throw new PlanningError(`selected source does not exist: ${path}`);
    blobs[path] = state;
  }
  return blobs;
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
