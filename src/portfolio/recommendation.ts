import { dirname } from "node:path";

import type { MonocarveConfig } from "../config.ts";
import type { DependencyGraph } from "../graph/model.ts";
import type { WorkspaceContext } from "../plan/context.ts";
import type {
  CandidateRecommendation,
  CompatibilityShim,
  PortfolioCandidate,
  RecommendationReason,
  TargetRecommendation,
} from "./types.ts";

export function recommendCandidate(
  config: MonocarveConfig,
  context: WorkspaceContext,
  graph: DependencyGraph,
  candidate: Omit<PortfolioCandidate, "score" | "recommendation" | "effort">,
  shims: readonly CompatibilityShim[],
): CandidateRecommendation {
  const reasons: RecommendationReason[] = [];
  const segment = candidate.suggestedPackageName.split("/").at(-1) ?? candidate.suggestedPackageName;
  if (config.portfolio.genericTargetSegments.includes(segment)) {
    reasons.push(reason("generic-target", `suggested target '${segment}' is generic`, []));
  }
  const adjacent = candidate.files.filter((path) =>
    config.portfolio.compositionAdjacentPatterns.some((pattern) => new RegExp(pattern).test(path))
  );
  if (adjacent.length > 0) reasons.push(reason("composition-adjacent", "closure is adjacent to application composition", adjacent));
  if (shims.length > 0) reasons.push(reason("compatibility-shim", "closure contains a high-fan-in compatibility shim", shims.map((shim) => shim.path)));
  if (candidate.domains.length > 1) reasons.push(reason("cross-domain", `closure spans ${candidate.domains.length} domains`, candidate.files));
  const highInboundModules = candidate.files.filter((path) =>
    (graph.incoming.get(path)?.length ?? 0) >= config.portfolio.highInboundThreshold
  );
  if (highInboundModules.length > 0) reasons.push(reason("high-inbound", "closure contains high-inbound modules", highInboundModules));
  const highFanOut = candidate.files.filter((path) =>
    (graph.outgoing.get(path)?.length ?? 0) >= config.portfolio.highFanOutThreshold
  );
  if (highFanOut.length > 0) reasons.push(reason("high-fan-out", "closure contains high-fan-out modules", highFanOut));
  if ((config.portfolio.maxRecommendedFiles !== undefined && candidate.files.length > config.portfolio.maxRecommendedFiles) ||
      (config.portfolio.maxRecommendedLines !== undefined && candidate.lineCount > config.portfolio.maxRecommendedLines)) {
    reasons.push(reason("large-review", "closure exceeds the configured recommended review size", candidate.files));
  }
  const effectful = candidate.files.filter((path) => context.evaluationEffectKinds(path).length > 0);
  if (effectful.length > 0) reasons.push(reason("evaluation-effects", "closure has top-level evaluation effects", effectful));

  const discouraged = new Set(["generic-target", "composition-adjacent", "compatibility-shim", "large-review"]);
  const status = reasons.some((item) => discouraged.has(item.code))
    ? "discouraged"
    : reasons.length > 0 ? "review-required" : "recommended";
  const targetOptions = targetRecommendations(candidate, graph);
  return {
    status,
    cohesion: candidate.domains.length <= 1 ? "high" : candidate.domains.length === 2 ? "medium" : "low",
    reasons,
    requiresExplicitPackageName: status !== "recommended" || targetOptions.length !== 1,
    highInboundModules,
    targetOptions,
  };
}

function targetRecommendations(
  candidate: Omit<PortfolioCandidate, "score" | "recommendation" | "effort">,
  graph: DependencyGraph,
): TargetRecommendation[] {
  const existing = candidate.dependencies.filter((name) => graph.workspace.packageNames.has(name)).map((packageName) => ({
    packageName,
    action: "extend" as const,
    confidence: "medium" as const,
    compatibility: "requires-review" as const,
    reasons: ["candidate already depends on this workspace package"],
  }));
  return [...existing, {
    packageName: candidate.suggestedPackageName,
    action: "create" as const,
    confidence: existing.length === 0 ? "medium" as const : "low" as const,
    compatibility: "compatible" as const,
    reasons: [`derived from ${dirname(candidate.files[0] ?? candidate.application)}`],
  }].sort((left, right) => left.packageName.localeCompare(right.packageName));
}

function reason(code: RecommendationReason["code"], detail: string, paths: readonly string[]): RecommendationReason {
  return { code, detail, paths: [...paths].sort() };
}
