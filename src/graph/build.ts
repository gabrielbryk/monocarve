/**
 * Turning a scanner report into the dependency model.
 *
 * Two decisions here shape everything downstream:
 *
 *  - **Tests are not nodes.** They are recorded as *importers* of nodes. A test
 *    is not part of the production graph — it must not create edges that make a
 *    closure look larger than it is — but it does travel with the code it
 *    covers, so the plan needs to know which tests point where.
 *  - **The resolver's failures are kept, not discarded.** An import of
 *    `@acme/db/schema` that the resolver cannot follow to a file is still a
 *    workspace edge, and an unresolvable relative import is still a fact about
 *    the file. Dropping either would make an unplannable closure look clean.
 */

import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import {
  applicationFor,
  domainFor,
  firstPartyRoots,
  isTestPath,
  testKindOf,
  isAssetPath,
  ownerFor,
  packageNameOf,
  type MonocarveConfig,
} from "../config.ts";
import { isDeclarationPath, isSourceModulePath, lineCount } from "../util/files.ts";
import { byCodeUnit } from "../util/hash.ts";
import { normalizePath } from "../util/paths.ts";
import { inventoryModuleReferences } from "../codemod/imports.ts";
import { fileFacts } from "./syntax.ts";
import type {
  DependencyGraph,
  ModuleEdge,
  ModuleNode,
  UnresolvedReference,
  WorkspaceEdge,
} from "./model.ts";
import { workspaceInventory, workspaceSubpathResolves, type WorkspaceInventory } from "./workspace.ts";

/** One module as a scanner reports it. The only scanner-shaped type we accept. */
export interface ScannedModule {
  readonly source: string;
  readonly dependencies: readonly ScannedDependency[];
}

export interface ScannedDependency {
  readonly module: string;
  readonly resolved?: string;
  readonly dynamic?: boolean;
  readonly couldNotResolve?: boolean;
}

export interface ScanReport {
  readonly modules: readonly ScannedModule[];
  /** Optional adapter observation of resolver/config reads not represented as modules. */
  readonly observedReads?: readonly string[];
  /** Actual values returned to dependency-cruiser by successful file reads. */
  readonly observedFileReads?: readonly { readonly path: string; readonly sha256: string }[];
}

export interface BuildGraphOptions {
  readonly config: MonocarveConfig;
  readonly rootDir: string;
  /** One report per application, keyed by application name. */
  readonly reports: Readonly<Record<string, ScanReport>>;
  readonly commit?: string;
}

function isFirstParty(roots: readonly string[], path: string): boolean {
  return roots.some((root) => path.startsWith(root));
}

function isProductionSource(config: MonocarveConfig, path: string): boolean {
  return isSourceModulePath(path, config.sourceExtensions) && !isTestPath(config, path);
}

/**
 * Whether an unresolved specifier is worth reporting. A bare specifier for a
 * package that is simply not installed is noise; a relative specifier that
 * resolves to nothing, or a workspace subpath the owning package does not
 * export, is a real defect the plan must not paper over.
 */
function unresolvableSpecifier(
  rootDir: string,
  specifier: string,
  workspace: WorkspaceInventory,
): boolean {
  if (specifier.startsWith(".")) return true;
  const owner = workspace.packageNames.get(packageNameOf(specifier));
  if (owner === undefined) return false;
  return !workspaceSubpathResolves(rootDir, owner, specifier);
}

export function buildDependencyGraph(options: BuildGraphOptions): DependencyGraph {
  const { config, rootDir } = options;
  const roots = firstPartyRoots(config);
  const workspace = workspaceInventory(config, rootDir);

  const production = new Map<string, ScannedModule>();
  const everyFirstParty = new Map<string, ScannedModule>();
  for (const report of Object.values(options.reports)) {
    for (const module of report.modules) {
      const source = normalizePath(module.source);
      if (!isFirstParty(roots, source)) continue;
      const normalized: ScannedModule = { ...module, source };
      everyFirstParty.set(source, normalized);
      if (isProductionSource(config, source)) production.set(source, normalized);
    }
  }

  const paths = [...production.keys()].sort();
  const nodeSet = new Set(paths);

  const edges: ModuleEdge[] = [];
  const unresolved: UnresolvedReference[] = [];
  const specifiers = new Map<string, readonly string[]>();
  const externalPackages = new Map<string, number>();
  const externalBySource = new Map<string, Set<string>>();
  const workspaceDependenciesBySource = new Map<string, Set<string>>();
  const unresolvedWorkspaceEdges: WorkspaceEdge[] = [];
  const nodes = new Map<string, ModuleNode>();

  for (const path of paths) {
    const module = production.get(path)!;
    const absolute = resolve(rootDir, path);
    const facts = fileFacts(absolute, path);
    const app = applicationFor(config, path);

    nodes.set(path, {
      path,
      zone: app ? "application" : "package",
      ...(app ? { application: app.name } : {}),
      owner: ownerFor(config, path),
      domain: domainFor(config, path),
      isTest: false,
      isAsset: isAssetPath(config, path),
      isDeclaration: isDeclarationPath(path),
      lineCount: lineCount(absolute),
      hasExports: facts.hasExports,
    });

    specifiers.set(path, [...new Set(module.dependencies.map((dependency) => dependency.module))]);

    for (const dependency of module.dependencies) {
      const resolvedPath = dependency.resolved ? normalizePath(dependency.resolved) : undefined;
      if (dependency.couldNotResolve && unresolvableSpecifier(rootDir, dependency.module, workspace)) {
        unresolved.push({ source: path, specifier: dependency.module });
      }
      if (resolvedPath && nodeSet.has(resolvedPath)) {
        const kind = facts.kinds.get(dependency.module);
        const dynamic = dependency.dynamic === true || kind?.dynamic === true;
        const typeOnly = kind?.typeOnly === true;
        edges.push({
          from: path,
          to: resolvedPath,
          kind: edgeKind(config, resolvedPath, dynamic, typeOnly),
          specifier: dependency.module,
          typeOnly,
          dynamic,
        });
        continue;
      }
      if (dependency.module.startsWith(".") || (resolvedPath && isFirstParty(roots, resolvedPath))) continue;
      recordExternal(path, dependency.module, workspace, {
        externalPackages,
        externalBySource,
        workspaceDependenciesBySource,
        unresolvedWorkspaceEdges,
      });
    }
  }

  const testImporters = collectTestImporters(config, rootDir, everyFirstParty, nodeSet);
  const testKinds = new Map<string, "unit" | "integration" | "e2e">();
  for (const path of [...everyFirstParty.keys()].sort(byCodeUnit)) {
    const kind = testKindOf(config, path);
    if (kind) testKinds.set(path, kind);
  }
  return {
    rootDir,
    ...(options.commit === undefined ? {} : { commit: options.commit }),
    nodes,
    paths,
    edges,
    outgoing: adjacency(edges, (edge) => [edge.from, edge.to]),
    incoming: adjacency(edges, (edge) => [edge.to, edge.from]),
    // By code unit, not by locale: `graphDigest` hashes this array *in order*
    // into `manifest.graphDigest`, so a collated order would make the plan's
    // bytes depend on the machine's ICU data. See `byCodeUnit`.
    unresolved: unresolved.sort(
      (left, right) => byCodeUnit(left.source, right.source) || byCodeUnit(left.specifier, right.specifier),
    ),
    specifiers,
    externalPackages,
    externalBySource,
    workspaceDependenciesBySource,
    unresolvedWorkspaceEdges,
    testImporters,
    testKinds,
    workspace,
  };
}

function edgeKind(config: MonocarveConfig, target: string, dynamic: boolean, typeOnly: boolean): ModuleEdge["kind"] {
  if (isAssetPath(config, target)) return "asset";
  if (dynamic) return "dynamic";
  if (typeOnly) return "type-only";
  return "static";
}

function adjacency(
  edges: readonly ModuleEdge[],
  pick: (edge: ModuleEdge) => [string, string],
): Map<string, readonly string[]> {
  const map = new Map<string, Set<string>>();
  for (const edge of edges) {
    const [key, value] = pick(edge);
    const bucket = map.get(key) ?? new Set<string>();
    bucket.add(value);
    map.set(key, bucket);
  }
  return new Map([...map].map(([key, values]) => [key, [...values].sort()]));
}

interface ExternalInventory {
  readonly externalPackages: Map<string, number>;
  readonly externalBySource: Map<string, Set<string>>;
  readonly workspaceDependenciesBySource: Map<string, Set<string>>;
  readonly unresolvedWorkspaceEdges: WorkspaceEdge[];
}

function recordExternal(
  source: string,
  specifier: string,
  workspace: WorkspaceInventory,
  inventory: ExternalInventory,
): void {
  const name = packageNameOf(specifier);
  const workspaceOwner = workspace.packageNames.get(name);
  const target = workspaceOwner ? inventory.workspaceDependenciesBySource : inventory.externalBySource;
  const values = target.get(source) ?? new Set<string>();
  values.add(workspaceOwner ?? name);
  target.set(source, values);
  if (workspaceOwner) {
    inventory.unresolvedWorkspaceEdges.push({ from: source, toOwner: workspaceOwner, specifier });
  } else {
    inventory.externalPackages.set(name, (inventory.externalPackages.get(name) ?? 0) + 1);
  }
}

function collectTestImporters(
  config: MonocarveConfig,
  rootDir: string,
  modules: ReadonlyMap<string, ScannedModule>,
  nodes: ReadonlySet<string>,
): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const module of modules.values()) {
    if (isProductionSource(config, module.source) || !isTestPath(config, module.source)) continue;
    for (const dependency of module.dependencies) {
      const resolvedPath = dependency.resolved ? normalizePath(dependency.resolved) : undefined;
      if (!resolvedPath || !nodes.has(resolvedPath)) continue;
      const importers = result.get(resolvedPath) ?? new Set<string>();
      importers.add(module.source);
      result.set(resolvedPath, importers);
    }
    // dependency-cruiser does not model workspace-configured module-specifier
    // calls such as `vi.mock("./module")`. They are still module references:
    // deleting or moving the target without rewriting the mock leaves a test
    // pointing at a path that no longer exists. Union the AST inventory into
    // the cruiser report so every downstream importer proof sees both forms.
    const importerPath = resolve(rootDir, module.source);
    if (!existsSync(importerPath)) continue;
    const source = readFileSync(importerPath, "utf8");
    for (const reference of inventoryModuleReferences(
      source,
      importerPath,
      true,
      rootDir,
      config.moduleSpecifierCalls,
      config.assetExtensions,
      config.cssImportExtensions,
    )) {
      if (reference.resolved === null) continue;
      const resolvedPath = normalizePath(relative(rootDir, reference.resolved));
      if (!nodes.has(resolvedPath)) continue;
      const importers = result.get(resolvedPath) ?? new Set<string>();
      importers.add(module.source);
      result.set(resolvedPath, importers);
    }
  }
  return result;
}
