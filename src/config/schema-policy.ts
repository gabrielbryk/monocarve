import { z } from "zod";

import { kebabId, protectedPath, regexSource, relativePath } from "./primitives.ts";

const domain = z.strictObject({
  name: z.string().min(1).describe("Domain name reported by portfolio analysis."),
  patterns: z.array(regexSource).min(1).describe("Regexes matching the files that belong to this domain."),
});

export const portfolio = z.strictObject({
  domains: z.array(domain).default([]).describe("Named domains, each defined by regexes over file paths; closures crossing domains are scored down."),
  /**
   * Directory prefixes (relative to an application `sourceRoot`) whose
   * immediate children are each their own domain. Without this a directory
   * like `components/` collapses hundreds of unrelated features into one
   * domain and every candidate looks like it crosses nothing.
   */
  nestedDomainRoots: z
    .array(z.string().min(1))
    .default([])
    .describe("Directory prefixes, relative to an application `sourceRoot`, whose immediate children are each their own domain."),
  /**
   * Packages whose presence makes a component framework-coupled: it is a
   * runtime adapter or UI, not portable logic. Scores down and drives the
   * scaffold profile; it is never on its own a rejection.
   */
  frameworkPackages: z
    .array(z.string().min(1))
    .default([])
    .describe("Packages whose use marks a component as framework-coupled; scored down, never rejected on its own."),
  /**
   * Regexes matching files that compose the application at runtime, on top of
   * each application's explicit `compositionRoots`. A closure containing one is
   * rejected: entrypoints and wiring never leave.
   */
  compositionRootPatterns: z
    .array(regexSource)
    .default([])
    .describe("Regexes matching runtime composition files, in addition to each application's `compositionRoots`; closures containing one are rejected."),
  /** Closures smaller than this are noise; larger than this are unreviewable. */
  minFiles: z.number().int().positive().default(2).describe("Smallest closure, in files, considered a candidate."),
  maxFiles: z.number().int().positive().default(120).describe("Largest closure, in files, considered reviewable."),
  /** Scoring weights. Negative values penalize; the ranking is a plain sum. */
  weights: z
    .strictObject({
      lineCount: z.number().default(1).describe("Weight per line of code in the closure, excluding lines already covered by a detected compatibility shim."),
      consumerCount: z.number().default(10).describe("Weight per consumer of the closure, counting both production importers and test importers."),
      fileCount: z.number().default(5).describe("Weight per file in the closure."),
      testCoverage: z.number().default(50).describe("Weight multiplied by the fraction (0-1) of the closure's files covered by travelling tests."),
      domainCrossing: z.number().default(-500).describe("Weight applied once when a candidate's closure spans more than one configured `domains` entry."),
      rewriteEscape: z.number().default(-100).describe("Weight per import that escapes the closure and needs rewriting."),
      /** Per existing workspace package the closure already depends on. */
      prerequisite: z.number().default(-12).describe("Weight per existing workspace package the closure already depends on."),
      /**
       * Per blocking reason. Large and negative so that no ineligible candidate
       * can outrank an eligible one on size alone, while blocked candidates
       * still order sensibly against each other in `backlog`.
       */
      rejection: z.number().default(-1000).describe("Weight per blocking reason, large enough that no ineligible candidate outranks an eligible one."),
      /**
       * Per retained-root blocker (see `retainedRoots`). Large and negative,
       * like `rejection`, but smaller in magnitude: a preparation candidate is
       * still real, ranked work — it should sort below genuinely extractable
       * candidates, not below every rejected one.
       */
      retainedEdge: z.number().default(-250).describe("Weight per retained-root blocker, ranking preparation candidates below extractable ones."),
      /**
       * Applied once when a candidate's closure spans more than one runtime
       * domain (browser vs. server, for example). Distinct from
       * `domainCrossing`, which scores an application-declared `domains` split;
       * this scores a difference the graph itself proves — a closure that
       * imports across a runtime boundary cannot be a single portable package
       * no matter how the domains are configured.
       */
      runtimeCrossing: z.number().default(-300).describe("Weight applied once when a candidate's closure spans more than one runtime domain."),
    })
    .prefault({})
    .describe("Scoring weights; negative values penalize and the ranking is a plain sum."),
  /** Candidate ids already extracted; `next`/`backlog` skip these. */
  extracted: z.array(z.string()).default([]).describe("Candidate ids already extracted; `next` and `backlog` skip them."),
  /**
   * Files or directory trees a candidate must never move. A value protects that
   * exact path and its descendants; similarly named siblings remain eligible.
   */
  protectedPaths: z.array(protectedPath).default([]).describe("Files or directory trees a candidate must never move; a closure containing one is ineligible."),
  /**
   * Paths or directory trees that must stay application-owned, distinct from
   * `protectedPaths`. A protected path makes a candidate INELIGIBLE — it is a
   * hard rejection, full stop. A retained root does the opposite: it makes an
   * otherwise-portable candidate a *preparation* candidate rather than an
   * extraction candidate, and drives a generated recipe explaining exactly what
   * would have to change (a configured `compositionBoundaries` or
   * `portPromotions` entry, or an honest "no configured substitution" gap) to
   * unblock it. Declare a root here, not `protectedPaths`, whenever the intent
   * is "this can't move yet, tell me how to make it movable" rather than
   * "this must never move".
   */
  retainedRoots: z
    .array(relativePath)
    .default([])
    .describe("Paths that must stay application-owned for now; candidates reaching them become preparation candidates with a generated recipe."),
  /**
   * Target shapes a candidate is not allowed to resolve to. Currently only
   * `"root"`: a candidate whose only sensible target is the root package
   * itself is not a distinct extractable unit — it is evidence the candidate
   * still needs preparation (see `retainedRoots`), so it is classified
   * `"preparation"` rather than rejected outright or offered as a genuine
   * extraction target.
   */
  forbidTargetSuggestion: z
    .array(z.enum(["root"]))
    .default([])
    .describe("Target shapes a candidate may not resolve to; `root` classifies such candidates as preparation work."),
  /** Directory names too generic to be useful package boundaries. Advisory only. */
  genericTargetSegments: z
    .array(z.string().min(1))
    .default(["root", "components", "src", "shared", "common", "utils"])
    .describe("Directory names too generic to be useful package boundaries; advisory only."),
  /** Minimum production fan-in before a pure re-export is reported as a compatibility shim. */
  compatibilityShimMinInbound: z
    .number()
    .int()
    .nonnegative()
    .default(5)
    .describe("Minimum production fan-in before a pure re-export is reported as a compatibility shim."),
  /** Advisory complexity thresholds; these never make a candidate ineligible. */
  highInboundThreshold: z.number().int().positive().default(12).describe("Advisory inbound-import count at or above which a module is flagged as a hotspot."),
  highFanOutThreshold: z.number().int().positive().default(8).describe("Advisory outbound-import count at or above which a module is flagged as a hotspot."),
  maxRecommendedFiles: z.number().int().positive().optional().describe("Advisory file count above which a candidate is not recommended."),
  maxRecommendedLines: z.number().int().positive().optional().describe("Advisory line count above which a candidate is not recommended."),
  /** Extra workspace-specific composition-adjacent paths that need review. */
  compositionAdjacentPatterns: z.array(regexSource).default([]).describe("Extra workspace-specific composition-adjacent path regexes flagged for review."),
  /** Production-file Jaccard similarity used to collapse near-identical candidates. */
  equivalenceThreshold: z
    .number()
    .min(0.5)
    .max(1)
    .default(0.95)
    .describe("Production-file Jaccard similarity at which near-identical candidates collapse into one group."),
});

/** Portfolio analysis settings: domains, nested domain roots, and framework coupling. */
export type PortfolioConfig = z.output<typeof portfolio>;

/**
 * How co-located tests participate in an extraction. Both strategies retain a
 * test that reaches app-local support outside the moved closure, because that
 * support must not be pulled into a production package. The default still
 * permits computed test-only references; `self-contained` refuses them.
 */
export const testRelocation = z.strictObject({
  strategy: z
    .enum(["all-importers", "self-contained"])
    .default("all-importers")
    .describe("How co-located tests follow moved code; `self-contained` also refuses computed test-only references."),
});

/** How tests follow extracted modules (`all-importers` or `self-contained`). */
export type TestRelocationConfig = z.output<typeof testRelocation>;

/** Explicit test intent. When present it replaces the legacy flat matcher. */
export const testKinds = z
  .strictObject({
    unit: z.array(regexSource).default([]).describe("Regexes matching unit test files."),
    integration: z.array(regexSource).default([]).describe("Regexes matching integration test files."),
    e2e: z.array(regexSource).default([]).describe("Regexes matching end-to-end test files."),
  })
  .optional();

/** Test classification used by `testKinds` matchers. */
export type TestKind = "unit" | "integration" | "e2e";
/** Explicit per-kind test matchers; replaces the legacy flat matcher when present. */
export type TestKindsConfig = z.output<typeof testKinds>;

/**
 * A config-declared integration-test suite that can be relocated as a leaf
 * workspace package.  Unlike a production extraction it has no public barrel:
 * its only permitted application edges are the explicit donor surfaces below.
 */
const integrationTestSuite = z.strictObject({
  /** Application whose published test surface the suite is allowed to consume. */
  application: z.string().min(1).describe("Application whose published test surface the suite may consume."),
  /** Package-kind profile that renders the leaf test package. */
  profile: z.string().min(1).describe("Extraction profile that renders the leaf test package."),
  /** Directory containing the suite's test modules, repo-relative. */
  sourceRoot: relativePath.describe("Repo-relative directory containing the suite's test modules."),
  /** Regexes selecting the test modules below sourceRoot. */
  patterns: z.array(regexSource).min(1).describe("Regexes selecting the test modules below `sourceRoot`."),
  /** Exact application source paths that may be rewritten to published specifiers. */
  donorImports: z
    .array(
      z.strictObject({
        source: relativePath.describe("Application source path imported by the suite."),
        specifier: z.string().min(1).describe("Published specifier that replaces imports of `source`."),
      }),
    )
    .default([])
    .describe("Exact application source paths that may be rewritten to published specifiers."),
});

export const integrationTestSuites = z
  .record(z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "must be a lowercase kebab-case identifier"), integrationTestSuite)
  .default({});

/** Integration-test suites relocatable as leaf workspace packages. */
export type IntegrationTestSuiteConfig = z.output<typeof integrationTestSuite>;

/* -------------------------------------------------------------------------- */
/* Graph + transaction                                                        */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* Path references                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A tree scanned as raw text for paths written as strings, and the extensions
 * that are read in it.
 *
 * Paired rather than declared as two independent lists so a config cannot name
 * a directory whose extensions it never lists: that combination scans nothing,
 * silently, which is the worst way for a heuristic to be wrong.
 */
const textScanRoot = z.strictObject({
  root: relativePath.describe("Repo-relative directory scanned as raw text."),
  extensions: z.array(z.string().regex(/^\./, "extension must start with a dot")).min(1).describe("File extensions read in `root`, each starting with a dot."),
});

/**
 * Detection of moved paths that appear as **string literals** rather than as
 * imports — `readFileSync("apps/web/src/widgets/chart.ts")`.
 *
 * Such a reference is invisible to the module graph, so it is correctly absent
 * from a plan, correctly not a containment violation, and correctly not
 * rewritten; it simply stops resolving once the file moves. See
 * `src/plan/path-references.ts` for what the scan can and cannot see.
 */
export const pathReferences = z.strictObject({
  enabled: z.boolean().default(true).describe("Warn about moved paths that appear as string literals."),
  /**
   * Non-source trees scanned as raw text — scripts, CI config, task
   * definitions. Empty by default: the source tree is scanned already, and
   * reading arbitrary trees byte-for-byte costs time and buys noise unless a
   * workspace knows it keeps paths in one.
   */
  textRoots: z.array(textScanRoot).default([]).describe("Non-source trees, such as scripts or CI config, scanned as raw text for path literals."),
  /**
   * How many path segments a literal must reproduce before it counts. This is
   * the false-positive boundary: a literal naming `src/index.ts` in a workspace
   * with a file of that path is far more likely to be a coincidence than a
   * reference, and a warning nobody trusts is worse than no warning. A moved
   * path with fewer segments than this is never reported at all.
   */
  minSegments: z.number().int().min(2).default(3).describe("Path segments a literal must reproduce before it counts as a reference."),
  /**
   * Also match a literal that names the path without its extension
   * (`apps/web/src/widgets/chart`), as bundler-resolved config and dynamic
   * loaders write it. Only literals whose last segment carries no dot are
   * matched this way, so `chart.tsx` never matches `chart.ts`.
   */
  matchExtensionless: z.boolean().default(true).describe("Also match literals naming a moved path without its extension."),
  /**
   * Files above this size are skipped by the raw-text scan. Bundles, lockfiles
   * and snapshots are where a path-shaped substring is most likely to be
   * accidental and least likely to be a reference anyone maintains.
   */
  maxBytes: z
    .number()
    .int()
    .positive()
    .default(512 * 1024)
    .describe("Files larger than this many bytes are skipped by the raw-text scan."),
});

/** Path-reference scanning policy for string references to moved files. */
export type PathReferencesConfig = z.output<typeof pathReferences>;

/**
 * Configuration root for path-reference rewriting. Each root declares a directory
 * that monocarve scans as raw text, detecting moved paths written as string
 * literals (e.g. "apps/web/src/widgets/chart.ts"), and rewrites them when
 * their sources move.
 *
 * This is a separate block from `pathReferences` because the warning scanner
 * is heuristic-only and reports what it finds, whereas this rewriter mutates
 * files under journal. Its matching rule is therefore strictly narrower:
 * `matchExtensionless` defaults to FALSE (not true like the scanner). A stem
 * token does not tell us which extension the replacement should carry, so
 * rewriting one is a guess—the warning scanner can afford to guess; the
 * rewriter may not.
 *
 * `onAmbiguousMatch: "refuse"` is the default because one token matching two
 * moved sources is a plan error, not a recovery case. When a workspace knows
 * its ambiguities should be skipped instead, it can declare that, and the
 * review will name every skipped reference by (file, line, column, reason).
 */
const pathRewriteRoot = z.strictObject({
  root: relativePath.describe("Repo-relative directory whose path literals may be rewritten."),
  extensions: z
    .array(z.string().regex(/^\./, "extension must start with a dot"))
    .min(1)
    .describe("File extensions rewritten in `root`, each starting with a dot."),
  mode: z.literal("exact-path-token").describe("Matching mode; only exact path tokens are rewritten."),
  /** Resolve shorthand tokens in this tree from this repo-relative base. */
  referenceBase: protectedPath.optional().describe("Repo-relative base from which shorthand tokens in this tree are resolved."),
});

export const pathReferenceRewrites = z.strictObject({
  enabled: z.boolean().default(false).describe("Rewrite moved path literals under journal during apply."),
  roots: z.array(pathRewriteRoot).default([]).describe("Trees scanned and rewritten, each with its extensions and matching mode."),
  onAmbiguousMatch: z.enum(["refuse", "skip"]).default("refuse").describe("Refuse the plan, or skip and report, when one token matches two moved sources."),
  matchExtensionless: z.boolean().default(false).describe("Also rewrite literals naming a moved path without its extension."),
  /**
   * Same false-positive floor as `pathReferences.minSegments`, applied to the
   * moved SOURCE rather than the scanned literal. Must not be looser (lower)
   * than `pathReferences.minSegments` — the scanner refuses to even warn about
   * a short path, so letting the rewriter mutate one it never warned about
   * would silently rewrite a reference nobody was told monocarve was watching.
   */
  minSegments: z
    .number()
    .int()
    .min(2)
    .default(3)
    .describe("Path segments a moved source must have before it is rewritten; must not be lower than `pathReferences.minSegments`."),
  maxBytes: z
    .number()
    .int()
    .positive()
    .default(512 * 1024)
    .describe("Files larger than this many bytes are not rewritten."),
});

/** Reviewed rewrites of path references in protected trees. */
export type PathReferenceRewritesConfig = z.output<typeof pathReferenceRewrites>;

/* -------------------------------------------------------------------------- */
/* Boundary preparation                                                       */
/* -------------------------------------------------------------------------- */

/**
 * `compositionBoundaries` and `portPromotions` are one mechanism described in
 * two vocabularies. Both exist to unblock a `retainedRoots` candidate by
 * telling the engine, exactly and by hand, what a retained edge should become
 * — never by letting the engine guess. `compositionBoundaries` speaks the
 * frontend's language (a shim gets replaced by a real package, or a portable
 * module imports a contract while the app keeps the concrete provider);
 * `portPromotions` speaks the backend's (a library depends on a port, the app
 * supplies the implementation). A later stage normalizes both into one
 * internal `ResolvedBoundary` shape so the builder, proofs, and audit are
 * written once; this file only defines the two surfaces a workspace author
 * actually writes.
 */
export const compositionBoundaries = z
  .array(
    z
      .strictObject({
        id: kebabId.describe("Unique kebab-case boundary id, used with `boundary --id`."),
        /** The app module that must NOT move. This is the retained edge being addressed. */
        retained: relativePath.describe("The application module that must not move; the retained edge being addressed."),
        /**
         * `"existing-package"`: the retained module is a shim for a package that
         * already exists — rewrite every consumer of the shim to import the real
         * package instead. `"port"`: the retained module is genuinely
         * app-specific — a portable module instead imports a contract, and the
         * app supplies the concrete implementation behind it.
         */
        strategy: z
          .enum(["existing-package", "port"])
          .describe("`existing-package` rewrites shim consumers to a real package; `port` has portable code import a contract the app implements."),
        /**
         * Required, and only meaningful, for `"existing-package"`. Naming the
         * exact specifier and the exact symbols it must export is what lets the
         * codemod rewrite consumers byte-for-byte instead of guessing at an
         * equivalent import — an unnamed symbol is refused, not silently
         * dropped.
         */
        replacement: z
          .strictObject({
            specifier: z.string().min(1).describe("Package specifier consumers are rewritten to."),
            symbols: z.array(z.string().min(1)).min(1).describe("Exact symbols the replacement package must export."),
          })
          .optional()
          .describe("Replacement package and symbols; required for `existing-package`."),
        /**
         * Once no importer of the shim remains, delete it. Defaults to false
         * because a shim can be intentionally long-lived (a compatibility
         * surface other tooling still expects); deletion is opt-in per boundary.
         */
        retire: z.boolean().default(false).describe("Delete the shim once no importer remains."),
        /** Rewrite only importers whose complete named surface is covered by replacement.symbols. */
        selective: z.boolean().default(false).describe("Rewrite only importers whose named imports are all covered by `replacement.symbols`."),
        /**
         * The five fields below are required together, and only for
         * `strategy: "port"`. `contract`/`contractModule` name the portable
         * package's contract interface; `appAdapter` is the app-owned file that
         * implements it; `packageImport` is how the portable module reaches the
         * contract; `symbols` is the exhaustive set of names the portable side
         * may consume. A config may not declare only some of these — the
         * engine never fills in a missing contract itself, because guessing one
         * is exactly the kind of silent correctness gap this tool exists to
         * refuse.
         */
        contract: z.string().min(1).optional().describe("Contract interface name; required for `port`."),
        contractModule: z.string().min(1).optional().describe("Module declaring the contract interface; required for `port`."),
        appAdapter: relativePath.optional().describe("Application-owned file implementing the contract; required for `port`."),
        packageImport: z.string().min(1).optional().describe("Specifier the portable module uses to reach the contract; required for `port`."),
        /** Exhaustive symbol list the portable side may import through `packageImport`. */
        symbols: z
          .array(z.string().min(1))
          .default([])
          .describe("Exhaustive symbols the portable side may import through `packageImport`; required for `port`."),
        /**
         * Id of a reviewed adapter template (see `scaffoldTemplates`). Adapter
         * code is generated only from a template a human has already reviewed —
         * never synthesized ad hoc.
         */
        template: z.string().min(1).optional().describe("Id of a reviewed adapter template in `scaffoldTemplates.extraFiles`."),
      })
      .superRefine((boundary, ctx) => {
        if (boundary.strategy === "existing-package" && boundary.replacement === undefined) {
          ctx.addIssue({ code: "custom", path: ["replacement"], message: 'strategy "existing-package" requires a "replacement" specifier and symbol list' });
        }
        if (boundary.selective && (boundary.strategy !== "existing-package" || boundary.retire)) {
          ctx.addIssue({ code: "custom", path: ["selective"], message: "selective boundaries require existing-package strategy with retire false" });
        }
        if (boundary.strategy === "port") {
          const required: readonly (keyof typeof boundary)[] = ["contract", "contractModule", "appAdapter", "packageImport"];
          for (const field of required) {
            if (boundary[field] === undefined) {
              ctx.addIssue({ code: "custom", path: [field], message: `strategy "port" requires "${field}"` });
            }
          }
          if (boundary.symbols.length === 0) {
            ctx.addIssue({ code: "custom", path: ["symbols"], message: 'strategy "port" requires a non-empty "symbols" list' });
          }
        }
      }),
  )
  .default([])
  .superRefine((boundaries, ctx) => {
    const seen = new Set<string>();
    for (const [index, boundary] of boundaries.entries()) {
      if (seen.has(boundary.id)) ctx.addIssue({ code: "custom", path: [index, "id"], message: "compositionBoundaries id must be unique" });
      seen.add(boundary.id);
    }
  });

export type CompositionBoundariesConfig = z.output<typeof compositionBoundaries>;
