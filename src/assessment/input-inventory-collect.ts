import { lstatSync, readFileSync, readdirSync, type Dirent } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, resolve } from "node:path";

import ts from "typescript";

import { createPackageManagerAdapter } from "../adapters/registry.ts";
import { sourceFiles } from "../util/files.ts";
import { byCodeUnit } from "../util/hash.ts";
import { inside } from "./input-inventory-paths.ts";
import { InputInventoryError, type CaptureInventoryOptions } from "./input-inventory-types.ts";

/** Gather every path and directory root that participates in captured input authority. */
export function collectInputPaths(
  options: CaptureInventoryOptions,
  rootDir: string,
  excluded: readonly string[],
): { paths: Set<string>; directoryRoots: Set<string> } {
  const paths = new Set<string>();
  const directoryRoots = new Set<string>();
  const add = (path: string): void => {
    paths.add(resolve(path));
  };
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
    collectProgramInputs(
      rootDir,
      app.tsconfig,
      [...app.consumerRoots, ...options.config.firstPartyRoots, ...options.config.firstPartyPackages.map((pkg) => pkg.root)],
      add,
    );
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

function walkFiles(path: string, excluded: readonly string[], add: (path: string) => void, directories: Set<string>): void {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) {
    add(path);
    return;
  }
  if (stat.isSymbolicLink() || stat.isFile()) {
    add(path);
    return;
  }
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
  const readFile = (path: string): string | undefined => ts.sys.readFile(path);
  const read = ts.readConfigFile(configPath, readFile);
  if (read.error) return;
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(configPath), undefined, configPath);
  const additionalFiles = additionalRoots.flatMap((root) => sourceFiles(resolve(rootDir, root)));
  const rootNames = [...new Set([...parsed.fileNames, ...additionalFiles])].toSorted(byCodeUnit);
  const program = ts.createProgram({
    rootNames,
    options: parsed.options,
    ...(parsed.projectReferences === undefined ? {} : { projectReferences: parsed.projectReferences }),
  });
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
  try {
    value = JSON.parse(readFileSync(manifest, "utf8")) as typeof value;
  } catch {
    return;
  }
  const targets = new Set<string>();
  for (const field of [value.types, value.typings, value.main, value.module]) if (typeof field === "string") targets.add(field);
  collectExportTargets(value.exports, targets);
  for (const target of targets)
    if (target.startsWith(".")) {
      const resolved = resolve(packageRoot, target);
      add(resolved);
      if (directories) addDirectoryAncestors(resolved, directories, packageRoot);
    }
}

function collectExportTargets(value: unknown, targets: Set<string>): void {
  if (typeof value === "string") {
    targets.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectExportTargets(item, targets);
    return;
  }
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

export function addDirectoryAncestors(path: string, directories: Set<string>, stopAt?: string): void {
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

export function packageRootFor(path: string): string | undefined {
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
  seen.add(absolute);
  add(absolute);
  let text: string;
  try {
    text = readFileSync(absolute, "utf8");
  } catch {
    return;
  }
  const source = ts.createSourceFile(absolute, text, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node): void => {
    visitConfigDependencyNode(node, source, absolute, add, seen);
    ts.forEachChild(node, visit);
  };
  visit(source);
}

function visitConfigDependencyNode(node: ts.Node, source: ts.SourceFile, absolute: string, add: (path: string) => void, seen: Set<string>): void {
  const reference = moduleReferenceOf(node, source);
  if (reference === undefined) return;
  if (!ts.isStringLiteral(reference)) throw new InputInventoryError("ASSESSMENT_INPUT_UNBOUND", `config import cannot be inventoried: ${absolute}`, [absolute]);
  // `fs` and `node:fs` are the same builtin; neither is a file to capture.
  if (reference.text.startsWith("node:") || reference.text.startsWith("bun:") || isBuiltin(reference.text)) return;
  const target = resolveConfigImport(reference.text, absolute);
  collectLocalConfigDependencies(target, add, seen);
}

function moduleReferenceOf(node: ts.Node, source: ts.SourceFile): ts.Expression | undefined {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return node.moduleSpecifier;
  if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === "require"))
    return node.arguments[0];
  return undefined;
}

function resolveConfigImport(specifier: string, absolute: string): string {
  try {
    return Bun.resolveSync(specifier, dirname(absolute));
  } catch {
    throw new InputInventoryError("ASSESSMENT_INPUT_UNBOUND", `config import cannot be resolved: ${specifier}`, [specifier]);
  }
}

export function nearestInstalledManifest(rootDir: string, path: string): string | undefined {
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
