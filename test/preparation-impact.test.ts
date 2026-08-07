import { expect, test } from "bun:test";

import { comparePortfolios } from "../src/impact/preparation.ts";
import type { Portfolio, PortfolioCandidate } from "../src/portfolio/types.ts";

function candidate(id: string, status: "recommended" | "review-required", lines: number): PortfolioCandidate {
  return { id, lineCount: lines, eligible: true, recommendation: { status } } as PortfolioCandidate;
}

test("reports exact before and after unlock deltas", () => {
  const before = { candidates: [candidate("old", "review-required", 100)] } as unknown as Portfolio;
  const after = { candidates: [candidate("new", "recommended", 500)] } as unknown as Portfolio;
  const report = comparePortfolios("p1", [{ zone: "application", lineCount: 1000 }], [{ zone: "application", lineCount: 900 }], before, after);
  expect(report.delta).toMatchObject({ applicationLines: -100, recommended: 1, reviewRequired: -1, largestRecommendedLines: 500 });
  expect(report.newlyRecommended).toEqual(["new"]);
  expect(report.noLongerRecommended).toEqual([]);
});
