/**
 * Containment: does anything in this closure reach outside it, and if so, can
 * that reach be repaired as part of the move?
 *
 * Three kinds of outward reach, with three different answers:
 *
 *  - **an asset** (`./chart.css`) — legal, because the asset travels with the
 *    closure byte-identically. Illegal only if it lives somewhere a plan may
 *    not move files out of.
 *  - **an escape to a symbol an existing package already exports** — legal, and
 *    becomes a `move-with-rewrite`: the file leaves *and* its specifier is
 *    repointed at the package, in one hashed operation with a replay proof.
 *  - **anything else** — a rejection, reported with the exact edge to break.
 *
 * The distinction is drawn from the *bindings actually used*: an escape only
 * counts as rewritable if every name the importer takes is genuinely on the
 * package's public surface. A near-match would produce a package that installs
 * and fails to compile.
 */

import { isFirstPartyPackageOwner, isPackageOwner, type MonocarveConfig } from "../config.ts";
import type { DependencyGraph } from "../graph/model.ts";
import { isBuiltinModule, type WorkspaceContext } from "../plan/context.ts";
import { isSourceModulePath } from "../util/files.ts";
import { byCodeUnit } from "../util/hash.ts";
import type { RewriteEscape } from "./types.ts";

export interface Escape {
  readonly file: string;
  readonly specifier: string;
  readonly resolved: string | undefined;
}

interface Containment {
  /** Relative imports of source modules, resolved where possible. */
  readonly internal: readonly { readonly specifier: string; readonly resolved: string | undefined }[];
  /** Relative imports of non-source files. */
  readonly assets: readonly string[];
  /** Bare specifiers that are neither builtin, workspace, nor installed. */
  readonly external: readonly string[];
}

export interface ContainmentAnalysis {
  /** Assets that can travel with the closure, sorted. */
  readonly assets: readonly string[];
  /** Assets outside every movable root, sorted. */
  readonly unmovableAssets: readonly string[];
  /** Relative imports that leave `files`. */
  readonly escapes: readonly Escape[];
  /** `file -> specifier` strings for unresolvable bare specifiers. */
  readonly external: readonly string[];
}

const containmentCache = new WeakMap<WorkspaceContext, Map<string, Containment>>();

function fileContainment(context: WorkspaceContext, graph: DependencyGraph, file: string): Containment {
  let byFile = containmentCache.get(context);
  if (!byFile) {
    byFile = new Map<string, Containment>();
    containmentCache.set(context, byFile);
  }
  const cached = byFile.get(file);
  if (cached) return cached;

  const owner = context.ownerOf(file);
  const internal: { specifier: string; resolved: string | undefined }[] = [];
  const assets: string[] = [];
  const external: string[] = [];

  for (const reference of context.moduleReferences(file)) {
    const specifier = reference.specifier;
    if (specifier === null) continue;
    if (specifier.startsWith(".")) {
      const resolved = context.resolveRelative(file, specifier);
      if (resolved !== undefined && !isSourceModulePath(resolved, context.config.sourceExtensions)) assets.push(resolved);
      else internal.push({ specifier, resolved });
      continue;
    }
    const name = context.packageNameOf(specifier);
    if (isBuiltinModule(name) || graph.workspace.packageNames.has(name) || context.isInstalledPackage(name, owner)) {
      continue;
    }
    external.push(specifier);
  }

  const containment: Containment = { internal, assets, external };
  byFile.set(file, containment);
  return containment;
}

export function analyzeContainment(context: WorkspaceContext, graph: DependencyGraph, files: readonly string[]): ContainmentAnalysis {
  const contained = new Set(files);
  const assets = new Set<string>();
  const unmovableAssets = new Set<string>();
  const escapes: Escape[] = [];
  const external: string[] = [];

  for (const file of files) {
    const containment = fileContainment(context, graph, file);
    for (const asset of containment.assets) (context.isMovable(asset) ? assets : unmovableAssets).add(asset);
    for (const specifier of containment.external) external.push(`${file} -> ${specifier}`);
    for (const entry of containment.internal) {
      if (entry.resolved === undefined || !contained.has(entry.resolved)) {
        escapes.push({ file, specifier: entry.specifier, resolved: entry.resolved });
      }
    }
  }

  return { assets: [...assets].toSorted(), unmovableAssets: [...unmovableAssets].toSorted(), escapes, external };
}

/**
 * The workspace package that already exports what an escape reaches for, or
 * undefined when nothing does.
 *
 * Every condition here is a way the rewrite could produce a package that does
 * not compile: the target must live in a package, that package must have a
 * resolvable entry, the entry must re-export the target module, and the entry's
 * surface must cover every binding the importer actually uses — including the
 * namespace import, which `export *` satisfies but a named re-export does not.
 */
export function exportingPackageFor(config: MonocarveConfig, context: WorkspaceContext, graph: DependencyGraph, escape: Escape): string | undefined {
  const target = escape.resolved;
  if (target === undefined) return undefined;
  const owner = context.ownerOf(target);
  if (!isPackageOwner(config, owner) && !isFirstPartyPackageOwner(config, owner)) return undefined;

  const packageEntry = [...graph.workspace.packageNames.entries()].find(([, value]) => value === owner);
  if (!packageEntry) return undefined;
  const entrypoint = context.packageEntrypoint(owner);
  if (entrypoint === undefined) return undefined;
  const surface = context.entrypointReexports(entrypoint).get(target);
  if (!surface) return undefined;

  const needed = context.importedBindings(escape.file, escape.specifier);
  if (needed.star && !surface.star) return undefined;
  // `export *` re-exports every named binding but never the default.
  if (![...needed.names].every((name) => (surface.star && name !== "default") || surface.names.has(name))) {
    return undefined;
  }
  return packageEntry[0];
}

/** Split escapes into rewritable ones and hard rejections. */
export function classifyEscapes(
  config: MonocarveConfig,
  context: WorkspaceContext,
  graph: DependencyGraph,
  escapes: readonly Escape[],
): { readonly rewritable: RewriteEscape[]; readonly blocking: Escape[] } {
  const rewritable: RewriteEscape[] = [];
  const blocking: Escape[] = [];
  for (const escape of escapes) {
    const exporting = exportingPackageFor(config, context, graph, escape);
    if (exporting === undefined) blocking.push(escape);
    else rewritable.push({ file: escape.file, specifier: escape.specifier, package: exporting });
  }
  return {
    // By code unit, not by locale. The plan builder groups these per file into
    // the `rewrites` array of a `move-with-rewrite`, which is serialized as it
    // stands, so the tiebreak below decides manifest bytes whenever one file
    // carries two escapes. The `file` half never reaches those bytes — the
    // operations themselves are emitted by iterating the plan's sources — but a
    // comparator is one expression and both halves are held to the same rule.
    // See `byCodeUnit`.
    rewritable: rewritable.sort((left, right) => byCodeUnit(left.file, right.file) || byCodeUnit(left.specifier, right.specifier)),
    blocking,
  };
}
