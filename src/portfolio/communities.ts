/**
 * Read-only, deterministic community diagnostics for an application's import
 * graph. These groups are suggestions, not candidate inputs: modularity
 * describes observed coupling, while extraction still requires hard proofs.
 */

import type { DependencyGraph } from "../graph/model.ts";
import { byCodeUnit, hashJson, type Sha256 } from "../util/hash.ts";

export interface CommunityAnalysisOptions {
  readonly application?: string;
  /** Nodes with at least this many first-party importers do not join edges. */
  readonly hubInboundThreshold?: number;
  /** Fixed safety bound for deterministic local-move passes. */
  readonly maximumPasses?: number;
}

export interface Community {
  /** Stable content-derived identifier, never a candidate or package name. */
  readonly id: string;
  readonly members: readonly string[];
  readonly lineCount: number;
  readonly internalEdges: number;
  readonly externalEdges: number;
}

export interface CommunityReport {
  readonly schema: "portfolio-communities";
  readonly graphDigest: Sha256;
  readonly parameters: {
    readonly algorithm: "deterministic-louvain-local-move";
    readonly graph: "undirected application production imports";
    readonly hubInboundThreshold: number;
    readonly maximumPasses: number;
  };
  /** Hubs remain listed in communities but do not bridge them by edges. */
  readonly suppressedHubs: readonly { readonly path: string; readonly incoming: number }[];
  /** Full-graph edges withheld only from clustering, retained for review. */
  readonly suppressedHubEdges: readonly (readonly [string, string])[];
  readonly communities: readonly Community[];
}

const DEFAULT_HUB_INBOUND_THRESHOLD = 12;
const DEFAULT_MAXIMUM_PASSES = 100;

/**
 * First local-move phase of Louvain, without random initialisation or graph
 * coarsening. A stable, reviewable partition is more useful here than a
 * heuristic that might be mistaken for an extraction decision.
 */
export function analyzeCommunities(graph: DependencyGraph, options: CommunityAnalysisOptions = {}): CommunityReport {
  const hubInboundThreshold = positiveInteger(options.hubInboundThreshold ?? DEFAULT_HUB_INBOUND_THRESHOLD, "hubInboundThreshold");
  const maximumPasses = positiveInteger(options.maximumPasses ?? DEFAULT_MAXIMUM_PASSES, "maximumPasses");
  const nodes = [...graph.nodes.values()]
    .filter((node) => node.zone === "application" && (options.application === undefined || node.application === options.application))
    .map((node) => node.path)
    .sort(byCodeUnit);
  const nodeSet = new Set(nodes);
  const suppressedHubs = nodes
    .map((path) => ({ path, incoming: (graph.incoming.get(path) ?? []).filter((source) => nodeSet.has(source)).length }))
    .filter((entry) => entry.incoming >= hubInboundThreshold)
    .sort((left, right) => byCodeUnit(left.path, right.path));
  const suppressed = new Set(suppressedHubs.map((entry) => entry.path));
  // Suppression changes the clustering input only.  The report keeps the full
  // graph's coupling counts and names every withheld edge, so a hub cannot
  // make a community look more isolated than it actually is.
  const fullEdges = uniqueUndirectedEdges(graph, nodeSet, new Set());
  const clusteringEdges = fullEdges.filter(([left, right]) => !suppressed.has(left) && !suppressed.has(right));
  const suppressedHubEdges = fullEdges.filter(([left, right]) => suppressed.has(left) || suppressed.has(right));
  const adjacency = adjacencyFor(nodes, clusteringEdges);
  const membership = louvainLocalMove(nodes, adjacency, maximumPasses);
  return {
    schema: "portfolio-communities",
    graphDigest: diagnosticDigest(nodes, graph),
    parameters: { algorithm: "deterministic-louvain-local-move", graph: "undirected application production imports", hubInboundThreshold, maximumPasses },
    suppressedHubs,
    suppressedHubEdges,
    communities: renderCommunities(nodes, fullEdges, membership, graph),
  };
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function diagnosticDigest(nodes: readonly string[], graph: DependencyGraph): Sha256 {
  const nodeSet = new Set(nodes);
  const edges = graph.edges
    .filter((edge) => nodeSet.has(edge.from) && nodeSet.has(edge.to))
    .map((edge) => [edge.from, edge.to, edge.specifier, edge.kind] as const)
    .sort(tupleCompare);
  return hashJson({ nodes, edges });
}

function uniqueUndirectedEdges(graph: DependencyGraph, nodes: ReadonlySet<string>, suppressed: ReadonlySet<string>): readonly (readonly [string, string])[] {
  const pairs = new Map<string, readonly [string, string]>();
  for (const edge of graph.edges) {
    if (!nodes.has(edge.from) || !nodes.has(edge.to) || suppressed.has(edge.from) || suppressed.has(edge.to)) continue;
    const [left, right] = byCodeUnit(edge.from, edge.to) <= 0 ? [edge.from, edge.to] : [edge.to, edge.from];
    if (left !== right) pairs.set(`${left}\u0000${right}`, [left, right]);
  }
  return [...pairs.values()].sort((left, right) => byCodeUnit(left[0], right[0]) || byCodeUnit(left[1], right[1]));
}

function adjacencyFor(nodes: readonly string[], edges: readonly (readonly [string, string])[]): ReadonlyMap<string, readonly string[]> {
  const mutable = new Map(nodes.map((node) => [node, new Set<string>()]));
  for (const [left, right] of edges) {
    mutable.get(left)?.add(right);
    mutable.get(right)?.add(left);
  }
  return new Map(nodes.map((node) => [node, [...(mutable.get(node) ?? [])].sort(byCodeUnit)]));
}

function louvainLocalMove(nodes: readonly string[], adjacency: ReadonlyMap<string, readonly string[]>, maximumPasses: number): ReadonlyMap<string, string> {
  const membership = new Map(nodes.map((node) => [node, node]));
  const degrees = new Map(nodes.map((node) => [node, adjacency.get(node)?.length ?? 0]));
  const totals = new Map(nodes.map((node) => [node, degrees.get(node) ?? 0]));
  const edgeCount = [...degrees.values()].reduce((sum, degree) => sum + degree, 0) / 2;
  if (edgeCount === 0) return membership;
  for (let pass = 0; pass < maximumPasses; pass += 1) {
    let changed = false;
    for (const node of nodes) {
      const old = membership.get(node)!;
      const degree = degrees.get(node) ?? 0;
      totals.set(old, (totals.get(old) ?? 0) - degree);
      const counts = new Map<string, number>();
      for (const neighbor of adjacency.get(node) ?? []) {
        const group = membership.get(neighbor)!;
        counts.set(group, (counts.get(group) ?? 0) + 1);
      }
      let best = old;
      let bestGain = 0;
      for (const group of [...counts.keys()].sort(byCodeUnit)) {
        const gain = (counts.get(group) ?? 0) / edgeCount - ((totals.get(group) ?? 0) * degree) / (2 * edgeCount * edgeCount);
        if (gain > bestGain || (gain === bestGain && gain > 0 && byCodeUnit(group, best) < 0)) {
          best = group;
          bestGain = gain;
        }
      }
      membership.set(node, best);
      totals.set(best, (totals.get(best) ?? 0) + degree);
      if (best !== old) changed = true;
    }
    if (!changed) break;
  }
  return membership;
}

function renderCommunities(nodes: readonly string[], edges: readonly (readonly [string, string])[], membership: ReadonlyMap<string, string>, graph: DependencyGraph): readonly Community[] {
  const groups = new Map<string, string[]>();
  for (const node of nodes) {
    const group = membership.get(node)!;
    const members = groups.get(group) ?? [];
    members.push(node);
    groups.set(group, members);
  }
  return [...groups.values()]
    .map((unsorted) => {
      const members = unsorted.sort(byCodeUnit);
      const memberSet = new Set(members);
      let internalEdges = 0;
      let externalEdges = 0;
      for (const [left, right] of edges) {
        const leftInside = memberSet.has(left);
        const rightInside = memberSet.has(right);
        if (leftInside && rightInside) internalEdges += 1;
        else if (leftInside || rightInside) externalEdges += 1;
      }
      return { id: `community-${hashJson(members).slice(0, 10)}`, members, lineCount: members.reduce((sum, path) => sum + (graph.nodes.get(path)?.lineCount ?? 0), 0), internalEdges, externalEdges };
    })
    .sort((left, right) => right.members.length - left.members.length || right.internalEdges - left.internalEdges || byCodeUnit(left.id, right.id));
}

function tupleCompare(left: readonly string[], right: readonly string[]): number {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const compared = byCodeUnit(left[index]!, right[index]!);
    if (compared !== 0) return compared;
  }
  return left.length - right.length;
}
