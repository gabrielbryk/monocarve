import { expect, test } from "bun:test";

import { estimateCandidateEffort } from "../src/portfolio/effort.ts";
import type { PortfolioCandidate } from "../src/portfolio/types.ts";

function candidate(consumers: number): Omit<PortfolioCandidate, "score" | "effort"> {
  return { id: "c-test", application: "web", suggestedPackageName: "@acme/test", files: ["apps/web/src/test.ts"], tests: [], assets: [], sccs: [], seed: { id: "s", members: ["apps/web/src/test.ts"] }, lineCount: 1000, owners: ["apps/web"], domains: ["web:test"], dependencies: [], consumers: [], consumerChurn: consumers, coverage: 0, eligible: true, rejectionReasons: [], warnings: [], rewriteEscapes: [], recommendation: { status: "recommended", cohesion: "high", reasons: [], requiresExplicitPackageName: false, highInboundModules: [], targetOptions: [] } };
}

test("review effort lowers ROI as consumer churn grows", () => {
  const low = estimateCandidateEffort(candidate(1));
  const high = estimateCandidateEffort(candidate(10));
  expect(low.locPerReviewUnit).toBeGreaterThan(high.locPerReviewUnit);
  expect(high.drivers.consumers).toBe(10);
});
