/** Traversal mechanics for the runtime evaluation closure. */

import type { ModuleReference } from "../codemod/imports.ts";
import { firstPartyRoots, packageNameOf, type MonocarveConfig } from "../config.ts";
import type { DependencyGraph, EdgeKind } from "../graph/model.ts";
import { isDeclarationPath } from "../util/files.ts";
import { byCodeUnit } from "../util/hash.ts";
import { isBuiltinModule, type WorkspaceContext } from "./context.ts";
import type { EscapeRewrite } from "./manifest.ts";

const EVALUATING_EDGE_KINDS: ReadonlySet<EdgeKind> = new Set<EdgeKind>(["static", "require", "re-export"]);

export interface EvaluationTraversalOptions {
  readonly config: MonocarveConfig;
  readonly context: WorkspaceContext;
  readonly graph: DependencyGraph;
  readonly seeds: readonly string[];
  readonly rewrites?: ReadonlyMap<string, readonly EscapeRewrite[]>;
}

export interface EvaluationTraversal {
  readonly seeds: readonly string[];
  readonly reached: readonly string[];
  readonly modules: readonly string[];
  readonly packageOwners: ReadonlyMap<string, ReadonlySet<string>>;
  readonly opaqueSpecifiers: readonly string[];
}

interface TraversalState {
  readonly roots: readonly string[];
  readonly edges: ReadonlyMap<string, readonly EvaluatingEdge[]>;
  readonly options: EvaluationTraversalOptions;
  readonly visited: Set<string>;
  readonly reached: Set<string>;
  readonly packageOwners: Map<string, Set<string>>;
  readonly opaque: Set<string>;
}

interface EvaluatingEdge {
  readonly to: string;
  readonly specifier: string;
}

export function traverseEvaluationClosure(options: EvaluationTraversalOptions): EvaluationTraversal {
  const roots = firstPartyRoots(options.config);
  const seeds = [...new Set(options.seeds)].filter((path) => evaluable(options.context, roots, path)).toSorted(byCodeUnit);
  const state: TraversalState = {
    roots,
    edges: evaluatingEdges(options.graph),
    options,
    visited: new Set(seeds),
    reached: new Set(),
    packageOwners: new Map(),
    opaque: new Set(),
  };
  const pending = [...seeds];
  while (pending.length > 0) {
    const source = pending.pop()!;
    for (const target of targetsFor(state, source)) addTarget(state, pending, target);
  }
  return {
    seeds,
    reached: [...state.reached].toSorted(byCodeUnit),
    modules: [...state.visited].toSorted(byCodeUnit),
    packageOwners: state.packageOwners,
    opaqueSpecifiers: [...state.opaque].toSorted(byCodeUnit),
  };
}

function evaluatingEdges(graph: DependencyGraph): ReadonlyMap<string, readonly EvaluatingEdge[]> {
  const indexed = new Map<string, EvaluatingEdge[]>();
  for (const edge of graph.edges) {
    if (!EVALUATING_EDGE_KINDS.has(edge.kind)) continue;
    const bucket = indexed.get(edge.from) ?? [];
    bucket.push({ to: edge.to, specifier: edge.specifier });
    indexed.set(edge.from, bucket);
  }
  return indexed;
}

function targetsFor(state: TraversalState, source: string): ReadonlySet<string> {
  const targets = graphTargets(state, source);
  for (const reference of state.options.context.moduleReferences(source)) {
    referenceTarget(state, source, reference, targets);
  }
  return targets;
}

function graphTargets(state: TraversalState, source: string): Set<string> {
  const replaced = new Set((state.options.rewrites?.get(source) ?? []).map((rewrite) => rewrite.donorlessSpecifier));
  return new Set(
    (state.edges.get(source) ?? [])
      .filter((edge) => !replaced.has(edge.specifier) && evaluable(state.options.context, state.roots, edge.to))
      .map((edge) => edge.to),
  );
}

function referenceTarget(state: TraversalState, source: string, reference: ModuleReference, targets: Set<string>): void {
  if (reference.specifier === null || !evaluatesTarget(reference)) return;
  const rewrite = (state.options.rewrites?.get(source) ?? []).find((entry) => entry.donorlessSpecifier === reference.specifier);
  const specifier = rewrite?.packageSpecifier ?? reference.specifier;
  const resolved = rewrite ? undefined : inside(state.options.context, reference.resolved);
  if (specifier.startsWith(".")) {
    if (resolved !== undefined && evaluable(state.options.context, state.roots, resolved)) targets.add(resolved);
    return;
  }
  packageTarget(state, source, specifier, resolved, targets);
}

function packageTarget(state: TraversalState, source: string, specifier: string, resolved: string | undefined, targets: Set<string>): void {
  const name = packageNameOf(specifier);
  if (isBuiltinModule(name)) return;
  const owner = state.options.graph.workspace.packageNames.get(name);
  if (owner === undefined) return noteExternalPackage(state, source, name);
  const entry =
    resolved !== undefined && isFirstParty(state.roots, resolved) ? resolved : specifier === name ? state.options.context.packageEntrypoint(owner) : undefined;
  if (entry !== undefined && evaluable(state.options.context, state.roots, entry)) targets.add(entry);
  else state.opaque.add(specifier);
}

function noteExternalPackage(state: TraversalState, source: string, name: string): void {
  const owners = state.packageOwners.get(name) ?? new Set<string>();
  owners.add(state.options.context.ownerOf(source));
  state.packageOwners.set(name, owners);
}

function addTarget(state: TraversalState, pending: string[], target: string): void {
  if (state.visited.has(target)) return;
  state.visited.add(target);
  state.reached.add(target);
  pending.push(target);
}

function evaluable(context: WorkspaceContext, roots: readonly string[], path: string): boolean {
  return isFirstParty(roots, path) && !isDeclarationPath(path) && context.isProductionSource(path) && context.exists(path);
}

function inside(context: WorkspaceContext, absolute: string | null): string | undefined {
  if (absolute === null) return undefined;
  try {
    return context.relative(absolute);
  } catch {
    return undefined;
  }
}

function isFirstParty(roots: readonly string[], path: string): boolean {
  return roots.some((root) => path.startsWith(root));
}

function evaluatesTarget(reference: ModuleReference): boolean {
  switch (reference.kind) {
    case "static-import":
    case "static-export":
    case "asset-import":
      return !reference.typeOnly;
    case "require":
    case "import-equals":
      return true;
    case "import-type":
    case "dynamic-import":
    case "require-resolve":
    case "configured-call":
      return false;
  }
}
