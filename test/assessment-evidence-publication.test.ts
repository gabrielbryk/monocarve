import { expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import type { DeclarationBatchResult } from "../src/assessment/batch.ts";
import { publishAssessment, publishDeclarationBatch, type AssessmentAnalyticalArguments } from "../src/assessment/bundle.ts";
import { publishEvidence, type EvidenceManifestBase, type PublishEvidenceOptions } from "../src/assessment/evidence.ts";
import type { AssessmentReports } from "../src/assessment/reports.ts";
import type { AssessmentSnapshot } from "../src/assessment/snapshot.ts";
import { byCodeUnit, hashBytes } from "../src/util/hash.ts";
import { scratchDirectory } from "./support/fixture-repo.ts";

const CHILD = join(import.meta.dir, "support/evidence-publisher-child.ts");

function options(rootDir: string, contents = "summary\n"): PublishEvidenceOptions<EvidenceManifestBase> {
  return {
    rootDir,
    destination: "evidence",
    analyticalRoots: ["src"],
    artifacts: { "raw/app.json": "raw\n", "summary.json": contents },
    requiredArtifacts: new Set(["raw/app.json", "summary.json"]),
    manifest: () => ({ kind: "architecture-assessment" }),
  };
}

function publishPrior(root: string): void {
  publishEvidence(options(root, "old summary\n"));
}

test("publication rejects traversal, escaping symlinks, and malformed generated inventories before publication", () => {
  const root = scratchDirectory();
  const outside = scratchDirectory();
  symlinkSync(outside, join(root, "escape"), "dir");
  for (const destination of ["../evidence", "nested/../evidence", "./evidence", "escape/evidence", "/tmp/evidence"]) {
    expect(() => publishEvidence({ ...options(root), destination })).toThrow("EVIDENCE_DESTINATION_UNSAFE");
  }
  for (const path of ["../summary.json", "/summary.json", "nested/../../summary.json", "manifest.json"]) {
    expect(() => publishEvidence({ ...options(root), artifacts: { [path]: "bad\n" }, requiredArtifacts: new Set([path]) })).toThrow(
      "EVIDENCE_REPLACEMENT_REFUSED",
    );
  }
  expect(() => publishEvidence({ ...options(root), artifacts: { a: "file\n", "a/b": "nested\n" }, requiredArtifacts: new Set(["a"]) })).toThrow("collide");
  expect(() => publishEvidence({ ...options(root), requiredArtifacts: new Set(["raw/app.json", "missing.json"]) })).toThrow(
    "required artifacts were not generated",
  );
  expect(existsSync(join(root, "evidence"))).toBeFalse();
});

test("dangling destination and backup entries are preserved, including entries appearing after staging", () => {
  for (const kind of ["architecture-assessment", "declaration-analysis-batch"] as const) {
    const targetRoot = scratchDirectory();
    const danglingTarget = join(targetRoot, "evidence");
    symlinkSync(join(targetRoot, "missing-target"), danglingTarget);
    expect(() => publishEvidence({ ...options(targetRoot), manifest: () => ({ kind }) })).toThrow("EVIDENCE_REPLACEMENT_REFUSED");
    expect(readlinkSync(danglingTarget)).toBe(join(targetRoot, "missing-target"));
    expect(operationalPaths(targetRoot)).toEqual([]);

    const backupRoot = scratchDirectory();
    const danglingBackup = join(backupRoot, "evidence.backup");
    symlinkSync(join(backupRoot, "missing-backup"), danglingBackup);
    expect(() => publishEvidence({ ...options(backupRoot), manifest: () => ({ kind }) })).toThrow("EVIDENCE_RECOVERY_REQUIRED");
    expect(readlinkSync(danglingBackup)).toBe(join(backupRoot, "missing-backup"));

    for (const sibling of ["evidence", "evidence.backup"] as const) {
      const raceRoot = scratchDirectory();
      const racedPath = join(raceRoot, sibling);
      expect(() =>
        publishEvidence({
          ...options(raceRoot),
          manifest: () => ({ kind }),
          testPhaseHook: (phase) => {
            if (phase === "staged") symlinkSync(join(raceRoot, `missing-${sibling}`), racedPath);
          },
        }),
      ).toThrow(sibling === "evidence" ? "EVIDENCE_REPLACEMENT_REFUSED" : "EVIDENCE_RECOVERY_REQUIRED");
      expect(readlinkSync(racedPath)).toBe(join(raceRoot, `missing-${sibling}`));
      expect(existsSync(join(raceRoot, "evidence.staging"))).toBeFalse();
    }
  }
});

test("replacement refuses duplicate, unsorted, modified, missing, and symlink-owned prior artifacts without moving them", () => {
  const mutations: Array<(root: string, manifest: Record<string, unknown>) => void> = [
    (_root, manifest) => {
      const artifacts = manifest.artifacts as Array<Record<string, unknown>>;
      artifacts.push({ ...artifacts[0]! });
    },
    (_root, manifest) => {
      (manifest.artifacts as unknown[]).reverse();
    },
    (_root, manifest) => {
      (manifest.artifacts as Array<Record<string, unknown>>)[0]!.path = "/outside.txt";
    },
    (root) => {
      writeFileSync(join(root, "evidence/summary.json"), "modified\n");
    },
    (root) => {
      unlinkSync(join(root, "evidence/summary.json"));
    },
    (root) => {
      unlinkSync(join(root, "evidence/summary.json"));
      symlinkSync(join(root, "evidence/raw/app.json"), join(root, "evidence/summary.json"));
    },
  ];
  for (const mutate of mutations) {
    const root = scratchDirectory();
    publishPrior(root);
    const manifestPath = join(root, "evidence/manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    mutate(root, manifest);
    if (JSON.stringify(manifest) !== readFileSync(manifestPath, "utf8").trim()) {
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    }
    const before = treeState(root, "evidence");
    expect(() => publishEvidence({ ...options(root, "new\n"), replaceGenerated: true })).toThrow("EVIDENCE_REPLACEMENT_REFUSED");
    expect(treeState(root, "evidence")).toEqual(before);
    expect(existsSync(join(root, "evidence.backup"))).toBeFalse();
  }
});

test("replacement refuses unrelated empty directories and preserves them", () => {
  const root = scratchDirectory();
  publishPrior(root);
  const unrelated = join(root, "evidence/unrelated-empty");
  mkdirSync(unrelated);
  const before = treeState(root, "evidence");

  expect(() => publishEvidence({ ...options(root, "new\n"), replaceGenerated: true })).toThrow("EVIDENCE_REPLACEMENT_REFUSED");
  expect(treeState(root, "evidence")).toEqual(before);
  expect(lstatSync(unrelated).isDirectory()).toBeTrue();
  expect(readdirSync(unrelated)).toEqual([]);
  expect(existsSync(join(root, "evidence.backup"))).toBeFalse();
});

test("prior bytes and destination identity are revalidated immediately before replacement", () => {
  const root = scratchDirectory();
  publishPrior(root);
  expect(() =>
    publishEvidence({
      ...options(root, "new\n"),
      replaceGenerated: true,
      testPhaseHook: (phase) => {
        if (phase === "staged") writeFileSync(join(root, "evidence/summary.json"), "changed after validation\n");
      },
    }),
  ).toThrow("prior artifact does not match");
  expect(readFileSync(join(root, "evidence/summary.json"), "utf8")).toBe("changed after validation\n");
  expect(operationalPaths(root)).toEqual([]);

  const second = scratchDirectory();
  publishPrior(second);
  expect(() =>
    publishEvidence({
      ...options(second, "new\n"),
      replaceGenerated: true,
      testPhaseHook: (phase) => {
        if (phase !== "staged") return;
        renameSync(join(second, "evidence"), join(second, "evidence.swapped"));
        mkdirSync(join(second, "evidence"));
      },
    }),
  ).toThrow("prior evidence destination changed");
  expect(existsSync(join(second, "evidence.backup"))).toBeFalse();
});

test("input drift detected at the final rename boundary preserves the prior bundle", () => {
  const root = scratchDirectory();
  const input = join(root, "assessment-input.txt");
  writeFileSync(input, "captured\n");
  publishPrior(root);
  const prior = treeState(root, "evidence");
  expect(() =>
    publishEvidence({
      ...options(root, "new\n"),
      replaceGenerated: true,
      testPhaseHook: (phase) => {
        if (phase === "staged") writeFileSync(input, "drifted\n");
      },
      verifyBeforeRename: () => {
        if (readFileSync(input, "utf8") !== "captured\n") throw new Error("assessment input drift detected");
      },
    }),
  ).toThrow("assessment input drift detected");
  expect(treeState(root, "evidence")).toEqual(prior);
  expect(operationalPaths(root)).toEqual([]);
});

test("assessment and batch publication revalidate snapshot authority after staging", () => {
  for (const kind of ["assessment", "batch"] as const) {
    const root = scratchDirectory();
    publishPrior(root);
    const prior = treeState(root, "evidence");
    let drifted = false;
    const snapshot = publicationSnapshot(root, () => {
      if (drifted) throw new Error(`${kind} analytical input drift detected`);
    });
    const testPhaseHook = (phase: string): void => {
      if (phase === "staged") drifted = true;
    };

    const publish = (): unknown =>
      kind === "assessment"
        ? publishAssessment({
            snapshot,
            reports: publicationReports(),
            destination: "evidence",
            analyticalRoots: ["src"],
            arguments: assessmentArguments,
            replaceGenerated: true,
            testPhaseHook,
          })
        : publishDeclarationBatch({
            snapshot,
            batch: publicationBatch(snapshot),
            destination: "evidence",
            analyticalRoots: ["src"],
            arguments: batchArguments,
            replaceGenerated: true,
            testPhaseHook,
          });

    expect(publish).toThrow(`${kind} analytical input drift detected`);
    expect(treeState(root, "evidence")).toEqual(prior);
    expect(operationalPaths(root)).toEqual([]);
  }
});

test("a real competing process receives busy and cannot alter the active writer's files", async () => {
  const root = scratchDirectory();
  publishPrior(root);
  symlinkSync(".", join(root, "alias"), "dir");
  const child = await blockedPublisher(root, "staged");
  const before = treeState(root);
  expect(() => publishEvidence({ ...options(root, "loser\n"), destination: "alias/evidence", replaceGenerated: true })).toThrow("EVIDENCE_DESTINATION_BUSY");
  expect(treeState(root)).toEqual(before);
  child.kill("SIGKILL");
  await child.exited;
});

test("process termination at every durable phase leaves only whole bundles and requires non-destructive recovery", async () => {
  for (const phase of ["staged", "prior-preserved", "published"] as const) {
    const root = scratchDirectory();
    publishPrior(root);
    const old = treeState(root, "evidence");
    const child = await blockedPublisher(root, phase);
    child.kill("SIGKILL");
    await child.exited;

    if (phase === "staged") expect(treeState(root, "evidence")).toEqual(old);
    if (phase === "prior-preserved") expect(existsSync(join(root, "evidence"))).toBeFalse();
    if (phase === "published") expect(readFileSync(join(root, "evidence/summary.json"), "utf8")).toBe("new summary\n");
    const beforeRetry = treeState(root);
    expect(() => publishEvidence({ ...options(root, "retry\n"), replaceGenerated: true })).toThrow("EVIDENCE_RECOVERY_REQUIRED");
    expect(treeState(root)).toEqual(beforeRetry);
  }
});

test("recovery diagnoses a recorded phase that lags a completed publication rename", async () => {
  const root = scratchDirectory();
  publishPrior(root);
  const child = await blockedPublisher(root, "published-before-recovery");
  child.kill("SIGKILL");
  await child.exited;
  expect(JSON.parse(readFileSync(join(root, "evidence.recovery.json"), "utf8"))).toMatchObject({ phase: "prior-preserved" });
  expect(readFileSync(join(root, "evidence/summary.json"), "utf8")).toBe("new summary\n");
  expect(existsSync(join(root, "evidence.staging"))).toBeFalse();
  expect(existsSync(join(root, "evidence.backup"))).toBeTrue();
  const before = treeState(root);
  expect(() => publishEvidence({ ...options(root), replaceGenerated: true })).toThrow("recorded phase=prior-preserved");
  expect(treeState(root)).toEqual(before);
});

test("caught failure after preserving a prior bundle restores every prior byte and removes owned residue", () => {
  const root = scratchDirectory();
  publishPrior(root);
  const before = treeState(root, "evidence");
  expect(() => publishEvidence({ ...options(root, "new\n"), replaceGenerated: true, failAfter: "prior-preserved" })).toThrow("injected evidence failure");
  expect(treeState(root, "evidence")).toEqual(before);
  expect(operationalPaths(root)).toEqual([]);
});

test("caught staged hook failure removes its own recovery record and stage", () => {
  const root = scratchDirectory();
  expect(() =>
    publishEvidence({
      ...options(root),
      testPhaseHook: (phase) => {
        if (phase === "staged") throw new Error("injected staged hook failure");
      },
    }),
  ).toThrow("injected staged hook failure");
  expect(existsSync(join(root, "evidence"))).toBeFalse();
  expect(operationalPaths(root)).toEqual([]);
});

test("a recovery file replaced at the staged boundary is preserved without truncation", () => {
  const root = scratchDirectory();
  const recovery = join(root, "evidence.recovery.json");
  const displaced = join(root, "original-recovery.json");
  expect(() =>
    publishEvidence({
      ...options(root),
      testPhaseHook: (phase) => {
        if (phase !== "staged") return;
        renameSync(recovery, displaced);
        writeFileSync(recovery, "foreign recovery bytes\n");
      },
    }),
  ).toThrow("recovery record changed");
  expect(readFileSync(recovery, "utf8")).toBe("foreign recovery bytes\n");
});

test("publication cleanup preserves backup and recovery entries replaced after publication", () => {
  const root = scratchDirectory();
  publishPrior(root);
  const backup = join(root, "evidence.backup");
  const recovery = join(root, "evidence.recovery.json");
  const foreignBackup = join(root, "foreign-backup");
  const foreignRecovery = join(root, "foreign-recovery");
  expect(() =>
    publishEvidence({
      ...options(root, "new\n"),
      replaceGenerated: true,
      testPhaseHook: (phase) => {
        if (phase !== "published") return;
        renameSync(backup, foreignBackup);
        mkdirSync(backup);
        writeFileSync(join(backup, "foreign.txt"), "foreign backup\n");
        renameSync(recovery, foreignRecovery);
        writeFileSync(recovery, "foreign recovery\n");
      },
    }),
  ).toThrow("preserved prior bundle changed");
  expect(readFileSync(join(backup, "foreign.txt"), "utf8")).toBe("foreign backup\n");
  expect(readFileSync(foreignRecovery, "utf8")).toContain('"phase": "published"');
  expect(readFileSync(recovery, "utf8")).toBe("foreign recovery\n");
});

test("lock release preserves changed owner contents in the same lock directory", () => {
  const root = scratchDirectory();
  const owner = join(root, "evidence.lock/owner.json");
  expect(() =>
    publishEvidence({
      ...options(root),
      testPhaseHook: (phase) => {
        if (phase === "published") writeFileSync(owner, "foreign owner\n");
      },
    }),
  ).toThrow("publication lock owner changed");
  expect(readFileSync(owner, "utf8")).toBe("foreign owner\n");
});

test("lock release preserves an identical-byte owner replacement and unexpected entries", () => {
  for (const mutation of ["same-byte-owner", "extra-entry"] as const) {
    const root = scratchDirectory();
    const lock = join(root, "evidence.lock");
    const owner = join(lock, "owner.json");
    const extra = join(lock, "foreign.txt");
    expect(() =>
      publishEvidence({
        ...options(root),
        testPhaseHook: (phase) => {
          if (phase !== "published") return;
          if (mutation === "same-byte-owner") {
            const bytes = readFileSync(owner);
            unlinkSync(owner);
            writeFileSync(owner, bytes);
          } else {
            writeFileSync(extra, "foreign lock entry\n");
          }
        },
      }),
    ).toThrow(mutation === "same-byte-owner" ? "publication lock owner changed" : "publication lock directory contents changed");
    if (mutation === "same-byte-owner") expect(existsSync(owner)).toBeTrue();
    else expect(readFileSync(extra, "utf8")).toBe("foreign lock entry\n");
    expect(() => publishEvidence(options(root))).toThrow("EVIDENCE_DESTINATION_BUSY");
    expect(existsSync(lock)).toBeTrue();
  }
});

test("caught failures preserve swapped staging, recovery, and lock entries and refuse the next publication", () => {
  for (const entry of ["stage", "recovery", "lock"] as const) {
    const root = scratchDirectory();
    const foreign = join(root, `foreign-${entry}`);
    const occupied = join(root, entry === "stage" ? "evidence.staging" : entry === "recovery" ? "evidence.recovery.json" : "evidence.lock");
    expect(() =>
      publishEvidence({
        ...options(root),
        failAfter: "staged",
        testPhaseHook: (phase) => {
          if (phase !== "staged") return;
          if (entry === "stage") {
            renameSync(occupied, foreign);
            mkdirSync(occupied);
            writeFileSync(join(occupied, "foreign.txt"), "foreign stage\n");
          } else {
            renameSync(occupied, foreign);
            if (entry === "recovery") writeFileSync(occupied, "foreign recovery\n");
            else {
              mkdirSync(occupied);
              writeFileSync(join(occupied, "owner.json"), "foreign lock\n");
            }
          }
        },
      }),
    ).toThrow("injected evidence failure");
    expect(existsSync(occupied)).toBeTrue();
    if (entry === "stage") expect(readFileSync(join(occupied, "foreign.txt"), "utf8")).toBe("foreign stage\n");
    if (entry === "recovery") expect(readFileSync(occupied, "utf8")).toBe("foreign recovery\n");
    if (entry === "lock") expect(readFileSync(join(occupied, "owner.json"), "utf8")).toBe("foreign lock\n");
    expect(() => publishEvidence(options(root))).toThrow(entry === "lock" ? "EVIDENCE_DESTINATION_BUSY" : "EVIDENCE_RECOVERY_REQUIRED");
  }
});

test("caught rollback preserves same-inode recovery residue whose bytes no longer match an owned phase", () => {
  const root = scratchDirectory();
  const recovery = join(root, "evidence.recovery.json");
  expect(() =>
    publishEvidence({
      ...options(root),
      failAfter: "staged",
      testPhaseHook: (phase) => {
        if (phase === "staged") writeFileSync(recovery, "uncertain recovery bytes\\n");
      },
    }),
  ).toThrow("injected evidence failure");
  expect(readFileSync(recovery, "utf8")).toBe("uncertain recovery bytes\\n");
  expect(() => publishEvidence(options(root))).toThrow("EVIDENCE_RECOVERY_REQUIRED");
});

test("budget accounting includes the canonical manifest and preserves prior evidence on every failure", () => {
  const probe = scratchDirectory();
  const artifacts = { "optional/full.json": "x".repeat(4_096), "raw/app.json": "raw\n" };
  const required = new Set(["raw/app.json"]);
  const result = publishEvidence({ ...options(probe), artifacts, requiredArtifacts: required });
  expect(result.totalBytes).toBe(bundleBytes(join(probe, "evidence")));
  expect(result.manifest.artifacts.map((entry) => entry.path)).toEqual(["optional/full.json", "raw/app.json"]);
  expect(result.manifest.artifacts.some((entry) => entry.path === "manifest.json")).toBeFalse();

  const root = scratchDirectory();
  publishPrior(root);
  const before = treeState(root, "evidence");
  for (const maxBytes of [0, -1, 1.5, Number.NaN]) {
    expect(() => publishEvidence({ ...options(root), replaceGenerated: true, maxBytes })).toThrow("positive integer");
    expect(treeState(root, "evidence")).toEqual(before);
  }
  expect(() => publishEvidence({ ...options(root), artifacts, requiredArtifacts: required, replaceGenerated: true, maxBytes: result.totalBytes - 1 })).toThrow(
    "omit only requested optional evidence (optional/full.json)",
  );
  expect(treeState(root, "evidence")).toEqual(before);
  expect(operationalPaths(root)).toEqual([]);
});

async function blockedPublisher(root: string, phase: string): Promise<ReturnType<typeof Bun.spawn>> {
  rmSync(join(root, ".publisher-ready"), { force: true });
  const child = Bun.spawn(["bun", CHILD, root, phase], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  const deadline = Date.now() + 5_000;
  while (!existsSync(join(root, ".publisher-ready")) && Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`publisher exited before ${phase}: ${await new Response(child.stderr).text()}`);
    await Bun.sleep(10);
  }
  if (!existsSync(join(root, ".publisher-ready"))) {
    child.kill("SIGKILL");
    throw new Error(`publisher did not reach ${phase}`);
  }
  return child;
}

function operationalPaths(root: string): string[] {
  return readdirSync(root)
    .filter((name) => /^evidence\.(?:backup|lock|recovery\.json|staging)$/u.test(name))
    .toSorted(byCodeUnit);
}

function treeState(root: string, subtree = ""): Record<string, string> {
  const base = join(root, subtree);
  const state: Record<string, string> = {};
  if (!existsSync(base)) return state;
  const visit = (path: string): void => {
    const name = relative(root, path).replaceAll("\\", "/");
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      state[name] = `link:${readlinkSync(path)}`;
      return;
    }
    if (stat.isDirectory()) {
      state[name] = "directory";
      for (const child of readdirSync(path).sort(byCodeUnit)) visit(join(path, child));
      return;
    }
    const bytes = readFileSync(path);
    state[name] = `${bytes.byteLength}:${hashBytes(bytes)}`;
  };
  visit(base);
  return state;
}

function bundleBytes(root: string): number {
  return readdirSync(root, { withFileTypes: true }).reduce((total, entry) => {
    const path = join(root, entry.name);
    return total + (entry.isDirectory() ? bundleBytes(path) : lstatSync(path).size);
  }, 0);
}

const assessmentArguments: AssessmentAnalyticalArguments = { application: "web", limit: 1, fullPortfolio: false, splitSelection: { mode: "none" } };
const batchArguments: AssessmentAnalyticalArguments = {
  application: "web",
  limit: 1,
  fullPortfolio: false,
  splitSelection: { mode: "files", paths: ["src/input.ts"] },
};

function publicationSnapshot(rootDir: string, verify: AssessmentSnapshot["verify"]): AssessmentSnapshot {
  const baseline = {
    sourceCommit: "a".repeat(40),
    inputDigest: "b".repeat(64),
    configDigest: "c".repeat(64),
    graphDigest: "d".repeat(64),
    executable: { schemaVersion: 1, semanticVersion: "0.0.0-test", packagingMode: "source", compiler: { artifactIntegrity: "e".repeat(64) } },
    runtime: { schemaVersion: 1, bun: "test", node: "test", dependencies: {} },
  };
  return {
    schemaVersion: 1,
    mode: "live",
    rootDir,
    application: "web",
    reports: { web: { modules: [] } },
    baseline,
    inputInventory: {
      schemaVersion: 1,
      sourceCommit: baseline.sourceCommit,
      dirtyPaths: [],
      configDigest: baseline.configDigest,
      entries: [],
      directories: [],
      digest: baseline.inputDigest,
    },
    qualification: { schemaVersion: 1, status: "qualified", exitCode: 0, mayPublish: true, overrides: [], diagnostics: [] },
    verify,
  } as unknown as AssessmentSnapshot;
}

function publicationReports(): AssessmentReports {
  return { summary: {}, layers: {}, hotspots: {}, portfolio: {}, backlog: {}, findings: "# Assessment\n" } as unknown as AssessmentReports;
}

function publicationBatch(snapshot: AssessmentSnapshot): DeclarationBatchResult {
  const reportPath = "splits/src_input.ts.json";
  return {
    aggregate: {
      schemaVersion: 1,
      baseline: snapshot.baseline,
      application: "web",
      selection: { mode: "files", requested: 1, selected: 1, deduplicated: 0 },
      diagnostics: [],
      completed: ["src/input.ts"],
      failed: [],
      entries: [
        {
          sourcePath: "src/input.ts",
          reportPath,
          sourceHash: "f".repeat(64),
          declarationCount: 0,
          splitCandidateCount: 0,
          dominantAffinities: [],
          unclassifiedCount: 0,
          cycleCount: 0,
          status: "complete",
        },
      ],
    },
    reports: { [reportPath]: {} },
  } as unknown as DeclarationBatchResult;
}
