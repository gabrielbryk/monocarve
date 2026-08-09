/** Verification is observational and generator output declarations are exact. */
import { afterEach, describe, expect, test } from "bun:test";

import { applyPlan } from "../src/transaction/apply.ts";
import { simulatePlan } from "../src/transaction/simulate.ts";
import { verifyAppliedPlan } from "../src/transaction/verify.ts";
import type { ExtractionManifest } from "../src/plan/manifest.ts";
import { cleanupFixtures, fixtureConfig, fixtureGit, fixtureRepo } from "./support/fixture-repo.ts";
import { TARGET, baseManifest, extractionFiles, landManifest } from "./support/transaction-fixture.ts";

describe("transaction verification", () => {
  afterEach(cleanupFixtures);

  test("refuses a generator that writes outside its declared output set", async () => {
    const root = fixtureRepo(extractionFiles());
    const config = fixtureConfig(root, {
      postJournalPreparers: [{
        id: "incomplete-generator", phase: "after-journal-before-gates",
        command: "printf 'declared\\n' > quality-baseline.txt; printf 'hidden\\n' > undeclared.txt",
        outputs: ["quality-baseline.txt"],
      }],
    });
    const base = baseManifest(root);
    const manifest: ExtractionManifest = {
      ...base,
      generatedFiles: [{ path: "quality-baseline.txt", source: TARGET, regenerate: config.postJournalPreparers[0]!.command, regenerateOnApply: true, exemptReason: "fixture output", preparerId: "incomplete-generator" }],
      changedFiles: [...base.changedFiles, "quality-baseline.txt"].sort(),
    };

    const result = await simulatePlan({ config, rootDir: root, manifest, skipGates: true });
    expect(result.ok).toBeFalse();
    expect(result.failure).toContain("changed undeclared output(s): undeclared.txt");
    expect(fixtureGit(root, "status", "--short")).toBe("");
  }, 120_000);

  test("verifies an applied plan from lifecycle evidence without mutating the checkout", async () => {
    const root = fixtureRepo(extractionFiles());
    const config = fixtureConfig(root);
    const manifest = baseManifest(root);
    const manifestPath = landManifest(root, manifest);
    await applyPlan({ config, rootDir: root, manifest, manifestPath, commit: true });
    const before = fixtureGit(root, "status", "--porcelain=v1", "--untracked-files=all");
    const head = fixtureGit(root, "rev-parse", "HEAD");

    const result = await verifyAppliedPlan({ config, rootDir: root, manifest, manifestPath });

    expect(result).toMatchObject({ lifecycle: "applied", blockers: [], audit: { passed: true }, regeneration: { ok: true } });
    expect(fixtureGit(root, "status", "--porcelain=v1", "--untracked-files=all")).toBe(before);
    expect(fixtureGit(root, "rev-parse", "HEAD")).toBe(head);
  }, 120_000);
});
