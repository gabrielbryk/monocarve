import { condense, sccId, type DependencyGraph, type EdgeKind, type ModuleZone } from "../graph/index.ts";
import { byCodeUnit, hashJson } from "../util/hash.ts";

export const VISUALIZATION_SCHEMA = "dependency-graph-v1";

export interface VisualizationNode {
  readonly id: string;
  readonly label: string;
  readonly members: readonly string[];
  readonly applications: readonly string[];
  readonly domains: readonly string[];
  readonly owners: readonly string[];
  readonly zones: readonly ModuleZone[];
  readonly lineCount: number;
  readonly layer: number;
  readonly cyclic: boolean;
}

export interface VisualizationEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly kinds: readonly EdgeKind[];
  readonly count: number;
}

export interface VisualizationGraph {
  readonly schema: typeof VISUALIZATION_SCHEMA;
  readonly commit: string | null;
  readonly digest: string;
  readonly generatedFrom: { readonly modules: number; readonly edges: number };
  readonly nodes: readonly VisualizationNode[];
  readonly edges: readonly VisualizationEdge[];
}

export function projectVisualizationGraph(graph: DependencyGraph): VisualizationGraph {
  const paths = graph.paths.filter((path) => graph.nodes.get(path)?.zone !== "external");
  const pathSet = new Set(paths);
  const workspaceEdges = graph.edges.filter((edge) => pathSet.has(edge.from) && pathSet.has(edge.to));
  const outgoing = new Map(paths.map((path) => [path, [] as string[]]));
  for (const edge of workspaceEdges) outgoing.get(edge.from)!.push(edge.to);
  for (const targets of outgoing.values()) targets.sort();
  const condensed = condense(paths, outgoing);
  const idByComponent = new Map(condensed.components.map((members, index) => [index, sccId(members)]));

  const nodes = condensed.components
    .map((members, index) => {
      const records = members.map((member) => graph.nodes.get(member)!);
      return {
        id: idByComponent.get(index)!,
        label: labelFor(members),
        members: [...members],
        applications: unique(records.flatMap((node) => (node.application === undefined ? [] : [node.application]))),
        domains: unique(records.map((node) => node.domain)),
        owners: unique(records.map((node) => node.owner)),
        zones: unique(records.map((node) => node.zone)),
        lineCount: records.reduce((sum, node) => sum + node.lineCount, 0),
        layer: condensed.layers.get(index) ?? 0,
        cyclic: members.length > 1,
      } satisfies VisualizationNode;
    })
    .toSorted((left, right) => byCodeUnit(left.id, right.id));

  const aggregates = new Map<string, { from: string; to: string; kinds: Set<EdgeKind>; count: number }>();
  for (const edge of workspaceEdges) {
    const fromIndex = condensed.componentByNode.get(edge.from);
    const toIndex = condensed.componentByNode.get(edge.to);
    if (fromIndex === undefined || toIndex === undefined || fromIndex === toIndex) continue;
    const from = idByComponent.get(fromIndex)!;
    const to = idByComponent.get(toIndex)!;
    const key = `${from}\0${to}`;
    const aggregate = aggregates.get(key) ?? { from, to, kinds: new Set<EdgeKind>(), count: 0 };
    aggregate.kinds.add(edge.kind);
    aggregate.count += 1;
    aggregates.set(key, aggregate);
  }
  const edges = [...aggregates.values()]
    .map((edge) => ({ id: `${edge.from}->${edge.to}`, from: edge.from, to: edge.to, kinds: [...edge.kinds].toSorted(), count: edge.count }))
    .toSorted((left, right) => byCodeUnit(left.id, right.id));

  const identity = { commit: graph.commit ?? null, nodes, edges };
  return {
    schema: VISUALIZATION_SCHEMA,
    commit: graph.commit ?? null,
    digest: hashJson(identity),
    generatedFrom: { modules: paths.length, edges: workspaceEdges.length },
    nodes,
    edges,
  };
}

function unique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].toSorted();
}

function labelFor(members: readonly string[]): string {
  const path = members[0] ?? "empty";
  const base = path.slice(path.lastIndexOf("/") + 1);
  return members.length === 1 ? base : `${base} +${members.length - 1}`;
}
