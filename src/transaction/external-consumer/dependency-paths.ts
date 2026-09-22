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
  const runtimeEntry = manifest?.main ? resolve(packageRoot, manifest.main) : resolved;
  return definitelyTypedEntry(require, dependency) ?? adjacentDeclaration(runtimeEntry) ?? runtimeEntry;
}

/**
 * Some ESM packages ship declaration siblings without advertising a `types`
 * condition (for example `dist/index.mjs` beside `dist/index.d.mts`). The
 * repository compiler discovers those siblings, so the synthetic consumer
 * must prefer them over mapping the package name directly to JavaScript.
 */
function adjacentDeclaration(runtimeEntry: string): string | undefined {
  const candidates = runtimeEntry.endsWith(".mjs")
    ? [runtimeEntry.replace(/\.mjs$/u, ".d.mts")]
    : runtimeEntry.endsWith(".cjs")
      ? [runtimeEntry.replace(/\.cjs$/u, ".d.cts")]
      : runtimeEntry.endsWith(".js")
        ? [runtimeEntry.replace(/\.js$/u, ".d.ts")]
        : [];
  return candidates.find(existsSync);
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

function dependencySubpathEntry(require: NodeRequire, dependency: string, subpath: string, packageRoot: string, exported: unknown): string | undefined {
  const declared = typesCondition(exported);
  const typed = declared === undefined ? undefined : resolve(packageRoot, declared);
  if (typed !== undefined && existsSync(typed)) return typed;
  const runtimeTarget = resolveTarget(packageRoot, exportTarget(exported));
  // A subpath export with no explicit `types` condition — a bare string value
  // like `"./sha2.js": "./sha2.js"` (@noble/hashes ships every subpath this
  // way) applies to every condition including `types`, so there is nothing
  // for typesCondition to find even though a real `.d.ts` sibling exists.
  // rootDependencyEntry already prefers that sibling for the `.` export;
  // subpaths need the identical fallback or the `paths` alias points TypeScript
  // straight at the runtime `.js` file with `allowJs` off, misreporting a
  // perfectly typed package as TS7016 "implicitly has an 'any' type".
  return definitelyTypedEntry(require, dependency, subpath) ?? adjacentDeclaration(runtimeTarget ?? "") ?? runtimeTarget;
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
  const candidates =
    subpath === undefined ? [declaredTypings(manifest) ?? manifest?.main ?? "index.d.ts"] : [`${subpath}.d.ts`, `${subpath}/index.d.ts`, subpath];
  return candidates.map((entry) => resolve(root, entry)).find(existsSync);
}
