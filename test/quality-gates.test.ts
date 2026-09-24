import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { findComplexityRegressions, findComplexityViolations } from "../scripts/quality/complexity-check.ts";
import { findLineViolations } from "../scripts/quality/max-file-lines.ts";
import { cleanupFixtures, fixtureGit, scratchDirectory } from "./support/fixture-repo.ts";

afterAll(cleanupFixtures);

test("max-file-lines checks every configured code tree and reports exact excesses", () => {
  const root = join(scratchDirectory(), "line-gate");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "small.ts"), "one\ntwo\n");
  writeFileSync(join(root, "src", "large.ts"), "one\ntwo\nthree\n");
  expect(findLineViolations(root, ["src"], 2)).toEqual([
    { path: "src/large.ts", lines: 3, limit: 2 },
  ]);
});

test("complexity gate fails each regressed metric independently", () => {
  const record = {
    path: "/repo/src/hard.ts",
    structuralScore: 101,
    maxCognitive: 26,
    maxNest: 9,
    maxCyclo: 16,
    maxMethodLoc: 81,
    lever: "extract-method",
    leverReason: "fixture",
  };
  expect(findComplexityViolations([record])).toEqual([
    expect.objectContaining({ metric: "maxCognitive", actual: 26, limit: 25 }),
    expect.objectContaining({ metric: "maxCyclo", actual: 16, limit: 15 }),
    expect.objectContaining({ metric: "maxMethodLoc", actual: 81, limit: 80 }),
    expect.objectContaining({ metric: "maxNest", actual: 9, limit: 8 }),
    expect.objectContaining({ metric: "structuralScore", actual: 101, limit: 100 }),
  ]);
  expect(findComplexityViolations([{ ...record, structuralScore: 100, maxCognitive: 25, maxNest: 8, maxCyclo: 15, maxMethodLoc: 80 }])).toEqual([]);
});

test("complexity ratchet permits legacy debt but rejects new and worsened metrics", () => {
  const legacy = complexityRecord("src/legacy.ts", { maxCyclo: 20 });
  expect(findComplexityRegressions([legacy], [legacy])).toEqual([]);
  expect(findComplexityRegressions([{ ...legacy, maxCyclo: 21 }], [legacy])).toEqual([
    expect.objectContaining({ path: "src/legacy.ts", metric: "maxCyclo", actual: 21, limit: 20 }),
  ]);
  expect(findComplexityRegressions([complexityRecord("src/new.ts", { maxCyclo: 16 })], [])).toEqual([
    expect.objectContaining({ path: "src/new.ts", metric: "maxCyclo", actual: 16, limit: 15 }),
  ]);
});

test("complexity ratchet accepts an all-new directory without a HEAD baseline", () => {
  const root = join(scratchDirectory(), "complexity-new-directory");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "README.md"), "complexity fixture\n");
  fixtureGit(root, "init", "-q", "-b", "main");
  fixtureGit(root, "config", "user.email", "fixture@example.invalid");
  fixtureGit(root, "config", "user.name", "Complexity Fixture");
  fixtureGit(root, "add", "-A");
  fixtureGit(root, "commit", "-qm", "test: seed complexity fixture");
  mkdirSync(join(root, "src", "all-new"), { recursive: true });
  writeFileSync(join(root, "src", "all-new", "module.ts"), "export const value = 1;\nexport const next = 2;\n");
  const checker = join(import.meta.dir, "../scripts/quality/complexity-check.ts");
  const result = spawnSync(process.execPath, [checker, "src/all-new"], { cwd: root, encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(result.stderr).not.toContain("baseline complexity analyzer failed");
});

test("runtime branding literals remain confined to branding.ts", () => {
  const src = join(import.meta.dir, "../src");
  const offenders = walk(src).filter((path) => !path.endsWith("/branding.ts")).filter((path) =>
    /["'`]monocarve(?:@|["'`])/u.test(readFileSync(path, "utf8")),
  );
  expect(offenders).toEqual([]);
});

test("source extension lists remain centralized in config policy", () => {
  const src = join(import.meta.dir, "../src");
  const offenders = walk(src).filter((path) => !path.endsWith("/config/source-policy.ts")).filter((path) =>
    /const\s+[A-Z_]*(?:EXTENSIONS|SUFFIXES)\s*=\s*\[/u.test(readFileSync(path, "utf8")),
  );
  expect(offenders).toEqual([]);
});

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}

function complexityRecord(path: string, override: Partial<ReturnType<typeof complexityRecordShape>> = {}) {
  return { ...complexityRecordShape(path), ...override };
}

function complexityRecordShape(path: string) {
  return { path, structuralScore: 10, maxCognitive: 2, maxNest: 1, maxCyclo: 2, maxMethodLoc: 5, lever: "none", leverReason: "fixture" };
}
