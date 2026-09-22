import { writeFileSync } from "node:fs";

import { isGuardedBranch, type MonocarveConfig } from "../config.ts";
import { PreflightError } from "../errors.ts";
import { currentBranch, git, headCommit, repositoryPrefix, showBaseline, statusEntries } from "../util/git.ts";
import { workspacePath } from "../util/paths.ts";
import type { ReadEvidence } from "./evidence.ts";
import type { ReconciliationRecord } from "./types.ts";

export function approveReconciliation(options: {
  readonly rootDir: string;
  readonly config: MonocarveConfig;
  readonly evidence: ReadEvidence<ReconciliationRecord>;
}): { readonly commit: string; readonly path: string; readonly subject: string } {
  const { rootDir, config, evidence } = options;
  reconciliationApprovalEvidence(rootDir, evidence);
  const branch = currentBranch(rootDir);
  if (isGuardedBranch(config, branch)) throw new PreflightError(`current branch ${branch} is guarded`);
  git({ cwd: rootDir }, "add", "--", evidence.path);
  try {
    const args = ["commit", "--only", "-m", evidence.value.approval.subject];
    if (evidence.value.approval.body) args.push("-m", evidence.value.approval.body);
    args.push("--", evidence.path);
    git({ cwd: rootDir }, ...args);
    const commit = headCommit(rootDir);
    if (git({ cwd: rootDir }, "rev-parse", `${commit}^`) !== evidence.value.observed.headCommit)
      throw new PreflightError("reconciliation approval parent changed");
    if (git({ cwd: rootDir }, "log", "-1", "--format=%s", commit) !== evidence.value.approval.subject)
      throw new PreflightError("reconciliation approval subject changed");
    const paths = git({ cwd: rootDir }, "diff-tree", "--no-commit-id", "--name-only", "-r", commit).split("\n").filter(Boolean);
    const expectedPath = `${repositoryPrefix(rootDir)}${evidence.path}`;
    if (paths.length !== 1 || paths[0] !== expectedPath) throw new PreflightError("reconciliation approval changed paths outside its record");
    if (showBaseline(rootDir, commit, evidence.path) !== evidence.bytes) throw new PreflightError("commit hook changed the reviewed reconciliation record");
    return { commit, path: evidence.path, subject: evidence.value.approval.subject };
  } catch (error) {
    git({ cwd: rootDir }, "reset", "--mixed", evidence.value.observed.headCommit);
    writeFileSync(workspacePath(rootDir, evidence.path), evidence.bytes);
    git({ cwd: rootDir }, "reset", "--", evidence.path);
    throw error;
  }
}

export function reconciliationApprovalEvidence(
  rootDir: string,
  evidence: ReadEvidence<ReconciliationRecord>,
): { readonly path: string; readonly subject: string; readonly observedHead: string } {
  if (headCommit(rootDir) !== evidence.value.observed.headCommit) throw new PreflightError("reconciliation approval must be directly atop its observed head");
  const entries = statusEntries(rootDir);
  const valid =
    entries.length === 1 &&
    entries[0]?.paths.length === 1 &&
    entries[0].paths[0] === evidence.path &&
    (entries[0].index === "?" || entries[0].index === " ") &&
    entries[0].worktree !== " ";
  if (!valid)
    throw new PreflightError(`reconciliation approval requires only its unstaged record: ${entries.flatMap((entry) => entry.paths).join(", ") || "none"}`);
  return { path: evidence.path, subject: evidence.value.approval.subject, observedHead: evidence.value.observed.headCommit };
}
