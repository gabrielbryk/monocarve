import { afterEach, describe, expect, test } from "bun:test";

import type { PlanReviewSummary } from "../src/plan/review.ts";
import { runIn } from "./support/cli.ts";
import { baseManifest, extractionFiles, PACKAGE_ROOT } from "./support/transaction-fixture.ts";
import { cleanupFixtures, fixtureConfig, fixtureRepo, write } from "./support/fixture-repo.ts";

afterEach(cleanupFixtures);

function reviewedPlan(): { root: string; path: string } {
  const root = fixtureRepo(extractionFiles());
  fixtureConfig(root);
  const path = "plans/review.json";
  write(root, path, `${JSON.stringify(baseManifest(root), null, 2)}\n`);
  return { root, path };
}

describe("plan-review CLI", () => {
  test("prints structured review evidence for an existing target", async () => {
    const { root, path } = reviewedPlan();
    const result = await runIn(root, "plan-review", "--plan", path, "--approval-subject", "chore: approve exact plan", "--json");

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const summary = JSON.parse(result.stdout) as PlanReviewSummary;
    expect(summary.target).toEqual({ mode: "existing", root: PACKAGE_ROOT, name: "@acme/analytics", entrypoint: "src/index.ts" });
    expect(summary.moves[0]).toMatchObject({ source: "apps/api/src/widget/widget.ts", target: "libs/analytics/src/widget/widget.ts" });
    expect(summary.approval).toEqual({ subject: "chore: approve exact plan", manifestPath: path });
    expect(summary.warnings).toEqual([]);
  });

  test("prints the human review without mutating the plan", async () => {
    const { root, path } = reviewedPlan();
    const result = await runIn(root, "plan-review", "--plan", path);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Target: @acme/analytics (existing) at libs/analytics");
    expect(result.stdout).toContain("apps/api/src/widget/widget.ts -> libs/analytics/src/widget/widget.ts");
    expect(result.stdout).toContain(`@ ${path}`);
  });
});
