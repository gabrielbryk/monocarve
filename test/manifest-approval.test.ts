import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, rmSync } from "node:fs";
import { join } from "node:path";

import { commitManifestApproval, manifestApprovalEvidence } from "../src/approval/manifest.ts";
import { serializeManifest } from "../src/plan/build.ts";
import { createPreparationManifest, serializePreparationManifest } from "../src/prepare/index.ts";
import { cleanupFixtures, fixtureConfig, fixtureGit, fixtureRepo, write } from "./support/fixture-repo.ts";
import { baseManifest, extractionFiles } from "./support/transaction-fixture.ts";
import { runIn } from "./support/cli.ts";
import { serializePreparerManifest, type PreparerManifest } from "../src/preparer/index.ts";
import { configDigest } from "../src/config/digest.ts";

describe("guided manifest approval", () => {
  afterEach(cleanupFixtures);

  function setup(branch = "approval-fixture") {
    const root = fixtureRepo(extractionFiles(), branch);
    const config = fixtureConfig(root);
    const manifest = baseManifest(root);
    const manifestPath = "plans/extraction.json";
    write(root, manifestPath, serializeManifest(manifest));
    return { rootDir: root, config, manifest, manifestPath };
  }

  test("reports the exact reviewed add action and rendered subject without mutating git", () => {
    const fixture = setup();
    expect(manifestApprovalEvidence(fixture)).toEqual({
      manifestPath: fixture.manifestPath,
      baselineCommit: fixture.manifest.baselineCommit,
      branch: "approval-fixture",
      subject: fixture.manifest.commits.plan!.subject,
      gitAdd: ["git", "add", "--", fixture.manifestPath],
    });
    expect(fixtureGit(fixture.rootDir, "diff", "--cached", "--name-only")).toBe("");
  });

  test("explicit approval commits only the byte-identical manifest", () => {
    const fixture = setup();
    const result = commitManifestApproval(fixture);
    expect(fixtureGit(fixture.rootDir, "log", "-1", "--format=%s")).toBe(fixture.manifest.commits.plan!.subject);
    expect(fixtureGit(fixture.rootDir, "log", "-1", "--format=%b")).toBe("");
    expect(fixtureGit(fixture.rootDir, "diff-tree", "--no-commit-id", "--name-only", "-r", result.commit)).toBe(fixture.manifestPath);
    expect(fixtureGit(fixture.rootDir, "rev-parse", `${result.commit}^`)).toBe(fixture.manifest.baselineCommit);
  });

  test("rolls back when a commit hook stages different manifest bytes", async () => {
    const fixture = setup();
    const hook = join(fixture.rootDir, ".git/hooks/pre-commit");
    write(fixture.rootDir, ".git/hooks/pre-commit", [
      "#!/bin/sh",
      `printf '%s\\n' '{\"forged\":true}' > ${fixture.manifestPath}`,
      `git add -- ${fixture.manifestPath}`,
      "",
    ].join("\n"));
    chmodSync(hook, 0o755);

    expect(() => commitManifestApproval(fixture)).toThrow("commit hook changed the reviewed manifest");
    expect(fixtureGit(fixture.rootDir, "rev-parse", "HEAD")).toBe(fixture.manifest.baselineCommit);
    await expect(Bun.file(join(fixture.rootDir, fixture.manifestPath)).text()).resolves.toBe(serializeManifest(fixture.manifest));
    expect(fixtureGit(fixture.rootDir, "diff", "--cached", "--name-only")).toBe("");
  });

  test("refuses tampered bytes and stale HEAD", () => {
    const tampered = setup();
    write(tampered.rootDir, tampered.manifestPath, `${serializeManifest(tampered.manifest)}\n`);
    expect(() => manifestApprovalEvidence(tampered)).toThrow("does not match the reviewed manifest");

    const stale = setup();
    write(stale.rootDir, "note.txt", "advance\n");
    fixtureGit(stale.rootDir, "add", "--", "note.txt");
    fixtureGit(stale.rootDir, "commit", "-qm", "test: advance head");
    expect(() => manifestApprovalEvidence(stale)).toThrow("does not match manifest baseline");
  });

  test("refuses guarded branches, staged paths, and unrelated dirt", () => {
    const guarded = setup("main");
    expect(manifestApprovalEvidence(guarded).branch).toBe("main");
    expect(() => commitManifestApproval(guarded)).toThrow("current branch main is guarded");

    const staged = setup();
    fixtureGit(staged.rootDir, "add", "--", staged.manifestPath);
    expect(() => commitManifestApproval(staged)).toThrow("only an unstaged manifest");

    const dirty = setup();
    write(dirty.rootDir, "apps/api/src/unrelated.ts", "export {};\n");
    expect(() => commitManifestApproval(dirty)).toThrow("apps/api/src/unrelated.ts");
    expect(fixtureGit(dirty.rootDir, "log", "-1", "--format=%s")).toBe("test: add fixture config");
  });

  test("CLI inspection is read-only and --commit creates the approval boundary", async () => {
    const fixture = setup();
    const inspected = await runIn(fixture.rootDir, "approve", "--plan", fixture.manifestPath);
    expect(inspected.code).toBe(0);
    expect(JSON.parse(inspected.stdout)).toMatchObject({
      manifestPath: fixture.manifestPath,
      subject: fixture.manifest.commits.plan!.subject,
      gitAdd: ["git", "add", "--", fixture.manifestPath],
    });
    expect(fixtureGit(fixture.rootDir, "diff", "--cached", "--name-only")).toBe("");

    const committed = await runIn(fixture.rootDir, "approve", "--plan", fixture.manifestPath, "--commit");
    expect(committed.code).toBe(0);
    expect(JSON.parse(committed.stdout)).toMatchObject({ commit: expect.any(String) });
    expect(fixtureGit(fixture.rootDir, "show", "--format=", "--name-only", "HEAD")).toBe(fixture.manifestPath);
  });

  test("CLI approves a standalone preparer manifest", async () => {
    const fixture = setup();
    const preparer = {
      schemaVersion: 1,
      planId: "preparer-plan",
      createdAt: "2026-08-07T00:00:00.000Z",
      baseline: { commit: fixture.manifest.baselineCommit, configDigest: configDigest(fixture.config) },
      extractionPlanId: `standalone-${fixture.manifest.baselineCommit}`,
      preparer: { id: "rewrite-boundary", phase: "pre-extraction", command: "true", commit: { subject: "fix: rewrite boundary" } },
      binding: { application: "standalone", packageName: "standalone", packageRoot: ".", sourcePath: "apps/api/src/index.ts", targetPath: "apps/api/src/index.ts" },
      mutations: [],
    } as unknown as PreparerManifest;
    const path = "plans/preparer.json";
    write(fixture.rootDir, path, serializePreparerManifest(preparer));
    fixtureGit(fixture.rootDir, "reset", "--hard", fixture.manifest.baselineCommit);
    rmSync(join(fixture.rootDir, fixture.manifestPath));
    write(fixture.rootDir, path, serializePreparerManifest(preparer));

    const committed = await runIn(fixture.rootDir, "approve", "--plan", path, "--commit");
    expect(committed.code).toBe(0);
    expect(fixtureGit(fixture.rootDir, "log", "-1", "--format=%s")).toBe("chore(monocarve): approve rewrite-boundary");
    expect(fixtureGit(fixture.rootDir, "show", "--format=", "--name-only", "HEAD")).toBe(path);
  });

  test("CLI approves a preparation manifest with its declared prepare subject", async () => {
    const fixture = setup();
    rmSync(join(fixture.rootDir, fixture.manifestPath));
    const preparation = createPreparationManifest({
      schemaVersion: 1,
      createdAt: new Date(Number(fixtureGit(fixture.rootDir, "show", "-s", "--format=%ct")) * 1000).toISOString(),
      generator: { name: "monocarve", version: "1.0.0" },
      baseline: {
        commit: fixture.manifest.baselineCommit,
        committerDate: new Date(Number(fixtureGit(fixture.rootDir, "show", "-s", "--format=%ct")) * 1000).toISOString(),
        configDigest: configDigest(fixture.config),
      },
      graphDigest: "a".repeat(64),
      declarations: [],
      operations: [],
      compatibilityReexports: [],
      changedFiles: [],
      commits: { prepare: { subject: "refactor(frontend): prepare extraction boundary" } },
      gates: { package: [], project: [], workspace: [] },
    });
    const path = "plans/preparation.json";
    write(fixture.rootDir, path, serializePreparationManifest(preparation));

    const committed = await runIn(fixture.rootDir, "approve", "--plan", path, "--commit");
    expect(committed.code).toBe(0);
    expect(fixtureGit(fixture.rootDir, "log", "-1", "--format=%s")).toBe(preparation.commits.prepare.subject);
    expect(fixtureGit(fixture.rootDir, "show", "--format=", "--name-only", "HEAD")).toBe(path);
  });
});
