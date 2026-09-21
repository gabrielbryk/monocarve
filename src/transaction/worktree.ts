/**
 * Disposable git worktree management.
 *
 * The simulation runs in a real worktree of the same repository, checked out at
 * the plan's baseline commit, with `node_modules` symlinked from the primary
 * checkout. That gives a full, honest gate run — the repository's own lint,
 * typecheck, and tests — without a multi-minute install and without ever
 * touching the developer's working tree.
 *
 * The symlink strategy has one consequence worth stating: because nothing is
 * installed, a package the plan *creates* has no `node_modules` entry anywhere,
 * so every gate that resolves it fails on resolution alone. {@link linkPlannedPackage}
 * models exactly the links the plan's own wiring declares — the new package
 * inside each consuming application, and the new package's declared
 * dependencies inside itself — and nothing else. Anything more would be the
 * simulation covering for a plan that is actually incomplete.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { MonocarveError } from "../errors.ts";
import { failedGateOutput } from "./gate-diagnostics.ts";
import { isDirectory } from "../util/files.ts";
import { git, tryGit } from "../util/git.ts";
import type { ExtractionManifest } from "../plan/manifest.ts";

export class WorktreeError extends MonocarveError {
  override readonly name = "WorktreeError";
}

/** Enough stderr to name the cause, not enough to paste an install log. */
const INSTALL_ERROR_TAIL = 2000;

/**
 * `worktree add` performs a checkout, and a checkout runs `post-checkout` from
 * the *shared* hook directory — the same hooks the primary checkout uses, since
 * a worktree borrows its repository's common git dir. A hook written for a
 * developer's worktree reasonably treats the new tree as durable and starts
 * work against it, detached and outliving this process; a disposable simulation
 * tree that {@link Worktree.dispose} deletes minutes later then leaves that work
 * running against a path that no longer exists.
 *
 * Suppressing hooks outright rather than with `--no-verify` is the same choice,
 * and for the same reason, that the simulation's bookkeeping commit makes:
 * a throwaway tree must be inert for the repository it borrowed `.git` from.
 */
const INERT_HOOKS = ["-c", "core.hooksPath=/dev/null"] as const;

export interface Worktree {
  /** Absolute path of the worktree root. */
  readonly path: string;
  /**
   * Absolute path of the *workspace* inside the worktree. Equal to `path` when
   * the workspace is the repository root, and a subdirectory otherwise.
   */
  readonly workspacePath: string;
  /** Commit it was created at. */
  readonly commit: string;
  /** Remove the worktree and its git registration. Idempotent. */
  dispose(): Promise<void>;
}

export interface CreateWorktreeOptions {
  /** Workspace root in the primary checkout. */
  readonly rootDir: string;
  readonly commit: string;
  /** Directory to create it under, absolute or workspace-relative. */
  readonly worktreeRoot: string;
  readonly nodeModules: "symlink" | "install" | "none";
  /** Command used when `nodeModules === "install"`. */
  readonly installCommand?: readonly string[];
  /** Prefix for the temporary directory name, normally the plan id. */
  readonly label?: string;
}

export async function createWorktree(options: CreateWorktreeOptions): Promise<Worktree> {
  const parent = isAbsolute(options.worktreeRoot)
    ? options.worktreeRoot
    : resolve(options.rootDir, options.worktreeRoot);
  assertWorktreeRootIsNotNested(options.rootDir, parent);
  mkdirSync(parent, { recursive: true });

  const path = realpathSync(mkdtempSync(join(parent, `${options.label ?? "simulation"}-`)));
  const repositoryRoot = git({ cwd: options.rootDir }, "rev-parse", "--show-toplevel");
  const prefix = relativeInside(repositoryRoot, options.rootDir);
  let added = false;

  try {
    git({ cwd: options.rootDir, quiet: true }, ...INERT_HOOKS, "worktree", "add", "--detach", path, options.commit);
    added = true;
    const workspacePath = prefix === "" ? path : join(path, prefix);

    if (options.nodeModules === "symlink") linkNodeModules(path, repositoryRoot);
    if (options.nodeModules === "install") installWorkspaceDependencies(workspacePath, options.installCommand);

    return {
      path,
      workspacePath,
      commit: options.commit,
      dispose: async () => {
        disposeWorktree(options.rootDir, path);
      },
    };
  } catch (error) {
    if (added) disposeWorktree(options.rootDir, path);
    else rmSync(path, { recursive: true, force: true });
    throw error;
  }
}

/**
 * A linked worktree is a complete checkout. Creating disposable worktrees
 * beneath one makes them look like nested worktrees on disk, causes discovery
 * tools to recurse through every checkout, and leaves the owning checkout
 * unusable while its contents are being removed. The primary worktree is the
 * one intentional exception: repo-relative `.worktrees/...` destinations
 * belong there.
 */
function assertWorktreeRootIsNotNested(rootDir: string, parent: string): void {
  const worktrees = git({ cwd: rootDir }, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => canonicalPath(line.slice("worktree ".length)));
  const primary = worktrees[0];
  if (!primary) return;

  const destination = canonicalPath(parent);
  const nestedIn = worktrees.slice(1).find((worktree) => isPathInside(worktree, destination));
  if (nestedIn) {
    throw new WorktreeError(`worktreeRoot ${parent} is inside registered worktree ${nestedIn}; choose a sibling or an external directory`);
  }
}

/** Resolve a path even when its final components have not been created yet. */
function canonicalPath(path: string): string {
  const unresolved: string[] = [];
  let existing = resolve(path);
  while (!existsSync(existing)) {
    unresolved.unshift(basename(existing));
    const next = dirname(existing);
    if (next === existing) return resolve(path);
    existing = next;
  }
  return resolve(realpathSync(existing), ...unresolved);
}

function isPathInside(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || isInside(path);
}

/** Run the configured install against the tree as it exists at this moment. */
export function installWorkspaceDependencies(workspacePath: string, command: readonly string[] | undefined): void {
  if (!command || command.length === 0) throw new WorktreeError("nodeModules: install requires an install command");
  const [binary, ...args] = command;
  // An install is an implementation detail of disposable simulation. Letting
  // its stdout inherit the CLI stream corrupts machine-readable reports and
  // can race the command's final write. Capture both streams; successful
  // chatter is discarded and failed chatter is surfaced only as a bounded
  // diagnostic.
  const result = Bun.spawnSync([binary!, ...args], { cwd: workspacePath, stdout: "pipe", stderr: "pipe" });
  const exitCode = result.exitCode ?? 1;
  if (exitCode === 0) return;
  const tail = failedGateOutput({ stdout: result.stdout.toString(), stderr: result.stderr.toString() }).trimEnd().slice(-INSTALL_ERROR_TAIL);
  throw new WorktreeError(`install command failed (exit ${exitCode}): ${command.join(" ")}${tail === "" ? "" : `\n${tail}`}`);
}

function relativeInside(repositoryRoot: string, rootDir: string): string {
  const root = resolve(repositoryRoot);
  const workspace = resolve(rootDir);
  const path = relative(root, workspace);
  if (!isInside(path)) throw new WorktreeError(`${rootDir} is not inside ${repositoryRoot}`);
  return path;
}

/** Whether a path returned by `relative()` stays at or below its origin. */
function isInside(path: string): boolean {
  return !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`);
}

function disposeWorktree(rootDir: string, path: string): void {
  tryGit({ cwd: rootDir }, "worktree", "remove", "--force", path);
  rmSync(path, { recursive: true, force: true });
  tryGit({ cwd: rootDir }, "worktree", "prune");
}

/**
 * Symlink each `node_modules` directory's *entries* rather than the directory
 * itself, so a later `linkPackage` can add one more entry without mutating the
 * primary checkout's tree.
 *
 * With one correction, and it is the whole reason the simulation means
 * anything. A workspace package is not installed, it is *linked*: the entry
 * `node_modules/@acme/brand` is a symlink to `libs/brand` in the same
 * repository. Mirrored verbatim into the worktree, that link still resolves to
 * the primary checkout — so every gate reaching a first-party package through
 * `node_modules` would read the developer's current code instead of the tree at
 * the baseline commit with the extraction applied. The workspace's own packages
 * are exactly what an extraction changes, so a simulation that reads them from
 * somewhere else proves nothing about the plan.
 *
 * Links into the package store (`node_modules/.pnpm`, and everything reached
 * through it) are left pointing at the checkout: those are installed artifacts,
 * identical in both trees, and copying a store per simulation is the
 * multi-minute install this design exists to avoid.
 */
function linkNodeModules(worktree: string, root: string): void {
  for (const directory of nodeModulesDirectories(root, ".")) {
    const source = resolve(root, directory);
    const target = resolve(worktree, directory);
    if (existsSync(target)) continue;
    mkdirSync(target, { recursive: true });
    for (const entry of readdirSync(source)) linkNodeModulesEntry(worktree, root, join(source, entry), join(target, entry));
  }
}

function linkNodeModulesEntry(worktree: string, root: string, from: string, to: string): void {
  const local = worktreeLocalTarget(worktree, root, from);
  if (local !== null) {
    symlinkSync(local, to, "dir");
    return;
  }
  // A scope directory (`@acme`) is a real directory holding one entry per
  // package, and in a workspace those entries are a mix: first-party links that
  // have to be redirected, published packages that must not be. Recurse so each
  // is decided on its own rather than by the scope it happens to share.
  if (isRealDirectory(from) && basename(from).startsWith("@")) {
    mkdirSync(to, { recursive: true });
    for (const entry of readdirSync(from)) linkNodeModulesEntry(worktree, root, join(from, entry), join(to, entry));
    return;
  }
  symlinkSync(from, to, isDirectory(from) ? "dir" : "file");
}

/**
 * Where `from` should point inside the worktree, or `null` when it is not a
 * link to first-party source.
 *
 * The test is on the *resolved* path: anything that lands inside the workspace
 * but outside a `node_modules` directory is source this repository owns, and
 * the worktree has its own copy at the same relative path. A worktree copy that
 * does not exist is still the right target — the package is genuinely absent at
 * the baseline commit, and a gate failing to resolve it is the truth rather
 * than a reason to reach back into the checkout.
 */
function worktreeLocalTarget(worktree: string, root: string, from: string): string | null {
  if (!lstatSync(from, { throwIfNoEntry: false })?.isSymbolicLink()) return null;
  let resolved: string;
  try {
    resolved = realpathSync(from);
  } catch {
    return null; // A broken link is mirrored as-is; the worktree is not where that gets fixed.
  }
  const workspace = realpathSync(root);
  const path = relative(workspace, resolved);
  if (!isInside(path) || path.split(sep).includes("node_modules")) return null;
  return join(worktree, path);
}

function isRealDirectory(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
}

function nodeModulesDirectories(root: string, relativeDirectory: string): string[] {
  const here = join(root, relativeDirectory);
  if (!existsSync(here)) return [];
  const found = existsSync(join(here, "node_modules")) ? [join(relativeDirectory, "node_modules")] : [];
  const entries = readdirSync(here, { withFileTypes: true }).filter(
    (entry) => entry.isDirectory() && entry.name !== "node_modules" && !entry.name.startsWith("."),
  );
  return [...found, ...entries.flatMap((entry) => nodeModulesDirectories(root, join(relativeDirectory, entry.name)))];
}

/**
 * A scope directory (`node_modules/@acme`) reached through a symlink cannot
 * take a new entry, so it is materialized as a real directory of symlinks
 * first.
 */
function materializeScope(directory: string): void {
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true });
    return;
  }
  if (!lstatSync(directory).isSymbolicLink()) return;
  const source = realpathSync(directory);
  unlinkSync(directory);
  mkdirSync(directory, { recursive: true });
  for (const entry of readdirSync(source)) symlinkSync(join(source, entry), join(directory, entry), "dir");
}

function linkPackage(workspace: string, owner: string, name: string, target: string): void {
  const link = resolve(workspace, owner, "node_modules", name);
  materializeScope(resolve(link, ".."));
  const state = lstatSync(link, { throwIfNoEntry: false });
  if (state?.isSymbolicLink()) unlinkSync(link);
  else if (state) return;
  symlinkSync(target, link, "dir");
}

/**
 * Model the `link:` entries the plan's own wiring declares, and nothing else.
 *
 * Returns the declared dependencies that resolve nowhere. Skipping one silently
 * is not neutral: the package then cannot resolve it inside the worktree, the
 * gate dies on a resolution error, and the simulation reports that as a failure
 * of the extraction rather than of its own setup. It stays a warning, though —
 * the repository may resolve the dependency some other way, and refusing here
 * would make the default mode less usable than it is.
 */
export function linkPlannedPackage(workspacePath: string, manifest: ExtractionManifest): string[] {
  const manifestPath = resolve(workspacePath, manifest.target.packageRoot, "package.json");
  if (!existsSync(manifestPath)) return [];

  const owners = [...new Set(manifest.consumers.map((consumer) => consumer.owner))].filter((owner) =>
    existsSync(resolve(workspacePath, owner, "package.json")),
  );
  for (const owner of owners) {
    linkPackage(workspacePath, owner, manifest.target.packageName, resolve(workspacePath, manifest.target.packageRoot));
  }

  const declared = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const unlinked: string[] = [];
  for (const name of Object.keys({ ...declared.dependencies, ...declared.devDependencies })) {
    const installed = [...owners, ""]
      .map((owner) => resolve(workspacePath, owner, "node_modules", name))
      .find(existsSync);
    if (installed) linkPackage(workspacePath, manifest.target.packageRoot, name, realpathSync(installed));
    else unlinked.push(name);
  }
  return unlinked;
}

/** Remove stale worktrees left behind by an interrupted run. */
export async function pruneWorktrees(rootDir: string, worktreeRoot: string): Promise<string[]> {
  const parent = isAbsolute(worktreeRoot) ? worktreeRoot : resolve(rootDir, worktreeRoot);
  if (!existsSync(parent)) return [];
  const removed: string[] = [];
  for (const entry of readdirSync(parent, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(parent, entry.name);
    disposeWorktree(rootDir, path);
    removed.push(path);
  }
  return removed;
}
