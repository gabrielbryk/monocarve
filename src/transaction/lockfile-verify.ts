/**
 * Opt-in: check the spliced lockfile against the one the package manager writes.
 *
 * Everything else in the pipeline compares the lockfile to the tool's own
 * transform — the plan hashes the splice, and the audit re-splices and hashes
 * again. That is internal consistency, and it says nothing about whether the
 * bytes are the ones the package manager would have written. This is the only
 * place that asks the package manager.
 *
 * It costs a real package-manager run, so it is off by default; when it is
 * asked for, every way of not getting an answer is a failure rather than a
 * note. The command comes from the adapter, and the regenerated lockfile is
 * discarded — the worktree keeps the bytes the plan declared, because the gates
 * that follow have to run against the plan, not against a repaired copy of it.
 *
 * ## What regenerating proves, and what it does not
 *
 * The regenerating command is a *serializer*, not a validator: it parses the
 * lockfile, re-resolves what the manifests no longer agree with, and writes the
 * structure back in canonical form. So a byte-identical result proves exactly
 * one thing — the planned bytes are the canonical serialization of what the
 * package manager parsed out of them. That is worth having, and it catches
 * every divergence that survives as a serialization difference: sort order,
 * quoting, an empty map against a bare key, section order, a version resolution
 * would have written differently.
 *
 * It does not catch a lockfile that is *incomplete*. An importer naming a
 * resolution the file carries no entry for round-trips untouched — the same
 * bytes, the same sha256 — while an install from those bytes fails outright.
 * Measured on the pnpm adapter at 11.17.0, and so a plan could emit a lockfile
 * this flag called correct and CI could not install.
 *
 * A second package-manager run does not fix that; both candidates were measured
 * rather than assumed, and are recorded against the adapter's own command.
 * The gap is closed the other way instead, offline: `completeness` asks the
 * adapter which resolutions the importers name that the file does not carry,
 * and a finding fails the verification even when the bytes agree. The adapter
 * refusing to write such a resolution in the first place is the other half of
 * that; this half is what notices a lockfile that arrived already broken.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { MonocarveError } from "../errors.ts";

export class LockfileVerificationError extends MonocarveError {
  override readonly name = "LockfileVerificationError";
}

export interface VerifyLockfileOptions {
  /** Workspace to run in — normally the simulation worktree, post-journal. */
  readonly workspacePath: string;
  /** Workspace-relative lockfile name, from the adapter. */
  readonly lockfileName: string;
  /** Adapter command that regenerates the lockfile without installing. */
  readonly command: readonly string[];
  /**
   * Adapter check for resolutions the lockfile names but does not carry —
   * normally `adapter.missingResolutions`. Optional so a caller with a stand-in
   * command can leave it out; when it is absent, the verification is the
   * regenerate-and-compare check alone, with the blind spot described above.
   */
  readonly completeness?: (lockfileText: string) => readonly string[];
  readonly timeoutMs?: number;
}

export interface LockfileVerification {
  readonly ok: boolean;
  /** Workspace-relative lockfile that was compared. */
  readonly lockfile: string;
  /** The command whose output it was compared against. */
  readonly command: string;
  /**
   * Everything the verification found, absent when it found nothing.
   *
   * Two kinds, in this order. A resolution the planned lockfile names and does
   * not carry comes first, as a sentence — it is the finding regenerating the
   * file cannot make, and it is the one that stops an install. After it, the
   * byte divergence as a bounded excerpt: `-` is the plan's lockfile, `+` is the
   * regenerated one.
   */
  readonly differences?: readonly string[];
}

/** Enough of a divergence to act on, never the file. */
const MAX_DIFF_LINES = 10;
const MAX_LINE_LENGTH = 200;
const COMMAND_ERROR_TAIL = 2000;

export function verifyLockfile(options: VerifyLockfileOptions): LockfileVerification {
  const [binary, ...args] = options.command;
  const printable = options.command.join(" ");
  if (binary === undefined) throw new LockfileVerificationError("lockfile verification requires a command");
  if (!isExecutable(binary)) {
    // Not a skip. The operator asked whether the splice matches what the
    // package manager writes; without the package manager there is no answer,
    // and reporting a pass here would be reporting one the run never obtained.
    throw new LockfileVerificationError(`lockfile verification needs ${binary} on PATH, and it is not there: ${printable}`);
  }

  const path = resolve(options.workspacePath, options.lockfileName);
  if (!existsSync(path)) {
    throw new LockfileVerificationError(`lockfile verification found no ${options.lockfileName} to compare`);
  }
  const planned = readFileSync(path, "utf8");

  let regenerated: string;
  try {
    const result = Bun.spawnSync([binary, ...args], {
      cwd: options.workspacePath,
      stdout: "pipe",
      stderr: "pipe",
      ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
    });
    const exitCode = result.exitCode ?? 1;
    if (exitCode !== 0) {
      const tail = result.stderr.toString().trimEnd().slice(-COMMAND_ERROR_TAIL);
      throw new LockfileVerificationError(`lockfile verification command failed (exit ${exitCode}): ${printable}${tail === "" ? "" : `\n${tail}`}`);
    }
    regenerated = readFileSync(path, "utf8");
  } finally {
    // The plan's bytes, restored whatever happened: the gates below this run
    // must see the lockfile the plan declared, and a half-regenerated worktree
    // would make every result after it describe a tree nobody planned.
    writeFileSync(path, planned);
  }

  // Against the *planned* bytes, not the regenerated ones: the plan's lockfile
  // is what the apply lands and what CI will install, and regenerating can
  // repair an incompleteness the plan still carries.
  const incomplete = (options.completeness?.(planned) ?? []).map((finding) => `${options.lockfileName}: ${finding}`);
  const differences = [...incomplete, ...lockfileDifference(planned, regenerated, options.lockfileName)];
  return { ok: differences.length === 0, lockfile: options.lockfileName, command: printable, ...(differences.length === 0 ? {} : { differences }) };
}

/**
 * The differing middle, once the common prefix and suffix are trimmed off.
 *
 * Trimming both ends is what keeps a moved block readable: a splice that lands
 * an importer in the wrong position differs from the regenerated file across
 * everything below it, and an index-by-index comparison would report that as
 * hundreds of changed lines instead of one displaced block.
 */
export function lockfileDifference(planned: string, regenerated: string, lockfile: string): string[] {
  if (planned === regenerated) return [];
  const left = planned.split("\n");
  const right = regenerated.split("\n");

  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start += 1;
  let end = 0;
  while (end < left.length - start && end < right.length - start && left[left.length - 1 - end] === right[right.length - 1 - end]) {
    end += 1;
  }

  const plannedMiddle = left.slice(start, left.length - end);
  const regeneratedMiddle = right.slice(start, right.length - end);
  return [
    `${lockfile} line ${start + 1}: ${plannedMiddle.length} planned line(s) against ${regeneratedMiddle.length} regenerated`,
    ...excerpt(plannedMiddle, "-"),
    ...excerpt(regeneratedMiddle, "+"),
  ];
}

function excerpt(lines: readonly string[], marker: string): string[] {
  const shown = lines.slice(0, MAX_DIFF_LINES).map((line) => `${marker}${truncate(line)}`);
  return lines.length > MAX_DIFF_LINES ? [...shown, `${marker} … ${lines.length - MAX_DIFF_LINES} more line(s)`] : shown;
}

function truncate(line: string): string {
  return line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}…` : line;
}

/** `Bun.which` only searches PATH, so a command given as a path is checked directly. */
function isExecutable(binary: string): boolean {
  return binary.includes("/") ? existsSync(binary) : Bun.which(binary) !== null;
}
