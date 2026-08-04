import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import type { ExtractionManifest } from "../src/plan/manifest.ts";
import { hashText, stableStringify } from "../src/util/hash.ts";
import { cleanupFixtures, fixtureGit } from "./support/fixture-repo.ts";
import { committedWorkspace, existsSync, readFileSync, runIn, runJsonIn, writeFileSync } from "./support/cli.ts";

afterAll(cleanupFixtures);

test("preparer CLI compiles, simulates, and explicitly journal-applies a nested destination output", async () => {
  const root = committedWorkspace();
  const configPath = join(root, "monocarve.config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  config.preparers = [{
    id: "quality-ratchet",
    phase: "pre-extraction",
    command: "mkdir -p libs/chart/src/widgets && printf '{\"limit\":1}\\n' > {targetPath}.baseline.json",
    outputs: ["{targetPath}.baseline.json"],
    verify: "test -s {targetPath}.baseline.json",
    commit: { subject: "chore: update quality ratchet" },
  }];
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  fixtureGit(root, "add", "--", "monocarve.config.json");
  fixtureGit(root, "commit", "-qm", "test: configure generic preparer");

  const extractionPath = ".monocarve/plans/extraction.json";
  const extraction = extractionManifest(root);
  mkdirSync(join(root, ".monocarve/plans"), { recursive: true });
  writeFileSync(join(root, extractionPath), `${stableStringify(extraction, 2)}\n`);

  const planned = await runJsonIn<{ output: string; written: boolean; binding: { targetPath: string } }>(
    root,
    "preparer-plan", "--extraction", extractionPath,
    "--preparer", "quality-ratchet",
    "--source", "apps/web/src/widgets/chart.ts",
    "--write",
  );
  expect(planned.written).toBe(true);
  expect(planned.binding.targetPath).toBe("libs/chart/src/widgets/chart.ts");
  expect(existsSync(join(root, "libs/chart/src/widgets/chart.ts.baseline.json"))).toBe(false);

  expect(await runJsonIn(root, "preparer-simulate", "--plan", planned.output)).toMatchObject({ ok: true });
  expect(existsSync(join(root, "libs/chart/src/widgets/chart.ts.baseline.json"))).toBe(false);

  const unapproved = await runIn(root, "preparer-apply", "--plan", planned.output);
  expect(unapproved.code).not.toBe(0);
  expect(unapproved.stderr).toContain("must be committed before apply");

  fixtureGit(root, "add", "-f", "--", planned.output);
  fixtureGit(root, "commit", "-qm", "chore: review preparer manifest");

  expect(await runJsonIn(root, "preparer-apply", "--plan", planned.output)).toMatchObject({ ok: true, committed: false });
  expect(readFileSync(join(root, "libs/chart/src/widgets/chart.ts.baseline.json"), "utf8")).toBe('{"limit":1}\n');
  expect(fixtureGit(root, "log", "-1", "--format=%s")).toBe("chore: review preparer manifest");

  writeFileSync(join(root, "unrelated.txt"), "dirty\n");
  const extraDirty = await runIn(root, "preparer-commit", "--plan", planned.output);
  expect(extraDirty.code).not.toBe(0);
  expect(extraDirty.stderr).toContain("exactly the declared dirty paths");
  unlinkSync(join(root, "unrelated.txt"));

  writeFileSync(join(root, "libs/chart/src/widgets/chart.ts.baseline.json"), "tampered\n");
  const tampered = await runIn(root, "preparer-commit", "--plan", planned.output);
  expect(tampered.code).not.toBe(0);
  expect(tampered.stderr).toContain("differs from reviewed result");
  writeFileSync(join(root, "libs/chart/src/widgets/chart.ts.baseline.json"), '{"limit":1}\n');

  writeFileSync(join(root, ".git/hooks/pre-commit"), "#!/bin/sh\nprintf hook > hook-ran.txt\nexit 1\n");
  chmodSync(join(root, ".git/hooks/pre-commit"), 0o755);
  const committed = await runJsonIn<{ commit: string; next: string }>(root, "preparer-commit", "--plan", planned.output);
  expect(committed.commit).toHaveLength(40);
  expect(committed.next).toContain("fresh extraction plan");
  expect(existsSync(join(root, "hook-ran.txt"))).toBe(false);
  expect(fixtureGit(root, "log", "-1", "--format=%s")).toBe("chore: update quality ratchet");
}, 30_000);

test("preparer apply refuses bytes changed after manifest approval", async () => {
  const root = committedWorkspace();
  const configPath = join(root, "monocarve.config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  config.preparers = [{ id: "ratchet", phase: "pre-extraction", command: "mkdir -p libs/chart && printf ok > {packageRoot}/ratchet.txt", outputs: ["{packageRoot}/ratchet.txt"], commit: { subject: "chore: update ratchet" } }];
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  fixtureGit(root, "add", "--", "monocarve.config.json");
  fixtureGit(root, "commit", "-qm", "test: configure preparer");
  mkdirSync(join(root, ".monocarve/plans"), { recursive: true });
  const extractionPath = ".monocarve/plans/extraction.json";
  writeFileSync(join(root, extractionPath), `${stableStringify(extractionManifest(root), 2)}\n`);
  const planned = await runJsonIn<{ output: string }>(root, "preparer-plan", "--extraction", extractionPath, "--preparer", "ratchet", "--source", "apps/web/src/widgets/chart.ts", "--write");
  fixtureGit(root, "add", "-f", "--", planned.output);
  fixtureGit(root, "commit", "-qm", "chore: review preparer manifest");
  writeFileSync(join(root, planned.output), ` ${readFileSync(join(root, planned.output), "utf8")}`);

  const result = await runIn(root, "preparer-apply", "--plan", planned.output);
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("do not match the reviewed committed manifest");
  expect(existsSync(join(root, "libs/chart/ratchet.txt"))).toBe(false);
}, 30_000);

function extractionManifest(root: string): ExtractionManifest {
  const source = "apps/web/src/widgets/chart.ts";
  const target = "libs/chart/src/widgets/chart.ts";
  const hash = hashText(readFileSync(join(root, source), "utf8"));
  return {
    schemaVersion: 2, planId: "reviewed-extraction", createdAt: "2026-01-01T00:00:00.000Z",
    generator: { name: "fixture", version: "1" }, baselineCommit: fixtureGit(root, "rev-parse", "HEAD"),
    graphDigest: hashText("graph"), application: "web",
    target: { packageName: "@acme/chart", packageRoot: "libs/chart", entrypoint: "src/index.ts", requiredExports: [] },
    source: { files: [source], tests: [], sccs: { [source]: [source] } },
    dependencies: { runtime: {}, dev: {}, packageReferences: [] }, sourceBlobs: { [source]: hash },
    operations: [{ kind: "move", source, target, preconditionHash: hash, resultHash: hash }],
    consumers: [], generatedFiles: [], changedFiles: [source, target],
    expectedDynamicImportDelta: { added: [], removed: [] }, evaluationEffects: [],
    metrics: { movedFiles: 1, movedLines: 1, applicationLinesBefore: 1, applicationLinesAfter: 0, consumers: 0 },
    commits: { move: { subject: "refactor: move" }, wiring: { subject: "refactor: wire" } },
    gates: { package: [], project: [], workspace: [] },
  };
}
