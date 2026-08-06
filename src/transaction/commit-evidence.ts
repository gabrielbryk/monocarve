/** Read-only proof of the exact commit chain emitted by a committed apply. */
import { readFileSync } from "node:fs";
import { pureRenames, wiringPaths, type ExtractionManifest } from "../plan/manifest.ts";
import { git, repositoryPrefix, showBaselineBytes, tryGit } from "../util/git.ts";
import { hashBytes } from "../util/hash.ts";
import { workspacePath } from "../util/paths.ts";

export interface CommitChainEvidence {
  readonly valid: boolean;
  readonly failures: readonly string[];
  readonly approvalCommit?: string;
  readonly moveCommit?: string;
  readonly wiringCommit?: string;
  readonly appliedCommit?: string;
  readonly laterCommitCount: number;
  readonly phase: "none" | "approved" | "post-move" | "applied";
}

export interface CommitEvidenceOptions {
  readonly rootDir: string;
  readonly manifest: ExtractionManifest;
  readonly manifestPath: string;
  readonly headCommit?: string;
}

export function inspectCommitChain(options: CommitEvidenceOptions): CommitChainEvidence {
  const { rootDir, manifest, manifestPath } = options;
  const head = options.headCommit ?? git({ cwd: rootDir }, "rev-parse", "HEAD");
  const failures: string[] = [];
  if (tryGit({ cwd: rootDir }, "merge-base", "--is-ancestor", manifest.baselineCommit, head) === null) {
    return result("none", failures.concat("manifest baseline is not an ancestor of HEAD"));
  }
  const commits = lines(git({ cwd: rootDir }, "rev-list", "--reverse", "--first-parent", `${manifest.baselineCommit}..${head}`));
  if (commits.length === 0) return result("none", failures);
  let at = 0;
  const approval = commits[at];
  if (approval === undefined || !proveApproval(rootDir, manifest, manifestPath, approval, failures)) return result("none", failures);
  at += 1;

  let move: string | undefined;
  if (pureRenames(manifest).length > 0) {
    move = commits[at];
    if (move === undefined) return result("approved", failures, { approvalCommit: approval });
    if (!proveMove(rootDir, manifest, approval, move, failures)) return result("approved", failures, { approvalCommit: approval });
    at += 1;
  }

  let wiring: string | undefined;
  if (wiringPaths(manifest).length > 0) {
    wiring = commits[at];
    if (wiring === undefined) return result(move === undefined ? "approved" : "post-move", failures, { approvalCommit: approval, ...(move ? { moveCommit: move } : {}) });
    if (!proveWiring(rootDir, manifest, move ?? approval, wiring, failures)) {
      return result(move === undefined ? "approved" : "post-move", failures, { approvalCommit: approval, ...(move ? { moveCommit: move } : {}) });
    }
    at += 1;
  }
  const applied = wiring ?? move ?? approval;
  return result("applied", failures, {
    approvalCommit: approval, ...(move ? { moveCommit: move } : {}), ...(wiring ? { wiringCommit: wiring } : {}),
    appliedCommit: applied, laterCommitCount: commits.length - at,
  });
}

function proveApproval(root: string, manifest: ExtractionManifest, path: string, commit: string, failures: string[]): boolean {
  const expectedParent = manifest.baselineCommit;
  const subject = manifest.commits.plan?.subject;
  if (subject === undefined) failures.push("manifest has no approval subject");
  if (tryGit({ cwd: root }, "rev-parse", `${commit}^`) !== expectedParent) failures.push("approval is not directly atop the manifest baseline");
  if (tryGit({ cwd: root }, "log", "-1", "--format=%s", commit) !== subject) failures.push("approval subject does not match the manifest");
  if (!same(lines(git({ cwd: root }, "diff-tree", "--no-commit-id", "--name-only", "-r", commit)), [repoPath(root, path)])) failures.push("approval does not change exactly the manifest path");
  const bytes = showBaselineBytes(root, commit, path);
  let reviewed: Uint8Array | null = null;
  try { reviewed = readFileSync(workspacePath(root, path)); } catch { /* Report the same bounded proof failure below. */ }
  if (bytes === null || reviewed === null || hashBytes(bytes) !== hashBytes(reviewed)) failures.push("approved manifest bytes do not match the reviewed manifest");
  return failures.length === 0;
}

function proveMove(root: string, manifest: ExtractionManifest, parent: string, commit: string, failures: string[]): boolean {
  if (tryGit({ cwd: root }, "rev-parse", `${commit}^`) !== parent) failures.push("move commit is not directly atop approval");
  if (tryGit({ cwd: root }, "log", "-1", "--format=%s", commit) !== manifest.commits.move.subject) failures.push("move subject does not match the manifest");
  const records = lines(git({ cwd: root }, "diff-tree", "--no-commit-id", "--name-status", "-r", "--find-renames=100%", commit));
  const actual = records.map((line) => line.split("\t"));
  const moves = pureRenames(manifest);
  if (actual.length !== moves.length || actual.some((entry) => entry[0] !== "R100") ||
      !same(actual.map((entry) => entry[1] ?? ""), moves.map((move) => repoPath(root, move.source))) ||
      !same(actual.map((entry) => entry[2] ?? ""), moves.map((move) => repoPath(root, move.target)))) failures.push("move commit is not exactly the declared R100 renames");
  for (const move of moves) {
    const bytes = showBaselineBytes(root, commit, move.target);
    if (bytes === null || hashBytes(bytes) !== move.resultHash) failures.push(`move target bytes do not match the manifest: ${move.target}`);
  }
  return failures.length === 0;
}

function proveWiring(root: string, manifest: ExtractionManifest, parent: string, commit: string, failures: string[]): boolean {
  if (tryGit({ cwd: root }, "rev-parse", `${commit}^`) !== parent) failures.push("wiring commit is not directly atop the preceding boundary");
  if (tryGit({ cwd: root }, "log", "-1", "--format=%s", commit) !== manifest.commits.wiring.subject) failures.push("wiring subject does not match the manifest");
  if (!same(lines(git({ cwd: root }, "diff-tree", "--no-commit-id", "--name-only", "-r", commit)), wiringPaths(manifest).map((path) => repoPath(root, path)))) failures.push("wiring paths do not match the manifest");
  const finalHashes = new Map<string, string>();
  for (const operation of manifest.operations) {
    if (operation.kind === "move") continue;
    const path = operationTarget(operation);
    finalHashes.set(path, operation.resultHash);
  }
  for (const [path, resultHash] of finalHashes) {
    const bytes = showBaselineBytes(root, commit, path);
    if (bytes === null || hashBytes(bytes) !== resultHash) failures.push(`wiring bytes do not match the manifest: ${path}`);
  }
  for (const artifact of manifest.generatedFiles.filter((entry) => entry.regenerateOnApply && entry.expectedHash)) {
    const bytes = showBaselineBytes(root, commit, artifact.path);
    if (bytes === null || hashBytes(bytes) !== artifact.expectedHash) failures.push(`generated artifact bytes do not match the manifest: ${artifact.path}`);
  }
  return failures.length === 0;
}

function operationTarget(operation: Exclude<ExtractionManifest["operations"][number], { readonly kind: "move" }>): string {
  switch (operation.kind) {
    case "move-with-rewrite": return operation.target;
    case "write-file": case "migrate-path-keys": return operation.path;
    case "lockfile-importer": return operation.lockfile;
    case "rewrite-import": case "rewrite-fs-reference": case "rewrite-path-reference": return operation.file;
  }
}

function result(phase: CommitChainEvidence["phase"], failures: readonly string[], extra: Partial<CommitChainEvidence> = {}): CommitChainEvidence {
  return { valid: failures.length === 0, failures, laterCommitCount: 0, phase, ...extra };
}
function lines(value: string): string[] { return value.split("\n").filter(Boolean); }
function repoPath(root: string, path: string): string { return `${repositoryPrefix(root)}${path}`; }
function same(left: readonly string[], right: readonly string[]): boolean {
  const a = [...left].sort(); const b = [...right].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
