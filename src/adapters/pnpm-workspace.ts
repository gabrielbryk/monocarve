/** pnpm workspace membership and package discovery. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { AdapterEditResult, WorkspaceInspection, WorkspacePackage } from "./types.ts";
import { LockfileError } from "./pnpm-error.ts";
import { assertEnumerableGlobs, globsCoverPackage, resolveWorkspacePackages } from "./workspace-globs.ts";

export async function listPackages(rootDir: string, manifestName: string): Promise<WorkspacePackage[]> {
  return [...(await inspectWorkspace(rootDir, manifestName)).packages];
}

export async function inspectWorkspace(rootDir: string, manifestName: string): Promise<WorkspaceInspection> {
  const result = resolveWorkspacePackages(rootDir, workspaceGlobs(rootDir, manifestName));
  return { packages: result.packages, unmatchedPatterns: result.unmatched };
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
  assertEnumerableGlobs(globs, "pnpm");
  return globs;
}

function workspaceGlob(line: string): string[] {
  const value = line.match(/^\s*-\s*['"]?([^'"\s]+)['"]?\s*$/)?.[1];
  return value === undefined ? [] : [value];
}

export function workspaceManifestEdit(manifestText: string, packageRoot: string): AdapterEditResult {
  const globs = workspaceGlobsText(manifestText);
  assertEnumerableGlobs(globs, "pnpm");
  if (globsCoverPackage(globs, packageRoot)) return { kind: "already-satisfied" };
  const lines = manifestText.split("\n");
  const packagesLine = lines.findIndex((line) => /^packages:\s*$/.test(line));
  if (packagesLine < 0) return { kind: "changed", contents: `${manifestText.replace(/\n*$/, "")}\npackages:\n  - ${packageRoot}\n` };
  lines.splice(packagesLine + 1, 0, `  - ${packageRoot}`);
  return { kind: "changed", contents: lines.join("\n") };
}

function workspaceGlobsText(manifestText: string): string[] {
  return manifestText.split("\n").flatMap(workspaceGlob);
}
