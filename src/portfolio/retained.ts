/**
 * Retained-root blockers: the minimal set of edges from a candidate's closure
 * into a `portfolio.retainedRoots` module.
 *
 * "Minimal" matters as much as "complete" here: a large closure can reach one
 * retained module through a dozen files, and reporting all twelve would make
 * the recipe look twelve times harder than it actually is. One entry per
 * distinct target module — taken from the closure file that sorts first by
 * `byCodeUnit` — is the smallest honest description of what stands in the way.
 *
 * `kind` is read through `context.importKinds`, the same per-specifier AST
 * fact `src/plan/dependency-evidence.ts` uses to decide devDependency vs.
 * runtime dependency: it is the authoritative "does this vanish at runtime"
 * answer, not a re-derivation of `graph.edges[].typeOnly` (which is kept only
 * as a fallback for a specifier the cache has not seen). The distinction is
 * the point of this module: a type-only blocker can sometimes be resolved by
 * promoting a declaration (`portPromotions`) without touching runtime code; a
 * value blocker always needs a real replacement provider.
 */

import type { DependencyGraph } from "../graph/model.ts";
import type { WorkspaceContext } from "../plan/context.ts";
import { byCodeUnit } from "../util/hash.ts";
import type { RetainedBlocker } from "./types.ts";

function underRetainedRoot(target: string, retainedRoots: readonly string[]): boolean {
  return retainedRoots.some((root) => target === root || target.startsWith(`${root}/`));
}

interface Reaching {
  readonly file: string;
  readonly specifier: string;
  readonly kind: "value" | "type";
}

function edgeKind(context: WorkspaceContext, file: string, specifier: string, fallback: boolean): "value" | "type" {
  const typeOnly = context.importKinds(file).get(specifier)?.typeOnly ?? fallback;
  return typeOnly ? "type" : "value";
}

export function retainedBlockers(
  context: WorkspaceContext,
  graph: DependencyGraph,
  closure: readonly string[],
  retainedRoots: readonly string[],
): RetainedBlocker[] {
  if (retainedRoots.length === 0) return [];
  const closureSet = new Set(closure);

  // A retained-root file that a closure member imports is a blocker whether
  // or not that file was itself pulled into the closure by the ordinary
  // transitive-closure walk (it usually is — that is exactly how a giant
  // config/db/infra closure forms). What matters is the edge, not whether the
  // target happens to already be a closure member.
  const byTarget = new Map<string, Reaching[]>();
  for (const edge of graph.edges) {
    if (!closureSet.has(edge.from)) continue;
    if (!underRetainedRoot(edge.to, retainedRoots)) continue;
    const bucket = byTarget.get(edge.to) ?? [];
    bucket.push({ file: edge.from, specifier: edge.specifier, kind: edgeKind(context, edge.from, edge.specifier, edge.typeOnly) });
    byTarget.set(edge.to, bucket);
  }

  return [...byTarget.entries()]
    .map(([target, reaching]): RetainedBlocker => {
      const representative = [...reaching].toSorted((left, right) => byCodeUnit(left.file, right.file))[0]!;
      return { file: representative.file, specifier: representative.specifier, target, kind: representative.kind };
    })
    .toSorted((left, right) => byCodeUnit(left.target, right.target));
}
