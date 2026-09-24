import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";

import type { ScanReport } from "../graph/build.ts";
import { headCommit, statusEntries } from "../util/git.ts";
import { byCodeUnit, hashJson, type Sha256 } from "../util/hash.ts";
import { discoverValidatedEvidenceRoots } from "./evidence-discovery.ts";
import { addDirectoryAncestors, collectInputPaths, nearestInstalledManifest, packageRootFor } from "./input-inventory-collect.ts";
import { compareDirectories, compareEntries, directoryMembership, inside, inventoryEntry, inventoryName } from "./input-inventory-paths.ts";
import { InputInventoryError, type CaptureInventoryOptions } from "./input-inventory-types.ts";

export { canonicalInputPath } from "./input-inventory-paths.ts";
export { collectLocalConfigDependencies } from "./input-inventory-collect.ts";
export { InputInventoryError, type CaptureInventoryOptions } from "./input-inventory-types.ts";

export type InventoryNamespace = "repository" | "installed" | "external";

export type InventoryEntry =
  | {
      readonly namespace: InventoryNamespace;
      readonly path: string;
      readonly kind: "file";
      readonly sha256: Sha256;
      readonly size: number;
      readonly canonicalPath: string;
    }
  | { readonly namespace: InventoryNamespace; readonly path: string; readonly kind: "symlink"; readonly target: string; readonly canonicalPath: string }
  | { readonly namespace: InventoryNamespace; readonly path: string; readonly kind: "missing" };

export interface DirectoryMembership {
  readonly namespace: InventoryNamespace;
  readonly path: string;
  readonly entries: readonly { readonly name: string; readonly kind: "file" | "directory" | "symlink" }[];
}

export interface AssessmentInputInventory {
  readonly schemaVersion: 1;
  readonly sourceCommit: string;
  readonly dirtyPaths: readonly string[];
  readonly configDigest: Sha256;
  readonly entries: readonly InventoryEntry[];
  readonly directories: readonly DirectoryMembership[];
  readonly digest: Sha256;
}

/** Recompute the digest over the inventory body, excluding its self-record. */
export function inventoryBodyDigest(inventory: AssessmentInputInventory): Sha256 {
  const { digest: _digest, ...body } = inventory;
  return hashJson(body);
}

/** Capture a closed, content-addressed authority for scanner, graph, and symbol reads. */
export function captureInputInventory(options: CaptureInventoryOptions): AssessmentInputInventory {
  const rootDir = realpathSync(options.rootDir);
  const analyticalRoots = [
    ...options.config.applications.flatMap((application) => [application.sourceRoot, ...application.consumerRoots]).map((path) => resolve(rootDir, path)),
    ...options.config.packageRoots.map((path) => resolve(rootDir, path)),
    ...options.config.firstPartyRoots.map((path) => resolve(rootDir, path)),
    ...options.config.firstPartyPackages.map((pkg) => resolve(rootDir, pkg.root)),
  ];
  const excluded = [
    ...new Set([...(options.excludedRoots ?? []).map((path) => resolve(rootDir, path)), ...discoverValidatedEvidenceRoots(rootDir, analyticalRoots, inside)]),
  ];
  const { paths, directoryRoots } = collectInputPaths(options, rootDir, excluded);

  for (const path of [...paths]) {
    const entry = inventoryEntry(rootDir, path);
    if (entry.kind === "symlink" && entry.canonicalPath.startsWith("external:")) {
      const target = realpathSync(path);
      paths.add(target);
      const packageRoot = packageRootFor(target);
      if (packageRoot === undefined) directoryRoots.add(dirname(target));
      else {
        paths.add(resolve(packageRoot, "package.json"));
        addDirectoryAncestors(target, directoryRoots, packageRoot);
      }
    }
    if (entry.kind === "file" && (entry.namespace === "installed" || entry.namespace === "external")) {
      const manifest = nearestInstalledManifest(rootDir, path);
      if (manifest) paths.add(manifest);
    }
  }
  const completeEntries = [...paths].map((path) => inventoryEntry(rootDir, path)).sort(compareEntries);
  const directories = [...directoryRoots].map((path) => directoryMembership(rootDir, path, excluded)).sort(compareDirectories);
  const sourceCommit = headCommit(rootDir);
  // Dirty state is input-scoped authority, not a record of every unrelated
  // workspace artifact. In particular, a prior assessment output directory
  // must not poison a later replay's digest. Additions/deletions of analytical
  // files remain covered by the directory-membership records above.
  const inputKeys = new Set(completeEntries.map((entry) => `${entry.namespace}:${entry.path}`));
  const dirtyPaths = [...new Set(statusEntries(rootDir).flatMap((entry) => entry.paths))]
    .filter((path) => !excluded.some((root) => inside(root, resolve(rootDir, path))))
    .filter((path) => {
      const named = inventoryName(rootDir, resolve(rootDir, path));
      return inputKeys.has(`${named.namespace}:${named.path}`);
    })
    .sort(byCodeUnit);
  const body = { schemaVersion: 1 as const, sourceCommit, dirtyPaths, configDigest: hashJson(options.config), entries: completeEntries, directories };
  return { ...body, digest: hashJson(body) };
}

export function verifyInputInventory(options: CaptureInventoryOptions, expected: AssessmentInputInventory): void {
  const actual = captureInputInventory(options);
  if (actual.digest === expected.digest) return;
  const expectedStates = new Map(expected.entries.map((entry) => [`${entry.namespace}:${entry.path}`, hashJson(entry)]));
  const actualStates = new Map(actual.entries.map((entry) => [`${entry.namespace}:${entry.path}`, hashJson(entry)]));
  const changed = [...new Set([...expectedStates.keys(), ...actualStates.keys()])]
    .filter((key) => expectedStates.get(key) !== actualStates.get(key))
    .sort(byCodeUnit);
  const expectedDirectories = new Map(expected.directories.map((entry) => [`${entry.namespace}:${entry.path}`, hashJson(entry)]));
  const actualDirectories = new Map(actual.directories.map((entry) => [`${entry.namespace}:${entry.path}`, hashJson(entry)]));
  changed.push(
    ...[...new Set([...expectedDirectories.keys(), ...actualDirectories.keys()])]
      .filter((key) => expectedDirectories.get(key) !== actualDirectories.get(key))
      .sort(byCodeUnit),
  );
  throw new InputInventoryError("ASSESSMENT_INPUT_DRIFT", `assessment inputs changed after capture: ${changed.join(", ")}`, [...new Set(changed)]);
}

/** Refuse scanner-discovered file reads that were not part of pre-scan authority. */
export function assertReportsBoundToInventory(
  rootDir: string,
  inventory: AssessmentInputInventory,
  reports: Readonly<Record<string, ScanReport>>,
  requireObservedBytes = false,
): void {
  const authority = new Map<string, InventoryEntry>(inventory.entries.map((entry) => [`${entry.namespace}:${entry.path}`, entry]));
  const memberships = new Map<string, DirectoryMembership>(inventory.directories.map((entry) => [`${entry.namespace}:${entry.path}`, entry]));
  const unbound = new Set<string>();
  const driftedReads = new Set<string>();
  for (const report of Object.values(reports)) {
    for (const observed of report.observedReads ?? []) checkInventoryPath(rootDir, observed, true, authority, memberships, unbound);
    for (const observed of report.observedFileReads ?? []) checkObservedFileRead(rootDir, observed, authority, unbound, driftedReads);
    if (requireObservedBytes) {
      const proven = new Set((report.observedFileReads ?? []).map((read) => inventoryKeyForPath(rootDir, read.path)));
      for (const module of report.modules) {
        const key = inventoryKeyForPath(rootDir, module.source);
        if (!proven.has(key)) unbound.add(key);
      }
    }
    for (const module of report.modules) {
      checkInventoryPath(rootDir, module.source, false, authority, memberships, unbound);
      // A resolver's missing target is an observed absence, not an unbound
      // read, when the captured parent membership proves that it was absent.
      for (const dependency of module.dependencies) {
        if (dependency.resolved) checkInventoryPath(rootDir, dependency.resolved, true, authority, memberships, unbound);
      }
    }
  }
  if (unbound.size > 0)
    throw new InputInventoryError(
      "ASSESSMENT_INPUT_UNBOUND",
      `scanner read paths outside captured authority: ${[...unbound].sort(byCodeUnit).join(", ")}`,
      [...unbound].sort(byCodeUnit),
    );
  if (driftedReads.size > 0)
    throw new InputInventoryError(
      "ASSESSMENT_INPUT_DRIFT",
      `scanner read bytes differed from pre-scan inventory: ${[...driftedReads].sort(byCodeUnit).join(", ")}`,
      [...driftedReads].sort(byCodeUnit),
    );
}

function inventoryKeyForPath(rootDir: string, path: string): string {
  if (/^(?:repository|installed|external):/u.test(path)) return path;
  const named = inventoryName(realpathSync(rootDir), isAbsolute(path) ? path : resolve(rootDir, path));
  return `${named.namespace}:${named.path}`;
}

function checkObservedFileRead(
  rootDir: string,
  observed: { readonly path: string; readonly sha256: string },
  authority: ReadonlyMap<string, InventoryEntry>,
  unbound: Set<string>,
  driftedReads: Set<string>,
): void {
  const key = inventoryKeyForPath(rootDir, observed.path);
  const entry = authority.get(key);
  const file = entry?.kind === "symlink" ? authority.get(entry.canonicalPath) : entry;
  if (file === undefined || file.kind !== "file") unbound.add(key);
  else if (file.sha256 !== observed.sha256) driftedReads.add(key);
}

function checkInventoryPath(
  rootDir: string,
  path: string,
  allowMissing: boolean,
  authority: ReadonlyMap<string, InventoryEntry>,
  memberships: ReadonlyMap<string, DirectoryMembership>,
  unbound: Set<string>,
): void {
  if (/^(?:repository|installed|external):/u.test(path)) {
    const entry = authority.get(path);
    if (entry === undefined || (entry.kind === "missing" && !allowMissing)) unbound.add(path);
    return;
  }
  const root = realpathSync(rootDir);
  const absolute = isAbsolute(path) ? path : resolve(rootDir, path);
  const named = inventoryName(root, absolute);
  const key = `${named.namespace}:${named.path}`;
  const entry = authority.get(key);
  if (entry === undefined && !(allowMissing && absenceIsBound(rootDir, absolute, memberships))) unbound.add(key);
  if (entry?.kind === "missing" && !allowMissing) unbound.add(key);
  if (named.namespace !== "installed") return;
  const manifest = nearestInstalledManifest(root, absolute);
  if (manifest === undefined) return;
  const manifestName = inventoryName(root, manifest);
  const manifestKey = `${manifestName.namespace}:${manifestName.path}`;
  if (!authority.has(manifestKey)) unbound.add(manifestKey);
}

/**
 * A resolver is allowed to probe a path that was absent at capture time when
 * the captured membership of its nearest existing parent proves that absence.
 * This is stronger than accepting arbitrary missing paths: a newly-created
 * file changes the parent membership and is rejected by verifyInputInventory.
 */
function absenceIsBound(rootDir: string, path: string, memberships: ReadonlyMap<string, DirectoryMembership>): boolean {
  const root = realpathSync(rootDir);
  const exact = inventoryName(root, path);
  if (memberships.has(`${exact.namespace}:${exact.path}`)) return true;
  let child = basename(path);
  let parent = dirname(path);
  while (true) {
    const named = inventoryName(root, parent);
    const membership = memberships.get(`${named.namespace}:${named.path}`);
    if (membership !== undefined) return !hasNamedEntry(membership.entries, child);
    const next = dirname(parent);
    if (next === parent) return false;
    child = basename(parent);
    parent = next;
  }
}

function hasNamedEntry(entries: DirectoryMembership["entries"], name: string): boolean {
  return entries.some((entry) => entry.name === name);
}
