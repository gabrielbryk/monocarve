import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyPlan } from "../src/transaction/apply.ts";
import type { ExtractionManifest } from "../src/plan/manifest.ts";
import {
  BARREL, ENTRYPOINT, PACKAGE_ROOT, cleanupFixtures, expectApplyToFail, expectRestored, extractionFiles, fixture,
  fixtureGit, repoState, write,
} from "./support/rollback-fixture.ts";

describe("rollback restores the checkout from every commit boundary", () => {
  afterEach(cleanupFixtures);

  /**
   * Whether HEAD actually passed through the move commit and was then reset off
   * it. A rollback leaves no trace in the commit graph, so a case that claims to
   * fail *after* the move commit would otherwise be indistinguishable from one
   * that failed before it ever ran — and would still pass every restore
   * assertion. The reflog is the only surviving witness.
   */
  function movedThroughMoveCommit(root: string, manifest: ExtractionManifest): boolean {
    const entries = fixtureGit(root, "reflog", "--format=%gs", "-3").split("\n");
    return entries[0]!.startsWith("reset: moving to") && entries[1] === `commit: ${manifest.commits.move.subject}`;
  }

  test("after the journal, when regeneration fails", async () => {
    // A real subprocess exiting non-zero, between the journal and the move
    // commit. At this point the journal has written every file and `git mv` has
    // staged the renames, so the rollback has an index to undo as well as files.
    const artifact = "libs/analytics/registry.ts";
    const { root, config, manifest, manifestPath } = fixture(
      { ...extractionFiles(), [artifact]: "export const registry = [];\n" },
      (base) => ({
        ...base,
        generatedFiles: [
          {
            path: artifact,
            source: PACKAGE_ROOT,
            regenerate: "exit 7",
            regenerateOnApply: true,
            exemptReason: "the fixture's generator never produces bytes",
          },
        ],
        changedFiles: [...base.changedFiles, artifact].sort(),
      }),
      { generatedArtifacts: { artifacts: [{ path: artifact, source: PACKAGE_ROOT, regenerate: "exit 7" }] } },
    );
    const before = repoState(root);

    // The simulation regenerates too, and would stop the apply before the
    // checkout was touched; this case is about the checkout's recovery.
    const error = await expectApplyToFail(
      applyPlan({ config, rootDir: root, manifest, manifestPath, commit: true, skipSimulation: true }),
    );
    expect(error.message).toContain(`regenerating ${artifact} failed (exit 7)`);
    expect(error.message).toContain(`[rollback complete: HEAD and index reset to ${before.head}`);

    // Before the move commit, which is what makes the two cases below different
    // positions rather than the same one twice — and what stops the witness
    // from being a check that is true no matter where the apply died.
    expect(movedThroughMoveCommit(root, manifest)).toBe(false);
    expectRestored(repoState(root), before);
  }, 120_000);

  test("at the move commit's R100 gate, with an unrelated file already staged", async () => {
    // Genuine refusal: the index carries a path the plan never declared, so the
    // move commit's scope assertion rejects the staged diff. `resume` is what
    // lets a dirty index reach it at all — apply otherwise demands a clean tree.
    const { root, config, manifest, manifestPath } = fixture();
    write(root, "apps/api/src/unrelated.ts", "export const unrelated = 1;\n");
    fixtureGit(root, "add", "--", "apps/api/src/unrelated.ts");
    const before = repoState(root);
    expect(before.staged).toContain("unrelated.ts");

    const error = await expectApplyToFail(
      applyPlan({ config, rootDir: root, manifest, manifestPath, commit: true, resume: true, skipSimulation: true }),
    );
    expect(error.message).toContain("move commit");
    expect(error.message).toContain("rollback complete");

    const after = repoState(root);
    expect(movedThroughMoveCommit(root, manifest)).toBe(false);
    // The pre-existing staged entry survives. `rollback` resets the index to
    // the commit apply started from — right for staging the transaction
    // created, wrong for staging that was already there — and then restores the
    // tree object it recorded of the index apply *found*, so a developer's own
    // `git add` is not collateral of someone else's failed extraction. It used
    // to be unstaged silently, under a message reading "rollback complete".
    expect(before.status).toContain("A  apps/api/src/unrelated.ts");
    expect(after.status).toContain("A  apps/api/src/unrelated.ts");
    expect(after.staged).toBe(before.staged);
    expectRestored(after, before);
  }, 120_000);

  test("at the wiring commit's scope gate, after the move commit landed", async () => {
    // The deepest boundary short of the wiring commit: the move commit is
    // already a commit, and the rollback has to undo it.
    //
    // The refusal is genuine and needs no tampering. The plan's entrypoint is
    // already present at the baseline with exactly the bytes the plan writes, so
    // the journal correctly skips that operation as completed — and then nothing
    // stages it, and the wiring commit's scope gate reports a declared path it
    // cannot find.
    const { root, config, manifest, manifestPath } = fixture({ ...extractionFiles(), [ENTRYPOINT]: BARREL });
    const before = repoState(root);

    const error = await expectApplyToFail(
      applyPlan({ config, rootDir: root, manifest, manifestPath, commit: true, skipSimulation: true }),
    );
    expect(error.message).toContain(`commit is missing declared operation paths: ${ENTRYPOINT}`);
    expect(error.message).toContain(`[rollback complete: HEAD and index reset to ${before.head}`);

    // HEAD was one commit further along when this threw; the reset undid it.
    // The reflog is the evidence that this case reaches the position it claims:
    // a commit, then the rollback's reset moving off it.
    expect(movedThroughMoveCommit(root, manifest)).toBe(true);
    expectRestored(repoState(root), before);
    expect(fixtureGit(root, "log", "-1", "--format=%s")).toBe(manifest.commits.plan!.subject);
  }, 120_000);

  test("during the wiring commit itself, with the move commit already landed", async () => {
    // The last position an apply can die: `git commit` for the wiring commit
    // fails outright, with the move commit in history and the wiring content
    // staged. Rollback has to undo a commit *and* an index *and* the files.
    //
    // The failure is git's own. A `post-commit` hook — which `--no-verify` does
    // not disable, unlike `pre-commit` (see the deviation below) — turns on
    // commit signing with a key that does not exist once the move commit has
    // landed, so the very next `git commit` dies in `gpg` with exit 128. No code
    // in `src/` participates.
    const { root, config, manifest, manifestPath } = fixture();
    const hook = join(root, ".git/hooks/post-commit");
    writeFileSync(hook, "#!/bin/sh\ngit config commit.gpgsign true\ngit config user.signingkey NOSUCHKEY0000\n");
    chmodSync(hook, 0o755);
    const before = repoState(root);

    const error = await expectApplyToFail(applyPlan({ config, rootDir: root, manifest, manifestPath, commit: true }));
    expect(error.name).toBe("ApplyError");
    expect(error.message).toContain("git commit");
    expect(error.message).toContain(`[rollback complete: HEAD and index reset to ${before.head}`);

    expect(movedThroughMoveCommit(root, manifest)).toBe(true);
    expectRestored(repoState(root), before);
    expect(fixtureGit(root, "log", "-1", "--format=%s")).toBe(manifest.commits.plan!.subject);
    // The move commit is no longer reachable: history is the length it was.
    expect(fixtureGit(root, "rev-list", "--count", "HEAD")).toBe(fixtureGit(root, "rev-list", "--count", before.head));
  }, 120_000);

  test("a failing pre-commit hook does not stop either commit", async () => {
    // Both commits use `--no-verify`, deliberately and now consistently with
    // what `commitStaged` says about itself — it used to document that "the
    // wiring commit runs the hooks normally" while hardcoding `--no-verify` for
    // both.
    //
    // The code was kept and the comment corrected, for two reasons spelled out
    // at `commitStaged`: the repository's own gates already ran, in the
    // simulation, against exactly these bytes; and a hook that rewrites staged
    // content would make the landed commit differ from the plan the reviewer
    // approved and the audit verifies against `resultHash`. A repository that
    // wants its hooks over this content configures them as a gate, where a
    // failure costs nothing instead of rolling back a correct move commit.
    //
    // If that is ever revisited, this test fails and says exactly what changed.
    const { root, config, manifest, manifestPath } = fixture();
    const hook = join(root, ".git/hooks/pre-commit");
    writeFileSync(hook, "#!/bin/sh\necho 'fixture hook refuses this commit' >&2\nexit 1\n");
    chmodSync(hook, 0o755);

    const result = await applyPlan({ config, rootDir: root, manifest, manifestPath, commit: true });
    expect(result.ok).toBe(true);
    expect(result.rolledBack).toBe(false);
    expect(fixtureGit(root, "log", "-1", "--format=%s")).toBe(manifest.commits.wiring.subject);
  }, 120_000);
});
