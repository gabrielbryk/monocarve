/** Repository-wide structured postconditions after a planned extraction lands. */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { PackageManagerAdapter } from "../adapters/types.ts";
import { verifyPackageImporters, type ProjectedImporterVerification } from "./projected-importers.ts";

export interface RepositoryPostconditionReport {
  readonly passed: boolean;
  readonly checkedPackages: readonly string[];
  readonly importerVerification: ProjectedImporterVerification;
  readonly failures: readonly string[];
}

export async function repositoryPostconditionPaths(rootDir: string, adapter: PackageManagerAdapter): Promise<string[]> {
  const packages = await adapter.listPackages(rootDir);
  return ["package.json", adapter.lockfileName, ...packages.map(({ dir }) => `${dir}/package.json`)].sort();
}

export async function auditRepositoryPostconditions(input: {
  readonly rootDir: string;
  readonly adapter: PackageManagerAdapter;
  /**
   * Importers changed by the manifest. A transaction must prove its own
   * dependency writes, not reject an otherwise valid extraction because an
   * unrelated pre-existing importer cannot be projected from the lockfile.
   */
  readonly packageRoots?: readonly string[];
}): Promise<RepositoryPostconditionReport> {
  const discovered = await input.adapter.listPackages(input.rootDir);
  const rootManifestPath = resolve(input.rootDir, "package.json");
  const packages = existsSync(rootManifestPath) ? [{ name: rootPackageName(rootManifestPath), dir: "." }, ...discovered] : discovered;
  const packageOwners = new Map<string, string>();
  const duplicateNames: string[] = [];
  for (const pkg of packages) {
    const previous = packageOwners.get(pkg.name);
    if (previous !== undefined && previous !== pkg.dir)
      duplicateNames.push(`workspace package name ${pkg.name} is declared by both ${previous} and ${pkg.dir}`);
    packageOwners.set(pkg.name, pkg.dir);
  }
  const roots = input.packageRoots === undefined ? packages.map(({ dir }) => dir).sort() : [...new Set(input.packageRoots)].sort();
  const checkedPackages = packages.filter(({ dir }) => roots.includes(dir));
  const names = new Set(packages.map(({ name }) => name));
  const failures: string[] = [...duplicateNames];
  for (const pkg of checkedPackages) {
    const manifest = JSON.parse(readFileSync(resolve(input.rootDir, pkg.dir, "package.json"), "utf8")) as Record<string, unknown>;
    const sections = (["dependencies", "devDependencies", "optionalDependencies"] as const).map(
      (section) => [section, stringRecord(manifest[section])] as const,
    );
    const owners = new Map<string, string[]>();
    for (const [section, entries] of sections)
      for (const [name, version] of Object.entries(entries)) {
        const declared = owners.get(name) ?? [];
        declared.push(section);
        owners.set(name, declared);
        if (version.startsWith("workspace:") && !names.has(name)) failures.push(`${pkg.dir}/package.json: unresolved workspace dependency ${name}`);
      }
    for (const [name, declared] of owners)
      if (declared.length > 1) {
        failures.push(`${pkg.dir}/package.json: ${name} appears in conflicting sections ${declared.join(", ")}`);
      }
  }
  const importerVerification = await verifyPackageImporters(input.rootDir, input.adapter, roots);
  failures.push(...importerVerification.differences.map(({ packageRoot, message }) => `${packageRoot}: ${message}`));
  return { passed: failures.length === 0, checkedPackages: roots, importerVerification, failures: [...new Set(failures)].sort() };
}

function rootPackageName(path: string): string {
  const manifest = JSON.parse(readFileSync(path, "utf8")) as { readonly name?: unknown };
  return typeof manifest.name === "string" && manifest.name !== "" ? manifest.name : "<workspace-root>";
}

function stringRecord(value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}
