/** Explicit, review-gated approval of one extraction manifest. */
import { lstatSync, readFileSync, writeFileSync } from "node:fs";

import { isGuardedBranch, type MonocarveConfig } from "../config.ts";
import { PreflightError } from "../errors.ts";
import { serializeManifest } from "../plan/build.ts";
import type { ExtractionManifest } from "../plan/manifest.ts";
import { currentBranch, git, gitBytes, headCommit, repositoryPrefix, showBaseline } from "../util/git.ts";
import { relativeWorkspacePath, workspacePath } from "../util/paths.ts";

export interface ManifestApprovalOptions {
  readonly rootDir: string;
  readonly config: MonocarveConfig;
  readonly manifest: ExtractionManifest;
  /** Absolute or workspace-relative path of the manifest written by `plan`. */
  readonly manifestPath: string;
}

export interface ManifestApprovalEvidence {
  readonly manifestPath: string;
  readonly baselineCommit: string;
  readonly branch: string;
  readonly subject: string;
  readonly gitAdd: readonly ["git", "add", "--", string];
}

export interface ManifestApprovalCommit extends ManifestApprovalEvidence {
  readonly commit: string;
}

/**
 * Prove that the reviewed bytes are on disk directly atop their baseline and
 * return the exact non-mutating next action. This never grants approval.
 */
export function manifestApprovalEvidence(options: ManifestApprovalOptions): ManifestApprovalEvidence {
  const manifestPath = relativeWorkspacePath(options.rootDir, options.manifestPath);
  const absolutePath = workspacePath(options.rootDir, manifestPath);
  const planCommit = options.manifest.commits.plan;
  if (planCommit === undefined) throw new PreflightError("manifest does not declare a plan approval commit");
  if (!lstatSync(absolutePath, { throwIfNoEntry: false })?.isFile()) {
    throw new PreflightError(`manifest is not a regular file: ${manifestPath}`);
  }
  const actual = readFileSync(absolutePath, "utf8");
  const expected = serializeManifest(options.manifest);
  if (actual !== expected) throw new PreflightError(`written manifest does not match the reviewed manifest: ${manifestPath}`);

  const current = headCommit(options.rootDir);
  if (current !== options.manifest.baselineCommit) {
    throw new PreflightError(`HEAD ${current} does not match manifest baseline ${options.manifest.baselineCommit}`);
  }
  const branch = currentBranch(options.rootDir);
  return {
    manifestPath,
    baselineCommit: current,
    branch,
    subject: planCommit.subject,
    gitAdd: ["git", "add", "--", manifestPath],
  };
}

/**
 * Explicitly create the approval commit. The repository must contain no other
 * staged, modified, or untracked path, so the resulting commit cannot smuggle
 * source changes into the approval boundary.
 */
export function commitManifestApproval(options: ManifestApprovalOptions): ManifestApprovalCommit {
  const evidence = manifestApprovalEvidence(options);
  if (isGuardedBranch(options.config, evidence.branch)) throw new PreflightError(`current branch ${evidence.branch} is guarded`);
  assertOnlyManifestDirty(options.rootDir, evidence.manifestPath, false);
  git({ cwd: options.rootDir }, "add", "--", evidence.manifestPath);
  try {
    assertOnlyManifestDirty(options.rootDir, evidence.manifestPath, true);
    const planCommit = options.manifest.commits.plan!;
    const args = ["commit", "--only", "-m", planCommit.subject];
    if (planCommit.body !== undefined && planCommit.body !== "") args.push("-m", planCommit.body);
    args.push("--", evidence.manifestPath);
    git({ cwd: options.rootDir }, ...args);
  } catch (error) {
    // Validation required a clean index before staging, so this restores that
    // exact index state while retaining the reviewed manifest in the worktree.
    git({ cwd: options.rootDir }, "reset", "--", evidence.manifestPath);
    throw error;
  }
  const commit = headCommit(options.rootDir);
  try {
    if (git({ cwd: options.rootDir }, "rev-parse", `${commit}^`) !== evidence.baselineCommit) {
      throw new PreflightError("manifest approval commit is not directly atop its baseline");
    }
    const changed = nulFields(gitBytes({ cwd: options.rootDir }, "diff-tree", "--no-commit-id", "--name-only", "-r", "-z", commit));
    const expectedPath = `${repositoryPrefix(options.rootDir)}${evidence.manifestPath}`;
    if (changed.length !== 1 || changed[0] !== expectedPath) {
      throw new PreflightError(`manifest approval commit changed paths other than ${evidence.manifestPath}`);
    }
    const expectedBytes = serializeManifest(options.manifest);
    if (showBaseline(options.rootDir, commit, evidence.manifestPath) !== expectedBytes) {
      throw new PreflightError(`commit hook changed the reviewed manifest: ${evidence.manifestPath}`);
    }
  } catch (error) {
    rollbackApprovalCommit(options.rootDir, evidence, commit, serializeManifest(options.manifest));
    throw new PreflightError(`${(error as Error).message}; approval commit was rolled back`);
  }
  return { ...evidence, commit };
}

function rollbackApprovalCommit(rootDir: string, evidence: ManifestApprovalEvidence, commit: string, reviewedBytes: string): void {
  if (headCommit(rootDir) !== commit) {
    throw new PreflightError(`approval validation failed after HEAD moved; refusing to roll back commit ${commit}`);
  }
  git({ cwd: rootDir }, "reset", "--mixed", evidence.baselineCommit);
  writeFileSync(workspacePath(rootDir, evidence.manifestPath), reviewedBytes);
  git({ cwd: rootDir }, "reset", "--", evidence.manifestPath);
}

function assertOnlyManifestDirty(rootDir: string, manifestPath: string, staged: boolean): void {
  const expected = `${repositoryPrefix(rootDir)}${manifestPath}`;
  const entries = repositoryStatus(rootDir);
  const valid = entries.length === 1 && entries[0]?.paths.length === 1 && entries[0].paths[0] === expected &&
    (staged ? entries[0].index !== " " && entries[0].index !== "?" && entries[0].worktree === " " : entries[0].index === " " || entries[0].index === "?");
  if (!valid) {
    const paths = [...new Set(entries.flatMap((entry) => entry.paths))];
    throw new PreflightError(`approval requires only an unstaged manifest; dirty paths: ${paths.join(", ") || "none"}`);
  }
}

interface StatusRecord { readonly index: string; readonly worktree: string; readonly paths: readonly string[] }

function repositoryStatus(rootDir: string): StatusRecord[] {
  const fields = nulFields(gitBytes({ cwd: rootDir }, "status", "--porcelain=v1", "-z", "--untracked-files=all"));
  const records: StatusRecord[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const value = fields[index]!;
    if (value.length < 4 || value[2] !== " ") throw new PreflightError(`could not parse git status record ${JSON.stringify(value)}`);
    const paths = [value.slice(3)];
    if (value[0] === "R" || value[0] === "C" || value[1] === "R" || value[1] === "C") paths.push(fields[++index]!);
    records.push({ index: value[0]!, worktree: value[1]!, paths });
  }
  return records;
}

function nulFields(bytes: Uint8Array): string[] {
  return new TextDecoder().decode(bytes).split("\0").filter((value) => value.length > 0);
}
