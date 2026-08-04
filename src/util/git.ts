/**
 * Every git invocation in this tool goes through here.
 *
 * Two properties make that centralization non-negotiable:
 *
 *  1. **The environment is scrubbed.** `GIT_INDEX_FILE`, `GIT_DIR`, and
 *     `GIT_WORK_TREE` are inherited by child processes, and a hook (or a test
 *     harness running under one) can leave them pointing at a *different*
 *     repository. A `git add` that inherits a stale `GIT_INDEX_FILE` writes
 *     into that other repository's index — silently, destructively, and with
 *     `cwd` looking entirely correct. Scrubbing them means `cwd` alone decides
 *     which repository is touched. See {@link scrubbedGitEnv}.
 *  2. **The config root need not be the repository root.** A workspace can be
 *     a subdirectory of its repository, so `git show <commit>:<path>` needs the
 *     path prefixed by the workspace's position inside the repository. Callers
 *     pass repo-relative-to-the-*workspace* paths and this module translates.
 */

import { execFileSync } from "node:child_process";
import { relative, resolve } from "node:path";

import { MonocarveError } from "../errors.ts";

export class GitError extends MonocarveError {
  override readonly name = "GitError";
}

/**
 * Variables that redirect git at a repository other than the one `cwd` names.
 * They are deleted, never overridden: an empty value is still a value to git.
 */
const REDIRECTING_VARIABLES = [
  "GIT_INDEX_FILE",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_PREFIX",
  "GIT_CEILING_DIRECTORIES",
] as const;

/**
 * A copy of the current environment with every repository-redirecting variable
 * removed. Exported so tests can assert on the scrub directly.
 */
export function scrubbedGitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const name of REDIRECTING_VARIABLES) delete env[name];
  return env;
}

export interface GitOptions {
  /** Directory the command runs in. This — and only this — selects the repository. */
  readonly cwd: string;
  /** Inherit stdio instead of capturing, for commands whose output is for the operator. */
  readonly inherit?: boolean;
  /** Swallow stderr; used where a non-zero exit is an expected answer. */
  readonly quiet?: boolean;
}

/** Run git and return trimmed stdout. Throws {@link GitError} on failure. */
export function git(options: GitOptions, ...args: string[]): string {
  try {
    const output = execFileSync("git", args, {
      cwd: options.cwd,
      encoding: "utf8",
      env: scrubbedGitEnv(),
      maxBuffer: 256 * 1024 * 1024,
      ...(options.inherit
        ? { stdio: "inherit" as const }
        : options.quiet
          ? { stdio: ["ignore", "pipe", "ignore"] as const }
          : {}),
    });
    return typeof output === "string" ? output.trim() : "";
  } catch (error) {
    throw new GitError(`git ${args.join(" ")} failed in ${options.cwd}: ${(error as Error).message}`);
  }
}

/** Run git and return raw stdout bytes — for blobs, which are not text. */
export function gitBytes(options: GitOptions, ...args: string[]): Uint8Array {
  return execFileSync("git", args, {
    cwd: options.cwd,
    env: scrubbedGitEnv(),
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/** Run git, returning null instead of throwing. */
export function tryGit(options: GitOptions, ...args: string[]): string | null {
  try {
    return git({ ...options, quiet: true }, ...args);
  } catch {
    return null;
  }
}

/** Absolute repository root containing `dir`. */
export function repositoryRoot(dir: string): string {
  return resolve(git({ cwd: dir }, "rev-parse", "--show-toplevel"));
}

/**
 * Path of `workspaceRoot` inside its repository, with a trailing slash, or the
 * empty string when the workspace *is* the repository root. Prefixed onto every
 * path handed to a repository-relative git command.
 */
export function repositoryPrefix(workspaceRoot: string): string {
  const root = repositoryRoot(workspaceRoot);
  const prefix = relative(root, resolve(workspaceRoot)).replaceAll("\\", "/");
  return prefix === "" ? "" : `${prefix}/`;
}

export function headCommit(workspaceRoot: string): string {
  return git({ cwd: workspaceRoot }, "rev-parse", "HEAD");
}

/** A revision resolved to the object it names, plus that object's own timestamp. */
export interface ResolvedCommit {
  /** Full 40-character object name — never a ref like `HEAD`. */
  readonly commit: string;
  /**
   * Committer date in UTC ISO 8601. A property of the commit object, so it is
   * the same on every machine and at every hour, which is what lets a plan
   * carry a timestamp without carrying a clock reading. Normalized to UTC
   * rather than kept in the committer's offset so two plans are comparable.
   */
  readonly committedAt: string;
}

/**
 * Resolve a revision to its commit hash and committer date.
 *
 * One invocation, not a `rev-parse` followed by a date lookup, because the two
 * values must describe the same object: a ref that moves between the calls
 * yields a hash and a date from different commits, which is precisely the kind
 * of provenance a plan may not carry.
 */
export function resolveCommit(workspaceRoot: string, revision: string): ResolvedCommit {
  const output = git({ cwd: workspaceRoot }, "show", "-s", "--format=%H%n%cI", `${revision}^{commit}`);
  const [commit, committedAt] = output.split("\n");
  if (!commit || !committedAt) {
    throw new GitError(`git show ${revision} in ${workspaceRoot} returned no commit and date: ${JSON.stringify(output)}`);
  }
  return { commit, committedAt: new Date(committedAt).toISOString() };
}

export function currentBranch(workspaceRoot: string): string {
  return git({ cwd: workspaceRoot }, "rev-parse", "--abbrev-ref", "HEAD");
}

/** Porcelain status, restricted to the workspace subtree. */
export function statusShort(workspaceRoot: string): string {
  return git({ cwd: workspaceRoot }, "status", "--short", "--", ".");
}

/** One porcelain-v1 status record, with every affected workspace-relative path. */
export interface GitStatusEntry {
  /** Index and worktree status columns, respectively (for example `"M"`, `"?"`). */
  readonly index: string;
  readonly worktree: string;
  /** One path normally; both old and new endpoints for a rename or copy. */
  readonly paths: readonly string[];
}

/**
 * Parse machine-readable porcelain rather than treating its display text as a
 * path list.  `-z` keeps filenames literal, and emits the second endpoint of
 * renames/copies as a separate NUL-delimited field.  A dirty-tree policy that
 * only checked the destination could otherwise let a protected source be
 * renamed out from underneath a plan.
 */
export function statusEntries(workspaceRoot: string): readonly GitStatusEntry[] {
  const output = new TextDecoder().decode(
    gitBytes({ cwd: workspaceRoot }, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."),
  );
  const fields = output.split("\0");
  const prefix = repositoryPrefix(workspaceRoot);
  const entries: GitStatusEntry[] = [];

  for (let index = 0; index < fields.length - 1; index += 1) {
    const record = fields[index];
    if (record === undefined || record.length === 0) continue;
    if (record.length < 4 || record[2] !== " ") {
      throw new GitError(`could not parse git status record ${JSON.stringify(record)}`);
    }
    const indexStatus = record[0];
    const worktreeStatus = record[1];
    const path = record.slice(3);
    if (indexStatus === undefined || worktreeStatus === undefined || path.length === 0) {
      throw new GitError(`could not parse git status record ${JSON.stringify(record)}`);
    }
    const renamedOrCopied = indexStatus === "R" || indexStatus === "C" || worktreeStatus === "R" || worktreeStatus === "C";
    const rawPaths = [path];
    if (renamedOrCopied) {
      const other = fields[index + 1];
      if (other === undefined || other.length === 0) {
        throw new GitError(`could not parse rename status record ${JSON.stringify(record)}`);
      }
      rawPaths.push(other);
      index += 1;
    }
    entries.push({
      index: indexStatus,
      worktree: worktreeStatus,
      paths: rawPaths.map((value) => workspaceRelativeStatusPath(value, prefix)),
    });
  }
  return entries;
}

function workspaceRelativeStatusPath(path: string, prefix: string): string {
  if (prefix === "") return path;
  if (!path.startsWith(prefix)) {
    throw new GitError(`git status path ${JSON.stringify(path)} is outside workspace ${JSON.stringify(prefix)}`);
  }
  return path.slice(prefix.length);
}

/**
 * Contents of a workspace-relative path at a commit, or `null` when the path did
 * not exist there. Never throws for a missing path — absence is an answer.
 */
export function showBaseline(workspaceRoot: string, commit: string, path: string): string | null {
  const prefix = repositoryPrefix(workspaceRoot);
  try {
    return execFileSync("git", ["show", `${commit}:${prefix}${path}`], {
      cwd: workspaceRoot,
      encoding: "utf8",
      env: scrubbedGitEnv(),
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/** Raw bytes of a workspace-relative path at a commit, or `null` when absent. */
export function showBaselineBytes(workspaceRoot: string, commit: string, path: string): Uint8Array | null {
  const prefix = repositoryPrefix(workspaceRoot);
  try {
    return execFileSync("git", ["show", `${commit}:${prefix}${path}`], {
      cwd: workspaceRoot,
      env: scrubbedGitEnv(),
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}
