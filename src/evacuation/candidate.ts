import { applicationFor, ownerFor, type MonocarveConfig } from "../config.ts";
import { buildApplicationGraph, sccId } from "../graph/components.ts";
import { isCompositionRoot } from "../graph/layers.ts";
import type { DependencyGraph, Scc } from "../graph/model.ts";
import { byCodeUnit, hashText } from "../util/hash.ts";
import type { ConsumerRef } from "../portfolio/types.ts";
import { EvacuationSelectorError } from "./selectors.ts";

/** One deterministic, provenance-preserving union of requested dependency closures. */
export interface EvacuationCandidate {
  readonly id: string;
  readonly application: string;
  /** Production graph paths explicitly selected by the operator. */
  readonly requested: readonly string[];
  /** Whole SCCs intersecting `requested`, including retained composition SCCs. */
  readonly seedSccs: readonly Scc[];
  /** Unselected production files absorbed solely to preserve a selected SCC. */
  readonly absorbedSccPeers: readonly string[];
  /** Direct application dependencies outside the bounded evacuation. */
  readonly unselectedDependencies: readonly string[];
  /** Production files that move, partitioned without splitting SCCs. */
  readonly files: readonly string[];
  readonly sccs: readonly Scc[];
  /** Whole composition-root SCCs excluded from `files`. */
  readonly retainedComposition: readonly Scc[];
  /** Existing workspace packages imported by the moved union. */
  readonly dependencies: readonly string[];
  /** Production and test consumers outside the moved union. */
  readonly consumers: readonly ConsumerRef[];
  readonly lineCount: number;
}

export interface EvacuationCandidateOptions {
  readonly config: MonocarveConfig;
  readonly graph: DependencyGraph;
  readonly application: string;
  /** Output of `resolveEvacuationSelectors`. */
  readonly selected: readonly string[];
}

/** Build the bounded union of selected SCCs, absorbing peers but not outbound dependencies. */
export function buildEvacuationCandidate(options: EvacuationCandidateOptions): EvacuationCandidate {
  const { config, graph, application } = options;
  const requested = [...new Set(options.selected)].sort(byCodeUnit);
  if (requested.length === 0) throw new EvacuationSelectorError("evacuation requires selected production paths");

  const applicationGraph = buildApplicationGraph(graph, application);
  for (const path of requested) {
    if (!applicationGraph.nodeSet.has(path)) {
      throw new EvacuationSelectorError(
        `evacuation selected path ${JSON.stringify(path)} is not production code in application ${JSON.stringify(application)}`,
      );
    }
  }

  const { components, componentByNode } = applicationGraph.condensed;
  const seedIds = new Set(requested.map((path) => componentByNode.get(path)!));

  const retainedIds = new Set(
    [...seedIds].filter((id) => (components[id] ?? []).some((path) => isCompositionRoot(config, path))),
  );
  const movedIds = new Set([...seedIds].filter((id) => !retainedIds.has(id)));
  const files = componentPaths(movedIds, components);
  const requestedSet = new Set(requested);
  const absorbedSccPeers = files.filter((path) => !requestedSet.has(path));
  const movedSet = new Set(files);
  const unselectedDependencies = [...new Set(graph.edges
    .filter((edge) => movedSet.has(edge.from) && !movedSet.has(edge.to))
    .map((edge) => edge.to)
    .filter((path) => graph.nodes.get(path)?.zone === "application"))]
    .sort(byCodeUnit);
  const retainedComposition = componentSccs(retainedIds, components);
  const seedSccs = componentSccs(seedIds, components);
  const sccs = componentSccs(movedIds, components);

  return {
    id: evacuationId(application, requested, files, retainedComposition),
    application,
    requested,
    seedSccs,
    absorbedSccPeers,
    unselectedDependencies,
    files,
    sccs,
    retainedComposition,
    dependencies: packageDependencies(graph, files),
    consumers: consumerRefs(config, graph, application, files),
    lineCount: files.reduce((total, path) => total + (graph.nodes.get(path)?.lineCount ?? 0), 0),
  };
}

function componentPaths(ids: ReadonlySet<number>, components: readonly (readonly string[])[]): string[] {
  return [...ids].flatMap((id) => components[id] ?? []).sort(byCodeUnit);
}

function componentSccs(ids: ReadonlySet<number>, components: readonly (readonly string[])[]): Scc[] {
  return [...ids]
    .map((id) => components[id] ?? [])
    .filter((members) => members.length > 0)
    .map((members) => ({ id: sccId(members), members: [...members].sort(byCodeUnit) }))
    .sort((left, right) => byCodeUnit(left.id, right.id));
}

function evacuationId(
  application: string,
  requested: readonly string[],
  files: readonly string[],
  retained: readonly Scc[],
): string {
  const identity = [application, ...requested, "--files--", ...files, "--retained--", ...retained.flatMap((scc) => scc.members)];
  return `e-${hashText(identity.join("\n")).slice(0, 12)}`;
}

function packageDependencies(graph: DependencyGraph, files: readonly string[]): string[] {
  const fileSet = new Set(files);
  const ownerToPackage = new Map([...graph.workspace.packageNames].map(([name, owner]) => [owner, name]));
  const owners = files.flatMap((file) => [...(graph.workspaceDependenciesBySource.get(file) ?? [])]);
  for (const edge of graph.edges) {
    if (!fileSet.has(edge.from)) continue;
    const target = graph.nodes.get(edge.to);
    if (target?.zone === "package") owners.push(target.owner);
  }
  return [...new Set(owners.map((owner) => ownerToPackage.get(owner) ?? owner))].sort(byCodeUnit);
}

function consumerRefs(
  config: MonocarveConfig,
  graph: DependencyGraph,
  application: string,
  files: readonly string[],
): ConsumerRef[] {
  const moved = new Set(files);
  const byFile = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    if (moved.has(edge.from) || !moved.has(edge.to)) continue;
    const specifiers = byFile.get(edge.from) ?? new Set<string>();
    specifiers.add(edge.specifier);
    byFile.set(edge.from, specifiers);
  }
  for (const path of files) {
    for (const test of graph.testImporters.get(path) ?? []) if (!byFile.has(test)) byFile.set(test, new Set());
  }
  return [...byFile]
    .map(([file, specifiers]) => ({
      file,
      owner: graph.nodes.get(file)?.owner ?? ownerFor(config, file),
      specifiers: [...specifiers].sort(byCodeUnit),
      external: applicationFor(config, file)?.name !== application,
    }))
    .sort((left, right) => byCodeUnit(left.file, right.file));
}
