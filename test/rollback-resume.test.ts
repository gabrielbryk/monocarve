import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtractionManifest } from "../src/plan/manifest.ts";
import { applyPlan } from "../src/transaction/apply.ts";
import {
  MANIFEST_PATH,
  PACKAGE_ROOT,
  TOKENS_DIR,
  cleanupFixtures,
  comparableFiles,
  expectApplyToFail,
  expectRestored,
  fixture,
  fixtureGit,
  repoState,
  withReadOnlyDirectory,
} from "./support/rollback-fixture.ts";

describe("--resume converges on the same tree as a clean apply", () => {
  afterEach(cleanupFixtures);

  /**
   * What a completed apply produced, stated so that two independent fixtures
   * are comparable: the committed diff over the plan's own baseline, the
   * worktree's bytes minus the per-fixture files, the commit subjects, and the
   * fact that nothing is left uncommitted. Raw tree hashes cannot be compared
   * across fixtures — the manifest commit embeds that fixture's baseline SHA.
   */
  function landed(root: string, manifest: ExtractionManifest): Record<string, unknown> {
    return {
      diff: fixtureGit(root, "diff", "--name-status", "--find-renames=100%", `${manifest.baselineCommit}..HEAD`, "--")
        .split("\n")
        .filter((line) => !line.endsWith(MANIFEST_PATH))
        .toSorted(),
      files: comparableFiles(root),
      subjects: fixtureGit(root, "log", "--format=%s", "-3"),
      status: fixtureGit(root, "status", "--porcelain=v1", "--untracked-files=all"),
    };
  }

  test("resuming after a rolled-back failure lands the same tree as never failing", async () => {
    const clean = fixture();
    const cleanResult = await applyPlan({ ...clean, rootDir: clean.root, commit: true });
    expect(cleanResult.ok).toBe(true);
    const expected = landed(clean.root, clean.manifest);

    const retried = fixture();
    await withReadOnlyDirectory(join(retried.root, TOKENS_DIR), async () => {
      await expectApplyToFail(applyPlan({ ...retried, rootDir: retried.root, commit: true }));
    });

    // A rollback returns HEAD to the manifest commit with a clean tree, so a
    // resume from here is indistinguishable from a first attempt — `--resume`
    // is accepted, and so would a plain re-apply be.
    const resumed = await applyPlan({ ...retried, rootDir: retried.root, commit: true, resume: true });
    expect(resumed.ok).toBe(true);
    expect(resumed.moveCommit).toBeTruthy();
    expect(resumed.wiringCommit).toBeTruthy();

    expect(landed(retried.root, retried.manifest)).toEqual(expected);
  }, 180_000);

  test("resuming from a landed move commit finishes the wiring and converges", async () => {
    // The state a killed process leaves: the move commit is in history, the
    // journal's other work is not. `applyPlan` cannot be made to stop there —
    // its own `catch` rolls the commit back — so the state is reconstructed the
    // way the process would have left it, by replaying the journal and making
    // the same move commit.
    const clean = fixture();
    expect((await applyPlan({ ...clean, rootDir: clean.root, commit: true })).ok).toBe(true);
    const expected = landed(clean.root, clean.manifest);

    const interrupted = fixture();
    const { root, manifest } = interrupted;
    for (const operation of manifest.operations) {
      if (operation.kind !== "move") continue;
      mkdirSync(join(root, operation.target, ".."), { recursive: true });
      fixtureGit(root, "mv", "--", operation.source, operation.target);
    }
    fixtureGit(root, "commit", "-q", "--no-verify", "-m", manifest.commits.move.subject, "-m", manifest.commits.move.body!);
    const moveCommit = fixtureGit(root, "rev-parse", "HEAD");

    const resumed = await applyPlan({ ...interrupted, rootDir: root, commit: true, resume: true });
    expect(resumed.ok).toBe(true);
    // Contract: a resume from `post-move` does not remake the move commit, so
    // the result reports only the wiring commit it did make.
    expect(resumed.moveCommit).toBeUndefined();
    expect(resumed.wiringCommit).toBeTruthy();

    expect(landed(root, manifest)).toEqual(expected);
    expect(fixtureGit(root, "rev-parse", "HEAD~1")).toBe(moveCommit);
  }, 180_000);

  test("a failure during a resume rolls back to the move commit, not to the baseline", async () => {
    // The rollback point is where *this* invocation started, which after an
    // interrupted apply is the move commit. A resume that fails therefore leaves
    // the move commit standing — correct, and worth pinning: it is the one case
    // where "restore what it was" does not mean "restore the baseline".
    const interrupted = fixture();
    const { root, config, manifest, manifestPath } = interrupted;
    for (const operation of manifest.operations) {
      if (operation.kind !== "move") continue;
      mkdirSync(join(root, operation.target, ".."), { recursive: true });
      fixtureGit(root, "mv", "--", operation.source, operation.target);
    }
    fixtureGit(root, "commit", "-q", "--no-verify", "-m", manifest.commits.move.subject, "-m", manifest.commits.move.body!);
    const before = repoState(root);

    await withReadOnlyDirectory(join(root, TOKENS_DIR), async () => {
      const error = await expectApplyToFail(applyPlan({ config, rootDir: root, manifest, manifestPath, commit: true, resume: true }));
      expect(error.message).toContain("EACCES");
      expect(error.message).toContain(`[rollback complete: HEAD and index reset to ${before.head}`);
    });

    expectRestored(repoState(root), before);
    expect(fixtureGit(root, "log", "-1", "--format=%s")).toBe(manifest.commits.move.subject);
  }, 180_000);
});

describe("what rollback prunes, and what it deliberately does not", () => {
  afterEach(cleanupFixtures);

  test("leaves no directory the journal created, and no directory it did not", async () => {
    // The snapshot is keyed by *file* path and `rmSync` leaves parent
    // directories in place, so an undone extraction used to leave empty
    // `libs/analytics/src/widget` and `libs/analytics/generated` trees in the
    // checkout — invisible to `git status`, which cannot report an empty
    // directory, and therefore silent in the one place a developer would look.
    //
    // The snapshot now records which ancestors were absent when it was taken,
    // and the restore prunes exactly those once they are empty again. Both
    // halves are asserted here, because the dangerous half is the second one: a
    // prune that walked up until it found something non-empty would delete an
    // empty directory that was already in the checkout and had nothing to do
    // with the extraction.
    const { root, config, manifest, manifestPath } = fixture();
    // Untracked and empty — git cannot carry it, so nothing but this restraint
    // would put it back.
    mkdirSync(join(root, `${PACKAGE_ROOT}/src`), { recursive: true });
    const before = repoState(root);
    expect(before.directories).toContain(`${PACKAGE_ROOT}/src`);
    expect(before.directories).not.toContain(`${PACKAGE_ROOT}/src/widget`);

    process.env.MONOCARVE_FAIL_OPERATION = "4";
    try {
      await expectApplyToFail(applyPlan({ config, rootDir: root, manifest, manifestPath, commit: true, skipSimulation: true }));
    } finally {
      delete process.env.MONOCARVE_FAIL_OPERATION;
    }

    const after = repoState(root);
    // What the journal created is gone…
    expect(after.directories).not.toContain(`${PACKAGE_ROOT}/src/widget`);
    // …and what it found is still there.
    expect(after.directories).toContain(`${PACKAGE_ROOT}/src`);
    expect(readdirSync(join(root, `${PACKAGE_ROOT}/src`))).toEqual([]);
    expectRestored(after, before);
  }, 120_000);
});
