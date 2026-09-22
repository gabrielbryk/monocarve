/**
 * What the workspace already contains: which packages exist, what they export,
 * and which of their subpaths actually resolve.
 *
 * This is the answer to "is that import leaving for a package, or for
 * application code?", which is the question containment turns on.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import type { MonocarveConfig } from "../config.ts";
import { ownerFor } from "../config.ts";
import { isSourceModulePath, sourceFiles } from "../util/files.ts";
import { relativePosix } from "../util/paths.ts";

export interface WorkspaceInventory {
  /**
   * Source files inside the configured package roots and exact-root
   * `firstPartyPackages`, workspace-relative.
   */
  readonly files: readonly string[];
  /** Package directories, workspace-relative, sorted. */
  readonly owners: readonly string[];
  /** Declared package name -> owning directory. */
  readonly packageNames: ReadonlyMap<string, string>;
}

export function workspaceInventory(config: MonocarveConfig, rootDir: string): WorkspaceInventory {
  const files = [...config.packageRoots, ...config.firstPartyPackages.map((pkg) => pkg.root)]
    .flatMap((root) => sourceFiles(resolve(rootDir, root), undefined, config.sourceExtensions))
    .map((file) => relativePosix(rootDir, file))
    .filter((path) => isSourceModulePath(path, config.sourceExtensions))
    .sort();
  const owners = [...new Set(files.map((file) => ownerFor(config, file)))].sort();
  const packageNames = new Map<string, string>();
  for (const owner of ownersOnDisk(config, rootDir, owners)) {
    const manifest = readManifest(join(rootDir, owner, "package.json"));
    if (manifest?.name) packageNames.set(manifest.name, owner);
  }
  // Declared in config, not read from disk: a `firstPartyPackages` entry names
  // its own identity so a bare-specifier import resolves to it even before, or
  // without, a `package.json` on disk.
  for (const pkg of config.firstPartyPackages) packageNames.set(pkg.name, pkg.root);
  return { files, owners, packageNames };
}

/**
 * Package directories, including ones whose sources have not been written yet.
 * A package created earlier in the same session has a manifest but may have no
 * source files, and it still counts as an existing package.
 */
function ownersOnDisk(config: MonocarveConfig, rootDir: string, fromFiles: readonly string[]): string[] {
  const owners = new Set(fromFiles);
  for (const root of config.packageRoots) {
    const absolute = resolve(rootDir, root);
    if (!existsSync(absolute)) continue;
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (existsSync(join(absolute, entry.name, "package.json"))) owners.add(`${root}/${entry.name}`);
    }
  }
  // The root itself is the package here, so it is added directly rather than
  // by scanning its children the way a `packageRoots` container is above.
  for (const pkg of config.firstPartyPackages) {
    if (existsSync(resolve(rootDir, pkg.root, "package.json"))) owners.add(pkg.root);
  }
  return [...owners].sort();
}

type ExportsField = string | { [key: string]: ExportsField } | ExportsField[] | null;

export interface PackageManifest {
  readonly name?: string;
  readonly main?: string;
  readonly types?: string;
  readonly exports?: ExportsField;
  /**
   * The bundler-facing claim a package makes about evaluating its own modules:
   * `false` for none, `true` or a glob list for some. Read, never trusted — see
   * `SideEffectsDeclaration` in `../plan/manifest.ts`.
   */
  readonly sideEffects?: boolean | readonly string[];
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
}

export function readManifest(absolute: string): PackageManifest | undefined {
  if (!existsSync(absolute)) return undefined;
  try {
    return JSON.parse(readFileSync(absolute, "utf8")) as PackageManifest;
  } catch {
    return undefined;
  }
}

function exportTargets(value: ExportsField): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(exportTargets);
  if (value && typeof value === "object") return Object.values(value).flatMap(exportTargets);
  return [];
}

function subpathTargets(manifest: PackageManifest, subpath: string): string[] {
  const exportsField = manifest.exports;
  if (exportsField === undefined || exportsField === null) {
    return subpath === "." ? [manifest.main, manifest.types].filter((entry): entry is string => typeof entry === "string") : [];
  }
  if (typeof exportsField === "string" || Array.isArray(exportsField)) {
    return subpath === "." ? exportTargets(exportsField) : [];
  }
  const keys = Object.keys(exportsField);
  // An `exports` object with no "./" keys is a conditions map for the root.
  if (!keys.some((key) => key.startsWith("."))) return subpath === "." ? exportTargets(exportsField) : [];
  const direct = exportsField[subpath];
  if (direct !== undefined) return exportTargets(direct);
  for (const key of keys) {
    if (!key.includes("*")) continue;
    const [head = "", tail = ""] = key.split("*");
    if (!subpath.startsWith(head) || !subpath.endsWith(tail)) continue;
    const star = subpath.slice(head.length, subpath.length - tail.length);
    return exportTargets(exportsField[key] ?? null).map((target) => target.replaceAll("*", star));
  }
  return [];
}

const subpathCache = new Map<string, boolean>();

/**
 * Whether `specifier` resolves to a file the package `owner` actually ships.
 *
 * A specifier like `@acme/db/schema` is a workspace edge even when the module
 * resolver could not follow it — but only if the package really exports that
 * subpath. Otherwise it is a broken import, and treating it as a satisfied
 * dependency would hide the breakage.
 */
export function workspaceSubpathResolves(rootDir: string, owner: string, specifier: string): boolean {
  const key = JSON.stringify([rootDir, owner, specifier]);
  const cached = subpathCache.get(key);
  if (cached !== undefined) return cached;
  const manifest = readManifest(join(rootDir, owner, "package.json"));
  let resolves = false;
  if (manifest) {
    const name = manifest.name ?? "";
    const subpath = specifier === name ? "." : `./${specifier.slice(name.length + 1)}`;
    resolves = subpathTargets(manifest, subpath).some((target) => existsSync(resolve(rootDir, owner, target)));
  }
  subpathCache.set(key, resolves);
  return resolves;
}

const entrypointCache = new Map<string, string | undefined>();

/** Workspace-relative public entry file of an existing package, if resolvable. */
export function packageEntrypoint(rootDir: string, owner: string): string | undefined {
  const key = JSON.stringify([rootDir, owner]);
  if (entrypointCache.has(key)) return entrypointCache.get(key);
  const manifest = readManifest(join(rootDir, owner, "package.json"));
  let entry: string | undefined;
  if (manifest) {
    const root =
      typeof manifest.exports === "object" && manifest.exports !== null && !Array.isArray(manifest.exports)
        ? (manifest.exports as Record<string, ExportsField>)["."]
        : manifest.exports;
    const candidates = [
      typeof root === "string" ? root : undefined,
      ...(root && typeof root === "object" && !Array.isArray(root)
        ? (["import", "default", "types"] as const).map((condition) => {
            const value = (root as Record<string, ExportsField>)[condition];
            return typeof value === "string" ? value : undefined;
          })
        : []),
      manifest.main,
      manifest.types,
    ].filter((value): value is string => typeof value === "string");
    entry = candidates.map((value) => `${owner}/${value.replace(/^\.\//, "")}`).find((path) => existsSync(resolve(rootDir, path)));
  }
  entrypointCache.set(key, entry);
  return entry;
}

export interface GeneratedProvenance {
  readonly source: string | null;
  readonly sourceExists: boolean;
  readonly regenerate: string | null;
}

/**
 * Provenance a generated file declares about itself in its header. A generated
 * file that moves must carry this forward, or nobody can regenerate it at its
 * new location.
 */
export function generatedProvenance(config: MonocarveConfig, rootDir: string, path: string): GeneratedProvenance | null {
  const absolute = resolve(rootDir, path);
  if (!existsSync(absolute)) return null;
  const settings = config.generatedArtifacts.provenance;
  const header = readFileSync(absolute, "utf8").split("\n").slice(0, settings.headerLines);
  if (!header.some((line) => new RegExp(settings.marker, "i").test(line))) return null;
  const capture = (pattern: string): string | null =>
    header.map((line) => line.match(new RegExp(pattern, "i"))?.[1]).find((value) => value !== undefined) ?? null;
  const source = capture(settings.source);
  const regenerate = capture(settings.regenerate);
  return { source, sourceExists: source !== null && existsSync(resolve(rootDir, source)), regenerate };
}

export function resetWorkspaceCaches(): void {
  subpathCache.clear();
  entrypointCache.clear();
}
