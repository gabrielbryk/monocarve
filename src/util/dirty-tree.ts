/**
 * The one dirty-working-tree policy, shared by planning and applying.
 *
 * A plan records file hashes as they are on disk and apply replays them, so
 * both commands need the tree to be clean for every path the plan can see.
 * Neither needs it clean for a path the plan cannot see: a repository may run
 * agents or editors that keep unrelated files perpetually modified, and
 * `transaction.allowDirtyPaths` is how it says so.
 *
 * The allowance is never unconditional. A listed path that turns out to be
 * plan-sensitive — a plan input, output, consumer, moved source, or regenerated
 * artifact — is still refused, because there the dirt is the thing the proof
 * depends on.
 */

import { statusEntries } from "./git.ts";

/** Equal paths and directory containment overlap; string-prefix matches do not. */
function pathOverlaps(left: string, right: string): boolean {
  const normalizedLeft = left.replace(/\/+$/, "");
  const normalizedRight = right.replace(/\/+$/, "");
  return normalizedLeft === normalizedRight || normalizedLeft.startsWith(`${normalizedRight}/`) || normalizedRight.startsWith(`${normalizedLeft}/`);
}

/**
 * Dirty paths this transaction may not proceed over, sorted and deduplicated.
 * Empty means the tree is clean enough.
 */
export function disallowedDirtyPaths(rootDir: string, allowDirtyPaths: readonly string[], sensitivePaths: readonly string[]): readonly string[] {
  const entries = statusEntries(rootDir);
  if (entries.length === 0) return [];
  const disallowed = entries.flatMap((entry) =>
    entry.paths.filter(
      (path) => !allowDirtyPaths.some((allowed) => pathOverlaps(path, allowed)) || sensitivePaths.some((sensitive) => pathOverlaps(path, sensitive)),
    ),
  );
  return [...new Set(disallowed)].toSorted();
}
