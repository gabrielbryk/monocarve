import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, unlinkSync } from "node:fs";
import { delimiter, join } from "node:path";

import type { ExtractionManifest } from "../src/plan/manifest.ts";
import { hashText, stableStringify } from "../src/util/hash.ts";
import { cleanupFixtures, fixtureGit } from "./support/fixture-repo.ts";
import { CLI, ROOT, committedWorkspace, existsSync, readFileSync, runIn, runJsonIn, writeFileSync } from "./support/cli.ts";

afterAll(cleanupFixtures);

test("preparer CLI compiles, simulates, and explicitly journal-applies a nested destination output", async () => {
  const root = committedWorkspace();
  const configPath = join(root, "monocarve.config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  config.preparers = [{
    id: "quality-ratchet",
    phase: "pre-extraction",
    command: "mkdir -p libs/chart/src/widgets && printf '{\"limit\":1}\\n' > {targetPath}.baseline.json",
    // The source output is intentionally already satisfied. Commit must stage
    // only the effective baseline mutation, not demand every declared output
    // appear dirty.
    outputs: ["{targetPath}.baseline.json", "{sourcePath}"],
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

test("preparer bootstrap commits introducing config through hooks that require generated output", async () => {
  const root = committedWorkspace();
  writeFileSync(join(root, "generated-guide.md"), "stale output\n");
  fixtureGit(root, "add", "generated-guide.md");
  fixtureGit(root, "commit", "-qm", "test: seed stale generated guide");
  const configPath = join(root, "monocarve.config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  config.preparers = [{
    id: "sync-guides",
    phase: "pre-extraction",
    command: "printf 'current config output\\n' > generated-guide.md && printf 'new output\\n' > generated-new.md",
    outputs: ["generated-guide.md", "generated-new.md"],
    verify: "grep -q 'current config output' generated-guide.md && grep -q 'new output' generated-new.md",
    commit: { subject: "docs: sync generated guide" },
  }];
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  // `LC_ALL=C sort` is load-bearing, not decoration: glibc's en_US.UTF-8
  // collation ignores the leading `.`, so an ambient-locale `sort` puts
  // `monocarve.config.json` before `.monocarve/plans/…` and the comparison
  // below — written in byte order — fails for a staged set that is correct.
  writeFileSync(join(root, ".git/hooks/pre-commit"), [
    "#!/bin/sh",
    "set -eu",
    "! git diff --cached --name-only | grep -qx generated-guide.md",
    "test \"$(git diff --cached --name-only | LC_ALL=C sort)\" = \".monocarve/plans/bootstrap.preparer.json\nmonocarve.config.json\"",
    "git diff --quiet",
    "grep -q 'current config output' generated-guide.md",
    "grep -q 'new output' generated-new.md",
  ].join("\n"));
  chmodSync(join(root, ".git/hooks/pre-commit"), 0o755);
  writeFileSync(join(root, ".git/hooks/commit-msg"), "#!/bin/sh\ngrep -qx 'chore: configure guide sync' \"$1\"\n");
  chmodSync(join(root, ".git/hooks/commit-msg"), 0o755);

  const planned = await runJsonIn<{ output: string }>(root,
    "preparer-plan", "--preparer", "sync-guides", "--source", "monocarve.config.json",
    "--bootstrap-config", "monocarve.config.json", "--out", ".monocarve/plans/bootstrap.preparer.json", "--write");
  expect(readFileSync(join(root, "generated-guide.md"), "utf8")).toBe("stale output\n");
  expect(existsSync(join(root, "generated-new.md"))).toBe(false);
  const committed = await runJsonIn<{ commit: string }>(root, "preparer-bootstrap-commit", "--plan", planned.output, "--subject", "chore: configure guide sync");
  expect(committed.commit).toHaveLength(40);
  expect(readFileSync(join(root, "generated-guide.md"), "utf8")).toBe("stale output\n");
  expect(existsSync(join(root, "generated-new.md"))).toBe(false);
  expect(fixtureGit(root, "show", "--format=", "--name-only", "HEAD").split("\n").sort()).toEqual([".monocarve/plans/bootstrap.preparer.json", "monocarve.config.json"]);
  expect(await runJsonIn(root, "preparer-apply", "--plan", planned.output)).toMatchObject({ ok: true });
  expect(readFileSync(join(root, "generated-guide.md"), "utf8")).toBe("current config output\n");
}, 30_000);

test("preparer bootstrap fails closed and rolls back temporary outputs when a hook rejects", async () => {
  const root = committedWorkspace();
  const configPath = join(root, "monocarve.config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  config.preparers = [{ id: "sync", phase: "pre-extraction", command: "printf generated > generated.txt", outputs: ["generated.txt"], commit: { subject: "docs: sync" } }];
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(join(root, ".git/hooks/pre-commit"), "#!/bin/sh\ntest -f generated.txt\nexit 1\n");
  chmodSync(join(root, ".git/hooks/pre-commit"), 0o755);
  const planned = await runJsonIn<{ output: string }>(root, "preparer-plan", "--preparer", "sync", "--source", "monocarve.config.json", "--bootstrap-config", "monocarve.config.json", "--out", ".monocarve/plans/bootstrap.json", "--write");
  const baseline = fixtureGit(root, "rev-parse", "HEAD");
  const failed = await runIn(root, "preparer-bootstrap-commit", "--plan", planned.output, "--subject", "chore: configure sync");
  expect(failed.code).not.toBe(0);
  expect(existsSync(join(root, "generated.txt"))).toBe(false);
  expect(fixtureGit(root, "diff", "--cached", "--name-only")).toBe("");
  expect(fixtureGit(root, "rev-parse", "HEAD")).toBe(baseline);
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

test("preparer CLI plans and simulates a command-free declarative create", async () => {
  const root = committedWorkspace();
  const configPath = join(root, "monocarve.config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  config.preparers = [{
    id: "create-contract",
    phase: "pre-extraction",
    creates: [{ path: "{packageRoot}/src/contract.ts", contents: "export interface Contract {}\n", mode: 420 }],
    commit: { subject: "refactor: add contract" },
  }];
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  fixtureGit(root, "add", "--", "monocarve.config.json");
  fixtureGit(root, "commit", "-qm", "test: configure declarative create");
  const extractionPath = ".monocarve/plans/extraction.json";
  mkdirSync(join(root, ".monocarve/plans"), { recursive: true });
  writeFileSync(join(root, extractionPath), `${stableStringify(extractionManifest(root), 2)}\n`);

  const planned = await runJsonIn<{ output: string; mutations: { path: string; preconditionHash: string; resultMode: number }[] }>(root, "preparer-plan", "--extraction", extractionPath, "--preparer", "create-contract", "--source", "apps/web/src/widgets/chart.ts", "--write");
  expect(planned.mutations).toEqual([expect.objectContaining({ path: "libs/chart/src/contract.ts", preconditionHash: "missing", resultMode: 0o644 })]);
  expect(await runJsonIn(root, "preparer-simulate", "--plan", planned.output)).toMatchObject({ ok: true });
  expect(existsSync(join(root, "libs/chart/src/contract.ts"))).toBe(false);
}, 30_000);

test("preparer-plan keeps noisy successful disposable installs out of JSON stdout", async () => {
  const root = committedWorkspace();
  const configPath = join(root, "monocarve.config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  config.transaction = { nodeModules: "install", cleanup: true, simulateGates: true };
  config.preparers = [{
    id: "declarative-boundary",
    phase: "pre-extraction",
    outputs: ["apps/web/src/types.ts"],
    replacements: [{ path: "apps/web/src/types.ts", before: "export interface Point {", after: "export interface Coordinate {", suffix: "\n  x: number;" }],
    creates: [{ path: "libs/chart/src/contract.ts", contents: "export interface Contract {}\n" }],
    verify: "bash scripts/noisy-verify.sh",
    commit: { subject: "refactor: prepare boundary" },
  }];
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  mkdirSync(join(root, "scripts"), { recursive: true });
  const verifyScript = join(root, "scripts/noisy-verify.sh");
  writeFileSync(verifyScript, [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "bash -c 'sleep 0.15; awk \"BEGIN { for (i = 0; i < 300000; i++) printf \\\"nested gate output %06d\\\\n\\\", i }\"'",
    "test -s libs/chart/src/contract.ts",
    "(sleep 2; printf 'late inherited-pipe output\\n') &",
    "exit 0",
    "",
  ].join("\n"));
  chmodSync(verifyScript, 0o755);
  fixtureGit(root, "add", "--", "monocarve.config.json", "scripts/noisy-verify.sh");
  fixtureGit(root, "commit", "-qm", "test: configure noisy install preparer");

  const bin = join(root, "test-bin");
  mkdirSync(bin, { recursive: true });
  const fakePnpm = join(bin, "pnpm");
  writeFileSync(fakePnpm, "#!/bin/sh\necho NOISY_INSTALL_OUTPUT\nexit 0\n");
  chmodSync(fakePnpm, 0o755);
  const output = ".monocarve/plans/noisy.preparer.json";
  const started = Date.now();
  const child = Bun.spawn([
    "bun", CLI, "--cwd", root, "preparer-plan", "--preparer", "declarative-boundary",
    "--source", "apps/web/src/types.ts", "--out", output, "--write", "--json",
  ], {
    cwd: ROOT,
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);

  expect(code, `${stderr}\n${stdout}`).toBe(0);
  const duration = Date.now() - started;
  expect(duration).toBeGreaterThanOrEqual(100);
  expect(duration).toBeLessThan(1_500);
  expect(stderr).toBe("");
  expect(stdout).not.toContain("NOISY_INSTALL_OUTPUT");
  expect(stdout).not.toContain("nested gate output");
  expect(stdout).not.toContain("late inherited-pipe output");
  const report = JSON.parse(stdout) as { output: string; written: boolean };
  expect(report).toMatchObject({ output, written: true });
  expect(existsSync(join(root, output))).toBe(true);
  expect(JSON.parse(readFileSync(join(root, output), "utf8"))).toMatchObject({ preparer: { id: "declarative-boundary" } });
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
