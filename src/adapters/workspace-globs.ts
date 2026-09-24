/**
 * Workspace membership globs, shared by the managers that use them.
 *
 * pnpm declares them in `pnpm-workspace.yaml` and bun in the root
 * `package.json`, but the glob dialect and the enumeration are the same: a
 * directory, a `dir/*` fan-out, and `!`-prefixed exclusions. Only the *reading*
 * of the declaration is adapter-owned; everything after it lives here, so both
 * adapters answer "is this already a package?" identically and a fix to one is
 * a fix to both.
 */

import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";

import { byCodeUnit } from "../util/hash.ts";
import { workspacePath } from "../util/paths.ts";
import type { WorkspacePackage } from "./types.ts";
import { WorkspaceDiscoveryError } from "./workspace-error.ts";

/**
 * Refuse the positive glob shapes enumeration cannot honour, naming the
 * manager so the operator knows which declaration to edit.
 *
 * A glob this cannot walk is a glob whose packages would be silently missing
 * from `listPackages`, and a missing package reads as "not a package yet" —
 * which is the input to scaffolding a second one on top of it.
 */
export function assertEnumerableGlobs(globs: readonly string[], manager: string): void {
  for (const glob of globs) {
    const pattern = glob.startsWith("!") ? glob.slice(1) : glob;
    if (!supportedPattern(pattern, glob.startsWith("!"))) {
      throw new WorkspaceDiscoveryError(patternEscapes(glob) ? "unsafe-path" : "unsupported-glob", `${manager} workspace glob is not yet ported: ${glob}`, {
        patterns: [glob],
      });
    }
  }
}

export interface WorkspaceEnumeration {
  readonly packages: readonly WorkspacePackage[];
  /** Positive declarations that resolved to no package manifest. */
  readonly unmatched: readonly string[];
}

/** Every package the positive globs enumerate and the negated globs keep. */
export function enumerateWorkspacePackages(rootDir: string, globs: readonly string[]): WorkspacePackage[] {
  return [...resolveWorkspacePackages(rootDir, globs).packages];
}

/** Workspace packages plus qualification evidence about unmatched declarations. */
export function resolveWorkspacePackages(rootDir: string, globs: readonly string[]): WorkspaceEnumeration {
  const positiveGlobs = globs.filter((glob) => !glob.startsWith("!"));
  const ignoredGlobs = globs.filter((glob) => glob.startsWith("!")).map((glob) => glob.slice(1));
  const resolved = positiveGlobs.map((glob) => ({ glob, packages: packagesForGlob(rootDir, glob) }));
  const byDirectory = new Map<string, WorkspacePackage>();
  const canonicalRoot = realpathSync(rootDir);
  for (const pkg of resolved.flatMap((entry) => entry.packages)) {
    if (ignoredGlobs.some((glob) => matchesGlob(pkg.dir, glob))) continue;
    const canonicalDir = relative(canonicalRoot, realpathSync(workspacePath(rootDir, pkg.dir))).replaceAll("\\", "/") || ".";
    byDirectory.set(canonicalDir, { ...pkg, dir: canonicalDir });
  }
  const packages = [...byDirectory.values()];
  assertUniqueNames(packages);
  return {
    packages: packages.sort((left, right) => byCodeUnit(left.name, right.name)),
    unmatched: resolved.filter((entry) => entry.packages.length === 0).map((entry) => entry.glob),
  };
}

/** Whether the complete declaration makes `packageRoot` a workspace member. */
export function globsCoverPackage(globs: readonly string[], packageRoot: string): boolean {
  const positives = globs.filter((glob) => !glob.startsWith("!"));
  const negatives = globs.filter((glob) => glob.startsWith("!")).map((glob) => glob.slice(1));
  return positives.some((glob) => matchesGlob(packageRoot, glob)) && !negatives.some((glob) => matchesGlob(packageRoot, glob));
}

function assertUniqueNames(packages: readonly WorkspacePackage[]): void {
  const owners = new Map<string, string>();
  for (const pkg of packages) {
    const previous = owners.get(pkg.name);
    if (previous !== undefined && previous !== pkg.dir) {
      throw new WorkspaceDiscoveryError("duplicate-package", `workspace package name ${pkg.name} is declared by both ${previous} and ${pkg.dir}`, {
        paths: [previous, pkg.dir],
      });
    }
    owners.set(pkg.name, pkg.dir);
  }
}

/**
 * Match the negated patterns that can exclude a package a supported positive
 * glob discovered. We deliberately accept only the glob forms that do not
 * participate in enumeration: a recursive segment exclusion and exact paths.
 */
function matchesGlob(dir: string, glob: string): boolean {
  if (glob.startsWith("**/") && glob.endsWith("/**")) {
    const segment = glob.slice(3, -3);
    return dir.split("/").includes(segment);
  }
  const pattern = segments(glob);
  const candidate = segments(dir);
  return pattern.length === candidate.length && pattern.every((part, index) => part === "*" || part === candidate[index]);
}

function packagesForGlob(rootDir: string, glob: string): WorkspacePackage[] {
  const matches = walkPattern(rootDir, segments(glob), 0, ".");
  return matches.flatMap((dir) => packageAt(rootDir, dir));
}

function packageAt(rootDir: string, dir: string): WorkspacePackage[] {
  const manifest = workspacePath(rootDir, join(dir, "package.json"));
  if (!existsSync(manifest)) return [];
  const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string; private?: boolean };
  if (!parsed.name) return [];
  const normalized = dir === "." ? "." : dir.replace(/^\.\//, "").replaceAll("\\", "/");
  return [{ name: parsed.name, dir: normalized, ...(parsed.private === undefined ? {} : { private: parsed.private }) }];
}

function walkPattern(rootDir: string, pattern: readonly string[], index: number, current: string): string[] {
  if (index === pattern.length) return [current];
  const part = pattern[index]!;
  if (part !== "*") return walkPattern(rootDir, pattern, index + 1, join(current, part));
  const absolute = workspacePath(rootDir, current);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(byCodeUnit)
    .flatMap((name) => walkPattern(rootDir, pattern, index + 1, join(current, name)));
}

function supportedPattern(pattern: string, negated: boolean): boolean {
  if (negated && /^\*\*\/[^*/?[\]{}]+\/\*\*$/u.test(pattern)) return true;
  if (pattern === ".") return true;
  if (pattern === "" || pattern.startsWith("/") || pattern.includes("\\")) return false;
  const parts = pattern.split("/");
  return parts.every((part) => part !== "" && part !== "." && part !== ".." && (part === "*" || !/[*?[\]{}]/u.test(part)));
}

function patternEscapes(glob: string): boolean {
  const pattern = glob.startsWith("!") ? glob.slice(1) : glob;
  return pattern.startsWith("/") || pattern.includes("\\") || pattern.split("/").some((part) => part === "..");
}

function segments(path: string): string[] {
  return path === "." ? [] : path.replace(/^\.\//, "").split("/");
}
