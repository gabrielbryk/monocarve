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
  const mutations = operations.flatMap((operation) => operation.kind === "extract-type-declarations"
    ? [operation.donor, operation.target]
    : [operation.file]);
  for (const mutation of mutations) {
    const actual = modeAt(rootDir, mutation.path);
    if (actual !== mutation.resultMode) {
      failures.push(`landed mode differs: ${mutation.path} (expected ${mutation.resultMode}, got ${actual})`);
    }
  }
  return mutations.length;
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
