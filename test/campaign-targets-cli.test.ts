import { expect, test } from "bun:test";

import { join } from "node:path";
import { committedWorkspace, runIn, writeFileSync } from "./support/cli.ts";
import { fixtureGit } from "./support/fixture-repo.ts";

test("target campaigns re-resolve a stable source path and remain read-only by default", async () => {
  const workspace = committedWorkspace();
  writeFileSync(join(workspace, "campaign.targets.json"), JSON.stringify({ application: "web", targets: [{ path: "apps/web/src/widgets/chart.ts", packageName: "@acme/chart-ui" }] }));
  fixtureGit(workspace, "add", "--", "campaign.targets.json");
  fixtureGit(workspace, "commit", "-qm", "test: add campaign targets");
  const first = await runIn(workspace, "campaign", "resolve", "--targets", "campaign.targets.json", "--json");
  const second = await runIn(workspace, "campaign", "resolve", "--targets", "campaign.targets.json", "--json");
  expect(first.code).toBe(0);
  expect(first.stderr).toBe("");
  expect(second.stdout).toBe(first.stdout);
  const result = JSON.parse(first.stdout) as { outcome: string; written: boolean; targets: { path: string; outcome: string; candidateId?: string }[]; manifest: { target: { packageName: string } } };
  expect(result).toMatchObject({ outcome: "review-required", written: false, manifest: { target: { packageName: "@acme/chart-ui" } } });
  expect(result.targets[0]).toMatchObject({ path: "apps/web/src/widgets/chart.ts", outcome: "ready" });
  expect(result.targets[0]?.candidateId).toStartWith("c-");
}, 240_000);

test("target campaigns reject duplicate stable identities before compiling", async () => {
  const workspace = committedWorkspace();
  writeFileSync(join(workspace, "campaign-duplicates.targets.json"), JSON.stringify({ application: "web", targets: [
    { path: "apps/web/src/widgets/chart.ts", packageName: "@acme/chart-ui" },
    { path: "apps/web/src/widgets/chart.ts", packageName: "@acme/chart-ui-next" },
  ] }));
  const result = await runIn(workspace, "campaign", "resolve", "--targets", "campaign-duplicates.targets.json", "--json");
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("duplicate campaign target path");
});
