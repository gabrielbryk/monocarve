/** Verification is observational and generator output declarations are exact. */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";

import type { ExtractionManifest } from "../src/plan/manifest.ts";
import {
  applyPreparerManifest,
  commitPreparerBootstrap,
  commitPreparerOutputs,
  compileStandalonePreparerManifest,
  serializePreparerManifest,
} from "../src/preparer/index.ts";
import { applyPlan } from "../src/transaction/apply.ts";
import { inspectCommitChain } from "../src/transaction/commit-evidence.ts";
import { simulatePlan } from "../src/transaction/simulate.ts";
import { verifyAppliedPlan } from "../src/transaction/verify.ts";
import { cleanupFixtures, fixtureConfig, fixtureGit, fixtureRepo } from "./support/fixture-repo.ts";
import { DONOR, TARGET, baseManifest, extractionFiles, landManifest } from "./support/transaction-fixture.ts";

describe("transaction verification", () => {
  afterEach(cleanupFixtures);

  test("refuses a generator that writes outside its declared output set", async () => {
    const root = fixtureRepo(extractionFiles());
    const config = fixtureConfig(root, {
      postJournalPreparers: [
        {
          id: "incomplete-generator",
          phase: "after-journal-before-gates",
          command: "printf 'declared\\n' > quality-baseline.txt; printf 'hidden\\n' > undeclared.txt",
          outputs: ["quality-baseline.txt"],
        },
      ],
    });
    const base = baseManifest(root);
    const manifest: ExtractionManifest = {
      ...base,
      generatedFiles: [
        {
          path: "quality-baseline.txt",
          source: TARGET,
          regenerate: config.postJournalPreparers[0]!.command!,
          regenerateOnApply: true,
          exemptReason: "fixture output",
          preparerId: "incomplete-generator",
        },
      ],
      changedFiles: [...base.changedFiles, "quality-baseline.txt"].toSorted(),
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

    const result = await verifyAppliedPlan({ config, configPath: `${root}/monocarve.config.json`, rootDir: root, manifest, manifestPath });

    expect(result).toMatchObject({ lifecycle: "applied", blockers: [], audit: { passed: true }, regeneration: { ok: true } });
    expect(fixtureGit(root, "status", "--porcelain=v1", "--untracked-files=all")).toBe(before);
    expect(fixtureGit(root, "rev-parse", "HEAD")).toBe(head);
  }, 120_000);

  test("accepts generator policy evolution only through an exact bootstrap and output commit", async () => {
    const root = fixtureRepo(extractionFiles());
    const oldCommand = "printf 'guide\\n' > generated-guide.md";
    const initial = fixtureConfig(root, {
      postJournalPreparers: [{ id: "guides", phase: "after-journal-before-gates", command: oldCommand, outputs: ["generated-guide.md"], triggers: [DONOR] }],
    });
    const base = baseManifest(root);
    const extraction: ExtractionManifest = {
      ...base,
      generatedFiles: [
        { path: "generated-guide.md", source: TARGET, regenerate: oldCommand, regenerateOnApply: true, exemptReason: "fixture guide", preparerId: "guides" },
      ],
      changedFiles: [...base.changedFiles, "generated-guide.md"].toSorted(),
    };
    const extractionPath = landManifest(root, extraction);
    expect(await applyPlan({ config: initial, rootDir: root, manifest: extraction, manifestPath: extractionPath, commit: true })).toMatchObject({ ok: true });

    const newCommand = "printf 'guide\\n' > generated-guide.md; printf 'backend\\n' > generated-backend-guide.md";
    const evolved = {
      ...initial,
      preparers: [
        {
          id: "reconcile-guides",
          phase: "pre-extraction" as const,
          command: newCommand,
          outputs: ["generated-backend-guide.md", "generated-guide.md"],
          commit: { subject: "docs: reconcile guides" },
        },
      ],
      postJournalPreparers: [
        {
          id: "guides",
          phase: "after-journal-before-gates" as const,
          command: newCommand,
          outputs: ["generated-backend-guide.md", "generated-guide.md"],
          triggers: [DONOR],
          emittedModuleSpecifiers: [],
        },
      ],
    };
    const configPath = `${root}/monocarve.config.json`;
    writeFileSync(configPath, `${JSON.stringify(evolved, null, 2)}\n`);
    const preparer = await compileStandalonePreparerManifest({
      rootDir: root,
      config: evolved,
      baselineCommit: "HEAD",
      preparerId: "reconcile-guides",
      sourcePath: "monocarve.config.json",
      bootstrapConfigPath: "monocarve.config.json",
    });
    const preparerPath = ".monocarve/reconcile-guides.preparer.json";
    mkdirSync(`${root}/.monocarve`, { recursive: true });
    writeFileSync(`${root}/${preparerPath}`, serializePreparerManifest(preparer));
    await commitPreparerBootstrap(root, evolved, preparerPath, preparer, "chore: declare guide reconciliation");
    await applyPreparerManifest({ rootDir: root, config: evolved, manifest: preparer });
    commitPreparerOutputs(root, evolved, preparerPath, preparer);

    const before = fixtureGit(root, "status", "--porcelain=v1", "--untracked-files=all");
    expect(inspectCommitChain({ rootDir: root, manifest: extraction, manifestPath: extractionPath })).toMatchObject({ phase: "applied", valid: true });
    const verified = await verifyAppliedPlan({ config: evolved, configPath, rootDir: root, manifest: extraction, manifestPath: extractionPath });
    expect(verified).toMatchObject({ blockers: [], regeneration: { ok: true }, generatorEvolutions: [{ preparerId: "reconcile-guides" }] });
    expect(fixtureGit(root, "status", "--porcelain=v1", "--untracked-files=all")).toBe(before);

    const unapproved = {
      ...evolved,
      postJournalPreparers: [{ ...evolved.postJournalPreparers[0]!, outputs: [...evolved.postJournalPreparers[0]!.outputs, "unapproved.md"] }],
    };
    const refused = await verifyAppliedPlan({ config: unapproved, configPath, rootDir: root, manifest: extraction, manifestPath: extractionPath });
    expect(refused?.blockers).toContain("post-journal preparer guides differs from the historical manifest without a linked approved preparer transaction");
    expect(fixtureGit(root, "status", "--porcelain=v1", "--untracked-files=all")).toBe(before);
  }, 120_000);
});
