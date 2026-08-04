/**
 * The changed-path scope proof, split out of `audit.ts` purely to keep that
 * file under the line-count gate: this module owns nothing about byte
 * replay, selectors, ownership, or compatibility surfaces — only comparing
 * the manifest's declared `changedFiles` against what git actually reports
 * changed since the baseline. `audit.ts` still owns `auditPreparationSync`
 * and folds this proof into its report and failure list.
 */
import { git } from "../util/git.ts";
import { byCodeUnit } from "../util/hash.ts";
import { normalizePath } from "../util/paths.ts";

export function verifyChangedScope(
  rootDir: string,
  baseline: string,
  declared: readonly string[],
  approvedManifestPath: string | undefined,
  failures: string[],
): void {
  const expected = new Set(declared.map(normalizePath));
  const actual = changedPaths(rootDir, baseline);
  if (approvedManifestPath !== undefined) actual.delete(approvedManifestPath);
  for (const path of [...actual].sort(byCodeUnit)) {
    if (!expected.has(path)) failures.push(`changed path is outside preparation scope: ${path}`);
  }
  for (const path of [...expected].sort(byCodeUnit)) {
    if (!actual.has(path)) failures.push(`declared changed path did not change: ${path}`);
  }
}

function changedPaths(rootDir: string, baseline: string): Set<string> {
  const diff = git({ cwd: rootDir }, "diff", "--name-only", baseline, "--", ".");
  const untracked = git({ cwd: rootDir }, "ls-files", "--others", "--exclude-standard", "--");
  return new Set([...lines(diff), ...lines(untracked)].map(normalizePath));
}

function lines(value: string): string[] {
  return value === "" ? [] : value.split("\n").filter((item) => item.length > 0);
}
