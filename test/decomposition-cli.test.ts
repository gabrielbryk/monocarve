import { afterAll, expect, test } from "bun:test";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { cleanupFixtures, fixtureGit, scratchDirectory } from "./support/fixture-repo.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..");
const CLI = join(ROOT, "src/cli.ts");
const FIXTURE = join(ROOT, "fixtures/basic-monorepo");
const HASH = "a".repeat(64);

function workspace(): string {
  const root = join(scratchDirectory(), "decomposition-cli");
  cpSync(FIXTURE, root, { recursive: true });
  fixtureGit(root, "init", "-q", "-b", "decomposition-cli");
  fixtureGit(root, "config", "user.email", "fixture@example.invalid");
  fixtureGit(root, "config", "user.name", "Monocarve Fixture");
  fixtureGit(root, "add", "-A");
  fixtureGit(root, "commit", "-qm", "test: seed decomposition cli");
  return root;
}

async function run(root: string, ...args: string[]) {
  const child = Bun.spawn(["bun", CLI, "--cwd", root, ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, stdout, stderr };
}

function plan(root: string, id: string, donor: string): string {
  const path = join(root, "plans", `${id}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        planId: `plan-${id}`,
        baselineCommit: "same-baseline",
        graphDigest: HASH,
        target: { packageName: `@acme/${id}`, packageRoot: `libs/${id}` },
        operations: [
          {
            kind: "rewrite-import",
            file: "apps/web/src/main.ts",
            donors: [donor],
            rewrites: [{ from: `./${id}.ts`, to: `@acme/${id}` }],
            preconditionHash: HASH,
            resultHash: "b".repeat(64),
          },
        ],
        generatedFiles: [],
      },
      null,
      2,
    )}\n`,
  );
  return path;
}

afterAll(cleanupFixtures);

test("symbols exposes deterministic type/value declaration evidence through the CLI", async () => {
  const root = workspace();
  const result = await run(root, "symbols", "--file", "apps/web/src/widgets/chart.ts", "--json");
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  const report = JSON.parse(result.stdout) as { schemaVersion: number; sourcePath: string; groups: unknown[] };
  expect(report.schemaVersion).toBe(1);
  expect(report.sourcePath).toBe("apps/web/src/widgets/chart.ts");
  expect(report.groups.length).toBeGreaterThan(0);
});

test("split-candidates reports cross-file consumer affinity without editing the workspace", async () => {
  const root = workspace();
  const result = await run(root, "split-candidates", "--file", "apps/web/src/widgets/chart.ts", "--json");
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  const report = JSON.parse(result.stdout) as {
    consumers: { groupName: string; affinity: string }[];
    splitCandidates: { names: string[]; dominantAffinity?: string }[];
  };
  expect(report.consumers).toContainEqual(expect.objectContaining({ groupName: "renderChart", affinity: "browser" }));
  expect(report.splitCandidates).toContainEqual(expect.objectContaining({ names: ["renderChart"] }));
}, 15_000);

test("conflicts exposes exact shared-consumer evidence and replan-safe waves through the CLI", async () => {
  const root = workspace();
  const alpha = plan(root, "alpha", "apps/web/src/widgets/chart.ts");
  const bravo = plan(root, "bravo", "apps/web/src/types.ts");
  const result = await run(root, "conflicts", "--plan", `alpha=${alpha}`, "--plan", `bravo=${bravo}`, "--json");
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  const report = JSON.parse(result.stdout) as {
    schema: string;
    conflicts: { category: string; path: string; disposition: string }[];
    waves: { execution: string }[];
  };
  expect(report.schema).toBe("campaign-conflicts");
  expect(report.conflicts).toContainEqual(expect.objectContaining({ category: "consumer-source", path: "apps/web/src/main.ts", disposition: "mergeable" }));
  expect(report.waves.every((wave) => wave.execution === "replan-between-every-child")).toBe(true);
});

test("conflicts refuses mixed baselines as an expected domain error", async () => {
  const root = workspace();
  const alpha = plan(root, "alpha", "apps/web/src/widgets/chart.ts");
  const bravo = plan(root, "bravo", "apps/web/src/types.ts");
  const parsed = JSON.parse(await Bun.file(bravo).text()) as { baselineCommit: string };
  parsed.baselineCommit = "different-baseline";
  writeFileSync(bravo, `${JSON.stringify(parsed)}\n`);
  const result = await run(root, "conflicts", "--plan", `alpha=${alpha}`, "--plan", `bravo=${bravo}`);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("monocarve: plans do not share a baseline commit");
  expect(result.stderr).not.toContain("Internal error");
});
