import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { type MonocarveConfig } from "../../config.ts";
import { readManifest } from "../../graph/workspace.ts";
import { relativePosix } from "../../util/paths.ts";

import { exportTarget } from "./package-exports.ts";

/** `paths` entries for every workspace package and its declared public subpaths. */
export function workspacePaths(config: MonocarveConfig, rootDir: string): Record<string, string[]> {
  const paths: Record<string, string[]> = {};
  for (const root of config.packageRoots) addRootPackages(paths, resolve(rootDir, root), rootDir);
  // The root itself is the package here, not a container to read subdirectories
  // of, so it is added directly rather than through `addRootPackages`.
  for (const pkg of config.firstPartyPackages) addPackagePaths(paths, resolve(rootDir, pkg.root), rootDir);
  return paths;
}

function addRootPackages(paths: Record<string, string[]>, absoluteRoot: string, rootDir: string): void {
  if (!existsSync(absoluteRoot)) return;
  for (const entry of readdirSync(absoluteRoot, { withFileTypes: true })) {
    if (entry.isDirectory()) addPackagePaths(paths, join(absoluteRoot, entry.name), rootDir);
  }
}

function addPackagePaths(paths: Record<string, string[]>, packageRoot: string, rootDir: string): void {
  const manifest = readManifest(join(packageRoot, "package.json"));
  const packageName = manifest?.name;
  if (!packageName) return;
  const exportsField = manifest.exports;
  const subpaths = exportsField && typeof exportsField === "object" && !Array.isArray(exportsField)
    ? exportsField as Record<string, unknown>
    : { ".": exportsField };
  const keys = Object.keys(subpaths).filter((key) => key.startsWith("."));
  for (const key of keys.length > 0 ? keys : ["."]) addPublicPath(paths, packageName, manifest, packageRoot, rootDir, key, subpaths[key]);
  paths[packageName] ??= [relativePosix(rootDir, join(packageRoot, "src/index.ts"))];
}

function addPublicPath(
  paths: Record<string, string[]>,
  packageName: string,
  manifest: { readonly types?: string | undefined; readonly main?: string | undefined },
  packageRoot: string,
  rootDir: string,
  key: string,
  exported: unknown,
): void {
  const specifier = key === "." ? packageName : `${packageName}/${key.replace(/^\.\//, "")}`;
  const fallback = key === "." ? (manifest.types ?? manifest.main) : undefined;
  const candidate = resolve(packageRoot, exportTarget(exported) ?? fallback ?? "./src/index.ts");
  if (key !== "." && !specifier.includes("*") && !existsSync(candidate)) return;
  const target = existsSync(candidate) ? candidate : join(packageRoot, "src/index.ts");
  paths[specifier] = [relativePosix(rootDir, target)];
}
