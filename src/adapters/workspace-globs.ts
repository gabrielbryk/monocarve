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

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { byCodeUnit } from "../util/hash.ts";
import { LockfileError } from "./lockfile-error.ts";
import type { WorkspacePackage } from "./types.ts";

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
    if (pattern.includes("*") && !pattern.endsWith("/*") && !pattern.startsWith("**/")) {
      throw new LockfileError(`${manager} workspace glob is not yet ported: ${glob}`);
    }
  }
}

/** Every package the positive globs enumerate and the negated globs keep. */
export function enumerateWorkspacePackages(rootDir: string, globs: readonly string[]): WorkspacePackage[] {
  const positiveGlobs = globs.filter((glob) => !glob.startsWith("!"));
  const ignoredGlobs = globs.filter((glob) => glob.startsWith("!")).map((glob) => glob.slice(1));
  const packages = positiveGlobs.flatMap((glob) => packagesForGlob(rootDir, glob)).filter((pkg) => !ignoredGlobs.some((glob) => matchesGlob(pkg.dir, glob)));
  assertUniqueNames(packages);
  return packages.sort((left, right) => byCodeUnit(left.name, right.name));
}

/** Whether a declared glob already makes `packageRoot` a workspace member. */
export function globCoversPackage(glob: string, packageRoot: string): boolean {
  if (glob === packageRoot) return true;
  if (!glob.endsWith("/*")) return false;
  const base = glob.slice(0, -2);
  return packageRoot.startsWith(`${base}/`) && !packageRoot.slice(base.length + 1).includes("/");
}

function assertUniqueNames(packages: readonly WorkspacePackage[]): void {
  const owners = new Map<string, string>();
  for (const pkg of packages) {
    const previous = owners.get(pkg.name);
    if (previous !== undefined && previous !== pkg.dir) {
      throw new LockfileError(`workspace package name ${pkg.name} is declared by both ${previous} and ${pkg.dir}`);
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
  return dir === glob;
}

function packagesForGlob(rootDir: string, glob: string): WorkspacePackage[] {
  const base = glob.endsWith("/*") ? glob.slice(0, -2) : glob;
  const absolute = resolve(rootDir, base);
  if (!existsSync(absolute)) return [];
  const dirs = glob.endsWith("/*")
    ? readdirSync(absolute, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(base, entry.name))
        .sort(byCodeUnit)
    : [base];
  return dirs.flatMap((dir) => packageAt(rootDir, dir));
}

function packageAt(rootDir: string, dir: string): WorkspacePackage[] {
  const manifest = join(rootDir, dir, "package.json");
  if (!existsSync(manifest)) return [];
  const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string; private?: boolean };
  if (!parsed.name) return [];
  return [{ name: parsed.name, dir: dir.replaceAll("\\", "/"), ...(parsed.private === undefined ? {} : { private: parsed.private }) }];
}
