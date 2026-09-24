/** Transaction application and rollback proofs. */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pnpmAdapter } from "../src/adapters/pnpm.ts";
import type { ExtractionManifest, PlanOperation } from "../src/plan/manifest.ts";
import { assertPlanValid } from "../src/plan/validate.ts";
import { applyPlan, preflight } from "../src/transaction/apply.ts";
import { auditPlanSync } from "../src/transaction/audit.ts";
import { executeJournal } from "../src/transaction/journal.ts";
import { simulatePlan } from "../src/transaction/simulate.ts";
import { hashText } from "../src/util/hash.ts";
import { cleanupFixtures, fixtureConfig, fixtureGit, fixtureRepo, read, write } from "./support/fixture-repo.ts";
import {
  APP,
  CONSUMER,
  DONOR,
  ENTRYPOINT,
  IMPORTER_BLOCK,
  LOCKFILE_APPLIED,
  PACKAGE_ROOT,
  TARGET,
  baseManifest,
  extractionFiles,
  landManifest,
  packageManifest,
} from "./support/transaction-fixture.ts";

describe("extraction transaction against a scratch repository", () => {
  afterEach(cleanupFixtures);

  test("lands an R100 move commit with its proof trailer and a sorted lockfile importer", async () => {
    const root = fixtureRepo(extractionFiles());
    const config = fixtureConfig(root);
    const manifest = baseManifest(root);
    expect(manifest.schemaVersion).toBe(3);
    expect(manifest.provenance).toBeDefined();
    expect(() => assertPlanValid(manifest, { config, rootDir: root })).not.toThrow();
    const manifestPath = landManifest(root, manifest);

    const result = await applyPlan({ config, rootDir: root, manifest, manifestPath, commit: true });
    expect(result.ok).toBe(true);
    expect(result.repositoryPostconditions).toMatchObject({ passed: true });

    const moveCommit = fixtureGit(root, "log", "-1", "--format=%B", "HEAD~1");
    expect(moveCommit).toContain(manifest.commits.move.subject);
    expect(moveCommit).toContain("Extraction-Proof: simulated fixture-extraction");
    expect(fixtureGit(root, "show", "--name-status", "--find-renames=100%", "--format=", "HEAD~1")).toContain("R100");
    expect(fixtureGit(root, "log", "-1", "--format=%s")).toBe(manifest.commits.wiring.subject);

    const wiring = fixtureGit(root, "show", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean).toSorted();
    expect(wiring).toEqual([CONSUMER, ENTRYPOINT, "pnpm-lock.yaml"].toSorted());

    // The block lands at its sorted position and re-extracts byte-identically.
    const applied = read(root, "pnpm-lock.yaml");
    expect(applied).toBe(LOCKFILE_APPLIED);
    expect(applied.indexOf("  libs/analytics:")).toBeLessThan(applied.indexOf("  libs/zeta:"));
    expect(pnpmAdapter.importerBlock(applied, PACKAGE_ROOT)).toBe(IMPORTER_BLOCK);
    expect(hashText(IMPORTER_BLOCK)).toBe(manifest.lockfileImporter!.hash);

    expect(auditPlanSync({ config, rootDir: root, manifest }).passed).toBe(true);
    expect(auditPlanSync({ config, rootDir: root, manifest }).sourceConservation).toMatchObject({
      passed: true,
      plannedFiles: 1,
      plannedTests: 0,
      plannedAssets: 0,
      landedFiles: 1,
    });
  }, 120_000);

  test("post-commit repository postcondition failure restores HEAD and every audited package artifact", async () => {
    const root = fixtureRepo(extractionFiles());
    const config = fixtureConfig(root);
    const manifest = baseManifest(root);
    const manifestPath = landManifest(root, manifest);
    const approvedHead = fixtureGit(root, "rev-parse", "HEAD");
    const originalRootManifest = read(root, "package.json");

    await expect(
      applyPlan({
        config,
        rootDir: root,
        manifest,
        manifestPath,
        commit: true,
        testHooks: {
          beforeRepositoryPostconditions: () => write(root, "package.json", '{"name":"fixture-workspace","dependencies":{"missing":"workspace:*"}}\n'),
        },
      }),
    ).rejects.toThrow("repository postconditions failed");

    expect(fixtureGit(root, "rev-parse", "HEAD")).toBe(approvedHead);
    expect(read(root, "package.json")).toBe(originalRootManifest);
    expect(fixtureGit(root, "status", "--short")).toBe("");
  }, 120_000);

  test("emitted-asset proof catches selector and declaration-order loss", async () => {
    const root = fixtureRepo(extractionFiles());
    const config = fixtureConfig(root, {
      assetEmissionProofs: [
        {
          id: "frontend-bundle",
          analyzer: "css-selectors",
          command:
            "mkdir -p dist; if test -f apps/api/src/widget/widget.ts; then printf '.kept{color:red;display:block}.lost{color:blue}' > dist/app.css; else printf '.kept{display:block;color:red}' > dist/app.css; fi",
          roots: ["dist"],
          extensions: [".css"],
        },
      ],
    });
    const result = await simulatePlan({ config, rootDir: root, manifest: baseManifest(root), skipGates: true });
    expect(result.ok).toBeFalse();
    expect(result.assetEmission?.checks[0]).toMatchObject({ passed: false, missingSelectors: [".lost"], changedDeclarationOrder: [".kept"] });
    expect(result.failure).toContain("asset-emission proof failed");
  }, 120_000);

  test("runs declared preparers after the journal and before audit and gates", async () => {
    const root = fixtureRepo(extractionFiles());
    const config = fixtureConfig(root, {
      postJournalPreparers: [
        {
          id: "path-ratchet",
          phase: "after-journal-before-gates",
          command: `test -f ${TARGET} && printf '%s' '${TARGET}' > quality-baseline.txt`,
          outputs: ["quality-baseline.txt"],
          verify: `grep -q '${TARGET}' quality-baseline.txt`,
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
          exemptReason: "fixture post-journal output",
          preparerId: "path-ratchet",
          verify: `grep -q '${TARGET}' quality-baseline.txt`,
        },
      ],
      changedFiles: [...base.changedFiles, "quality-baseline.txt"].toSorted(),
    };
    const result = await simulatePlan({ config, rootDir: root, manifest, skipGates: true });
    expect(result.failure).toBeUndefined();
    expect(result.ok).toBeTrue();
    expect(result.repositoryPostconditions).toMatchObject({ passed: true });
    expect(result.regeneration?.artifacts).toContainEqual(expect.objectContaining({ path: "quality-baseline.txt", changed: true }));
  }, 120_000);

  test("source conservation names a missing landed file", async () => {
    const root = fixtureRepo(extractionFiles());
    const config = fixtureConfig(root);
    const manifest = baseManifest(root);
    await executeJournal({ config, treeRoot: root, manifest });
    rmSync(join(root, TARGET));
    const report = auditPlanSync({ config, rootDir: root, manifest, skipCompileProof: true });
    expect(report.sourceConservation).toMatchObject({ passed: false, plannedFiles: 1, landedFiles: 0 });
    expect(report.sourceConservation.failures).toContain(`files source was not conserved at its target: ${DONOR} -> ${TARGET}`);
  });

  test("preflight accepts the approved committed manifest state", async () => {
    const root = fixtureRepo(extractionFiles());
    const config = fixtureConfig(root);
    const manifest = baseManifest(root);
    const manifestPath = landManifest(root, manifest);

    // `apply --commit` may start from this reviewed manifest commit. If verify
    // rejected it, an operator could not prove the exact state apply accepts.
    expect(await preflight({ config, rootDir: root, manifest, manifestPath })).toEqual([]);
  });

  test("failed gates preserve the landed worktree, complete log, and exact retry command", async () => {
    const root = fixtureRepo(extractionFiles());
    const base = fixtureConfig(root);
    const config = { ...base, gates: { ...base.gates }, transaction: { ...base.transaction, cleanup: true } };
    const manifest = { ...baseManifest(root), gates: { package: [], project: [], workspace: ["printf 'full diagnostic'; exit 9"] } };

    const result = await simulatePlan({ config, rootDir: root, manifest });

    expect(result.ok).toBeFalse();
    expect(result.failedGate).toMatchObject({ tier: "workspace", exitCode: 9 });
    const worktreePath = result.worktreePath ?? "";
    expect(worktreePath).toBeTruthy();
    expect(existsSync(worktreePath)).toBeTrue();
    expect(result.gateRetry).toEqual({ cwd: worktreePath, command: "printf 'full diagnostic'; exit 9" });
    const logPath = result.failedGate?.logPath ?? "";
    expect(existsSync(logPath)).toBeTrue();
    await expect(Bun.file(logPath).text()).resolves.toContain("full diagnostic");
    expect(existsSync(logPath.slice(0, logPath.indexOf(".diagnostics/")))).toBeTrue();
  }, 120_000);

  test("preflight refuses an arbitrary commit after the approved manifest", async () => {
    const root = fixtureRepo(extractionFiles());
    const config = fixtureConfig(root);
    const manifest = baseManifest(root);
    const manifestPath = landManifest(root, manifest);
    write(root, "notes.txt", "unrelated post-plan commit\n");
    fixtureGit(root, "add", "--", "notes.txt");
    fixtureGit(root, "commit", "-qm", "docs: add an unrelated note");

    // A post-baseline HEAD is not approved merely because it contains the
    // manifest: the proof requires its exact subject and changed-path set.
    const issues = await preflight({ config, rootDir: root, manifest, manifestPath });
    expect(issues[0]).toContain("HEAD must contain exactly the approved manifest over the baseline");
    expect(issues[0]).toContain(`git commit -m "${manifest.commits.plan!.subject}"`);
  });

  test("preflight refuses a manifest commit with an empty commit before it", async () => {
    const root = fixtureRepo(extractionFiles());
    const config = fixtureConfig(root);
    const manifest = baseManifest(root);
    fixtureGit(root, "commit", "--allow-empty", "-qm", "chore: unrelated empty commit");
    const manifestPath = landManifest(root, manifest);

    await expect(preflight({ config, rootDir: root, manifest, manifestPath })).resolves.toContain(
      "the approved manifest commit must be directly atop the plan baseline",
    );
  });

  test("preflight refuses an empty commit after the approved manifest", async () => {
    const root = fixtureRepo(extractionFiles());
    const config = fixtureConfig(root);
    const manifest = baseManifest(root);
    const manifestPath = landManifest(root, manifest);
    fixtureGit(root, "commit", "--allow-empty", "-qm", manifest.commits.plan!.subject);

    await expect(preflight({ config, rootDir: root, manifest, manifestPath })).resolves.toContain(
      "the approved manifest commit must be directly atop the plan baseline",
    );
  });

  test("applies a plan whose identical blobs git pairs across the declared moves", async () => {
    // Two donors with byte-identical content whose targets invert their
    // sources' sort order. Git's exact-rename pass pairs identical blobs by
    // that order — the basename tie-break cannot separate two files both named
    // `index.ts` — so it reports the pairs crossed while the landed tree is
    // exactly what the plan declared. Asserting the pairing rolled this back.
    const twinA = "apps/api/src/shared/zulu/index.ts";
    const twinB = "apps/api/src/widget/alfa/index.ts";
    const twinATarget = `${PACKAGE_ROOT}/src/zulu/index.ts`;
    const twinBTarget = `${PACKAGE_ROOT}/src/alfa/index.ts`;
    const twin = "export const twinValue = 1;\n";
    const files = extractionFiles();
    files[twinA] = twin;
    files[twinB] = twin;

    const root = fixtureRepo(files);
    const config = fixtureConfig(root);
    const base = baseManifest(root);
    const twinHash = hashText(twin);
    const manifest: ExtractionManifest = {
      ...base,
      source: { files: [DONOR, twinA, twinB], tests: [], sccs: { "scc-fixture": [DONOR], "scc-zulu": [twinA], "scc-alfa": [twinB] } },
      sourceBlobs: { ...base.sourceBlobs, [twinA]: twinHash, [twinB]: twinHash },
      changedFiles: [...base.changedFiles, twinA, twinB, twinATarget, twinBTarget].toSorted(),
      metrics: { ...base.metrics, movedFiles: 3, movedLines: 3 },
      operations: [
        ...base.operations,
        { kind: "move", source: twinA, target: twinATarget, preconditionHash: twinHash, resultHash: twinHash },
        { kind: "move", source: twinB, target: twinBTarget, preconditionHash: twinHash, resultHash: twinHash },
      ],
    };
    expect(() => assertPlanValid(manifest, { config, rootDir: root })).not.toThrow();
    const manifestPath = landManifest(root, manifest);

    const result = await applyPlan({ config, rootDir: root, manifest, manifestPath, commit: true });
    expect(result.ok).toBe(true);
    expect(result.moveCommit).toBeTruthy();

    const reported = fixtureGit(root, "show", "--name-status", "--find-renames=100%", "--format=", "HEAD~1").split("\n").filter(Boolean);
    expect(reported).toHaveLength(3);
    expect(reported.every((line) => line.startsWith("R100"))).toBe(true);
    // The crossing itself. If git ever stops crossing here this line fails,
    // which says the fixture no longer reproduces the case — not that the gate
    // regressed; the assertions below are the ones about correctness.
    expect(reported).toContain(`R100\t${twinA}\t${twinBTarget}`);

    expect(read(root, twinATarget)).toBe(twin);
    expect(read(root, twinBTarget)).toBe(twin);
    expect(existsSync(join(root, twinA))).toBe(false);
    expect(existsSync(join(root, twinB))).toBe(false);
    expect(auditPlanSync({ config, rootDir: root, manifest }).passed).toBe(true);
  }, 120_000);

  test("finds every exact rename with diff.renameLimit pinned to 1", async () => {
    // A pin, not a proof: no bug in this repository can make it fail. What it
    // pins is git's behaviour — exact renames are matched by content hash in a
    // pass that runs before the similarity search, and `diff.renameLimit`
    // bounds only that search — so a plan of any size still reports R100. If
    // this ever fails, that property changed in git, and the move commit's gate
    // would start seeing A/D lines on plans that are perfectly correct.
    const bulk = Array.from({ length: 32 }, (_, index) => ({
      source: `${APP}/src/bulk/mod${index}.ts`,
      target: `${PACKAGE_ROOT}/src/bulk/mod${index}.ts`,
      contents: `export const bulk${index} = ${index};\n`,
    }));
    const files = extractionFiles();
    for (const entry of bulk) files[entry.source] = entry.contents;

    const root = fixtureRepo(files);
    fixtureGit(root, "config", "diff.renameLimit", "1");
    const config = fixtureConfig(root);
    const base = baseManifest(root);
    const manifest: ExtractionManifest = {
      ...base,
      source: {
        files: [DONOR, ...bulk.map((entry) => entry.source)],
        tests: [],
        sccs: { "scc-fixture": [DONOR], ...Object.fromEntries(bulk.map((entry, index) => [`scc-bulk-${index}`, [entry.source]])) },
      },
      sourceBlobs: { ...base.sourceBlobs, ...Object.fromEntries(bulk.map((entry) => [entry.source, hashText(entry.contents)])) },
      changedFiles: [...base.changedFiles, ...bulk.flatMap((entry) => [entry.source, entry.target])].toSorted(),
      metrics: { ...base.metrics, movedFiles: 1 + bulk.length, movedLines: 1 + bulk.length },
      operations: [
        ...base.operations,
        ...bulk.map((entry): PlanOperation => {
          const hash = hashText(entry.contents);
          return { kind: "move", source: entry.source, target: entry.target, preconditionHash: hash, resultHash: hash };
        }),
      ],
    };
    expect(() => assertPlanValid(manifest, { config, rootDir: root })).not.toThrow();
    const manifestPath = landManifest(root, manifest);

    const result = await applyPlan({ config, rootDir: root, manifest, manifestPath, commit: true });
    expect(result.ok).toBe(true);

    const reported = fixtureGit(root, "show", "--name-status", "--find-renames=100%", "--format=", "HEAD~1").split("\n").filter(Boolean);
    expect(reported).toHaveLength(1 + bulk.length);
    expect(reported.every((line) => line.startsWith("R100"))).toBe(true);
  }, 180_000);

  test("keeps a move-with-rewrite donor out of the R100 move commit and replays its rewrite", async () => {
    const rewriteDonor = "apps/api/src/widget/decorated.ts";
    const rewriteTarget = "libs/analytics/src/widget/decorated.ts";
    const telemetry = "@acme/telemetry";
    const files = extractionFiles();
    files[rewriteDonor] = 'import { telemetryValue } from "../shared/telemetry.ts";\n\nexport const decorated = telemetryValue + 1;\n';
    files["apps/api/src/shared/telemetry.ts"] = "export const telemetryValue = 1;\n";
    files["libs/telemetry/package.json"] = packageManifest(telemetry);
    files["libs/telemetry/src/index.ts"] = "export const telemetryValue = 1;\n";

    const root = fixtureRepo(files);
    const config = fixtureConfig(root);
    const base = baseManifest(root);
    const rewrites = [{ donorlessSpecifier: "../shared/telemetry.ts", packageSpecifier: telemetry }];
    const rewritten = files[rewriteDonor]!.replace("../shared/telemetry.ts", telemetry);
    const barrel = 'export * from "./widget/widget.ts";\nexport * from "./widget/decorated.ts";\n';
    const donorHash = hashText(files[rewriteDonor]!);

    const manifest: ExtractionManifest = {
      ...base,
      sourceBlobs: { ...base.sourceBlobs, [rewriteDonor]: donorHash },
      source: { files: [DONOR, rewriteDonor], tests: [], sccs: { "scc-a": [DONOR], "scc-b": [rewriteDonor] } },
      target: {
        ...base.target,
        requiredExports: [
          { name: "decorated", typeOnly: false },
          { name: "widgetValue", typeOnly: false },
        ],
      },
      changedFiles: [...base.changedFiles, rewriteDonor, rewriteTarget].toSorted(),
      operations: [
        ...base.operations.map((operation) =>
          operation.kind === "write-file" && operation.path === ENTRYPOINT ? { ...operation, contents: barrel, resultHash: hashText(barrel) } : operation,
        ),
        { kind: "move-with-rewrite", source: rewriteDonor, target: rewriteTarget, rewrites, preconditionHash: donorHash, resultHash: hashText(rewritten) },
      ],
    };
    expect(() => assertPlanValid(manifest, { config, rootDir: root })).not.toThrow();
    const manifestPath = landManifest(root, manifest);

    await applyPlan({ config, rootDir: root, manifest, manifestPath, commit: true });

    const moved = fixtureGit(root, "show", "--name-status", "--find-renames=100%", "--format=", "HEAD~1").split("\n").filter(Boolean);
    expect(moved).toHaveLength(1);
    expect(moved[0]).toContain("R100");
    expect(moved[0]).toContain(TARGET);

    const wiring = fixtureGit(root, "show", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean).toSorted();
    expect(wiring).toEqual([CONSUMER, rewriteDonor, ENTRYPOINT, rewriteTarget, "pnpm-lock.yaml"].toSorted());
    expect(read(root, rewriteTarget)).toBe(rewritten);

    const report = auditPlanSync({ config, rootDir: root, manifest });
    expect(report.codemodReplay.passed).toBe(true);
    expect(report.passed).toBe(true);
  }, 120_000);

  test("refuses to re-apply a plan whose wiring commit already landed", async () => {
    const root = fixtureRepo(extractionFiles());
    const config = fixtureConfig(root);
    const manifest = baseManifest(root);
    const manifestPath = landManifest(root, manifest);
    await applyPlan({ config, rootDir: root, manifest, manifestPath, commit: true });
    await expect(applyPlan({ config, rootDir: root, manifest, manifestPath, commit: true, resume: true })).rejects.toThrow("cannot be re-applied");
  }, 120_000);

  test("preflight identifies the applied boundary through later commits and directs the operator to audit", async () => {
    const root = fixtureRepo(extractionFiles());
    const config = fixtureConfig(root);
    const manifest = baseManifest(root);
    const manifestPath = landManifest(root, manifest);
    await applyPlan({ config, rootDir: root, manifest, manifestPath, commit: true });
    write(root, "notes.txt", "legitimate follow-up\n");
    fixtureGit(root, "add", "--", "notes.txt");
    fixtureGit(root, "commit", "-qm", "docs: follow applied extraction");

    await expect(preflight({ config, rootDir: root, manifest, manifestPath })).resolves.toEqual([
      `plan ${manifest.planId} is already applied; run monocarve audit --plan ${manifestPath}`,
    ]);
  }, 120_000);

  test("throws before the move commit when an out-of-scope file is already staged", async () => {
    const root = fixtureRepo(extractionFiles());
    const config = fixtureConfig(root);
    const manifest = baseManifest(root);
    const manifestPath = landManifest(root, manifest);
    const head = fixtureGit(root, "rev-parse", "HEAD");

    write(root, "apps/api/src/unrelated.ts", "export const unrelated = 1;\n");
    fixtureGit(root, "add", "--", "apps/api/src/unrelated.ts");

    // `resume` skips the clean-tree gate, so the staged file survives to the
    // move commit's scope assertion — which is the guard under test.
    await expect(applyPlan({ config, rootDir: root, manifest, manifestPath, commit: true, resume: true })).rejects.toThrow("R100");
    expect(fixtureGit(root, "rev-parse", "HEAD")).toBe(head);
    expect(read(root, DONOR)).toBe("export const widgetValue = 1;\n");
  }, 120_000);

  test("blocks committing on a guarded branch", async () => {
    const root = fixtureRepo(extractionFiles(), "develop");
    const config = fixtureConfig(root);
    const manifest = baseManifest(root);
    const manifestPath = landManifest(root, manifest);
    await expect(applyPlan({ config, rootDir: root, manifest, manifestPath, commit: true })).rejects.toThrow("guarded branch develop");
  }, 60_000);

  test("restores every touched path when a later operation fails", async () => {
    const root = fixtureRepo(extractionFiles());
    const config = fixtureConfig(root);
    const manifest = baseManifest(root);
    process.env.MONOCARVE_FAIL_OPERATION = "2";
    try {
      await expect(executeJournal({ config, treeRoot: root, manifest })).rejects.toThrow("injected operation failure 2");
    } finally {
      delete process.env.MONOCARVE_FAIL_OPERATION;
    }
    expect(read(root, DONOR)).toBe("export const widgetValue = 1;\n");
    expect(existsSync(join(root, TARGET))).toBe(false);
    expect(existsSync(join(root, ENTRYPOINT))).toBe(false);
    expect(read(root, CONSUMER)).toContain("./widget/widget.ts");
  }, 60_000);

  /**
   * The gates do not all read the whole tree. A repository's own checks
   * routinely scope themselves to "what changed since HEAD" and then apply an
   * obligation to the answer — a doc that must move with backend source, two
   * artifacts that must move together. Run against a worktree where the journal
   * was replayed but never committed, every one of them sees the entire
   * extraction as uncommitted work and reports a finding that no apply could
   * ever produce: once the move and wiring commits land, that same diff is
   * empty. The simulation is only worth running if the tree it gates is the
   * tree that lands.
   */
  test("the gates run against a committed tree, the way they will after the apply", async () => {
    const root = fixtureRepo({
      ...extractionFiles(),
      // Fails when anything is uncommitted, and proves the moved file is
      // present — so a gate that passes for want of a tree cannot pass here.
      "scripts/diff-guard.sh": [
        "#!/bin/sh",
        'test -f "' + TARGET + '" || { echo "the move never happened"; exit 1; }',
        "changed=$(git status --porcelain)",
        '[ -z "$changed" ] || { echo "uncommitted during gates:"; echo "$changed"; exit 1; }',
        "",
      ].join("\n"),
    });
    const config = fixtureConfig(root, { gates: { package: [], project: [], workspace: ["sh scripts/diff-guard.sh"] } });
    const manifest = { ...baseManifest(root), gates: { package: [], project: [], workspace: ["sh scripts/diff-guard.sh"] } };

    const result = await simulatePlan({ config, rootDir: root, manifest });

    expect(result.failure).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.gates.map((gate) => gate.exitCode)).toEqual([0]);

    // The commit is the worktree's alone. The checkout that lent it `.git` is
    // where an unnoticed extra commit would do real damage.
    expect(fixtureGit(root, "log", "-1", "--format=%s")).not.toContain("simulate");
    expect(fixtureGit(root, "status", "--porcelain")).toBe("");
    expect(existsSync(join(root, TARGET))).toBe(false);
  }, 120_000);
});
