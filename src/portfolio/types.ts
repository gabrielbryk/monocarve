/**
 * Candidate model produced by the portfolio stage.
 *
 * A candidate is an SCC-closure: pick a seed component, take the transitive
 * closure of everything it depends on inside the application, and ask whether
 * that set can leave as a package. The answer is a set of eligibility facts, not
 * a boolean — `backlog` exists to turn the "no" answers into concrete work.
 */

import type { Scc } from "../graph/model.ts";

/** Why a candidate cannot be extracted as-is. */
export type RejectionCode =
  /** A relative import leaves the closure and lands on application code. */
  | "closure-escapes-app-code"
  /** An escape target is real code but not an exported symbol of a package. */
  | "escape-to-non-exported-symbol"
  /** A relative import lands on an asset that cannot travel with the closure. */
  | "unmovable-asset"
  /** A bare specifier resolves to nothing installed anywhere. */
  | "uninstalled-package"
  /** The closure is imported by, or spans, more than one application or package. */
  | "multiple-owners"
  /** The closure contains a configured composition root. */
  | "composition-root"
  /** A relative import in the closure resolves to nothing at all. */
  | "unresolved-imports"
  /** A dynamic import inside the closure; its specifier cannot be proven. */
  | "dynamic-imports"
  /** A computed specifier: no codemod can rewrite it. */
  | "unsupported-module-reference"
  /** A generated file in the closure whose declared source no longer exists. */
  | "generated-source-missing"
  /** Nothing is exported, nothing imports it, nothing tests it. */
  | "no-exports"
  /** `.d.ts` only — types with no implementation belong in an existing package. */
  | "declaration-only"
  /** Below `portfolio.minFiles`. */
  | "too-small"
  /** Above `portfolio.maxFiles` — too large to review in one PR. */
  | "too-large"
  /** A movable file, test, or asset is covered by `portfolio.protectedPaths`. */
  | "protected-path"
  /** The plan builder cannot express the move (unresolvable specifier, name clash). */
  | "unplannable";

export interface RejectionReason {
  readonly code: RejectionCode;
  /** One-line human explanation, already specific. */
  readonly detail: string;
  /**
   * The concrete edges to break, `from -> specifier`. `backlog` renders these
   * verbatim so the reader gets "break apps/web/src/x.ts -> ../shared/y", not a
   * category.
   */
  readonly edges: readonly string[];
}

/**
 * A first-party import that leaves the closure but lands on a symbol an existing
 * workspace package already exports. Such an escape does not reject the
 * candidate: the plan builder emits a `move-with-rewrite` operation that
 * repoints the specifier at the package as the file moves.
 */
export interface RewriteEscape {
  /** Closure file containing the escaping import, workspace-relative. */
  readonly file: string;
  /** The specifier as written, e.g. `"../../shared/logger"`. */
  readonly specifier: string;
  /** Workspace package that already exports the symbol, e.g. `"@acme/logger"`. */
  readonly package: string;
}

/** A module outside the candidate that imports into it. */
export interface ConsumerRef {
  readonly file: string;
  /** Owning directory of that file. */
  readonly owner: string;
  /** Specifiers in that file pointing into the closure. */
  readonly specifiers: readonly string[];
  /** True when the consumer lives outside the donating application. */
  readonly external: boolean;
}

export interface CompatibilityShim {
  readonly path: string;
  readonly packageName: string;
  readonly replacementSpecifier: string;
  readonly symbols: readonly string[];
  readonly productionConsumers: readonly string[];
  readonly testConsumers: readonly string[];
  readonly lineCount: number;
}

export type RecommendationReasonCode =
  | "generic-target"
  | "composition-adjacent"
  | "compatibility-shim"
  | "cross-domain"
  | "high-inbound"
  | "high-fan-out"
  | "large-review"
  | "evaluation-effects";

export interface RecommendationReason {
  readonly code: RecommendationReasonCode;
  readonly detail: string;
  readonly paths: readonly string[];
}

export interface TargetRecommendation {
  readonly packageName: string;
  readonly action: "extend" | "create";
  readonly confidence: "high" | "medium" | "low";
  readonly compatibility: "compatible" | "requires-review";
  readonly reasons: readonly string[];
}

export interface CandidateRecommendation {
  readonly status: "recommended" | "review-required" | "discouraged";
  readonly cohesion: "high" | "medium" | "low";
  readonly reasons: readonly RecommendationReason[];
  readonly requiresExplicitPackageName: boolean;
  readonly highInboundModules: readonly string[];
  readonly targetOptions: readonly TargetRecommendation[];
}

export interface CandidateEffort {
  /** Relative review complexity, not a duration estimate. */
  readonly reviewUnits: number;
  readonly locPerReviewUnit: number;
  readonly risk: "low" | "medium" | "high";
  readonly drivers: {
    readonly files: number;
    readonly tests: number;
    readonly assets: number;
    readonly consumers: number;
    readonly rewrites: number;
    readonly warnings: number;
    readonly blockers: number;
  };
}

/**
 * One retained edge a candidate's closure crosses: an import that reaches a
 * `portfolio.retainedRoots` module. Distinguishing `"value"` from `"type"` at
 * this granularity matters because a type-only edge can sometimes be resolved
 * by promoting a declaration (`portPromotions`) without touching runtime
 * code, while a value edge always needs a real replacement provider.
 */
export interface RetainedBlocker {
  /** Closure file containing the import into the retained root. */
  readonly file: string;
  /** The specifier as written. */
  readonly specifier: string;
  /** The retained-root module the specifier resolves to. */
  readonly target: string;
  readonly kind: "value" | "type";
}

/**
 * One step of the preparation recipe generated for a `RetainedBlocker`: the
 * configured `compositionBoundaries` / `portPromotions` entry that already
 * covers it, or an explicit report that no configured substitution exists.
 * The recipe never invents a remedy — `remedy.kind === "unconfigured"` is a
 * first-class, honest outcome, not an error.
 */
export interface RecipeStep {
  readonly blocker: RetainedBlocker;
  readonly remedy:
    | { readonly kind: "composition-boundary"; readonly id: string }
    | { readonly kind: "port-promotion"; readonly id: string }
    | { readonly kind: "unconfigured" };
  readonly detail: string;
}

export interface PortfolioCandidate {
  /** Stable, content-derived id (`c-<hash>`), safe to reference across runs. */
  readonly id: string;
  /** Application that currently owns the code. */
  readonly application: string;
  /** Suggested package name, already scoped. */
  readonly suggestedPackageName: string;

  /** Production TS files in the closure, sorted. */
  readonly files: readonly string[];
  /** Test files that travel with the closure, sorted. */
  readonly tests: readonly string[];
  /**
   * Non-TS files reachable by relative import from closure files, sorted.
   * They move byte-identically with the closure; their presence here is what
   * makes an otherwise-escaping asset import legal.
   */
  readonly assets: readonly string[];
  /** Components partitioning `files` (never `tests` or `assets`). */
  readonly sccs: readonly Scc[];
  /** The seed component this candidate grew from. */
  readonly seed: Scc;

  readonly lineCount: number;
  /** Owning directories spanned by the closure; more than one is a rejection. */
  readonly owners: readonly string[];
  /** Runtime domains spanned by the closure; more than one is a warning. */
  readonly domains: readonly string[];
  /** Existing workspace packages the closure already depends on. */
  readonly dependencies: readonly string[];
  readonly consumers: readonly ConsumerRef[];
  /** Files that would have to be edited: consumers plus test importers. */
  readonly consumerChurn: number;
  /** Fraction of the closure covered by travelling tests, 0..1. */
  readonly coverage: number;

  /** Sum of the configured weights. Higher is a better next extraction. */
  readonly score: number;
  readonly eligible: boolean;
  readonly rejectionReasons: readonly RejectionReason[];
  /**
   * Advisory, non-blocking observations — notably "closure crosses runtime
   * domains", which scores down rather than rejecting, because the split is
   * often the very thing the extraction is meant to fix.
   */
  readonly warnings: readonly string[];
  readonly rewriteEscapes: readonly RewriteEscape[];
  readonly compatibilityShims?: readonly CompatibilityShim[];
  readonly recommendation?: CandidateRecommendation;
  readonly effort?: CandidateEffort;

  /**
   * `"extraction"` is an ordinary candidate. `"preparation"` is a candidate
   * whose closure crosses a `portfolio.retainedRoots` boundary (see
   * `retainedBlockers`) or whose only viable target is the root package under
   * `portfolio.forbidTargetSuggestion: ["root"]` — real, ranked work, but work
   * that unblocks a future extraction rather than performing one now.
   * Optional because this field is populated by the ranking stage
   * (`src/portfolio/rank-assessment.ts`); a candidate constructed before that
   * wiring lands omits it rather than guessing a classification.
   */
  readonly classification?: "extraction" | "preparation";
  /** Retained edges this candidate's closure crosses. Empty when it crosses none. Optional for the same reason as `classification`. */
  readonly retainedBlockers?: readonly RetainedBlocker[];
  /** Generated recipe explaining what would unblock each retained blocker. Optional for the same reason as `classification`. */
  readonly recipe?: readonly RecipeStep[];
}

export interface Portfolio {
  readonly rootDir: string;
  readonly commit?: string;
  readonly candidates: readonly PortfolioCandidate[];
  /**
   * A non-overlapping selection, highest score first: the candidates that could
   * be extracted in sequence without two of them claiming the same file.
   */
  readonly selected: readonly string[];
  readonly equivalenceGroups?: readonly CandidateEquivalenceGroup[];
}

export interface CandidateEquivalenceGroup {
  readonly id: string;
  readonly representativeId: string;
  readonly candidateIds: readonly string[];
  readonly sharedFileCount: number;
  readonly similarity: number;
}

export function eligibleCandidates(portfolio: Portfolio): PortfolioCandidate[] {
  return portfolio.candidates
    .filter((candidate) => candidate.eligible)
    .slice()
    .toSorted((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}

export function blockedCandidates(portfolio: Portfolio): PortfolioCandidate[] {
  return portfolio.candidates
    .filter((candidate) => !candidate.eligible)
    .slice()
    .toSorted((left, right) => right.lineCount - left.lineCount || left.id.localeCompare(right.id));
}

/**
 * One concrete obstacle from a blocked candidate, with the deliberately narrow
 * answer to "what would this one change unlock?"  `occurrences` is merely how
 * often the obstacle appears.  `freedCandidates` only includes candidates for
 * which it is the *only* rejection and, when it is an edge, the only edge in
 * that rejection.  A reason with several edges therefore records each edge as
 * observed but credits none of them with freeing the candidate: removing one
 * leaves the other edges to resolve.
 */
export interface MarginalBlocker {
  readonly code: RejectionCode;
  readonly detail: string;
  /** Present for an edge-level blocker; absent for a reason with no edges. */
  readonly edge?: string;
  /** Blocked candidates that mention this exact edge or edge-less reason. */
  readonly occurrences: number;
  /** Candidates made eligible by removing this one blocker and no other. */
  readonly freedCandidates: number;
  /** Production LOC in `freedCandidates`, not all occurrences. */
  readonly freedLineCount: number;
  /** Stable ids of `freedCandidates`, for audit rather than inference. */
  readonly candidateIds: readonly string[];
}

/**
 * Rank individual blockers by their proven one-change unlock, not frequency.
 *
 * This intentionally does not model interacting changes: candidates with two
 * rejection reasons, or a single reason containing multiple concrete edges,
 * contribute occurrences but cannot be credited to any individual item. The
 * result is a lower bound for one-change work, never a prediction that a
 * high-frequency category is a high-value fix.
 */
export function marginalBlockers(candidates: readonly Pick<PortfolioCandidate, "id" | "lineCount" | "rejectionReasons">[]): MarginalBlocker[] {
  interface Accumulator {
    readonly code: RejectionCode;
    readonly detail: string;
    readonly edge?: string;
    occurrences: number;
    readonly freed: { id: string; lineCount: number }[];
  }

  const byBlocker = new Map<string, Accumulator>();
  const add = (
    reason: RejectionReason,
    edge: string | undefined,
    candidate: Pick<PortfolioCandidate, "id" | "lineCount" | "rejectionReasons">,
    frees: boolean,
  ): void => {
    const key = edge === undefined ? `${reason.code}\u0000${reason.detail}` : `${reason.code}\u0000${edge}`;
    let entry = byBlocker.get(key);
    if (entry === undefined) {
      entry = { code: reason.code, detail: reason.detail, ...(edge === undefined ? {} : { edge }), occurrences: 0, freed: [] };
      byBlocker.set(key, entry);
    }
    entry.occurrences += 1;
    if (frees) entry.freed.push({ id: candidate.id, lineCount: candidate.lineCount });
  };

  for (const candidate of candidates) {
    for (const reason of candidate.rejectionReasons) {
      const frees = candidate.rejectionReasons.length === 1 && reason.edges.length <= 1;
      if (reason.edges.length === 0) add(reason, undefined, candidate, frees);
      else for (const edge of reason.edges) add(reason, edge, candidate, frees);
    }
  }

  return [...byBlocker.values()]
    .map((entry) => {
      const freed = entry.freed.sort((left, right) => left.id.localeCompare(right.id));
      return {
        code: entry.code,
        detail: entry.detail,
        ...(entry.edge === undefined ? {} : { edge: entry.edge }),
        occurrences: entry.occurrences,
        freedCandidates: freed.length,
        freedLineCount: freed.reduce((total, candidate) => total + candidate.lineCount, 0),
        candidateIds: freed.map((candidate) => candidate.id),
      };
    })
    .toSorted(
      (left, right) =>
        right.freedCandidates - left.freedCandidates ||
        right.freedLineCount - left.freedLineCount ||
        right.occurrences - left.occurrences ||
        left.code.localeCompare(right.code) ||
        (left.edge ?? left.detail).localeCompare(right.edge ?? right.detail),
    );
}

/**
 * The one-line instructions `backlog` prints: what to break, to unlock what.
 * A blocker with no concrete edge falls back to its own explanation.
 */
export function blockingHints(candidate: PortfolioCandidate): string[] {
  return candidate.rejectionReasons.flatMap((reason) =>
    reason.edges.length === 0 ? [reason.detail] : [`break ${reason.edges[0]} to unlock ${candidate.id} (${candidate.lineCount} LOC)`],
  );
}
