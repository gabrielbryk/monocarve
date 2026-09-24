import { dirname } from "node:path";

import type { MonocarveConfig } from "../config.ts";
import type { DependencyGraph } from "../graph/model.ts";
import type { WorkspaceContext } from "../plan/context.ts";
import type { CandidateRecommendation, CompatibilityShim, PortfolioCandidate, RecommendationReason, TargetRecommendation } from "./types.ts";

type CandidateDraft = Omit<PortfolioCandidate, "score" | "recommendation" | "effort">;

const DISCOURAGED_REASONS = new Set(["generic-target", "composition-adjacent", "compatibility-shim", "large-review"]);

export function recommendCandidate(
  config: MonocarveConfig,
  context: WorkspaceContext,
  graph: DependencyGraph,
  candidate: CandidateDraft,
  shims: readonly CompatibilityShim[],
): CandidateRecommendation {
  const reasons = placementReasons(config, candidate, shims);
  const highInboundModules = candidate.files.filter((path) => (graph.incoming.get(path)?.length ?? 0) >= config.portfolio.highInboundThreshold);
  reasons.push(...shapeReasons(config, context, graph, candidate, highInboundModules));

  const status = recommendationStatus(reasons);
  const targetOptions = targetRecommendations(candidate, graph);
  return {
    status,
    cohesion: cohesionFor(candidate.domains.length),
    reasons,
    requiresExplicitPackageName: status !== "recommended" || targetOptions.length !== 1,
    highInboundModules,
    targetOptions,
  };
}

/** Reasons about where the closure sits: target naming, composition, shims, and domains. */
function placementReasons(config: MonocarveConfig, candidate: CandidateDraft, shims: readonly CompatibilityShim[]): RecommendationReason[] {
  const reasons: RecommendationReason[] = [];
  const segment = candidate.suggestedPackageName.split("/").at(-1) ?? candidate.suggestedPackageName;
  if (config.portfolio.genericTargetSegments.includes(segment)) {
    reasons.push(reason("generic-target", `suggested target '${segment}' is generic`, []));
  }
  const adjacent = candidate.files.filter((path) => config.portfolio.compositionAdjacentPatterns.some((pattern) => new RegExp(pattern).test(path)));
  if (adjacent.length > 0) reasons.push(reason("composition-adjacent", "closure is adjacent to application composition", adjacent));
  if (shims.length > 0)
    reasons.push(
      reason(
        "compatibility-shim",
        "closure contains a high-fan-in compatibility shim",
        shims.map((shim) => shim.path),
      ),
    );
  if (candidate.domains.length > 1) reasons.push(reason("cross-domain", `closure spans ${candidate.domains.length} domains`, candidate.files));
  return reasons;
}

/** Reasons about the closure's coupling, size, and evaluation behavior. */
function shapeReasons(
  config: MonocarveConfig,
  context: WorkspaceContext,
  graph: DependencyGraph,
  candidate: CandidateDraft,
  highInboundModules: readonly string[],
): RecommendationReason[] {
  const reasons: RecommendationReason[] = [];
  if (highInboundModules.length > 0) reasons.push(reason("high-inbound", "closure contains high-inbound modules", highInboundModules));
  const highFanOut = candidate.files.filter((path) => (graph.outgoing.get(path)?.length ?? 0) >= config.portfolio.highFanOutThreshold);
  if (highFanOut.length > 0) reasons.push(reason("high-fan-out", "closure contains high-fan-out modules", highFanOut));
  if (exceedsRecommendedReview(config, candidate)) {
    reasons.push(reason("large-review", "closure exceeds the configured recommended review size", candidate.files));
  }
  const effectful = candidate.files.filter((path) => context.evaluationEffectKinds(path).length > 0);
  if (effectful.length > 0) reasons.push(reason("evaluation-effects", "closure has top-level evaluation effects", effectful));
  return reasons;
}

function exceedsRecommendedReview(config: MonocarveConfig, candidate: CandidateDraft): boolean {
  const { maxRecommendedFiles, maxRecommendedLines } = config.portfolio;
  return (
    (maxRecommendedFiles !== undefined && candidate.files.length > maxRecommendedFiles) ||
    (maxRecommendedLines !== undefined && candidate.lineCount > maxRecommendedLines)
  );
}

function recommendationStatus(reasons: readonly RecommendationReason[]): CandidateRecommendation["status"] {
  if (reasons.some((item) => DISCOURAGED_REASONS.has(item.code))) return "discouraged";
  return reasons.length > 0 ? "review-required" : "recommended";
}

function cohesionFor(domainCount: number): CandidateRecommendation["cohesion"] {
  if (domainCount <= 1) return "high";
  return domainCount === 2 ? "medium" : "low";
}

export function targetRecommendations(candidate: CandidateDraft, graph: DependencyGraph): TargetRecommendation[] {
  const suggestedExists = graph.workspace.packageNames.has(candidate.suggestedPackageName);
  const existing = candidate.dependencies
    .filter((name) => name !== candidate.suggestedPackageName && graph.workspace.packageNames.has(name))
    .map((packageName) => ({
      packageName,
      action: "extend" as const,
      confidence: "medium" as const,
      compatibility: "requires-review" as const,
      reasons: ["candidate already depends on this workspace package"],
    }));
  return [
    ...existing,
    {
      packageName: candidate.suggestedPackageName,
      action: suggestedExists ? ("extend" as const) : ("create" as const),
      confidence: suggestedExists || existing.length > 0 ? ("low" as const) : ("medium" as const),
      compatibility: suggestedExists ? ("requires-review" as const) : ("compatible" as const),
      reasons: suggestedExists
        ? ["suggested package already exists; extending it requires compatibility review"]
        : [`derived from ${dirname(candidate.files[0] ?? candidate.application)}`],
    },
  ].toSorted((left, right) => left.packageName.localeCompare(right.packageName));
}

function reason(code: RecommendationReason["code"], detail: string, paths: readonly string[]): RecommendationReason {
  return { code, detail, paths: [...paths].toSorted() };
}
