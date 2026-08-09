import { existsSync, statSync } from "node:fs";

import type { MonocarveConfig } from "../config.ts";
import { executePreparationJournal, rollbackCompletedPreparationJournal } from "../prepare/journal.ts";
import { byCodeUnit } from "../util/hash.ts";
import { currentBranch, git, headCommit, statusEntries } from "../util/git.ts";
import { fileState } from "../util/files.ts";
import { workspacePath } from "../util/paths.ts";
import { isGuardedBranch } from "../config.ts";
import type { PreparerManifest } from "./manifest.ts";
import { assertApprovedPreparerManifest, assertPreparerManifest, PreparerError, simulatePreparerManifest } from "./core.ts";

/** Commit a new preparer configuration and its approval while hooks observe its reviewed outputs. */
export async function commitPreparerBootstrap(rootDir: string, config: MonocarveConfig, path: string, manifest: PreparerManifest, subject: string): Promise<string> {
  assertPreparerManifest(config, manifest);
  const bootstrap = manifest.bootstrapConfig;
  if (bootstrap === undefined) throw new PreparerError("preparer manifest does not declare a bootstrap config");
  const branch = currentBranch(rootDir);
  if (isGuardedBranch(config, branch)) throw new PreparerError(`refusing to commit preparer bootstrap on guarded branch ${branch}`);
  if (headCommit(rootDir) !== manifest.baseline.commit) throw new PreparerError("bootstrap commit requires the exact manifest baseline at HEAD");
  const allowedDirty = new Set([bootstrap.path, path]);
  const dirty = unique(statusEntries(rootDir).flatMap((entry) => entry.paths));
  if (!dirty.includes(bootstrap.path) || dirty.some((item) => !allowedDirty.has(item))) throw new PreparerError(`bootstrap commit requires only config and manifest dirty paths; found: ${dirty.join(", ") || "(none)"}`);
  const actual = state(rootDir, bootstrap.path);
  if (actual.hash !== bootstrap.resultHash || actual.mode !== bootstrap.resultMode) throw new PreparerError("bootstrap config differs from reviewed result");
  await simulatePreparerManifest({ rootDir, config, manifest });
  const journal = executePreparationJournal({ rootDir, operations: manifest.mutations.map((item) => ({ kind: "write" as const, ...item })) });
  const staged = [bootstrap.path, path];
  try {
    git({ cwd: rootDir, quiet: true }, "add", "-f", "--", ...staged);
    git({ cwd: rootDir }, "commit", "-m", subject, "--", ...staged);
  } catch (error) {
    git({ cwd: rootDir, quiet: true }, "reset", "--", ...staged);
    throw error;
  } finally {
    const restored = rollbackCompletedPreparationJournal(journal.recovery);
    if (restored.failures.length > 0) throw new PreparerError(`bootstrap output rollback was incomplete: ${restored.failures.map((item) => item.path).join(", ")}`);
  }
  const result = headCommit(rootDir);
  assertApprovedPreparerManifest(rootDir, path, manifest);
  return result;
}

function state(root: string, path: string): { readonly hash: ReturnType<typeof fileState>; readonly mode: number | "missing" } {
  const absolute = workspacePath(root, path);
  return existsSync(absolute) ? { hash: fileState(absolute), mode: (statSync(absolute).mode & 0o111) === 0 ? 0o644 : 0o755 } : { hash: "missing", mode: "missing" };
}

function unique(items: readonly string[]): string[] { return [...new Set(items)].sort(byCodeUnit); }
