import type { CandidateEffort, PortfolioCandidate } from "./types.ts";

/** Deterministic review-effort heuristic; it is explicitly not elapsed-time prediction. */
export function estimateCandidateEffort(candidate: Omit<PortfolioCandidate, "score" | "effort">): CandidateEffort {
  const units =
    candidate.files.length +
    candidate.tests.length +
    candidate.assets.length +
    candidate.consumerChurn * 3 +
    candidate.rewriteEscapes.length * 2 +
    candidate.dependencies.length +
    candidate.warnings.length * 2 +
    candidate.rejectionReasons.length * 5 +
    (candidate.recommendation?.reasons.length ?? 0) * 2;
  const reviewUnits = Math.max(1, units);
  const risk =
    candidate.rejectionReasons.length > 0 || candidate.recommendation?.status === "discouraged"
      ? "high"
      : candidate.warnings.length > 0 || candidate.recommendation?.status === "review-required"
        ? "medium"
        : "low";
  return {
    reviewUnits,
    locPerReviewUnit: candidate.lineCount / reviewUnits,
    risk,
    drivers: {
      files: candidate.files.length,
      tests: candidate.tests.length,
      assets: candidate.assets.length,
      consumers: candidate.consumerChurn,
      rewrites: candidate.rewriteEscapes.length,
      warnings: candidate.warnings.length,
      blockers: candidate.rejectionReasons.length,
    },
  };
}
