/** Independent manifest-to-lockfile importer agreement proof. */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { PackageManagerAdapter } from "../adapters/types.ts";
import type { ExtractionManifest } from "../plan/manifest.ts";

export interface ProjectedImporterDifference {
  readonly packageRoot: string;
  readonly message: string;
}

export interface ProjectedImporterVerification {
  readonly ok: boolean;
  readonly checked: readonly string[];
  readonly differences: readonly ProjectedImporterDifference[];
}

export async function verifyProjectedImporters(input: {
  readonly workspacePath: string;
  readonly manifest: ExtractionManifest;
  readonly adapter: PackageManagerAdapter;
}): Promise<ProjectedImporterVerification> {
  const roots = [
    ...new Set([
      ...(input.manifest.target?.packageRoot ? [input.manifest.target.packageRoot] : []),
      ...input.manifest.operations.flatMap((operation) => (operation.kind === "lockfile-importer" ? [operation.packageRoot] : [])),
    ]),
  ].sort();
  return verifyPackageImporters(input.workspacePath, input.adapter, roots);
}

export async function verifyPackageImporters(
  workspacePath: string,
  adapter: PackageManagerAdapter,
  roots: readonly string[],
): Promise<ProjectedImporterVerification> {
  if (roots.length === 0) return { ok: true, checked: [], differences: [] };
  const lockfilePath = resolve(workspacePath, adapter.lockfileName);
  if (!existsSync(lockfilePath)) return { ok: true, checked: [], differences: [] };
  const lockfile = readFileSync(lockfilePath, "utf8");
  const packages = await adapter.listPackages(workspacePath);
  const workspaceRoots = Object.fromEntries(packages.map(({ name, dir }) => [name, dir]));
  const registeredRoots = new Set(packages.map(({ dir }) => dir));
  const checked = roots.filter((root) => root === "." || registeredRoots.has(root));
  const differences: ProjectedImporterDifference[] = [];
  for (const packageRoot of checked) {
    const packagePath = resolve(workspacePath, packageRoot, "package.json");
    const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as Record<string, unknown>;
    const actual = adapter.importerBlock(lockfile, packageRoot);
    if (actual === undefined) {
      differences.push({ packageRoot, message: `${adapter.lockfileName} has no importer` });
      continue;
    }
    let expected: string;
    try {
      expected = adapter.renderImporterBlock({
        packageRoot,
        ...identity(parsed),
        dependencies: stringRecord(parsed.dependencies),
        devDependencies: stringRecord(parsed.devDependencies),
        optionalDependencies: stringRecord(parsed.optionalDependencies),
        lockfileText: lockfile,
        workspaceRoots,
      });
    } catch (error) {
      differences.push({ packageRoot, message: `cannot project importer: ${(error as Error).message}` });
      continue;
    }
    if (normalize(actual) !== normalize(expected)) {
      differences.push({ packageRoot, message: "package.json dependency sections do not match the projected lockfile importer" });
    }
  }
  return { ok: differences.length === 0, checked, differences };
}

/**
 * The manifest's own name and version, for lockfiles that record them.
 *
 * Absent fields stay absent rather than becoming `undefined` keys, so an
 * adapter that ignores identity sees exactly the input it always saw.
 */
function identity(parsed: Record<string, unknown>): { packageName?: string; packageVersion?: string } {
  return {
    ...(typeof parsed.name === "string" ? { packageName: parsed.name } : {}),
    ...(typeof parsed.version === "string" ? { packageVersion: parsed.version } : {}),
  };
}

function stringRecord(value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function normalize(value: string): string {
  return value.trimEnd().replaceAll("\r\n", "\n");
}
