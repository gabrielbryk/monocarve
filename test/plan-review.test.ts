import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";

import { formatPlanReview, planReviewJson, summarizePlanReview } from "../src/plan/review.ts";
import type { ExtractionManifest } from "../src/plan/manifest.ts";
import { baseManifest, extractionFiles, PACKAGE_ROOT } from "./support/transaction-fixture.ts";
import { fixtureRepo } from "./support/fixture-repo.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function manifest(): ExtractionManifest {
  const root = fixtureRepo(extractionFiles());
  roots.push(root);
  return baseManifest(root);
}

describe("plan review summary", () => {
  test("reports the exact reviewed recipe in stable human and JSON forms", () => {
    const base = manifest();
    const reviewed: ExtractionManifest = {
      ...base,
      dependencies: {
        runtime: { "library-b": "workspace:*", "library-a": "^1.0.0" },
        dev: { "test-library": "^2.0.0" },
        packageReferences: ["packages/zeta", "packages/alpha"],
      },
      operations: [
        ...base.operations,
        {
          kind: "migrate-path-keys",
          path: "workspace.json",
          command: "update paths",
          moves: [
            { source: "legacy/b", target: "modern/b" },
            { source: "legacy/a", target: "modern/a" },
          ],
          preconditionHash: "missing",
          resultHash: "0".repeat(64),
        },
      ],
    };

    const summary = summarizePlanReview(reviewed, {
      baselinePaths: ["apps/api/src/main.ts"],
      manifestPath: "plans/reviewed.json",
      approvalSubject: "chore: approve reviewed extraction",
    });

    expect(summary.target).toEqual({ mode: "new", root: PACKAGE_ROOT, name: "@acme/analytics", entrypoint: "src/index.ts" });
    expect(summary.moves).toEqual([
      expect.objectContaining({ kind: "move", source: "apps/api/src/widget/widget.ts", target: "libs/analytics/src/widget/widget.ts" }),
      { kind: "migrate-path-key", source: "legacy/b", target: "modern/b", operationIndex: 4, nestedIndex: 0 },
      { kind: "migrate-path-key", source: "legacy/a", target: "modern/a", operationIndex: 4, nestedIndex: 1 },
    ]);
    expect(summary.operationCounts).toEqual({
      move: 1,
      "move-with-rewrite": 0,
      "rewrite-import": 1,
      "write-file": 1,
      "lockfile-importer": 1,
      "migrate-path-keys": 1,
    });
    expect(summary.dependencyAdditions.runtime.map(({ name }) => name)).toEqual(["library-a", "library-b"]);
    expect(summary.dependencyAdditions.packageReferences).toEqual(["packages/alpha", "packages/zeta"]);
    expect(summary.consumerRewrites).toEqual(base.consumers);
    expect(summary.exports.entrypoint).toEqual(base.target.requiredExports);
    expect(summary.approval).toEqual({ subject: "chore: approve reviewed extraction", manifestPath: "plans/reviewed.json" });
    expect(summary.warnings).toEqual([]);

    expect(JSON.parse(planReviewJson(summary))).toEqual(summary);
    expect(planReviewJson(summary)).toBe(planReviewJson(summary));
    expect(formatPlanReview(summary)).toContain("legacy/b -> modern/b");
    expect(formatPlanReview(summary)).toContain("Approval: chore: approve reviewed extraction @ plans/reviewed.json");
  });

  test("recognizes an existing target with no package or registration scaffold", () => {
    const base = manifest();
    const withoutScaffold: ExtractionManifest = {
      ...base,
      operations: base.operations.filter((operation) => operation.kind !== "write-file"),
    };
    const summary = summarizePlanReview(withoutScaffold, {
      baselinePaths: [`${PACKAGE_ROOT}/package.json`, `${PACKAGE_ROOT}/src/existing.ts`],
      manifestPath: "plans/existing.json",
    });

    expect(summary.target.mode).toBe("existing");
    expect(summary.scaffoldOutputs).toEqual([]);
    expect(summary.operationCounts["write-file"]).toBe(0);
    expect(summary.approval.subject).toBe(base.commits.plan?.subject);
    expect(summary.warnings).toEqual([]);
  });

  test("warns when baseline and approval evidence are absent", () => {
    const base = manifest();
    const summary = summarizePlanReview({
      ...base,
      commits: { move: base.commits.move, wiring: base.commits.wiring },
      gates: { package: [], project: [], workspace: [] },
    });
    expect(summary.target.mode).toBe("unknown");
    expect(summary.warnings.map(({ code }) => code)).toEqual([
      "target-mode-unknown",
      "approval-path-missing",
      "approval-subject-missing",
      "no-gates",
    ]);
  });

  test("makes possible donor orphans an explicit review decision", () => {
    const base = manifest();
    const summary = summarizePlanReview({
      ...base,
      donorDependencyPruning: { mode: "report", candidates: [{ name: "runtime-library", section: "runtime" }] },
    }, { baselinePaths: [], manifestPath: "plans/review.json" });
    expect(summary.warnings).toContainEqual(expect.objectContaining({ code: "donor-dependency-review" }));
    expect(formatPlanReview(summary)).toContain("verify scripts, config, generators, and other non-source consumers");
  });
});
