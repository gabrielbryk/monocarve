/**
 * Path containment.
 *
 * Every path the engine touches is workspace-relative and POSIX-separated, and
 * every conversion to an absolute path is checked: a plan is a file that says
 * "write these bytes there", so a manifest that escapes the workspace — through
 * `..`, through an absolute path, or through a symlink whose target is outside —
 * is the one input that must never be trusted.
 */

import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { MonocarveError } from "../errors.ts";

export class PathEscapeError extends MonocarveError {
  override readonly name = "PathEscapeError";
}

/** Strip `./`, normalize separators. Does not resolve `..`. */
export function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function assertContained(rootDir: string, absolute: string, original: string): void {
  const root = resolve(rootDir);
  const prefix = root + sep;
  if (absolute !== root && !absolute.startsWith(prefix)) {
    throw new PathEscapeError(`path escapes the workspace: ${original}`);
  }
  let probe = absolute;
  while (!existsSync(probe) && probe !== dirname(probe)) probe = dirname(probe);
  const real = realpathSafe(probe);
  const realRoot = realpathSafe(root);
  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    throw new PathEscapeError(`path follows a symlink outside the workspace: ${original}`);
  }
}

function realpathSafe(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Absolute path for a workspace-relative path, refusing anything that escapes. */
export function workspacePath(rootDir: string, path: string): string {
  const normalized = normalizePath(path);
  if (isAbsolute(normalized) || normalized.split("/").includes("..")) {
    throw new PathEscapeError(`path is not workspace-relative: ${path}`);
  }
  const absolute = resolve(rootDir, normalized);
  assertContained(rootDir, absolute, path);
  return absolute;
}

/** Workspace-relative path for an absolute (or already relative) path. */
export function relativeWorkspacePath(rootDir: string, path: string): string {
  const absolute = isAbsolute(path) ? resolve(path) : workspacePath(rootDir, path);
  assertContained(rootDir, absolute, path);
  const result = relative(resolve(rootDir), absolute).replaceAll("\\", "/");
  if (!result || result.startsWith("..")) throw new PathEscapeError(`path is outside the workspace: ${path}`);
  return result;
}

/** POSIX-normalized `relative()`, for specifiers and project references. */
export function relativePosix(from: string, to: string): string {
  return relative(from, to).replaceAll("\\", "/");
}
