/**
 * Preparation recipe: for each retained-root blocker, name the configured
 * remedy that already covers it, or report the gap honestly.
 *
 * `compositionBoundaries` and `portPromotions` are one mechanism described in
 * two vocabularies (see `src/config/schema-policy.ts`). This module never
 * invents a third option: a blocker whose target matches neither is reported
 * as `"unconfigured"`, naming the exact edge, because guessing a contract on
 * a workspace's behalf is exactly the silent-correctness gap this tool exists
 * to refuse.
 */

import type { MonocarveConfig } from "../config.ts";
import type { CompositionBoundariesConfig } from "../config/schema-policy.ts";
import type { PortPromotionsConfig } from "../config/schema-promotions.ts";
import { byCodeUnit } from "../util/hash.ts";
import type { RecipeStep, RetainedBlocker } from "./types.ts";

type Boundary = CompositionBoundariesConfig[number];
type Promotion = PortPromotionsConfig[number];

function underRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

/**
 * A `compositionBoundaries` entry names the exact retained module it
 * addresses, so the match is exact — not a prefix, unlike `retainedRoots`
 * itself, which names trees. Sorted by id first so two entries that (through
 * misconfiguration) both name the same `retained` path resolve the same way
 * on every run.
 */
function matchingBoundary(boundaries: CompositionBoundariesConfig, target: string): Boundary | undefined {
  return [...boundaries].toSorted((left, right) => byCodeUnit(left.id, right.id)).find((boundary) => boundary.retained === target);
}

function matchingPromotion(promotions: PortPromotionsConfig, target: string): Promotion | undefined {
  return [...promotions]
    .toSorted((left, right) => byCodeUnit(left.id, right.id))
    .find((promotion) => promotion.retainedRoots.some((root) => underRoot(target, root)));
}

export function preparationRecipe(config: MonocarveConfig, blockers: readonly RetainedBlocker[]): RecipeStep[] {
  return blockers.map((blocker) => step(config, blocker));
}

function step(config: MonocarveConfig, blocker: RetainedBlocker): RecipeStep {
  const edge = `${blocker.file} -> ${blocker.specifier}`;

  const boundary = matchingBoundary(config.compositionBoundaries, blocker.target);
  if (boundary) {
    return {
      blocker,
      remedy: { kind: "composition-boundary", id: boundary.id },
      detail: `compositionBoundaries "${boundary.id}" (strategy: ${boundary.strategy}) already covers ${edge}`,
    };
  }

  const promotion = matchingPromotion(config.portPromotions, blocker.target);
  if (promotion) {
    const ports = promotion.libraryPorts ?? (promotion.libraryPort ? [promotion.libraryPort] : []);
    return {
      blocker,
      remedy: { kind: "port-promotion", id: promotion.id },
      detail: `portPromotions "${promotion.id}" (promotes ${ports.join(", ")} into ${promotion.targetPackage}) already covers ${edge}`,
    };
  }

  return { blocker, remedy: { kind: "unconfigured" }, detail: `no configured substitution for ${edge} (${blocker.kind} edge into ${blocker.target})` };
}
