import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { serializeManifest } from "../src/plan/build.ts";
import { hashText } from "../src/util/hash.ts";
import { inspectCommitChain } from "../src/transaction/commit-evidence.ts";
import { classifyLifecycle } from "../src/transaction/lifecycle-status.ts";
import { executeJournal } from "../src/transaction/journal.ts";
import { cleanupFixtures, fixtureConfig, fixtureGit, fixtureRepo, write } from "./support/fixture-repo.ts";
import { baseManifest, CONSUMER, DONOR, ENTRYPOINT, extractionFiles, TARGET } from "./support/transaction-fixture.ts";

function approve(root: string, manifest: ReturnType<typeof baseManifest>): string {
  const path = "plans/fixture-extraction.json";
  write(root, path, serializeManifest(manifest));
  fixtureGit(root, "add", "--", path);
  fixtureGit(root, "commit", "-qm", manifest.commits.plan!.subject);
  return path;
}

describe("transaction lifecycle evidence", () => {
  afterEach(cleanupFixtures);

  test("classifies the exact approval, application, and descendant boundaries", async () => {
    const root = fixtureRepo({ ...extractionFiles(), "quality-baseline.txt": "stable\n" });
    const config = fixtureConfig(root);
    const base = baseManifest(root);
    const manifest = {
      ...base,
      generatedFiles: [{
        path: "quality-baseline.txt", source: TARGET, regenerate: "true", regenerateOnApply: true as const,
        expectedHash: hashText("stable\n"), exemptReason: "unchanged post-journal fixture",
      }],
      changedFiles: [...base.changedFiles, "quality-baseline.txt"].sort(),
    };
    const manifestPath = approve(root, manifest);
    const approved = inspectCommitChain({ rootDir: root, manifest, manifestPath });
    expect(approved).toMatchObject({ valid: true, phase: "approved", laterCommitCount: 0 });
    expect(classifyLifecycle({ manifestPath, atBaseline: false, planWritten: true, chain: approved }).state).toBe("approved");

    write(root, TARGET, "export const widgetValue = 1;\n");
    fixtureGit(root, "rm", "-q", "--", DONOR);
    fixtureGit(root, "add", "--", TARGET);
    fixtureGit(root, "commit", "-qm", manifest.commits.move.subject);
    await executeJournal({ config, treeRoot: root, manifest: { ...manifest, operations: manifest.operations.filter((operation) => operation.kind !== "move") } });
    fixtureGit(root, "add", "--", CONSUMER, ENTRYPOINT, "pnpm-lock.yaml");
    fixtureGit(root, "commit", "-qm", manifest.commits.wiring.subject);
    const applied = inspectCommitChain({ rootDir: root, manifest, manifestPath });
    expect(applied).toMatchObject({ valid: true, phase: "applied", laterCommitCount: 0 });
    expect(classifyLifecycle({ manifestPath, atBaseline: false, planWritten: true, chain: applied, currentTreeValid: true }).state).toBe("applied");

    fixtureGit(root, "commit", "--allow-empty", "-qm", "docs: later history");
    const descendant = inspectCommitChain({ rootDir: root, manifest, manifestPath });
    expect(descendant.laterCommitCount).toBe(1);
    expect(classifyLifecycle({ manifestPath, atBaseline: false, planWritten: true, chain: descendant, currentTreeValid: true }).state).toBe("applied-with-later-commits");
  }, 120_000);

  test("a forged move subject and path cannot establish an applied boundary", () => {
    const root = fixtureRepo(extractionFiles());
    const manifest = baseManifest(root);
    const manifestPath = approve(root, manifest);
    write(root, TARGET, "export const forged = true;\n");
    fixtureGit(root, "rm", "-q", "--", DONOR);
    fixtureGit(root, "add", "--", TARGET);
    fixtureGit(root, "commit", "-qm", manifest.commits.move.subject);

    const evidence = inspectCommitChain({ rootDir: root, manifest, manifestPath });
    expect(evidence.valid).toBeFalse();
    expect(evidence.failures.join("\n")).toMatch(/R100|target bytes/);
    expect(classifyLifecycle({ manifestPath, atBaseline: false, planWritten: true, chain: evidence }).state).toBe("drifted");
  });

  test("receipt evidence is required for audited state and current-tree drift wins", () => {
    const chain = { valid: true, failures: [], laterCommitCount: 0, phase: "applied" as const, appliedCommit: "a" };
    expect(classifyLifecycle({ manifestPath: "plans/x.json", atBaseline: false, planWritten: true, chain, currentTreeValid: true, receipt: { valid: true } }).state).toBe("applied-and-audited");
    const drift = classifyLifecycle({ manifestPath: "plans/x.json", atBaseline: false, planWritten: true, chain, currentTreeValid: false, receipt: { valid: true } });
    expect(drift.state).toBe("drifted");
    expect(drift.next).toEqual(["monocarve", "audit", "--plan", "plans/x.json"]);
  });

  test("bare and structural failures choose conservative next commands", () => {
    expect(classifyLifecycle({ atBaseline: false, planWritten: false })).toMatchObject({
      state: "unknown", next: ["monocarve", "portfolio"],
    });
    const chain = { valid: true, failures: [], laterCommitCount: 0, phase: "applied" as const, appliedCommit: "a" };
    const structural = classifyLifecycle({ manifestPath: "plans/x.json", atBaseline: false, planWritten: true, chain,
      audit: { passed: false, reconcilable: false, failures: ["consumer boundary failed"] } });
    expect(structural).toMatchObject({ state: "drifted", failures: ["consumer boundary failed"], next: ["monocarve", "audit", "--plan", "plans/x.json"] });
    const bytes = classifyLifecycle({ manifestPath: "plans/x.json", atBaseline: false, planWritten: true, chain,
      audit: { passed: false, reconcilable: true, failures: ["byte mismatch"] } });
    expect(bytes).toMatchObject({ state: "drifted", failures: ["byte mismatch"], next: ["monocarve", "reconcile", "--plan", "plans/x.json"] });
  });

  test("wiring proof compares a repeatedly written path only to its final journal state", async () => {
    const root = fixtureRepo(extractionFiles());
    const config = fixtureConfig(root);
    const base = baseManifest(root);
    const first = 'export * from "./widget/widget.ts";\n';
    const final = `${first}// final journal state\n`;
    const operations = base.operations.flatMap((operation) => operation.kind === "write-file" && operation.path.endsWith("/src/index.ts")
      ? [
          { ...operation, contents: first, resultHash: hashText(first) },
          { ...operation, contents: final, preconditionHash: hashText(first), resultHash: hashText(final) },
        ]
      : [operation]);
    const manifest = { ...base, operations };
    const manifestPath = approve(root, manifest);
    write(root, TARGET, "export const widgetValue = 1;\n");
    fixtureGit(root, "rm", "-q", "--", DONOR);
    fixtureGit(root, "add", "--", TARGET);
    fixtureGit(root, "commit", "-qm", manifest.commits.move.subject);
    await executeJournal({ config, treeRoot: root, manifest: { ...manifest, operations: manifest.operations.filter((operation) => operation.kind !== "move") } });
    fixtureGit(root, "add", "--", CONSUMER, ENTRYPOINT, "pnpm-lock.yaml");
    fixtureGit(root, "commit", "-qm", manifest.commits.wiring.subject);

    const evidence = inspectCommitChain({ rootDir: root, manifest, manifestPath });
    expect(evidence).toMatchObject({ valid: true, phase: "applied" });

    write(root, "libs/analytics/src/index.ts", "wrong final bytes\n");
    fixtureGit(root, "add", "--", "libs/analytics/src/index.ts");
    fixtureGit(root, "commit", "--amend", "--no-edit", "-q");
    const forged = inspectCommitChain({ rootDir: root, manifest, manifestPath });
    expect(forged.valid).toBeFalse();
    expect(forged.failures).toContain("wiring bytes do not match the manifest: libs/analytics/src/index.ts");
  }, 120_000);

  test("proves approval, move, and wiring from a workspace nested inside its Git repository", async () => {
    const repository = fixtureRepo(extractionFiles());
    const config = fixtureConfig(repository);
    const manifestTemplate = baseManifest(repository);
    mkdirSync(join(repository, "workspace"));
    for (const path of ["package.json", "pnpm-lock.yaml", "apps", "libs", "monocarve.config.json"]) {
      renameSync(join(repository, path), join(repository, "workspace", path));
    }
    fixtureGit(repository, "add", "-A");
    fixtureGit(repository, "commit", "-qm", "test: nest synthetic workspace");
    const root = join(repository, "workspace");
    const manifest = { ...manifestTemplate, baselineCommit: fixtureGit(repository, "rev-parse", "HEAD") };
    const manifestPath = "plans/fixture-extraction.json";
    write(root, manifestPath, serializeManifest(manifest));
    fixtureGit(repository, "add", "--", `workspace/${manifestPath}`);
    fixtureGit(repository, "commit", "-qm", manifest.commits.plan!.subject);

    write(root, TARGET, "export const widgetValue = 1;\n");
    fixtureGit(repository, "rm", "-q", "--", `workspace/${DONOR}`);
    fixtureGit(repository, "add", "--", `workspace/${TARGET}`);
    fixtureGit(repository, "commit", "-qm", manifest.commits.move.subject);
    await executeJournal({ config, treeRoot: root, manifest: { ...manifest, operations: manifest.operations.filter((operation) => operation.kind !== "move") } });
    fixtureGit(repository, "add", "--", `workspace/${CONSUMER}`, `workspace/${ENTRYPOINT}`, "workspace/pnpm-lock.yaml");
    fixtureGit(repository, "commit", "-qm", manifest.commits.wiring.subject);

    expect(inspectCommitChain({ rootDir: root, manifest, manifestPath })).toMatchObject({ valid: true, phase: "applied" });
  }, 120_000);

  test("proves real move-only and wiring-only application chains", () => {
    const moveRoot = fixtureRepo(extractionFiles());
    fixtureConfig(moveRoot);
    const moveBase = baseManifest(moveRoot);
    const moveManifest = { ...moveBase, operations: moveBase.operations.filter((operation) => operation.kind === "move") };
    const movePath = approve(moveRoot, moveManifest);
    write(moveRoot, TARGET, "export const widgetValue = 1;\n");
    fixtureGit(moveRoot, "rm", "-q", "--", DONOR);
    fixtureGit(moveRoot, "add", "--", TARGET);
    fixtureGit(moveRoot, "commit", "-qm", moveManifest.commits.move.subject);
    const moveEvidence = inspectCommitChain({ rootDir: moveRoot, manifest: moveManifest, manifestPath: movePath });
    expect(moveEvidence).toMatchObject({ valid: true, phase: "applied", moveCommit: expect.any(String) });
    expect(moveEvidence.wiringCommit).toBeUndefined();

    const wiringRoot = fixtureRepo(extractionFiles());
    fixtureConfig(wiringRoot);
    const wiringBase = baseManifest(wiringRoot);
    const wiringOperation = wiringBase.operations.find((operation) => operation.kind === "write-file");
    if (wiringOperation?.kind !== "write-file") throw new Error("fixture has no write operation");
    const wiringManifest = { ...wiringBase, operations: [wiringOperation] };
    const wiringPath = approve(wiringRoot, wiringManifest);
    write(wiringRoot, wiringOperation.path, wiringOperation.contents);
    fixtureGit(wiringRoot, "add", "--", wiringOperation.path);
    fixtureGit(wiringRoot, "commit", "-qm", wiringManifest.commits.wiring.subject);
    const wiringEvidence = inspectCommitChain({ rootDir: wiringRoot, manifest: wiringManifest, manifestPath: wiringPath });
    expect(wiringEvidence).toMatchObject({ valid: true, phase: "applied", wiringCommit: expect.any(String) });
    expect(wiringEvidence.moveCommit).toBeUndefined();
  });
});
