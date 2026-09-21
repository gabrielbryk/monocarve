/**
 * The declared surface of the target package, re-read from disk.
 *
 * Half of the audit's boundary proof. The other half — which files may import
 * application code — lives with the reviewed baseline in
 * `plan/boundary-baseline.ts`; this half answers whether the package the plan
 * claims to have produced actually exposes what the manifest says it does.
 * Both feed one `boundaryRules` proof, and both read landed bytes rather than
 * trusting any operation's own claim.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { ExtractionManifest, MoveOperation, MoveWithRewriteOperation } from "../plan/manifest.ts";
import { sourceExportsFromFile } from "../plan/public-surface.ts";
import { relativePosix } from "../util/paths.ts";
import { firstExportTarget } from "./audit-helpers.ts";

/** Entrypoint existence and declared exports, from the landed files. */
export function entrypointSurfaceFailures(
  rootDir: string,
  manifest: ExtractionManifest,
  moves: readonly (MoveOperation | MoveWithRewriteOperation)[],
): string[] {
  const entrypoint = resolve(rootDir, manifest.target.packageRoot, manifest.target.entrypoint);
  if (!existsSync(entrypoint)) return [`target entrypoint does not exist: ${manifest.target.entrypoint}`];
  try {
    const entrypointDeclared = manifest.operations.some(
      (operation) =>
        operation.kind === "write-file" &&
        operation.path === `${manifest.target.packageRoot}/${manifest.target.entrypoint}`,
    );
    // When the plan wrote the barrel, it alone defines the surface. When it
    // did not — extraction into a package that already had one — the moved
    // modules are inspected too.
    const moduleTargets = moves
      .filter((move) => /\.[cm]?[jt]sx?$/.test(move.target))
      .map((move) => resolve(rootDir, move.target));
    const files = [entrypoint, ...(entrypointDeclared ? [] : moduleTargets)].filter(existsSync);
    const actual = files.flatMap((file) => sourceExportsFromFile(file));
    return manifest.target.requiredExports
      .filter((required) => !actual.some((entry) => entry.name === required.name && entry.typeOnly === required.typeOnly))
      .map((required) => `target entrypoint does not expose ${required.name}`);
  } catch (error) {
    return [`target surface could not be read: ${(error as Error).message}`];
  }
}

/** Every declared public subpath, checked against the landed package manifest. */
export function publicSubpathFailures(rootDir: string, manifest: ExtractionManifest): string[] {
  const packageManifestPath = resolve(rootDir, manifest.target.packageRoot, "package.json");
  if ((manifest.target.publicModules?.length ?? 0) === 0 || !existsSync(packageManifestPath)) return [];
  try {
    const packageManifest = JSON.parse(readFileSync(packageManifestPath, "utf8")) as { exports?: unknown };
    const exportsMap = packageManifest.exports && typeof packageManifest.exports === "object" && !Array.isArray(packageManifest.exports)
      ? packageManifest.exports as Record<string, unknown>
      : {};
    return (manifest.target.publicModules ?? []).flatMap((module) => subpathFailures(rootDir, manifest.target.packageRoot, exportsMap, module));
  } catch (error) {
    return [`package subpaths could not be read: ${(error as Error).message}`];
  }
}

type PublicModuleRecord = NonNullable<ExtractionManifest["target"]["publicModules"]>[number];

function subpathFailures(
  rootDir: string,
  packageRoot: string,
  exportsMap: Record<string, unknown>,
  module: PublicModuleRecord,
): string[] {
  const declared = firstExportTarget(exportsMap[module.exportKey]);
  if (declared !== module.exportTarget) return [`package subpath ${module.exportKey} does not target ${module.exportTarget}`];
  const resolved = relativePosix(rootDir, resolve(rootDir, packageRoot, declared));
  if (resolved !== module.target) return [`package subpath ${module.exportKey} resolves to ${resolved}, not ${module.target}`];
  const actual = sourceExportsFromFile(resolve(rootDir, module.target), module.target);
  return module.requiredExports
    .filter((required) => !actual.some((entry) => entry.name === required.name && entry.typeOnly === required.typeOnly))
    .map((required) => `package subpath ${module.exportKey} does not expose ${required.name}`);
}
