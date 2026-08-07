import type { DependencyGraph } from "../graph/model.ts";
import type { Portfolio } from "./types.ts";

export interface LazyRegistryTarget {
  readonly source: string;
  readonly specifier: string;
  readonly resolvedPath: string;
  readonly domain: string;
  readonly lineCount: number;
  readonly candidateIds: readonly string[];
  readonly suggestedPackageNames: readonly string[];
}

/** Map static dynamic-import entries to extractable closure/package targets. */
export function analyzeLazyRegistry(graph: DependencyGraph, portfolio: Portfolio, sourcePath: string): LazyRegistryTarget[] {
  if (!graph.nodes.has(sourcePath)) return [];
  return graph.edges.filter((edge) => edge.from === sourcePath && edge.dynamic).map((edge) => {
    const target = graph.nodes.get(edge.to);
    const candidates = portfolio.candidates.filter((candidate) => candidate.files.includes(edge.to));
    return {
      source: sourcePath,
      specifier: edge.specifier,
      resolvedPath: edge.to,
      domain: target?.domain ?? "unknown",
      lineCount: target?.lineCount ?? 0,
      candidateIds: candidates.map((candidate) => candidate.id).sort(),
      suggestedPackageNames: [...new Set(candidates.map((candidate) => candidate.suggestedPackageName))].sort(),
    };
  }).sort((left, right) => left.resolvedPath.localeCompare(right.resolvedPath));
}
