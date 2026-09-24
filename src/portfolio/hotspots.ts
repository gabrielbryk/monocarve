import type { DependencyGraph } from "../graph/model.ts";
import { byCodeUnit } from "../util/hash.ts";
import type { Portfolio, PortfolioCandidate } from "./types.ts";

export interface CouplingHotspot {
  readonly path: string;
  readonly application?: string;
  readonly lineCount: number;
  readonly inbound: number;
  readonly fanOut: number;
  readonly closureCount: number;
  readonly largestClosureLines: number;
  readonly crossDomainClosures: number;
  readonly discouragedClosures: number;
  readonly pressureScore: number;
  readonly suggestedAction: "split-capabilities" | "extract-registry" | "declare-boundary" | "review-closure";
  readonly candidateIds: readonly string[];
}

/** Rank modules by how much candidate closure pressure they propagate. */
export function analyzeCouplingHotspots(graph: DependencyGraph, portfolio: Portfolio, application?: string): CouplingHotspot[] {
  const candidates = representativeCandidates(portfolio).filter((candidate) => application === undefined || candidate.application === application);
  return graph.paths.flatMap((path): CouplingHotspot[] => {
    const node = graph.nodes.get(path);
    if (!node || node.zone !== "application" || (application !== undefined && node.application !== application)) return [];
    const closures = candidates.filter((candidate) => candidate.files.includes(path));
    if (closures.length === 0) return [];
    const inbound = graph.incoming.get(path)?.length ?? 0;
    const fanOut = graph.outgoing.get(path)?.length ?? 0;
    const largestClosureLines = Math.max(...closures.map((candidate) => candidate.lineCount));
    const crossDomainClosures = closures.filter((candidate) => candidate.domains.length > 1).length;
    const discouragedClosures = closures.filter((candidate) => candidate.recommendation?.status === "discouraged").length;
    return [{
      path,
      ...(node.application === undefined ? {} : { application: node.application }),
      lineCount: node.lineCount,
      inbound,
      fanOut,
      closureCount: closures.length,
      largestClosureLines,
      crossDomainClosures,
      discouragedClosures,
      pressureScore: largestClosureLines + inbound * 100 + fanOut * 50 + crossDomainClosures * 250 + discouragedClosures * 100,
      suggestedAction: action(inbound, fanOut, crossDomainClosures),
      candidateIds: closures.map((candidate) => candidate.id).sort(),
    }];
  }).sort((left, right) => right.pressureScore - left.pressureScore || byCodeUnit(left.path, right.path));
}

function representativeCandidates(portfolio: Portfolio): PortfolioCandidate[] {
  if (!portfolio.equivalenceGroups || portfolio.equivalenceGroups.length === 0) return [...portfolio.candidates];
  const byId = new Map(portfolio.candidates.map((candidate) => [candidate.id, candidate]));
  return portfolio.equivalenceGroups.flatMap((group) => {
    const candidate = byId.get(group.representativeId);
    return candidate ? [candidate] : [];
  });
}

function action(inbound: number, fanOut: number, crossDomain: number): CouplingHotspot["suggestedAction"] {
  if (inbound >= 8) return "split-capabilities";
  if (fanOut >= 8) return "extract-registry";
  if (crossDomain > 0) return "declare-boundary";
  return "review-closure";
}
