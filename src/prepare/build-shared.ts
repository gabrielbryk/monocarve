/**
 * Pieces shared by every preparation compiler (`build.ts`, `build-boundary.ts`,
 * `value-split.ts`, `generated-source-adoption.ts`). Kept dependency-free of
 * those compilers so none of them has to import another.
 */
import { PlanningError } from "../plan/context.ts";
import { git, repositoryPrefix } from "../util/git.ts";
import type { PreparationCommitSpec, PreparationGates } from "./manifest-types.ts";

export interface PreparationManifestRendering {
  /** Fully rendered repository gates. The compiler never invents commands. */
  readonly gates: PreparationGates;
  /** Fully rendered commit metadata. `{planId}` is refused to prevent an ID cycle. */
  readonly commit: PreparationCommitSpec;
}

export function baselineFileMode(rootDir: string, commit: string, path: string): number {
  const output = git({ cwd: rootDir }, "ls-tree", commit, "--", `${repositoryPrefix(rootDir)}${path}`);
  const match = /^(\d{6})\s+\w+\s+[0-9a-f]+\t/.exec(output);
  if (!match?.[1]) throw new PlanningError(`could not read baseline file mode for ${path}`);
  const treeMode = Number.parseInt(match[1], 8);
  if (!Number.isSafeInteger(treeMode) || (treeMode & 0o170000) !== 0o100000) {
    throw new PlanningError(`preparation donor ${path} is not a regular baseline file`);
  }
  return treeMode & 0o777;
}
