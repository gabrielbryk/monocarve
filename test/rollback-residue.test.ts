import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import type { ExtractionManifest } from "../src/plan/manifest.ts";
import { ApplyError, applyPlan } from "../src/transaction/apply.ts";
import { executeJournal, snapshotPaths, type Snapshot } from "../src/transaction/journal.ts";
import { rollback } from "../src/transaction/rollback.ts";
import { hashText } from "../src/util/hash.ts";
import {
  DONOR,
  LOCKFILE_APPLIED,
  PACKAGE_ROOT,
  TARGET,
  TOKENS,
  TOKENS_DIR,
  baseManifest,
  cleanupFixtures,
  expectApplyToFail,
  expectRestored,
  extractionFiles,
  fixture,
  fixtureConfig,
  fixtureGit,
  fixtureRepo,
  read,
  repoState,
  restoreNote,
  withReadOnlyDirectory,
  write,
} from "./support/rollback-fixture.ts";

describe("rollback reports residue loudly when it cannot restore", () => {
  afterEach(cleanupFixtures);

  test("rejects a restore that reports success but leaves bytes unlike its snapshot", async () => {
    // Failure shape: a restore writer returns successfully after writing the
    // wrong bytes. `restoreSnapshot` has no error to report in that case, so a
    // rollback that trusts its report returns false success and leaves a
    // corrupted checkout. The post-restore comparison is the only check here
    // that can fail on that plausible bug.
    const root = fixtureRepo({ "payload.ts": "export const value = 'before';\n" });
    const path = "payload.ts";
    const expected = "export const value = 'before';\n";
    const incorrectlyRestored = "export const value = 'wrong';\n";
    write(root, path, "export const value = 'changed';\n");
    const snapshots = new Map<string, Snapshot>([
      [
        path,
        {
          exists: true,
          // This deliberately models a false-success writer: it writes these
          // bytes but claims the snapshot hash of `expected` was restored.
          content: new TextEncoder().encode(incorrectlyRestored),
          state: hashText(expected),
          kind: "file",
          mode: lstatSync(join(root, path)).mode & 0o777,
          absentAncestors: [],
        },
      ],
    ]);

    const result = await rollback(root, { headCommit: fixtureGit(root, "rev-parse", "HEAD"), branch: null, snapshots, staged: false });

    expect(result.ok).toBe(false);
    expect(result.residue).toEqual([path]);
    expect(result.restored).toEqual([path]);
    expect(result.message).toContain("ROLLBACK INCOMPLETE - manual recovery required");
    expect(result.message).toContain(`1 path(s) still differ from their snapshot: ${path}`);
    expect(read(root, path)).toBe(incorrectlyRestored);
  });

  test("replaces a same-byte symlink with the snapshotted regular file", async () => {
    // A symlink to a file with the same bytes fooled the old `fileState`
    // comparison. That was a false-success rollback: the checkout retained a
    // link even though the snapshot owned a regular file.
    const root = fixtureRepo({ "payload.ts": "export const value = 1;\n", "target.ts": "export const value = 1;\n" });
    const path = "payload.ts";
    const snapshots = snapshotPaths(root, [path]);
    rmSync(join(root, path));
    symlinkSync("target.ts", join(root, path));

    const result = await rollback(root, { headCommit: fixtureGit(root, "rev-parse", "HEAD"), branch: null, snapshots, staged: false });

    expect(result.ok).toBe(true);
    expect(result.restored).toEqual([path]);
    expect(lstatSync(join(root, path)).isSymbolicLink()).toBe(false);
    expect(read(root, path)).toBe("export const value = 1;\n");
  });

  test("replaces a dangling symlink instead of writing through it", async () => {
    // `existsSync` calls stat and therefore calls a dangling symlink missing.
    // The old restore wrote through that link, created its target, and then
    // accepted the matching bytes as success while the link remained.
    const root = fixtureRepo({ "payload.ts": "export const value = 1;\n" });
    const path = "payload.ts";
    const danglingTarget = "not-created.ts";
    const snapshots = snapshotPaths(root, [path]);
    rmSync(join(root, path));
    symlinkSync(danglingTarget, join(root, path));

    const result = await rollback(root, { headCommit: fixtureGit(root, "rev-parse", "HEAD"), branch: null, snapshots, staged: false });

    expect(result.ok).toBe(true);
    expect(result.restored).toEqual([path]);
    expect(lstatSync(join(root, path)).isSymbolicLink()).toBe(false);
    expect(existsSync(join(root, danglingTarget))).toBe(false);
  });

  test("restores a snapshotted symlink after it was replaced with a regular file", async () => {
    // The reverse transition matters independently: an ordinary file can have
    // the link target's exact bytes, but it is not the symlink the snapshot
    // promised to restore.
    const root = fixtureRepo({ "target.ts": "export const value = 1;\n" });
    const path = "payload.ts";
    const linkTarget = "target.ts";
    symlinkSync(linkTarget, join(root, path));
    const snapshots = snapshotPaths(root, [path]);
    rmSync(join(root, path));
    write(root, path, "export const value = 1;\n");

    const result = await rollback(root, { headCommit: fixtureGit(root, "rev-parse", "HEAD"), branch: null, snapshots, staged: false });

    expect(result.ok).toBe(true);
    expect(result.restored).toEqual([path]);
    expect(lstatSync(join(root, path)).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(root, path))).toBe(linkTarget);
  });

  test("restores executable mode when bytes did not drift", async () => {
    // Content hashes alone cannot observe this. A mode-only change must still
    // count as residue until rollback puts the original executable permission
    // bits back.
    const root = fixtureRepo({ "script.ts": "export const run = () => 1;\n" });
    const path = "script.ts";
    const absolute = join(root, path);
    chmodSync(absolute, 0o755);
    const snapshots = snapshotPaths(root, [path]);
    chmodSync(absolute, 0o644);

    const result = await rollback(root, { headCommit: fixtureGit(root, "rev-parse", "HEAD"), branch: null, snapshots, staged: false });

    expect(result.ok).toBe(true);
    expect(result.restored).toEqual([path]);
    expect(lstatSync(absolute).mode & 0o777).toBe(0o755);
  });

  test("says ROLLBACK INCOMPLETE and names exactly what it could not put back", async () => {
    // The other half of the contract, and the only shape that still produces
    // residue: something has to make a path unwritable *between* the journal
    // writing it and the recovery putting it back. A generator does, and this
    // one does what generators routinely do — marks its output read-only so
    // nobody hand-edits it — and then fails. The rollback restores everything
    // else and is left with one file it cannot touch.
    const artifact = "generated/registry.ts";
    const regenerated = "export const registry = [1];\n";
    const artifactDirectory = "generated";
    const regenerate = `printf 'export const registry = [1];\\n' > ${artifact} && chmod a-w ${artifactDirectory} && exit 7`;
    const { root, config, manifest, manifestPath } = fixture(
      { ...extractionFiles(), [artifact]: "export const registry = [];\n" },
      (base) => ({
        ...base,
        generatedFiles: [
          {
            path: artifact,
            source: PACKAGE_ROOT,
            regenerate,
            regenerateOnApply: true,
            exemptReason: "the fixture's generator writes a fixed line and then refuses",
          },
        ],
        changedFiles: [...base.changedFiles, artifact].sort(),
      }),
      { generatedArtifacts: { artifacts: [{ path: artifact, source: PACKAGE_ROOT, regenerate }] } },
    );
    const before = repoState(root);

    let error: Error;
    try {
      error = await expectApplyToFail(applyPlan({ config, rootDir: root, manifest, manifestPath, commit: true, skipSimulation: true }));
    } finally {
      // Let the assertion inspect the true recovery result, then make fixture
      // cleanup possible. The rollback has already happened before this runs.
      chmodSync(join(root, artifactDirectory), 0o755);
    }

    // Both, in one message: the failure that has to be fixed, and the state it
    // left behind. The recovery's own failure does not displace the cause.
    expect(error!.message).toContain(`regenerating ${artifact} failed (exit 7)`);
    expect(error!.message).toContain("ROLLBACK INCOMPLETE - manual recovery required");
    expect(error!.message).toContain(`1 path(s) NOT restored: ${artifact}`);
    expect(error!.message).toContain("EACCES");
    // Precise, not merely loud: the file actually left behind is the one named,
    // and it reaches a caller as data and not only as prose.
    expect((error as ApplyError).residue).toEqual([artifact]);

    const after = repoState(root);
    expect(Object.keys(after.files)).toEqual(Object.keys(before.files));
    expect(Object.keys(after.files).filter((path) => after.files[path] !== before.files[path])).toEqual([artifact]);
    expect(read(root, artifact)).toBe(regenerated);
    // Everything else is genuinely back, which is the point of attempting every
    // path instead of stopping at the first refusal — and the residue is loud in
    // `git status`, which is where a developer will look.
    expect(after.directories).toEqual(before.directories);
    expect(after.head).toBe(before.head);
    expect(after.index).toBe(before.index);
    expect(after.status).toContain(`M ${artifact}`);
    expect(after.status.split("\n").filter(Boolean)).toHaveLength(1);
  }, 120_000);

  test("an untouched read-only file is not residue, and does not displace the real failure", async () => {
    // The reproduction that found three defects at once, now asserting what it
    // ought to have found. The fixture's lockfile already carries the importer
    // block, so the journal correctly *skips* the lockfile operation — nothing
    // writes that file. It is then made read-only, and the journal is made to
    // die on its last operation by a read-only target directory.
    //
    // What used to happen: `restoreSnapshot` rewrote every snapshot path
    // unconditionally, so it failed with EACCES on a file the transaction never
    // modified; that throw happened inside `executeJournal`'s catch *before* it
    // rethrew, so the failure that mattered — the operation that could not write
    // into the read-only directory — was discarded; and the apply then reported
    // ROLLBACK INCOMPLETE, naming a file nothing had touched, over a checkout
    // that was in fact completely restored. Safe in direction and useless in
    // practice: it destroyed the operator's ability to see a true alarm.
    const files = { ...extractionFiles(), "pnpm-lock.yaml": LOCKFILE_APPLIED };

    // The control, on an identical fixture: with only the target directory
    // read-only, the failure is reported where it happens and the recovery
    // succeeds. The case below must be indistinguishable from it.
    const control = fixture(files);
    await withReadOnlyDirectory(join(control.root, TOKENS_DIR), async () => {
      const reported = await expectApplyToFail(applyPlan({ ...control, rootDir: control.root, commit: true, skipSimulation: true }));
      expect(reported.message).toContain(TOKENS_DIR);
      expect(reported.message).toContain("rollback complete");
      // Four of six: the skipped lockfile operation changed nothing.
      expect(reported.message).toContain(restoreNote(4));
    });

    const { root, config, manifest, manifestPath } = fixture(files);
    const lockfile = join(root, "pnpm-lock.yaml");
    const before = repoState(root);

    let error: Error;
    await withReadOnlyDirectory(join(root, TOKENS_DIR), async () => {
      chmodSync(lockfile, 0o444);
      try {
        error = await expectApplyToFail(applyPlan({ config, rootDir: root, manifest, manifestPath, commit: true, skipSimulation: true }));
      } finally {
        chmodSync(lockfile, 0o644);
      }
    });

    // The reported failure is the directory the journal could not write into,
    // and the untouched file is not mentioned at all — it is not residue,
    // because the restore never needed to write it.
    expect(error!.message).toContain(TOKENS_DIR);
    expect(error!.message).not.toContain("pnpm-lock.yaml");
    expect(error!.message).toContain("rollback complete");
    expect(error!.message).not.toContain("ROLLBACK INCOMPLETE");
    expect(error!.message).toContain(restoreNote(4));
    expectRestored(repoState(root), before);
  }, 120_000);

  test("a restore that fails is reported alongside the failure that caused it", async () => {
    // Error preservation, at the position where it was actually broken:
    // `executeJournal`'s own catch, which restored the snapshot and let that
    // restore's exception replace the failure it was recovering from.
    //
    // Making a restore fail *inside* the journal takes some doing now, and that
    // is the fix working: a restore only writes paths an operation wrote, and
    // what the kernel permitted then it permits a moment later. What it cannot
    // survive is a path whose *type* changed underneath it — so this plan, which
    // no compiler would ever emit, moves the donor away and then scaffolds a
    // file *inside* a directory of the donor's own name. The journal then dies
    // for an unrelated reason (a read-only target directory, EACCES from the
    // kernel), and the restore meets a directory where it must write a file.
    // Nothing is stubbed: both errors come from the operating system.
    const root = fixtureRepo(extractionFiles());
    const config = fixtureConfig(root);
    const base = baseManifest(root);
    const inside = `${DONOR}/note.ts`;
    const note = "export const note = 1;\n";
    const manifest: ExtractionManifest = {
      ...base,
      operations: [
        base.operations[0]!,
        { kind: "write-file", path: inside, contents: note, preconditionHash: "missing", resultHash: hashText(note), generator: "scaffold:note" },
        base.operations[4]!,
      ],
    };

    let error: Error;
    await withReadOnlyDirectory(join(root, TOKENS_DIR), async () => {
      error = await expectApplyToFail(executeJournal({ config, treeRoot: root, manifest }));
    });

    // The cause, which is what has to be fixed…
    expect(error!.message).toContain("EACCES");
    expect(error!.message).toContain(TOKENS);
    // …and the recovery's outcome, which is what has to be cleaned up. Both, in
    // that order. Before the fix the message was the second one alone.
    expect(error!.message).toContain("JOURNAL RESTORE INCOMPLETE - 1 path(s) NOT restored");
    expect(error!.message).toContain(DONOR);
    expect(error!.message).toContain("EISDIR");

    // And the report is honest about which path that is: everything the restore
    // could undo, it undid — including the file it had to remove from inside the
    // very directory that blocked it.
    expect(existsSync(join(root, TARGET))).toBe(false);
    expect(existsSync(join(root, inside))).toBe(false);
    expect(existsSync(join(root, DONOR))).toBe(false);
  }, 120_000);
});
