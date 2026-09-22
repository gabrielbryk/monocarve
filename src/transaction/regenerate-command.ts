/**
 * Subprocess and working-tree primitives shared by the two regeneration paths
 * in this directory: the configured generated artifacts and the post-journal
 * preparers. Both need to run a configured shell command in a given tree and to
 * tell which files that command touched, and both must do it the same way — so
 * the rules live here once rather than being restated per call site.
 */

import { scrubbedGitEnv, statusEntries } from "../util/git.ts";

/** Enough of a generator's output to act on, never its whole log. */
const OUTPUT_TAIL = 4000;

export interface CommandResult {
  readonly exitCode: number;
  readonly durationMs: number;
  readonly output: string;
}

/**
 * The command, from the workspace root, under the same environment discipline
 * as every other subprocess here: `GIT_INDEX_FILE`, `GIT_DIR` and friends are
 * stripped, because a generator that shells out to git would otherwise write
 * into whatever repository those variables name — which during a simulation is
 * emphatically not the tree it was asked to regenerate.
 */
export function run(command: string, cwd: string, timeoutMs: number): CommandResult {
  const started = Date.now();
  const result = Bun.spawnSync(["sh", "-c", command], {
    cwd,
    env: scrubbedGitEnv(),
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
  });
  // Truthiness, not `!== null`: a process that exited normally reports the
  // signal as `null` on some paths and `undefined` on others, and a note
  // reading "killed by undefined" is worse than no note at all.
  const signal = result.signalCode ? `killed by ${result.signalCode} after ${timeoutMs}ms\n` : "";
  const exitCode = result.exitCode ?? 1;
  const output = `${signal}${result.stdout.toString()}${result.stderr.toString()}`.trimEnd().slice(-OUTPUT_TAIL);
  return { exitCode, durationMs: Date.now() - started, output };
}

export function dirtyPaths(rootDir: string): ReadonlySet<string> {
  return new Set(statusEntries(rootDir).flatMap((entry) => entry.paths));
}

export function newlyDirtyPaths(rootDir: string, before: ReadonlySet<string>): string[] {
  return [...dirtyPaths(rootDir)].filter((path) => !before.has(path)).sort();
}
