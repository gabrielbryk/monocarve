import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

import { type MonocarveConfig } from "../../config.ts";
import { applicationOwner } from "../../config/helpers.ts";
import { readManifest } from "../../graph/workspace.ts";

import { declaredTypings, exportTarget, resolveTarget, subpathExports, typesCondition } from "./package-exports.ts";

/** `paths` entries for dependencies installed by applications or workspace packages. */
export function externalDependencyPaths(config: MonocarveConfig, installedRoot: string): Record<string, string[]> {
  const paths: Record<string, string[]> = {};
  for (const owner of dependencyOwners(config, installedRoot)) addOwnerDependencies(paths, installedRoot, owner);
  return paths;
}

function dependencyOwners(config: MonocarveConfig, installedRoot: string): string[] {
  const packageOwners = config.packageRoots.flatMap((root) => packageDirectories(installedRoot, root));
  const applicationOwners = config.applications.map(applicationOwner);
  const firstPartyPackageOwners = config.firstPartyPackages.map((pkg) => pkg.root);
  return [...new Set([...packageOwners, ...applicationOwners, ...firstPartyPackageOwners, ""])];
}

function packageDirectories(installedRoot: string, root: string): string[] {
  const absolute = resolve(installedRoot, root);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name));
}

function addOwnerDependencies(paths: Record<string, string[]>, installedRoot: string, owner: string): void {
  const manifestPath = resolve(installedRoot, owner, "package.json");
  const manifest = readManifest(manifestPath);
  if (!manifest) return;
  const require = createRequire(manifestPath);
  for (const dependency of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
    if (!paths[dependency]) addDependency(paths, require, dependency);
  }
}

function addDependency(paths: Record<string, string[]>, require: NodeRequire, dependency: string): void {
  try {
    const resolved = require.resolve(dependency);
    const packageRoot = packageRootFromResolved(resolved, dependency);
    if (!packageRoot) return;
    const manifest = readManifest(join(packageRoot, "package.json"));
    paths[dependency] = [rootDependencyEntry(require, dependency, packageRoot, manifest, resolved)];
    addDependencySubpaths(paths, require, dependency, packageRoot, manifest);
  } catch {
    // TypeScript's diagnostics, rather than this setup phase, report an unresolved dependency.
  }
}

function packageRootFromResolved(resolved: string, packageName: string): string | undefined {
  let current = resolve(resolved);
  while (current !== dirname(current)) {
    const manifest = readManifest(join(current, "package.json"));
    if (manifest?.name === packageName) return current;
    current = dirname(current);
  }
  return undefined;
}

function rootDependencyEntry(
  require: NodeRequire,
  dependency: string,
  packageRoot: string,
  manifest: ReturnType<typeof readManifest>,
  resolved: string,
): string {
  // Conditional exports are the source of truth for an ESM synthetic
  // consumer. A legacy top-level `types` field can name a CJS declaration tree
  // (TypeBox does), which makes nominal symbols split across CJS and ESM.
  const ownTypes = typesCondition(subpathExports(manifest)["."]) ?? declaredTypings(manifest);
  if (ownTypes !== undefined && existsSync(resolve(packageRoot, ownTypes))) return resolve(packageRoot, ownTypes);
  // TypeScript's package fallback predates the `types` field. Some still ship
  // a root index.d.ts beside `main`; mapping them straight to JavaScript would
  // manufacture an implicit-any failure that the repository compiler does not.
  const conventionalTypes = resolve(packageRoot, "index.d.ts");
  if (existsSync(conventionalTypes)) return conventionalTypes;
  return definitelyTypedEntry(require, dependency) ?? (manifest?.main ? resolve(packageRoot, manifest.main) : resolved);
}

function addDependencySubpaths(
  paths: Record<string, string[]>,
  require: NodeRequire,
  dependency: string,
  packageRoot: string,
  manifest: ReturnType<typeof readManifest>,
): void {
  for (const [key, value] of Object.entries(subpathExports(manifest))) {
    if (key === "." || key.includes("*")) continue;
    const name = key.replace(/^\.\//, "");
    const target = dependencySubpathEntry(require, dependency, name, packageRoot, value);
    if (target !== undefined) paths[`${dependency}/${name}`] ??= [target];
  }
}

function dependencySubpathEntry(
  require: NodeRequire,
  dependency: string,
  subpath: string,
  packageRoot: string,
  exported: unknown,
): string | undefined {
  const declared = typesCondition(exported);
  const typed = declared === undefined ? undefined : resolve(packageRoot, declared);
  if (typed !== undefined && existsSync(typed)) return typed;
  return definitelyTypedEntry(require, dependency, subpath) ?? resolveTarget(packageRoot, exportTarget(exported));
}

function definitelyTypedEntry(require: NodeRequire, dependency: string, subpath?: string): string | undefined {
  const mangled = dependency.startsWith("@") ? `@types/${dependency.slice(1).replace("/", "__")}` : `@types/${dependency}`;
  let root: string;
  try {
    root = dirname(require.resolve(`${mangled}/package.json`));
  } catch {
    return undefined;
  }
  const manifest = readManifest(join(root, "package.json"));
  const candidates = subpath === undefined
    ? [declaredTypings(manifest) ?? manifest?.main ?? "index.d.ts"]
    : [`${subpath}.d.ts`, `${subpath}/index.d.ts`, subpath];
  return candidates.map((entry) => resolve(root, entry)).find(existsSync);
}
