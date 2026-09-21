import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { MonocarveConfig } from "../config.ts";
import { isGuardedBranch } from "../config.ts";
import { executePreparationJournal, rollbackCompletedPreparationJournal } from "../prepare/journal.ts";
import { byCodeUnit } from "../util/hash.ts";
import { currentBranch, git, headCommit, repositoryPrefix, scrubbedGitEnv, statusEntries, tryGit } from "../util/git.ts";
import { fileState } from "../util/files.ts";
import { workspacePath } from "../util/paths.ts";
import type { PreparerManifest } from "./manifest.ts";
import { assertApprovedPreparerManifest, assertPreparerManifest, PreparerError, simulatePreparerManifest } from "./core.ts";
import { ensureScratchDir } from "../util/scratch-root.ts";

/** Commit a new preparer configuration and its approval while hooks observe its reviewed outputs. */
export async function commitPreparerBootstrap(rootDir: string, config: MonocarveConfig, path: string, manifest: PreparerManifest, subject: string): Promise<string> {
  assertPreparerManifest(config, manifest);
  const bootstrap = manifest.bootstrapConfig;
  if (bootstrap === undefined) throw new PreparerError("preparer manifest does not declare a bootstrap config");
  const branch = currentBranch(rootDir);
  if (isGuardedBranch(config, branch)) throw new PreparerError(`refusing to commit preparer bootstrap on guarded branch ${branch}`);
  const baseline = manifest.baseline.commit;
  if (headCommit(rootDir) !== baseline) throw new PreparerError("bootstrap commit requires the exact manifest baseline at HEAD");
  assertInitialState(rootDir, path, manifest);
  await simulatePreparerManifest({ rootDir, config, manifest });

  const journal = executePreparationJournal({ rootDir, operations: manifest.mutations.map((item) => ({ kind: "write" as const, ...item })) });
  const temporary = createTemporaryIndex(rootDir, manifest.mutations.map((item) => item.path));
  let committed = false;
  try {
    temporary.run("add", "-f", "--", bootstrap.path, path);
    temporary.run("commit", "-m", subject);
    committed = true;
    const result = headCommit(rootDir);
    assertExactCommit(rootDir, baseline, result, [bootstrap.path, path]);
    if (temporary.run("status", "--porcelain=v1", "--untracked-files=all", "--", ".") !== "") throw new PreparerError("commit hooks changed the reviewed bootstrap tree");
    // The real index was never exposed to the temporary outputs. Advance it to
    // the new two-file commit before restoring those outputs in the worktree.
    git({ cwd: rootDir, quiet: true }, "reset", "--mixed", result);
    assertApprovedPreparerManifest(rootDir, path, manifest);
    return result;
  } catch (error) {
    if (committed && git({ cwd: rootDir }, "rev-parse", "HEAD^") === baseline) git({ cwd: rootDir, quiet: true }, "reset", "--mixed", baseline);
    throw error;
  } finally {
    temporary.dispose();
    const restored = rollbackCompletedPreparationJournal(journal.recovery);
    if (restored.failures.length > 0) throw new PreparerError(`bootstrap output rollback was incomplete: ${restored.failures.map((item) => item.path).join(", ")}`);
  }
}

function assertInitialState(rootDir: string, path: string, manifest: PreparerManifest): void {
  const bootstrap = manifest.bootstrapConfig!;
  const allowedDirty = new Set([bootstrap.path, path]);
  const dirty = unique(statusEntries(rootDir).flatMap((entry) => entry.paths));
  if (!dirty.includes(bootstrap.path) || dirty.some((item) => !allowedDirty.has(item))) throw new PreparerError(`bootstrap commit requires only config and manifest dirty paths; found: ${dirty.join(", ") || "(none)"}`);
  const actual = state(rootDir, bootstrap.path);
  if (actual.hash !== bootstrap.resultHash || actual.mode !== bootstrap.resultMode) throw new PreparerError("bootstrap config differs from reviewed result");
  if (git({ cwd: rootDir }, "diff", "--cached", "--name-only") !== "") throw new PreparerError("bootstrap commit requires an initially empty index");
}

/**
 * The temporary index gives hooks two truthful views simultaneously: outputs
 * exist in the worktree but are hidden as unchanged, while config and manifest
 * alone are staged and become the commit snapshot.
 */
function createTemporaryIndex(rootDir: string, outputs: readonly string[]): { readonly run: (...args: string[]) => string; readonly dispose: () => void } {
  const directory = mkdtempSync(ensureScratchDir("bootstrap-index-"));
  const index = join(directory, "index");
  const excludes = join(directory, "exclude");
  copyFileSync(git({ cwd: rootDir }, "rev-parse", "--path-format=absolute", "--git-path", "index"), index);
  const prefix = repositoryPrefix(rootDir);
  const tracked = outputs.filter((path) => tryGit({ cwd: rootDir }, "ls-files", "--error-unmatch", "--", path) !== null);
  const untracked = outputs.filter((path) => !tracked.includes(path));
  writeFileSync(excludes, untracked.map((path) => `/${escapeIgnore(`${prefix}${path}`)}`).join("\n") + (untracked.length === 0 ? "" : "\n"));
  const run = (...args: string[]): string => bootstrapGit(rootDir, index, excludes, args);
  if (tracked.length > 0) run("update-index", "--skip-worktree", "--", ...tracked);
  return { run, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

function bootstrapGit(rootDir: string, index: string, excludes: string, args: readonly string[]): string {
  try {
    return execFileSync("git", ["-c", `core.excludesFile=${excludes}`, ...args], {
      cwd: rootDir,
      encoding: "utf8",
      env: { ...scrubbedGitEnv(), GIT_INDEX_FILE: index },
      maxBuffer: 256 * 1024 * 1024,
    }).trim();
  } catch (error) {
    throw new PreparerError(`git ${args.join(" ")} failed during preparer bootstrap: ${(error as Error).message}`);
  }
}

function assertExactCommit(rootDir: string, baseline: string, result: string, paths: readonly string[]): void {
  if (git({ cwd: rootDir }, "rev-parse", `${result}^`) !== baseline) throw new PreparerError("bootstrap hook changed commit ancestry");
  const actual = git({ cwd: rootDir }, "diff-tree", "--no-commit-id", "--name-only", "-r", result).split("\n").filter(Boolean).sort(byCodeUnit);
  const expected = paths.map((path) => `${repositoryPrefix(rootDir)}${path}`).sort(byCodeUnit);
  if (actual.length !== expected.length || actual.some((item, index) => item !== expected[index])) throw new PreparerError(`bootstrap commit scope differs from config and manifest: ${actual.join(", ")}`);
}

function escapeIgnore(path: string): string { return path.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]").replaceAll("*", "\\*").replaceAll("?", "\\?").replace(/^([#!])/, "\\$1"); }

function state(root: string, path: string): { readonly hash: ReturnType<typeof fileState>; readonly mode: number | "missing" } {
  const absolute = workspacePath(root, path);
  return existsSync(absolute) ? { hash: fileState(absolute), mode: (statSync(absolute).mode & 0o111) === 0 ? 0o644 : 0o755 } : { hash: "missing", mode: "missing" };
}

function unique(items: readonly string[]): string[] { return [...new Set(items)].sort(byCodeUnit); }
