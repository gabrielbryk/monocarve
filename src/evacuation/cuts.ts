import type { MonocarveConfig } from "../config.ts";
import type { DependencyGraph } from "../graph/model.ts";
import type { WorkspaceContext } from "../plan/context.ts";
import { preparationRecipe } from "../portfolio/recipe.ts";
import type { RecipeStep, RetainedBlocker } from "../portfolio/types.ts";
import { byCodeUnit } from "../util/hash.ts";
import type { EvacuationCandidate } from "./candidate.ts";

export type BoundaryCutReason = "composition-root" | "retained-root" | "outside-evacuation";

export interface EvacuationBoundaryCut {
  readonly from: string;
  readonly specifier: string;
  readonly target: string;
  readonly kind: "value" | "type";
  readonly reason: BoundaryCutReason;
  readonly remedy: RecipeStep["remedy"];
}

/** Report application edges that must be inverted before this bounded union can move. */
export function evacuationBoundaryCuts(
  config: MonocarveConfig,
  context: WorkspaceContext,
  graph: DependencyGraph,
  candidate: EvacuationCandidate,
): EvacuationBoundaryCut[] {
  const moved = new Set(candidate.files);
  const composition = new Set(candidate.retainedComposition.flatMap((scc) => scc.members));
  return graph.edges
    .filter((edge) => moved.has(edge.from) && graph.nodes.get(edge.to)?.zone === "application")
    .flatMap((edge): EvacuationBoundaryCut[] => {
      const reason = cutReason(edge.to, moved, composition, config.portfolio.retainedRoots);
      if (reason === null) return [];
      const typeOnly = context.importKinds(edge.from).get(edge.specifier)?.typeOnly ?? edge.typeOnly;
      const kind = typeOnly ? "type" : "value";
      const blocker: RetainedBlocker = { file: edge.from, specifier: edge.specifier, target: edge.to, kind };
      return [{ from: edge.from, specifier: edge.specifier, target: edge.to, kind, reason, remedy: preparationRecipe(config, [blocker])[0]!.remedy }];
    })
    .toSorted((left, right) => byCodeUnit(left.from, right.from) || byCodeUnit(left.target, right.target) || byCodeUnit(left.specifier, right.specifier));
}

function cutReason(target: string, moved: ReadonlySet<string>, composition: ReadonlySet<string>, retainedRoots: readonly string[]): BoundaryCutReason | null {
  if (composition.has(target)) return "composition-root";
  if (retainedRoots.some((root) => target === root || target.startsWith(`${root}/`))) return "retained-root";
  return moved.has(target) ? null : "outside-evacuation";
}
