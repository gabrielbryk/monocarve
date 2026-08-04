/**
 * The dependency model every later stage reads.
 *
 * It is deliberately smaller than dependency-cruiser's output: the scanner
 * narrows to this shape so a different scanner (ts-morph, a language server, a
 * bundler's module graph) can be dropped in without touching the portfolio,
 * plan, or transaction stages.
 *
 * Paths are always workspace-relative and POSIX-separated.
 */

import type { WorkspaceInventory } from "./workspace.ts";

/** How one module reaches another. Drives containment and rewrite decisions. */
export type EdgeKind =
  /** `import x from "./y"` — resolved, value-level. */
  | "static"
  /** `import type { X } from "./y"` / `import { type X }` — erased at runtime. */
  | "type-only"
  /** `await import("./y")` — survives extraction only if the specifier can be rewritten. */
  | "dynamic"
  /** `require("./y")` in CJS interop code. */
  | "require"
  /** `export * from "./y"` — a re-export, which makes barrels a self-import hazard. */
  | "re-export"
  /** A non-TS file pulled in by relative import (`./styles.css`). */
  | "asset";

/** Where a module lives, which decides whether it can move at all. */
export type ModuleZone =
  /** Inside a configured application `sourceRoot`. */
  | "application"
  /** Inside a configured `packageRoots` entry — already a workspace package. */
  | "package"
  /** In the workspace but outside both (scripts, config, generated). */
  | "repo"
  /** Resolved into `node_modules` or unresolvable. */
  | "external";

export interface ModuleNode {
  /** Workspace-relative POSIX path, or the bare specifier for `external` modules. */
  readonly path: string;
  readonly zone: ModuleZone;
  /** Owning application name, when `zone === "application"`. */
  readonly application?: string;
  /** Owning directory: the application root or the package directory. */
  readonly owner: string;
  /** Runtime domain, from `portfolio.domains` or derived from the path. */
  readonly domain: string;
  /** Matched by the configured test classification policy. */
  readonly isTest: boolean;
  /** Extension is in the configured `assetExtensions`. */
  readonly isAsset: boolean;
  /** Declaration-only module (`.d.ts`). Closures made only of these are rejected. */
  readonly isDeclaration: boolean;
  /** Physical line count, used for candidate sizing and reporting. */
  readonly lineCount: number;
  /** Whether the file exports anything; an empty surface cannot be extracted. */
  readonly hasExports: boolean;
}

export interface ModuleEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: EdgeKind;
  /** The specifier exactly as written, needed to rewrite it byte-precisely. */
  readonly specifier: string;
  /**
   * Kept alongside `kind` because an edge can be several things at once: a
   * specifier imported both as `import type` and as `await import()` is
   * type-only in one place and dynamic in another, and eligibility asks both
   * questions independently.
   */
  readonly typeOnly: boolean;
  readonly dynamic: boolean;
}

/** An edge to a workspace package the resolver could not follow to a file. */
export interface WorkspaceEdge {
  readonly from: string;
  /** Directory of the package the specifier names. */
  readonly toOwner: string;
  readonly specifier: string;
}

export interface UnresolvedReference {
  readonly source: string;
  readonly specifier: string;
}

export interface DependencyGraph {
  /** Absolute workspace root the scan was taken against. */
  readonly rootDir: string;
  /** Commit the scan describes. */
  readonly commit?: string;
  readonly nodes: ReadonlyMap<string, ModuleNode>;
  /** Sorted node paths — the iteration order everything hashed depends on. */
  readonly paths: readonly string[];
  readonly edges: readonly ModuleEdge[];
  /** Adjacency, precomputed: `from` -> unique `to`, sorted. */
  readonly outgoing: ReadonlyMap<string, readonly string[]>;
  /** Reverse adjacency: `to` -> unique `from`, sorted. Consumer discovery reads this. */
  readonly incoming: ReadonlyMap<string, readonly string[]>;
  /** Relative specifiers the scanner saw but could not resolve. */
  readonly unresolved: readonly UnresolvedReference[];
  /** Every raw specifier per module, including ones that leave the workspace. */
  readonly specifiers: ReadonlyMap<string, readonly string[]>;
  /** External package name -> number of importing modules. */
  readonly externalPackages: ReadonlyMap<string, number>;
  /** Module -> external package names it imports. */
  readonly externalBySource: ReadonlyMap<string, ReadonlySet<string>>;
  /** Module -> workspace package directories it imports by package name. */
  readonly workspaceDependenciesBySource: ReadonlyMap<string, ReadonlySet<string>>;
  /** Package-name edges the resolver could not follow to a file. */
  readonly unresolvedWorkspaceEdges: readonly WorkspaceEdge[];
  /** Production module -> test files importing it. Tests are not graph nodes. */
  readonly testImporters: ReadonlyMap<string, ReadonlySet<string>>;
  /** Test path -> configured intent; tests stay outside production nodes. */
  readonly testKinds: ReadonlyMap<string, "unit" | "integration" | "e2e">;
  readonly workspace: WorkspaceInventory;
}

/** A strongly connected component: the atomic unit of movement. */
export interface Scc {
  /** Stable id derived from the sorted member list, e.g. `scc-3f9a1c`. */
  readonly id: string;
  /** Sorted member paths. Singletons are components too. */
  readonly members: readonly string[];
}

/** Summary emitted by the CLI scan command. */
export interface GraphSummary {
  readonly moduleCount: number;
  readonly edgeCount: number;
  readonly unresolvedCount: number;
  readonly dynamicImportCount: number;
  readonly byZone: Readonly<Record<ModuleZone, number>>;
}

export function summarizeGraph(graph: DependencyGraph): GraphSummary {
  const byZone: Record<ModuleZone, number> = { application: 0, package: 0, repo: 0, external: 0 };
  for (const node of graph.nodes.values()) byZone[node.zone] += 1;

  return {
    moduleCount: graph.nodes.size,
    edgeCount: graph.edges.length,
    unresolvedCount: graph.unresolved.length,
    dynamicImportCount: graph.edges.filter((edge) => edge.dynamic).length,
    byZone,
  };
}

/** Nodes owned by one application, or by every application when unfiltered. */
export function applicationNodes(graph: DependencyGraph, application?: string): string[] {
  return graph.paths.filter((path) => {
    const node = graph.nodes.get(path);
    if (!node || node.zone !== "application") return false;
    return application === undefined || node.application === application;
  });
}

/** Line count of a set of paths, for candidate sizing. */
export function totalLines(graph: DependencyGraph, paths: Iterable<string>): number {
  let total = 0;
  for (const path of paths) total += graph.nodes.get(path)?.lineCount ?? 0;
  return total;
}
