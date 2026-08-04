/** Permission-mode proof for preparation replay outputs. */
import { lstatSync } from "node:fs";

import { MISSING } from "../util/hash.ts";
import { workspacePath } from "../util/paths.ts";
import type { PreparationReplayOperation } from "./manifest-types.ts";

/**
 * A mismatch means the landed object is not the exact regular file approved
 * by the manifest, even if its bytes happen to match.
 */
export function verifyPreparationResultModes(
  rootDir: string,
  operations: readonly PreparationReplayOperation[],
  failures: string[],
): number {
  let checked = 0;
  for (const operation of operations) {
    if (operation.kind === "delete-module") {
      checked += 1;
      const actual = modeAt(rootDir, operation.file.path);
      // Delete operations predate a missing-mode sentinel and serialize their
      // structurally required resultMode as 0. That value is not a file mode:
      // the approved result is absence, as the journal already enforces.
      if (actual !== MISSING) {
        failures.push(`landed deletion did not remove ${operation.file.path} (expected missing, got ${actual})`);
      }
      continue;
    }
    const mutations = operation.kind === "extract-type-declarations"
      ? [operation.donor, operation.target]
      : [operation.file];
    for (const mutation of mutations) {
      checked += 1;
      const actual = modeAt(rootDir, mutation.path);
      if (actual !== mutation.resultMode) {
        failures.push(`landed mode differs: ${mutation.path} (expected ${mutation.resultMode}, got ${actual})`);
      }
    }
  }
  return checked;
}

function modeAt(rootDir: string, path: string): number | typeof MISSING | "non-file" {
  try {
    const stat = lstatSync(workspacePath(rootDir, path));
    return stat.isFile() ? canonicalGitMode(Number(stat.mode)) : "non-file";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return MISSING;
    throw error;
  }
}

/** Git records only the regular-file executable bit, never local umask bits. */
function canonicalGitMode(mode: number): number {
  return (mode & 0o111) === 0 ? 0o644 : 0o755;
}
