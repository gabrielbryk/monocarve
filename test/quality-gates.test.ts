import { afterAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { findComplexityViolations } from "../scripts/quality/complexity-check.ts";
import { findLineViolations } from "../scripts/quality/max-file-lines.ts";
import { cleanupFixtures, scratchDirectory } from "./support/fixture-repo.ts";

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
