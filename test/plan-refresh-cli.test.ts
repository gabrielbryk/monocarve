import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";

import { cleanupFixtures, fixtureGit, write } from "./support/fixture-repo.ts";
import { committedWorkspace, existsSync, readFileSync, runIn, runJsonIn } from "./support/cli.ts";

afterAll(cleanupFixtures);

test("refresh is read-only by default and writes only to an explicit output", async () => {
  const root = committedWorkspace();
  const portfolio = await runJsonIn<{ top: { id: string; files: string[] }[] }>(root, "portfolio", "--recommendation", "all", "--no-cache");
  const candidate = portfolio.top.find((entry) => entry.files.includes("apps/web/src/widgets/chart.ts"));
  expect(candidate).toBeDefined();
  const stale = ".monocarve/stale.json";
  const planned = await runIn(root, "plan", "--candidate", candidate!.id, "--package-name", "@acme/chart", "--out", stale, "--write", "--no-cache");
  expect(planned.code).toBe(0);

  write(root, "docs/advance.md", "advance HEAD\n");
  fixtureGit(root, "add", "--", "docs/advance.md");
  fixtureGit(root, "commit", "-qm", "docs: advance refresh baseline");
  const refreshedPath = ".monocarve/refreshed.json";

  const preview = await runJsonIn<{
    schema: string;
    written: boolean;
    semanticDiff: unknown[];
    previousBaselineCommit: string;
    currentBaselineCommit: string;
  }>(root, "refresh", "--plan", stale, "--no-cache");
  expect(preview.schema).toBe("plan-refresh");
  expect(preview.written).toBe(false);
  expect(preview.semanticDiff).toEqual([]);
  expect(preview.currentBaselineCommit).not.toBe(preview.previousBaselineCommit);
  expect(existsSync(join(root, refreshedPath))).toBe(false);

  const written = await runJsonIn<{ written: boolean; output: string }>(
    root, "refresh", "--plan", stale, "--out", refreshedPath, "--write", "--no-cache",
  );
  expect(written).toMatchObject({ written: true, output: refreshedPath });
  const manifest = JSON.parse(readFileSync(join(root, refreshedPath), "utf8")) as { baselineCommit: string };
  expect(manifest.baselineCommit).toBe(fixtureGit(root, "rev-parse", "HEAD"));

  const original = readFileSync(join(root, stale), "utf8");
  const replace = await runIn(root, "refresh", "--plan", stale, "--write", "--replace", "--no-cache");
  expect(replace.code).toBe(64);
  expect(replace.stderr).toContain("--replace is no longer supported");
  expect(readFileSync(join(root, stale), "utf8")).toBe(original);
}, 30_000);

test("refresh refuses write without an explicit output path", async () => {
  const root = committedWorkspace();
  const result = await runIn(root, "refresh", "--plan", ".monocarve/missing.json", "--write");

  // Usage is rejected before any attempt to replace an inferred input path.
  expect(result.code).toBe(64);
  expect(result.stderr).toContain("--write requires an explicit --out <path>");
});

test("plan refuses to delete or silently overwrite an existing manifest", async () => {
  const root = committedWorkspace();
  const portfolio = await runJsonIn<{ top: { id: string; files: string[] }[] }>(root, "portfolio", "--recommendation", "all", "--no-cache");
  const candidate = portfolio.top.find((entry) => entry.files.includes("apps/web/src/widgets/chart.ts"))!;
  const path = ".monocarve/existing.json";
  expect((await runIn(root, "plan", "--candidate", candidate.id, "--package-name", "@acme/chart", "--out", path, "--write", "--no-cache")).code).toBe(0);
  const original = readFileSync(join(root, path), "utf8");
  const oldBaseline = (JSON.parse(original) as { baselineCommit: string }).baselineCommit;
  write(root, "docs/new-baseline.md", "new baseline\n");
  fixtureGit(root, "add", "--", "docs/new-baseline.md");
  fixtureGit(root, "commit", "-qm", "docs: advance baseline");
  const currentBaseline = fixtureGit(root, "rev-parse", "HEAD");
  const repeated = await runIn(root, "plan", "--candidate", candidate.id, "--package-name", "@acme/chart", "--out", path, "--write", "--no-cache");
  expect(repeated.code).toBe(64);
  expect(repeated.stderr).toContain(`existing baseline ${oldBaseline}`);
  expect(repeated.stderr).toContain(`current baseline ${currentBaseline}`);
  expect(repeated.stderr).toContain("The existing file was not changed");
  expect(repeated.stderr).toContain(`refresh --plan "${path}" --out <new-path> --write`);
  expect(readFileSync(join(root, path), "utf8")).toBe(original);
}, 30_000);

test("apply refuses baseline-only replacement and preserves the reviewed plan", async () => {
  const root = committedWorkspace();
  const portfolio = await runJsonIn<{ top: { id: string; files: string[] }[] }>(root, "portfolio", "--recommendation", "all", "--no-cache");
  const candidate = portfolio.top.find((entry) => entry.files.includes("apps/web/src/widgets/chart.ts"))!;
  const path = ".monocarve/stale-for-apply.json";
  await runJsonIn(root, "plan", "--candidate", candidate.id, "--package-name", "@acme/chart", "--out", path, "--write", "--no-cache");
  const old = JSON.parse(readFileSync(join(root, path), "utf8")) as { baselineCommit: string };
  write(root, "docs/preparation.md", "baseline-only preparation\n");
  fixtureGit(root, "add", "--", "docs/preparation.md");
  fixtureGit(root, "commit", "-qm", "docs: prepare extraction");
  const original = readFileSync(join(root, path), "utf8");

  const result = await runIn(root, "apply", "--plan", path, "--commit", "--refresh-if-baseline-only", "--no-cache");
  expect(result.code).toBe(64);
  expect(result.stderr).toContain("--refresh-if-baseline-only is no longer supported");
  expect(readFileSync(join(root, path), "utf8")).toBe(original);
  expect(old.baselineCommit).not.toBe(fixtureGit(root, "rev-parse", "HEAD"));
  expect(fixtureGit(root, "log", "-1", "--format=%s")).toBe("docs: prepare extraction");
}, 60_000);

test("baseline refresh cannot mutate through a simulation-only apply", async () => {
  const root = committedWorkspace();
  const result = await runIn(root, "apply", "--plan", ".monocarve/missing.json", "--refresh-if-baseline-only");
  expect(result.code).toBe(64);
  expect(result.stderr).toContain("--refresh-if-baseline-only is no longer supported");
});

test("next refuses to overwrite an existing reviewed manifest", async () => {
  const root = committedWorkspace();
  const path = ".monocarve/next-existing.json";
  expect((await runIn(root, "next", "--out", path, "--write", "--no-cache")).code).toBe(0);
  const original = readFileSync(join(root, path), "utf8");
  const repeated = await runIn(root, "next", "--out", path, "--write", "--no-cache");
  expect(repeated.code).not.toBe(0);
  expect(readFileSync(join(root, path), "utf8")).toBe(original);
}, 60_000);
