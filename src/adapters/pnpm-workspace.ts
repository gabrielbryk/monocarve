/** pnpm workspace membership and package discovery. */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { byCodeUnit } from "../util/hash.ts";
import type { AdapterEditResult, WorkspacePackage } from "./types.ts";
import { LockfileError } from "./pnpm-error.ts";

export async function listPackages(rootDir: string, manifestName: string): Promise<WorkspacePackage[]> {
  const globs = workspaceGlobs(rootDir, manifestName);
  const positiveGlobs = globs.filter((glob) => !glob.startsWith("!"));
  const ignoredGlobs = globs.filter((glob) => glob.startsWith("!")).map((glob) => glob.slice(1));
  const packages = positiveGlobs
    .flatMap((glob) => packagesForGlob(rootDir, glob))
    .filter((pkg) => !ignoredGlobs.some((glob) => matchesGlob(pkg.dir, glob)));
  const owners = new Map<string, string>();
  for (const pkg of packages) {
    const previous = owners.get(pkg.name);
    if (previous !== undefined && previous !== pkg.dir) throw new LockfileError(`workspace package name ${pkg.name} is declared by both ${previous} and ${pkg.dir}`);
    owners.set(pkg.name, pkg.dir);
  }
  return packages.sort((left, right) => byCodeUnit(left.name, right.name));
}

function workspaceGlobs(rootDir: string, manifestName: string): string[] {
  const manifestPath = join(rootDir, manifestName);
  if (!existsSync(manifestPath)) return [];
  const text = readFileSync(manifestPath, "utf8");
  const packagesLine = text.split("\n").find((line) => /^packages\s*:/u.test(line));
  if (packagesLine && !/^packages\s*:\s*(?:\[\s*\])?\s*$/u.test(packagesLine)) {
    throw new LockfileError("inline pnpm workspace package arrays are not yet ported; use one package glob per YAML list line");
  }
  const globs = text.split("\n").flatMap(workspaceGlob);
  for (const glob of globs) {
    const pattern = glob.startsWith("!") ? glob.slice(1) : glob;
    if (pattern.includes("*") && !pattern.endsWith("/*") && !pattern.startsWith("**/")) {
      throw new LockfileError(`pnpm workspace glob is not yet ported: ${glob}`);
    }
  }
  return globs;
}

/** Match the negated pnpm patterns that can exclude a package discovered by a
 * supported positive workspace glob. We deliberately accept only the glob
 * forms that do not participate in enumeration: a recursive segment exclusion
 * and exact paths.
 */
function matchesGlob(dir: string, glob: string): boolean {
  if (glob.startsWith("**/") && glob.endsWith("/**")) {
    const segment = glob.slice(3, -3);
    return dir.split("/").includes(segment);
  }
  return dir === glob;
}

function workspaceGlob(line: string): string[] {
  const value = line.match(/^\s*-\s*['"]?([^'"\s]+)['"]?\s*$/)?.[1];
  return value === undefined ? [] : [value];
}

function packagesForGlob(rootDir: string, glob: string): WorkspacePackage[] {
  const base = glob.endsWith("/*") ? glob.slice(0, -2) : glob;
  const absolute = resolve(rootDir, base);
  if (!existsSync(absolute)) return [];
  const dirs = glob.endsWith("/*")
    ? readdirSync(absolute, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => join(base, entry.name)).sort(byCodeUnit)
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

export function workspaceManifestEdit(manifestText: string, packageRoot: string): AdapterEditResult {
  if (workspaceGlobsText(manifestText).some((glob) => coversPackage(glob, packageRoot))) return { kind: "already-satisfied" };
  const lines = manifestText.split("\n");
  const packagesLine = lines.findIndex((line) => /^packages:\s*$/.test(line));
  if (packagesLine < 0) return { kind: "changed", contents: `${manifestText.replace(/\n*$/, "")}\npackages:\n  - ${packageRoot}\n` };
  lines.splice(packagesLine + 1, 0, `  - ${packageRoot}`);
  return { kind: "changed", contents: lines.join("\n") };
}

function workspaceGlobsText(manifestText: string): string[] {
  return manifestText.split("\n").flatMap(workspaceGlob);
}

function coversPackage(glob: string, packageRoot: string): boolean {
  if (glob === packageRoot) return true;
  if (!glob.endsWith("/*")) return false;
  const base = glob.slice(0, -2);
  return packageRoot.startsWith(`${base}/`) && !packageRoot.slice(base.length + 1).includes("/");
}
