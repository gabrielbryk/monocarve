import { afterEach, expect, test } from "bun:test";

import { explainArtifact, explainDependency, formatPlanExplanation } from "../src/plan/explain.ts";
import type { ExtractionManifest } from "../src/plan/manifest.ts";
import { hashText } from "../src/util/hash.ts";
import { committedWorkspace, runIn, runJsonIn } from "./support/cli.ts";
import { cleanupFixtures } from "./support/fixture-repo.ts";

afterEach(cleanupFixtures);

test("dependency and artifact explanations expose exact persisted provenance", () => {
  const operation = {
    kind: "write-file" as const,
    path: "libs/chart/package.json",
    contents: "{}\n",
    preconditionHash: "missing" as const,
    resultHash: hashText("{}\n"),
    generator: "scaffold:package-json",
  };
  const manifest = {
    planId: "c-example",
    dependencies: { runtime: { library: "1" }, dev: {}, packageReferences: [] },
    dependencyDecisions: [{ name: "library", decision: "target-runtime", sources: ["apps/web/src/chart.ts"], reasons: ["production-import"] }],
    projectedArtifacts: [{ path: operation.path, kind: "json", resultHash: operation.resultHash }],
    operations: [operation],
  } as unknown as ExtractionManifest;
  expect(explainDependency(manifest, "library")).toMatchObject({
    declarations: [{ section: "runtime", version: "1" }],
    decisions: [{ sources: ["apps/web/src/chart.ts"] }],
  });
  const artifact = explainArtifact(manifest, operation.path);
  expect(artifact.operations).toEqual([{ index: 0, kind: "write-file", generator: "scaffold:package-json", paths: [operation.path] }]);
  expect(formatPlanExplanation(artifact)).toContain(operation.resultHash);
  expect(() => explainDependency(manifest, "absent")).toThrow("no dependency evidence");
});

test("explain CLI is read-only and requires one selector", async () => {
  const root = committedWorkspace();
  const portfolio = await runJsonIn<{ top: { id: string }[] }>(root, "portfolio", "--recommendation", "all", "--strategy", "max-loc", "--no-cache");
  const planned = await runJsonIn<{ output: string; dependencies: { runtime: Record<string, string> } }>(
    root,
    "plan",
    "--candidate",
    portfolio.top[0]!.id,
    "--package-name",
    "@acme/chart",
    "--write",
    "--no-cache",
  );
  const dependency = Object.keys(planned.dependencies.runtime)[0]!;
  const explained = await runJsonIn<{ kind: string; name: string; decisions: unknown[] }>(
    root,
    "explain",
    "--plan",
    planned.output,
    "--dependency",
    dependency,
    "--json",
  );
  expect(explained).toMatchObject({ kind: "dependency", name: dependency });
  expect(explained.decisions.length).toBeGreaterThan(0);
  const invalid = await runIn(root, "explain", "--plan", planned.output);
  expect(invalid.code).toBe(64);
  expect(invalid.stderr).toContain("exactly one");
});
