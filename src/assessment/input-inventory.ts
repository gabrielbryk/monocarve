import { lstatSync, readFileSync, readdirSync, realpathSync, type Dirent } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";

import ts from "typescript";

import { createPackageManagerAdapter } from "../adapters/registry.ts";
import type { LoadedConfig } from "../config.ts";
import { MonocarveError } from "../errors.ts";
import { byCodeUnit, hashJson, type Sha256 } from "../util/hash.ts";
import { headCommit, statusEntries } from "../util/git.ts";
import { sourceFiles } from "../util/files.ts";
import type { ScanReport } from "../graph/build.ts";
import { discoverValidatedEvidenceRoots } from "./evidence-discovery.ts";
import { compareDirectories, compareEntries, directoryMembership, inside, inventoryEntry, inventoryName } from "./input-inventory-paths.ts";

export { canonicalInputPath } from "./input-inventory-paths.ts";

export class InputInventoryError extends MonocarveError {
  override readonly name = "InputInventoryError";
  constructor(readonly code: "ASSESSMENT_INPUT_DRIFT" | "ASSESSMENT_INPUT_UNBOUND", message: string, readonly paths: readonly string[]) { super(message); }
}

export type InventoryNamespace = "repository" | "installed" | "external";

export type InventoryEntry =
  | { readonly namespace: InventoryNamespace; readonly path: string; readonly kind: "file"; readonly sha256: Sha256; readonly size: number; readonly canonicalPath: string }
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

export interface CaptureInventoryOptions extends Pick<LoadedConfig, "config" | "configPath" | "rootDir"> {
  /** Validated operational paths excluded only after overlap checks. */
  readonly excludedRoots?: readonly string[];
  /** Files exposed to executable config before its config-driven roots existed. */
  readonly configSnapshotPaths?: readonly string[];
}

/** Capture a closed, content-addressed authority for scanner, graph, and symbol reads. */
export function captureInputInventory(options: CaptureInventoryOptions): AssessmentInputInventory {
  const rootDir = realpathSync(options.rootDir);
  const analyticalRoots = [
    ...options.config.applications.flatMap((application) => [
      application.sourceRoot,
      ...application.consumerRoots,
    ]).map((path) => resolve(rootDir, path)),
    ...options.config.packageRoots.map((path) => resolve(rootDir, path)),
    ...options.config.firstPartyRoots.map((path) => resolve(rootDir, path)),
    ...options.config.firstPartyPackages.map((pkg) => resolve(rootDir, pkg.root)),
  ];
  const excluded = [...new Set([
    ...(options.excludedRoots ?? []).map((path) => resolve(rootDir, path)),
    ...discoverValidatedEvidenceRoots(rootDir, analyticalRoots, inside),
  ])];
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

function collectInputPaths(options: CaptureInventoryOptions, rootDir: string, excluded: readonly string[]): { paths: Set<string>; directoryRoots: Set<string> } {
  const paths = new Set<string>();
  const directoryRoots = new Set<string>();
  const add = (path: string): void => { paths.add(resolve(path)); };
  const addTree = (path: string): void => {
    const absolute = resolve(path);
    directoryRoots.add(absolute);
    walkFiles(absolute, excluded, add, directoryRoots);
  };
  add(options.configPath);
  collectLocalConfigDependencies(options.configPath, add);
  for (const path of options.configSnapshotPaths ?? []) {
    add(path);
    if (inside(rootDir, path)) addDirectoryAncestors(path, directoryRoots, rootDir);
    else directoryRoots.add(dirname(path));
  }
  for (const app of options.config.applications) {
    for (const configuredRoot of [app.sourceRoot, ...app.consumerRoots]) {
      const sourceRoot = resolve(rootDir, configuredRoot);
      addTree(sourceRoot);
      addDirectoryAncestors(sourceRoot, directoryRoots, rootDir);
      collectAncestorManifests(rootDir, sourceRoot, add);
      collectNodeModulesAncestors(sourceRoot, directoryRoots);
    }
    collectTsconfigClosure(resolve(rootDir, app.tsconfig), add);
    collectProgramInputs(rootDir, app.tsconfig, [
      ...app.consumerRoots,
      ...options.config.firstPartyRoots,
      ...options.config.firstPartyPackages.map((pkg) => pkg.root),
    ], add);
  }
  for (const root of [...options.config.packageRoots, ...options.config.firstPartyRoots, ...options.config.firstPartyPackages.map((pkg) => pkg.root)]) {
    const absolute = resolve(rootDir, root);
    addTree(absolute);
    addDirectoryAncestors(absolute, directoryRoots, rootDir);
    collectAncestorManifests(rootDir, absolute, add);
    collectNodeModulesAncestors(absolute, directoryRoots);
  }
  directoryRoots.add(rootDir);
  collectInstalledResolutionInputs(rootDir, add, directoryRoots);
  const adapter = createPackageManagerAdapter(options.config);
  if (adapter.workspaceManifestName !== null) add(resolve(rootDir, adapter.workspaceManifestName));
  add(resolve(rootDir, adapter.lockfileName));
  add(resolve(rootDir, "package.json"));
  if (options.config.graph.cruiserConfig) add(resolve(rootDir, options.config.graph.cruiserConfig));
  return { paths, directoryRoots };
}

export function verifyInputInventory(options: CaptureInventoryOptions, expected: AssessmentInputInventory): void {
  const actual = captureInputInventory(options);
  if (actual.digest === expected.digest) return;
  const expectedStates = new Map(expected.entries.map((entry) => [`${entry.namespace}:${entry.path}`, hashJson(entry)]));
  const actualStates = new Map(actual.entries.map((entry) => [`${entry.namespace}:${entry.path}`, hashJson(entry)]));
  const changed = [...new Set([...expectedStates.keys(), ...actualStates.keys()])]
    .filter((key) => expectedStates.get(key) !== actualStates.get(key)).sort(byCodeUnit);
  const expectedDirectories = new Map(expected.directories.map((entry) => [`${entry.namespace}:${entry.path}`, hashJson(entry)]));
  const actualDirectories = new Map(actual.directories.map((entry) => [`${entry.namespace}:${entry.path}`, hashJson(entry)]));
  changed.push(...[...new Set([...expectedDirectories.keys(), ...actualDirectories.keys()])]
    .filter((key) => expectedDirectories.get(key) !== actualDirectories.get(key)).sort(byCodeUnit));
  throw new InputInventoryError("ASSESSMENT_INPUT_DRIFT", `assessment inputs changed after capture: ${changed.join(", ")}`, [...new Set(changed)]);
}

/** Refuse scanner-discovered file reads that were not part of pre-scan authority. */
export function assertReportsBoundToInventory(rootDir: string, inventory: AssessmentInputInventory, reports: Readonly<Record<string, ScanReport>>, requireObservedBytes = false): void {
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
  if (unbound.size > 0) throw new InputInventoryError("ASSESSMENT_INPUT_UNBOUND", `scanner read paths outside captured authority: ${[...unbound].sort(byCodeUnit).join(", ")}`, [...unbound].sort(byCodeUnit));
  if (driftedReads.size > 0) throw new InputInventoryError("ASSESSMENT_INPUT_DRIFT", `scanner read bytes differed from pre-scan inventory: ${[...driftedReads].sort(byCodeUnit).join(", ")}`, [...driftedReads].sort(byCodeUnit));
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
    if (membership !== undefined) return !membership.entries.some((entry) => entry.name === child);
    const next = dirname(parent);
    if (next === parent) return false;
    child = basename(parent);
    parent = next;
  }
}

function walkFiles(path: string, excluded: readonly string[], add: (path: string) => void, directories: Set<string>): void {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) { add(path); return; }
  if (stat.isSymbolicLink() || stat.isFile()) { add(path); return; }
  if (!stat.isDirectory() || excluded.some((root) => inside(root, path))) return;
  directories.add(path);
  for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => byCodeUnit(a.name, b.name))) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    walkFiles(resolve(path, entry.name), excluded, add, directories);
  }
}

function collectTsconfigClosure(path: string, add: (path: string) => void, seen = new Set<string>()): void {
  const absolute = resolve(path);
  if (seen.has(absolute)) return;
  seen.add(absolute);
  add(absolute);
  const host: ts.ParseConfigFileHost = {
    ...ts.sys,
    readFile(fileName) {
      add(fileName);
      return ts.sys.readFile(fileName);
    },
    onUnRecoverableConfigFileDiagnostic() {},
  };
  const parsed = ts.getParsedCommandLineOfConfigFile(absolute, {}, host);
  for (const reference of parsed?.projectReferences ?? []) {
    collectTsconfigClosure(reference.path.endsWith(".json") ? reference.path : resolve(reference.path, "tsconfig.json"), add, seen);
  }
}

/**
 * Capture the exact TypeScript closure used by declaration batches.  Batch
 * analysis adds configured consumers and first-party roots as program roots;
 * keeping those roots here is essential because their resolved declarations
 * and dependencies can affect diagnostics, symbol resolution, and affinities
 * without being included by the application's tsconfig.
 */
function collectProgramInputs(rootDir: string, tsconfigPath: string, additionalRoots: readonly string[], add: (path: string) => void): void {
  const configPath = resolve(rootDir, tsconfigPath);
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) return;
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(configPath), undefined, configPath);
  const additionalFiles = additionalRoots.flatMap((root) => sourceFiles(resolve(rootDir, root)));
  const rootNames = [...new Set([...parsed.fileNames, ...additionalFiles])].sort(byCodeUnit);
  const program = ts.createProgram({ rootNames, options: parsed.options, ...(parsed.projectReferences === undefined ? {} : { projectReferences: parsed.projectReferences }) });
  for (const file of program.getSourceFiles()) add(file.fileName);
}

/** Capture package metadata and declared resolver targets without hashing an entire install. */
function collectInstalledResolutionInputs(rootDir: string, add: (path: string) => void, directories: Set<string>): void {
  visitModulesDirectory(resolve(rootDir, "node_modules"), add, directories);
}

/** Resolver probes walk `node_modules` at each importer ancestor, not only at
 * the workspace root. Capture those existing directories so an absent bare
 * import is an observed, membership-bound absence. */
function collectNodeModulesAncestors(path: string, directories: Set<string>): void {
  let current = path;
  while (true) {
    const modules = resolve(current, "node_modules");
    if (lstatSync(modules, { throwIfNoEntry: false })?.isDirectory()) directories.add(modules);
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function visitModulesDirectory(modules: string, add: (path: string) => void, directories: Set<string>): void {
  const stat = lstatSync(modules, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) return;
  directories.add(modules);
  for (const entry of readdirSync(modules, { withFileTypes: true }).sort((left, right) => byCodeUnit(left.name, right.name))) {
    inspectModulesEntry(modules, entry, add, directories);
  }
}

function inspectModulesEntry(modules: string, entry: Dirent, add: (path: string) => void, directories: Set<string>): void {
  const path = resolve(modules, entry.name);
  if (entry.isDirectory() && entry.name === "node_modules") {
    visitModulesDirectory(path, add, directories);
    return;
  }
  if (!entry.isDirectory() && !entry.isSymbolicLink()) return;
  if (entry.name.startsWith("@") && entry.isDirectory()) {
    inspectInstalledScope(path, add, directories);
    return;
  }
  inspectInstalledPackage(path, add, directories);
}

function inspectInstalledScope(path: string, add: (path: string) => void, directories: Set<string>): void {
  for (const child of readdirSync(path, { withFileTypes: true }).sort((left, right) => byCodeUnit(left.name, right.name))) {
    if (child.isDirectory() || child.isSymbolicLink()) inspectInstalledPackage(resolve(path, child.name), add, directories);
  }
}

function inspectInstalledPackage(packageRoot: string, add: (path: string) => void, directories?: Set<string>): void {
  const manifest = resolve(packageRoot, "package.json");
  if (!lstatSync(manifest, { throwIfNoEntry: false })?.isFile()) return;
  add(manifest);
  let value: { types?: unknown; typings?: unknown; main?: unknown; module?: unknown; exports?: unknown };
  try { value = JSON.parse(readFileSync(manifest, "utf8")) as typeof value; } catch { return; }
  const targets = new Set<string>();
  for (const field of [value.types, value.typings, value.main, value.module]) if (typeof field === "string") targets.add(field);
  collectExportTargets(value.exports, targets);
  for (const target of targets) if (target.startsWith(".")) {
    const resolved = resolve(packageRoot, target);
    add(resolved);
    if (directories) addDirectoryAncestors(resolved, directories, packageRoot);
  }
}

function collectExportTargets(value: unknown, targets: Set<string>): void {
  if (typeof value === "string") { targets.add(value); return; }
  if (Array.isArray(value)) { for (const item of value) collectExportTargets(item, targets); return; }
  if (typeof value !== "object" || value === null) return;
  for (const item of Object.values(value)) collectExportTargets(item, targets);
}

function collectAncestorManifests(rootDir: string, path: string, add: (path: string) => void): void {
  let current = lstatSync(path, { throwIfNoEntry: false })?.isDirectory() ? path : dirname(path);
  const root = resolve(rootDir);
  while (inside(root, current)) {
    add(resolve(current, "package.json"));
    if (current === root) return;
    current = dirname(current);
  }
}

function addDirectoryAncestors(path: string, directories: Set<string>, stopAt?: string): void {
  let current = dirname(path);
  const stop = stopAt === undefined ? undefined : resolve(stopAt);
  while (true) {
    directories.add(current);
    if (stop !== undefined && current === stop) return;
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function packageRootFor(path: string): string | undefined {
  let current = dirname(path);
  while (true) {
    if (lstatSync(resolve(current, "package.json"), { throwIfNoEntry: false })?.isFile()) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function collectLocalConfigDependencies(path: string, add: (path: string) => void, seen = new Set<string>()): void {
  const absolute = resolve(path);
  if (seen.has(absolute)) return;
  seen.add(absolute); add(absolute);
  let text: string;
  try { text = readFileSync(absolute, "utf8"); } catch { return; }
  const source = ts.createSourceFile(absolute, text, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node): void => {
    const reference = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) ? node.moduleSpecifier
      : ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === "require") ? node.arguments[0]
      : undefined;
    if (reference !== undefined) {
      if (!ts.isStringLiteral(reference)) throw new InputInventoryError("ASSESSMENT_INPUT_UNBOUND", `config import cannot be inventoried: ${absolute}`, [absolute]);
      if (!reference.text.startsWith("node:")) {
        let target: string;
        try { target = Bun.resolveSync(reference.text, dirname(absolute)); }
        catch { throw new InputInventoryError("ASSESSMENT_INPUT_UNBOUND", `config import cannot be resolved: ${reference.text}`, [reference.text]); }
        collectLocalConfigDependencies(target, add, seen);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

function nearestInstalledManifest(rootDir: string, path: string): string | undefined {
  const boundary = resolve(rootDir, "node_modules");
  let current = dirname(path);
  while (true) {
    const manifest = resolve(current, "package.json");
    if (lstatSync(manifest, { throwIfNoEntry: false })?.isFile()) return manifest;
    const parent = dirname(current);
    if (parent === current || (!inside(boundary, current) && inside(rootDir, current))) break;
    current = parent;
  }
  return undefined;
}
