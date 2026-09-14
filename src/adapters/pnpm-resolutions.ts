/** Resolution evidence read from pnpm lockfiles. */

import { LockfileError } from "./pnpm-error.ts";
import { parseImporters, yamlScalar } from "./pnpm-importers.ts";

interface ImporterDependency {
  readonly root: string;
  readonly name: string;
  readonly specifier: string;
  readonly version: string;
}

const REGISTRY_VERSION = /^\d/;

export function dependencyVersion(text: string, name: string, specifier: string, importerRoot?: string | readonly string[]): string {
  const existing = existingDependencyVersion(text, name, specifier, importerRoot);
  if (existing) return existing;
  if (REGISTRY_VERSION.test(specifier) && lockfileAttests(text, name, specifier)) return specifier;
  throw new LockfileError(
    `cannot resolve a lockfile version for ${name}@${specifier}: no importer resolves that specifier and the lockfile has no ${name}@${specifier} entry to take`,
  );
}

export function missingResolutions(lockfileText: string): readonly string[] {
  const snapshots = sectionKeys(lockfileText, "snapshots");
  if (snapshots === undefined && sectionKeys(lockfileText, "packages") !== undefined) return [];
  const resolved = snapshots ?? new Set<string>();
  return importerDependencies(lockfileText)
    .filter((dependency) => REGISTRY_VERSION.test(dependency.version))
    .filter((dependency) => !resolved.has(`${dependency.name}@${dependency.version}`))
    .map((dependency) => `${dependency.root} declares ${dependency.name}@${dependency.version}, and the lockfile has no entry for it`);
}

function existingDependencyVersion(text: string, name: string, specifier: string, importerRoot?: string | readonly string[]): string | undefined {
  const dependencies = importerDependencies(text);
  if (importerRoot !== undefined) {
    const roots = typeof importerRoot === "string" ? [importerRoot] : importerRoot;
    const local = dependencies.filter((dependency) => roots.includes(dependency.root) && dependency.name === name);
    const exactLocal = uniqueImporterVersion(local, name, specifier, (dependency) => dependency.specifier === specifier);
    if (exactLocal !== undefined) return exactLocal;
    if (specifier === "catalog:") {
      const persistedLocal = uniqueImporterVersion(local, name, specifier, () => true);
      if (persistedLocal !== undefined) return persistedLocal;
    }
  }
  const exact = uniqueImporterVersion(dependencies, name, specifier, (dependency) => dependency.specifier === specifier);
  if (exact !== undefined || specifier !== "catalog:") return exact;
  // pnpm may materialize a catalog request in an importer as the selected
  // concrete range (not `catalog:`), notably when an override supplies that
  // selection. The lock still attests the resolution, but only a single
  // version across every importer is safe to project back into catalog syntax.
  return uniqueImporterVersion(dependencies, name, specifier, () => true);
}

function uniqueImporterVersion(
  dependencies: readonly ImporterDependency[],
  name: string,
  specifier: string,
  includes: (dependency: ImporterDependency) => boolean,
): string | undefined {
  const resolved = new Map<string, string>();
  for (const dependency of dependencies) {
    if (dependency.name === name && includes(dependency) && !resolved.has(dependency.version)) {
      resolved.set(dependency.version, dependency.root);
    }
  }
  if (resolved.size > 1) {
    const detail = [...resolved].map(([version, root]) => `${root}: ${version}`).join(", ");
    throw new LockfileError(
      `lockfile resolves ${name}@${specifier} to more than one version (${detail}); reconcile the importers before a new package copies one`,
    );
  }
  return [...resolved.keys()][0];
}

function importerDependencies(text: string): ImporterDependency[] {
  const { lines, entries } = parseImporters(text);
  return entries.flatMap((entry) => importerDependencyEntries(lines, entry));
}

function importerDependencyEntries(lines: readonly string[], entry: { readonly root: string; readonly start: number; readonly end: number }): ImporterDependency[] {
  const found: ImporterDependency[] = [];
  for (let index = entry.start + 1; index < entry.end; index += 1) {
    const key = lines[index]?.match(/^ {6}(?:'([^']+)'|([^:]+)):\s*$/);
    if (!key) continue;
    const details = dependencyDetails(lines, index + 1, entry.end);
    if (!details) continue;
    found.push({ root: entry.root, name: key[1] ?? key[2]!, ...details });
  }
  return found;
}

function dependencyDetails(lines: readonly string[], start: number, end: number): { specifier: string; version: string } | undefined {
  let specifier: string | undefined;
  let version: string | undefined;
  for (let cursor = start; cursor < end && cursor < start + 4; cursor += 1) {
    const line = lines[cursor] ?? "";
    if (/^ {6}\S/.test(line)) break;
    const specifierMatch = line.match(/^ {8}specifier:\s*(.+)$/);
    const versionMatch = line.match(/^ {8}version:\s*(.+)$/);
    if (specifierMatch) specifier = yamlScalar(specifierMatch[1]!);
    if (versionMatch) version = yamlScalar(versionMatch[1]!);
  }
  return specifier === undefined || version === undefined ? undefined : { specifier, version };
}

function lockfileAttests(text: string, name: string, version: string): boolean {
  const id = `${name}@${version}`;
  return (sectionKeys(text, "snapshots")?.has(id) ?? false) && (sectionKeys(text, "packages")?.has(id) ?? false);
}

function sectionKeys(text: string, section: string): Set<string> | undefined {
  const lines = text.split("\n");
  const start = lines.indexOf(`${section}:`);
  if (start < 0) return undefined;
  const keys = new Set<string>();
  for (const line of lines.slice(start + 1)) {
    if (/^[^\s]/.test(line)) break;
    const match = line.match(/^ {2}([^\s].*?):(?: .*)?$/);
    if (match) keys.add(yamlScalar(match[1]!));
  }
  return keys;
}
