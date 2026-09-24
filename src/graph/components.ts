/**
 * Components, condensation, and layering.
 *
 * Components — not files — are the unit of movement: splitting a cycle across a
 * package boundary produces a workspace that cannot build. Everything the
 * portfolio stage reasons about is therefore expressed over the condensation of
 * the graph, where every cycle has already collapsed into a single vertex.
 */

import { hashText } from "../util/hash.ts";
import type { DependencyGraph, Scc } from "./model.ts";

export interface CondensedGraph {
  /** Components in discovery order; each member list is sorted. */
  readonly components: readonly (readonly string[])[];
  readonly componentByNode: ReadonlyMap<string, number>;
  readonly outgoing: ReadonlyMap<number, ReadonlySet<number>>;
  readonly incoming: ReadonlyMap<number, ReadonlySet<number>>;
  /** Longest path to a leaf: layer 0 depends on nothing. */
  readonly layers: ReadonlyMap<number, number>;
}

/**
 * Tarjan's algorithm, iterated over sorted nodes so the component order — and
 * therefore every id derived from it — is deterministic.
 */
export function stronglyConnectedComponents(nodes: readonly string[], outgoing: ReadonlyMap<string, readonly string[]>): string[][] {
  let nextIndex = 0;
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  const known = new Set(nodes);

  const visit = (node: string): void => {
    indices.set(node, nextIndex);
    lowLinks.set(node, nextIndex++);
    stack.push(node);
    onStack.add(node);
    for (const dependency of outgoing.get(node) ?? []) {
      if (!known.has(dependency)) continue;
      if (!indices.has(dependency)) {
        visit(dependency);
        lowLinks.set(node, Math.min(lowLinks.get(node)!, lowLinks.get(dependency)!));
      } else if (onStack.has(dependency)) {
        lowLinks.set(node, Math.min(lowLinks.get(node)!, indices.get(dependency)!));
      }
    }
    if (lowLinks.get(node) !== indices.get(node)) return;
    const component: string[] = [];
    for (;;) {
      const member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
      if (member === node) break;
    }
    components.push(component.sort());
  };

  for (const node of [...nodes].toSorted()) if (!indices.has(node)) visit(node);
  return components;
}

/** Everything reachable from `start` in the condensation, excluding itself. */
export function transitive(start: number, outgoing: ReadonlyMap<number, ReadonlySet<number>>): Set<number> {
  const seen = new Set<number>();
  const queue = [...(outgoing.get(start) ?? [])];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);
    queue.push(...(outgoing.get(current) ?? []));
  }
  return seen;
}

export function condense(nodes: readonly string[], outgoing: ReadonlyMap<string, readonly string[]>): CondensedGraph {
  const components = stronglyConnectedComponents(nodes, outgoing);
  const componentByNode = new Map<string, number>();
  components.forEach((component, id) => component.forEach((node) => componentByNode.set(node, id)));

  const condensedOutgoing = new Map<number, Set<number>>();
  const incoming = new Map<number, Set<number>>();
  components.forEach((_, id) => {
    condensedOutgoing.set(id, new Set());
    incoming.set(id, new Set());
  });
  for (const [from, dependencies] of outgoing) {
    const fromId = componentByNode.get(from);
    if (fromId === undefined) continue;
    for (const to of dependencies) {
      const toId = componentByNode.get(to);
      if (toId === undefined || fromId === toId) continue;
      condensedOutgoing.get(fromId)!.add(toId);
      incoming.get(toId)!.add(fromId);
    }
  }

  const layers = new Map<number, number>();
  const layerFor = (id: number): number => {
    const cached = layers.get(id);
    if (cached !== undefined) return cached;
    // Provisional value guards against a self-referential lookup; the
    // condensation is acyclic, so it is never actually read.
    layers.set(id, 0);
    const dependencies = [...(condensedOutgoing.get(id) ?? [])];
    const layer = dependencies.length === 0 ? 0 : 1 + Math.max(...dependencies.map(layerFor));
    layers.set(id, layer);
    return layer;
  };
  components.forEach((_, id) => layerFor(id));

  return { components, componentByNode, outgoing: condensedOutgoing, incoming, layers };
}

/** The subgraph of one application (or of every application), condensed. */
export interface ApplicationGraph {
  readonly nodes: readonly string[];
  readonly nodeSet: ReadonlySet<string>;
  readonly condensed: CondensedGraph;
}

export function buildApplicationGraph(graph: DependencyGraph, application?: string): ApplicationGraph {
  const nodes = graph.paths.filter((path) => {
    const node = graph.nodes.get(path);
    if (!node || node.zone !== "application") return false;
    return application === undefined || node.application === application;
  });
  const nodeSet = new Set(nodes);
  const outgoing = new Map<string, string[]>(nodes.map((node) => [node, []]));
  for (const edge of graph.edges) {
    if (nodeSet.has(edge.from) && nodeSet.has(edge.to)) outgoing.get(edge.from)!.push(edge.to);
  }
  for (const dependencies of outgoing.values()) dependencies.sort();
  return { nodes, nodeSet, condensed: condense(nodes, outgoing) };
}

/** Stable, content-derived component id: same members, same id, across runs. */
export function sccId(members: readonly string[]): string {
  return `scc-${hashText([...members].toSorted().join("\n")).slice(0, 12)}`;
}

export function toSccs(condensed: CondensedGraph): Scc[] {
  return condensed.components.map((members) => ({ id: sccId(members), members: [...members] }));
}
