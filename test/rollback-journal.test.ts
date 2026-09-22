import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { applyPlan } from "../src/transaction/apply.ts";
import {
  PACKAGE_ROOT,
  RESTORED_BEFORE_OPERATION,
  TOKENS,
  TOKENS_DIR,
  cleanupFixtures,
  expectApplyToFail,
  expectRestored,
  fixture,
  type Fixture,
  repoState,
  restoreNote,
  withReadOnlyDirectory,
} from "./support/rollback-fixture.ts";

describe("rollback restores the checkout from every journal position", () => {
  afterEach(cleanupFixtures);

  // The seam throws *before* operation `i` runs, so the tree it leaves is the
  // tree a genuine crash inside operation `i` would leave: operations 0..i-1
  // applied, `i` not. `seam and EACCES stop the journal at the same operation`
  // proves that equivalence at the one position both mechanisms can reach.
  for (const index of [0, 1, 2, 3, 4]) {
    test(`restores everything when operation ${index} fails`, async () => {
      const { root, config, manifest, manifestPath } = fixture();
      const before = repoState(root);

      process.env.MONOCARVE_FAIL_OPERATION = String(index);
      let error: Error;
      try {
        // The seam fires in the simulation's journal too, which would abort the
        // apply before the checkout was ever touched; the simulation has its own
        // proofs elsewhere and is not what this case is about.
        error = await expectApplyToFail(applyPlan({ config, rootDir: root, manifest, manifestPath, commit: true, skipSimulation: true }));
      } finally {
        delete process.env.MONOCARVE_FAIL_OPERATION;
      }

      // Loud: the error names the failure and carries the recovery's verdict.
      expect(error.name).toBe("ApplyError");
      expect(error.message).toContain(`injected operation failure ${index}`);
      expect(error.message).toContain(`[rollback complete: HEAD and index reset to ${before.head}`);

      // …and says how far the journal had got, which is how this suite knows
      // the seam stopped where it claims to have stopped.
      const restored = RESTORED_BEFORE_OPERATION[index]!;
      if (restored === 0) expect(error.message).not.toContain("journal restored");
      else expect(error.message).toContain(restoreNote(restored));

      expectRestored(repoState(root), before);
    }, 120_000);
  }

  test("restores everything when the last operation genuinely cannot write (EACCES)", async () => {
    // No seam: the kernel refuses the write because the plan's target directory
    // is read-only. The directory is empty and untracked, so git does not carry
    // it — the simulation worktree does not have it, the simulation passes, and
    // the failure happens only in the real checkout.
    const { root, config, manifest, manifestPath } = fixture();
    const before = repoState(root);

    await withReadOnlyDirectory(join(root, TOKENS_DIR), async () => {
      const error = await expectApplyToFail(applyPlan({ config, rootDir: root, manifest, manifestPath, commit: true }));
      expect(error.name).toBe("ApplyError");
      expect(error.message).toContain("EACCES");
      expect(error.message).toContain(`[rollback complete: HEAD and index reset to ${before.head}`);
      expect(error.message).toContain(restoreNote(RESTORED_BEFORE_OPERATION[4]!));
    });

    expectRestored(repoState(root), before);
  }, 120_000);

  test("restores everything when the first operation genuinely cannot write (EACCES)", async () => {
    // Same mechanism at the other end of the journal: the move's target
    // directory cannot be created, so operation 0 fails and nothing was applied.
    const { root, config, manifest, manifestPath } = fixture();
    const before = repoState(root);

    await withReadOnlyDirectory(join(root, `${PACKAGE_ROOT}/src`), async () => {
      const error = await expectApplyToFail(applyPlan({ config, rootDir: root, manifest, manifestPath, commit: true }));
      expect(error.message).toContain("EACCES");
      expect(error.message).toContain("rollback complete");
      // Nothing applied, so nothing to put back: the recovery is silent about
      // restoring rather than claiming work it did not do.
      expect(error.message).not.toContain("journal restored");
    });

    expectRestored(repoState(root), before);
  }, 120_000);

  test("seam and EACCES stop the journal at the same operation", async () => {
    // The pin that makes the sweep above evidence rather than decoration: the
    // seam has to leave the tree a genuine failure at the same operation leaves.
    //
    // This used to be shown by freezing the half-applied tree — a read-only
    // file that no operation touched made `restoreSnapshot` throw on its first
    // entry, before it had undone anything, so the mid-journal tree survived
    // for inspection. That is the exact defect the recovery path was fixed for:
    // a restore now skips a path that already holds its snapshot bytes, so an
    // untouched read-only file cannot block it, and no arrangement of
    // permissions can freeze the tree any more. Every path a restore must write
    // is a path an operation wrote first, and what the kernel allowed once it
    // allows again.
    //
    // What survives the recovery is its own account of it: the number of paths
    // that differed from the baseline when the failure hit — which is a direct
    // measure of how far the journal got, and which the sweep pins separately
    // at every position (see RESTORED_BEFORE_OPERATION, strictly increasing, so
    // two positions can never report the same count).
    async function messageFrom(fail: (target: Fixture) => Promise<Error>): Promise<string> {
      const target = fixture();
      const before = repoState(target.root);
      const error = await fail(target);
      // Whichever mechanism produced it, the checkout is the baseline again.
      expectRestored(repoState(target.root), before);
      return error.message;
    }

    const bySeam = await messageFrom(async (target) => {
      process.env.MONOCARVE_FAIL_OPERATION = "4";
      try {
        return await expectApplyToFail(applyPlan({ ...target, rootDir: target.root, commit: true, skipSimulation: true }));
      } finally {
        delete process.env.MONOCARVE_FAIL_OPERATION;
      }
    });

    const byKernel = await messageFrom(async (target) => {
      let error!: Error;
      await withReadOnlyDirectory(join(target.root, TOKENS_DIR), async () => {
        error = await expectApplyToFail(applyPlan({ ...target, rootDir: target.root, commit: true, skipSimulation: true }));
      });
      return error;
    });

    // The claim: stopping before operation 4 and having operation 4 refused by
    // the kernel leave the same amount of the journal applied.
    const note = restoreNote(RESTORED_BEFORE_OPERATION[4]!)!;
    expect(bySeam).toContain(note);
    expect(byKernel).toContain(note);

    // …and each mechanism is still the mechanism it claims to be: the seam
    // names the operation index it was given, the kernel names the file it
    // refused. Without this, both sides could be failing for the same reason.
    expect(bySeam).toContain("injected operation failure 4");
    expect(bySeam).not.toContain("EACCES");
    expect(byKernel).toContain(`EACCES: permission denied, open`);
    expect(byKernel).toContain(TOKENS);
  }, 120_000);
});
