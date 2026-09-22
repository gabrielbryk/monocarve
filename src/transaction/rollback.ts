/**
 * Rollback.
 *
 * Rollback is not best-effort. If it cannot restore the pre-apply state exactly,
 * it says so and hands back a precise description of what remains, rather than
 * silently doing partial work and reporting success. A developer who is told
 * "rollback incomplete: these three paths" can recover in a minute; one who is
 * told nothing discovers it days later.
 *
 * "Precise" is the operative word, and it cuts both ways:
 *
 *  - what is reported as residue is what is *actually* left behind, not every
 *    path the transaction declared. A recovery that lists six files when one is
 *    unrestored costs the operator the five minutes it takes to discover the
 *    other five were fine, and costs the report its authority the next time;
 *  - a recovery failure is never reported *instead of* the failure that caused
 *    the rollback. The cause is what has to be fixed; the residue is what has to
 *    be cleaned up. An operator needs both, and the caller keeps both.
 */

import { MonocarveError } from "../errors.ts";
import { git } from "../util/git.ts";
import { restoreSnapshot, snapshotMismatch, type Snapshot } from "./journal.ts";

export class RollbackError extends MonocarveError {
  override readonly name = "RollbackError";
}

export interface RollbackPoint {
  /** HEAD before apply started. */
  readonly headCommit: string;
  /** Branch checked out at the time, for restoring a detached-HEAD accident. */
  readonly branch: string | null;
  /** Snapshot of every path the journal touches, taken before it ran. */
  readonly snapshots: ReadonlyMap<string, Snapshot>;
  /** Whether the index may hold staged changes from the attempt. */
  readonly staged: boolean;
  /**
   * Tree object recording the index exactly as apply found it, written before
   * the journal ran.
   *
   * Resetting the index to the pre-apply commit is right for staging the
   * transaction created and wrong for staging that was already there: a resume
   * is allowed to start from a dirty index, and unstaging a developer's own
   * `git add` while reporting a clean rollback is the kind of quiet loss this
   * module exists to prevent. Restoring this tree afterwards puts the index
   * back where the transaction found it, whatever was in it.
   */
  readonly indexTree?: string;
}

export interface RollbackResult {
  readonly ok: boolean;
  /** Paths that could not be restored; empty on success. */
  readonly residue: readonly string[];
  /** Paths that had changed and were put back. */
  readonly restored: readonly string[];
  readonly message: string;
}

interface SnapshotMismatch {
  readonly path: string;
  readonly message: string;
}

/**
 * A restore reporting no write error is not evidence that it restored the
 * bytes it was asked for. A buggy writer, a path replaced between write and
 * return, or an unusual filesystem can all make that report a false success.
 *
 * This is deliberately independent from `restoreSnapshot`: compare the
 * resulting filesystem state to the snapshot after *all* restore attempts,
 * then make the rollback result describe that state. A failure here is a
 * residual path, not an exception that could hide the apply failure.
 */
function snapshotMismatches(rootDir: string, snapshots: ReadonlyMap<string, Snapshot>): SnapshotMismatch[] {
  const mismatches: SnapshotMismatch[] = [];
  for (const [path, snapshot] of snapshots) {
    try {
      const mismatch = snapshotMismatch(rootDir, path, snapshot);
      if (mismatch !== undefined) mismatches.push({ path, message: mismatch });
    } catch (error) {
      mismatches.push({ path, message: `could not verify restored state (${(error as Error).message})` });
    }
  }
  return mismatches;
}

export async function rollback(rootDir: string, point: RollbackPoint): Promise<RollbackResult> {
  const problems: string[] = [];
  const notes: string[] = [];

  if (point.staged) {
    try {
      git({ cwd: rootDir, quiet: true }, "reset", "--mixed", point.headCommit);
    } catch (error) {
      problems.push(`HEAD/index reset to ${point.headCommit} FAILED (${(error as Error).message})`);
    }
    if (point.indexTree === undefined) {
      // Only reachable when the index could not be recorded at all — an
      // unmerged index, which `git write-tree` refuses. Say so rather than let
      // a discarded `git add` pass for a complete rollback.
      notes.push("the pre-apply index could not be recorded, so staging that predated the apply was not preserved");
    } else {
      try {
        git({ cwd: rootDir, quiet: true }, "read-tree", point.indexTree);
      } catch (error) {
        problems.push(`pre-apply index restore FAILED (${(error as Error).message})`);
      }
    }
  }

  const restore = restoreSnapshot(rootDir, point.snapshots);
  if (restore.failures.length > 0) {
    problems.push(`${restore.failures.length} path(s) NOT restored: ` + restore.failures.map((failure) => `${failure.path} (${failure.message})`).join("; "));
  }

  const mismatches = snapshotMismatches(rootDir, point.snapshots);
  if (mismatches.length > 0) {
    problems.push(
      `${mismatches.length} path(s) still differ from their snapshot: ` + mismatches.map((mismatch) => `${mismatch.path} (${mismatch.message})`).join("; "),
    );
  }

  // The report exposes the paths that are really still wrong, rather than the
  // paths a write happened to complain about. The verification pass is the
  // authority: it catches a false-success restore and avoids claiming residue
  // for a path another recovery step has already put back.
  const residue = mismatches.map((mismatch) => mismatch.path);
  if (problems.length === 0) {
    return {
      ok: true,
      residue,
      restored: restore.restored,
      message:
        `rollback complete: HEAD and index reset to ${point.headCommit}; restored ${restore.restored.length} of ` +
        `${point.snapshots.size} operation path(s) on disk${notes.length === 0 ? "" : ` (${notes.join("; ")})`}`,
    };
  }
  return { ok: false, residue, restored: restore.restored, message: `ROLLBACK INCOMPLETE - manual recovery required: ${[...problems, ...notes].join("; ")}` };
}
