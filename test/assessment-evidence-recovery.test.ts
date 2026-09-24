import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { EvidenceError, publishEvidence } from "../src/assessment/evidence.ts";
import { scratchDirectory } from "./support/fixture-repo.ts";

const baseOptions = (rootDir: string) => ({
  rootDir,
  destination: "evidence",
  analyticalRoots: ["src"],
  artifacts: { "summary.json": "summary\n" },
  requiredArtifacts: new Set(["summary.json"]),
  manifest: () => ({ kind: "architecture-assessment" as const }),
});

test("a competing writer cannot disturb the winner's target or recovery residue", () => {
  const root = scratchDirectory();
  mkdirSync(join(root, "evidence.lock"));
  mkdirSync(join(root, "evidence.staging"));
  mkdirSync(join(root, "evidence.backup"));
  writeFileSync(join(root, "evidence.staging/marker"), "first writer staging\n");
  writeFileSync(join(root, "evidence.backup/marker"), "first writer backup\n");
  writeFileSync(join(root, "evidence.recovery.json"), '{"phase":"prior-preserved"}\n');

  const before = operationalState(root);
  expect(() => publishEvidence({ ...baseOptions(root), artifacts: { "summary.json": "second writer\n" } })).toThrow(EvidenceError);
  expect(() => publishEvidence({ ...baseOptions(root), artifacts: { "summary.json": "second writer\n" } })).toThrow("EVIDENCE_DESTINATION_BUSY");
  expect(operationalState(root)).toEqual(before);
});

test("caught failures after publication restore the prior bundle and remove owned residue", () => {
  for (const failure of ["before-recovery", "published", "cleanup-before-backup"] as const) {
    const root = scratchDirectory();
    publishEvidence(baseOptions(root));
    const before = operationalState(root);

    expect(() =>
      publishEvidence({
        ...baseOptions(root),
        artifacts: { "summary.json": "replacement\n" },
        replaceGenerated: true,
        ...(failure === "published"
          ? { failAfter: "published" as const }
          : {
              testPhaseHook: (phase: string) => {
                if (phase === (failure === "before-recovery" ? "published-before-recovery" : failure))
                  throw new Error("injected evidence failure during cleanup");
              },
            }),
      }),
    ).toThrow("injected evidence failure");

    expect(operationalState(root)).toEqual(before);
    expect(readFileSync(join(root, "evidence/summary.json"), "utf8")).toBe("summary\n");
  }
});

test("caught first-publication failure after rename leaves no authoritative bundle", () => {
  for (const failure of ["published-renamed-before-sync", "published", "cleanup-before-backup"] as const) {
    const root = scratchDirectory();
    expect(() =>
      publishEvidence({
        ...baseOptions(root),
        ...(failure === "published"
          ? { failAfter: "published" as const }
          : {
              testPhaseHook: (phase: string) => {
                if (phase === failure) throw new Error("injected evidence failure during cleanup");
              },
            }),
      }),
    ).toThrow("injected evidence failure");
    expect(existsSync(join(root, "evidence"))).toBeFalse();
    expect(operationalState(root)).toEqual({});
  }
});

test("caught failures between directory rename and sync restore the prior bundle", () => {
  for (const failure of ["prior-renamed-before-sync", "published-renamed-before-sync"] as const) {
    const root = scratchDirectory();
    publishEvidence(baseOptions(root));
    const before = operationalState(root);
    expect(() =>
      publishEvidence({
        ...baseOptions(root),
        artifacts: { "summary.json": "replacement\n" },
        replaceGenerated: true,
        testPhaseHook: (phase) => {
          if (phase === failure) throw new Error("injected sync failure");
        },
      }),
    ).toThrow("injected sync failure");
    expect(operationalState(root)).toEqual(before);
  }
});

test("partial or complete backup removal failure preserves the new bundle and recovery state", () => {
  for (const failure of ["backup-removal-started", "backup-removed"] as const) {
    const root = scratchDirectory();
    publishEvidence(baseOptions(root));
    expect(() =>
      publishEvidence({
        ...baseOptions(root),
        artifacts: { "summary.json": "replacement\n" },
        replaceGenerated: true,
        testPhaseHook: (phase) => {
          if (phase !== failure) return;
          if (phase === "backup-removal-started") unlinkSync(join(root, "evidence.backup/summary.json"));
          throw new Error("injected backup cleanup failure");
        },
      }),
    ).toThrow("injected backup cleanup failure");
    expect(readFileSync(join(root, "evidence/summary.json"), "utf8")).toBe("replacement\n");
    expect(existsSync(join(root, "evidence.recovery.json"))).toBeTrue();
    let diagnosis = "";
    try {
      publishEvidence({ ...baseOptions(root), replaceGenerated: true });
    } catch (error) {
      diagnosis = String(error);
    }
    expect(diagnosis).toContain(failure === "backup-removal-started" ? "evidence.backup=incomplete-or-invalid" : "evidence.backup=absent");
    if (failure === "backup-removal-started") expect(diagnosis).toContain("matches-recorded-prior-hash");
    expect(diagnosis).toContain("evidence=intact manifest:");
    expect(diagnosis).toContain("matches-recorded-staged-hash");
  }
});

test("replacement refuses a forged prior artifact path before moving the prior bundle", () => {
  const root = scratchDirectory();
  publishEvidence(baseOptions(root));
  const manifestPath = join(root, "evidence/manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { artifacts: Array<{ path: string }> };
  manifest.artifacts[0]!.path = "../outside.txt";
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const before = readFileSync(manifestPath, "utf8");

  expect(() => publishEvidence({ ...baseOptions(root), replaceGenerated: true })).toThrow("EVIDENCE_REPLACEMENT_REFUSED");
  expect(readFileSync(manifestPath, "utf8")).toBe(before);
  expect(existsSync(join(root, "evidence.backup"))).toBeFalse();
  expect(existsSync(join(root, "evidence.staging"))).toBeFalse();
});

function operationalState(root: string): Record<string, string | string[]> {
  const state: Record<string, string | string[]> = {};
  for (const name of ["evidence", "evidence.lock", "evidence.staging", "evidence.backup"]) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    state[name] = readdirSync(path).sort();
    for (const entry of readdirSync(path)) {
      const nested = join(path, entry);
      try {
        state[`${name}/${entry}`] = readFileSync(nested, "utf8");
      } catch {
        /* directory */
      }
    }
  }
  const recovery = join(root, "evidence.recovery.json");
  if (existsSync(recovery)) state["evidence.recovery.json"] = readFileSync(recovery, "utf8");
  return state;
}
