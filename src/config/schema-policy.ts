import { z } from "zod";

import { protectedPath, regexSource, relativePath } from "./primitives.ts";

const domain = z.strictObject({
  name: z.string().min(1),
  patterns: z.array(regexSource).min(1),
});

export const portfolio = z.strictObject({
  domains: z.array(domain).default([]),
  /**
   * Directory prefixes (relative to an application `sourceRoot`) whose
   * immediate children are each their own domain. Without this a directory
   * like `components/` collapses hundreds of unrelated features into one
   * domain and every candidate looks like it crosses nothing.
   */
  nestedDomainRoots: z.array(z.string().min(1)).default([]),
  /**
   * Packages whose presence makes a component framework-coupled: it is a
   * runtime adapter or UI, not portable logic. Scores down and drives the
   * scaffold profile; it is never on its own a rejection.
   */
  frameworkPackages: z.array(z.string().min(1)).default([]),
  /**
   * Regexes matching files that compose the application at runtime, on top of
   * each application's explicit `compositionRoots`. A closure containing one is
   * rejected: entrypoints and wiring never leave.
   */
  compositionRootPatterns: z.array(regexSource).default([]),
  /** Closures smaller than this are noise; larger than this are unreviewable. */
  minFiles: z.number().int().positive().default(2),
  maxFiles: z.number().int().positive().default(120),
  /** Scoring weights. Negative values penalize; the ranking is a plain sum. */
  weights: z
    .strictObject({
      lineCount: z.number().default(1),
      consumerCount: z.number().default(10),
      fileCount: z.number().default(5),
      testCoverage: z.number().default(50),
      domainCrossing: z.number().default(-500),
      rewriteEscape: z.number().default(-100),
      /** Per existing workspace package the closure already depends on. */
      prerequisite: z.number().default(-12),
      /**
       * Per blocking reason. Large and negative so that no ineligible candidate
       * can outrank an eligible one on size alone, while blocked candidates
       * still order sensibly against each other in `backlog`.
       */
      rejection: z.number().default(-1000),
      /**
       * Per retained-root blocker (see `retainedRoots`). Large and negative,
       * like `rejection`, but smaller in magnitude: a preparation candidate is
       * still real, ranked work — it should sort below genuinely extractable
       * candidates, not below every rejected one.
       */
      retainedEdge: z.number().default(-250),
      /**
       * Applied once when a candidate's closure spans more than one runtime
       * domain (browser vs. server, for example). Distinct from
       * `domainCrossing`, which scores an application-declared `domains` split;
       * this scores a difference the graph itself proves — a closure that
       * imports across a runtime boundary cannot be a single portable package
       * no matter how the domains are configured.
       */
      runtimeCrossing: z.number().default(-300),
    })
    .prefault({}),
  /** Candidate ids already extracted; `next`/`backlog` skip these. */
  extracted: z.array(z.string()).default([]),
  /**
   * Files or directory trees a candidate must never move. A value protects that
   * exact path and its descendants; similarly named siblings remain eligible.
   */
  protectedPaths: z.array(protectedPath).default([]),
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
  retainedRoots: z.array(relativePath).default([]),
  /**
   * Target shapes a candidate is not allowed to resolve to. Currently only
   * `"root"`: a candidate whose only sensible target is the root package
   * itself is not a distinct extractable unit — it is evidence the candidate
   * still needs preparation (see `retainedRoots`), so it is classified
   * `"preparation"` rather than rejected outright or offered as a genuine
   * extraction target.
   */
  forbidTargetSuggestion: z.array(z.enum(["root"])).default([]),
});

export type PortfolioConfig = z.output<typeof portfolio>;

/**
 * How co-located tests participate in an extraction. Both strategies retain a
 * test that reaches app-local support outside the moved closure, because that
 * support must not be pulled into a production package. The default still
 * permits computed test-only references; `self-contained` refuses them.
 */
export const testRelocation = z.strictObject({
  strategy: z.enum(["all-importers", "self-contained"]).default("all-importers"),
});

export type TestRelocationConfig = z.output<typeof testRelocation>;

/** Explicit test intent. When present it replaces the legacy flat matcher. */
export const testKinds = z.strictObject({
  unit: z.array(regexSource).default([]),
  integration: z.array(regexSource).default([]),
  e2e: z.array(regexSource).default([]),
}).optional();

export type TestKind = "unit" | "integration" | "e2e";
export type TestKindsConfig = z.output<typeof testKinds>;

/**
 * A config-declared integration-test suite that can be relocated as a leaf
 * workspace package.  Unlike a production extraction it has no public barrel:
 * its only permitted application edges are the explicit donor surfaces below.
 */
export const integrationTestSuite = z.strictObject({
  /** Application whose published test surface the suite is allowed to consume. */
  application: z.string().min(1),
  /** Package-kind profile that renders the leaf test package. */
  profile: z.string().min(1),
  /** Directory containing the suite's test modules, repo-relative. */
  sourceRoot: relativePath,
  /** Regexes selecting the test modules below sourceRoot. */
  patterns: z.array(regexSource).min(1),
  /** Exact application source paths that may be rewritten to published specifiers. */
  donorImports: z.array(z.strictObject({ source: relativePath, specifier: z.string().min(1) })).default([]),
});

export const integrationTestSuites = z.record(
  z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "must be a lowercase kebab-case identifier"),
  integrationTestSuite,
).default({});

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
export const textScanRoot = z.strictObject({
  root: relativePath,
  extensions: z.array(z.string().regex(/^\./, "extension must start with a dot")).min(1),
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
  enabled: z.boolean().default(true),
  /**
   * Non-source trees scanned as raw text — scripts, CI config, task
   * definitions. Empty by default: the source tree is scanned already, and
   * reading arbitrary trees byte-for-byte costs time and buys noise unless a
   * workspace knows it keeps paths in one.
   */
  textRoots: z.array(textScanRoot).default([]),
  /**
   * How many path segments a literal must reproduce before it counts. This is
   * the false-positive boundary: a literal naming `src/index.ts` in a workspace
   * with a file of that path is far more likely to be a coincidence than a
   * reference, and a warning nobody trusts is worse than no warning. A moved
   * path with fewer segments than this is never reported at all.
   */
  minSegments: z.number().int().min(2).default(3),
  /**
   * Also match a literal that names the path without its extension
   * (`apps/web/src/widgets/chart`), as bundler-resolved config and dynamic
   * loaders write it. Only literals whose last segment carries no dot are
   * matched this way, so `chart.tsx` never matches `chart.ts`.
   */
  matchExtensionless: z.boolean().default(true),
  /**
   * Files above this size are skipped by the raw-text scan. Bundles, lockfiles
   * and snapshots are where a path-shaped substring is most likely to be
   * accidental and least likely to be a reference anyone maintains.
   */
  maxBytes: z.number().int().positive().default(512 * 1024),
});

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
export const pathRewriteRoot = z.strictObject({
  root: relativePath,
  extensions: z.array(z.string().regex(/^\./, "extension must start with a dot")).min(1),
  mode: z.literal("exact-path-token"),
});

export const pathReferenceRewrites = z.strictObject({
  enabled: z.boolean().default(false),
  roots: z.array(pathRewriteRoot).default([]),
  onAmbiguousMatch: z.enum(["refuse", "skip"]).default("refuse"),
  matchExtensionless: z.boolean().default(false),
  /**
   * Same false-positive floor as `pathReferences.minSegments`, applied to the
   * moved SOURCE rather than the scanned literal. Must not be looser (lower)
   * than `pathReferences.minSegments` — the scanner refuses to even warn about
   * a short path, so letting the rewriter mutate one it never warned about
   * would silently rewrite a reference nobody was told monocarve was watching.
   */
  minSegments: z.number().int().min(2).default(3),
  maxBytes: z.number().int().positive().default(512 * 1024),
});

export type PathReferenceRewritesConfig = z.output<typeof pathReferenceRewrites>;

/* -------------------------------------------------------------------------- */
/* Boundary preparation                                                       */
/* -------------------------------------------------------------------------- */

const kebabId = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "must be a lowercase kebab-case identifier");

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
        id: kebabId,
        /** The app module that must NOT move. This is the retained edge being addressed. */
        retained: relativePath,
        /**
         * `"existing-package"`: the retained module is a shim for a package that
         * already exists — rewrite every consumer of the shim to import the real
         * package instead. `"port"`: the retained module is genuinely
         * app-specific — a portable module instead imports a contract, and the
         * app supplies the concrete implementation behind it.
         */
        strategy: z.enum(["existing-package", "port"]),
        /**
         * Required, and only meaningful, for `"existing-package"`. Naming the
         * exact specifier and the exact symbols it must export is what lets the
         * codemod rewrite consumers byte-for-byte instead of guessing at an
         * equivalent import — an unnamed symbol is refused, not silently
         * dropped.
         */
        replacement: z
          .strictObject({
            specifier: z.string().min(1),
            symbols: z.array(z.string().min(1)).min(1),
          })
          .optional(),
        /**
         * Once no importer of the shim remains, delete it. Defaults to false
         * because a shim can be intentionally long-lived (a compatibility
         * surface other tooling still expects); deletion is opt-in per boundary.
         */
        retire: z.boolean().default(false),
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
        contract: z.string().min(1).optional(),
        contractModule: z.string().min(1).optional(),
        appAdapter: relativePath.optional(),
        packageImport: z.string().min(1).optional(),
        /** Exhaustive symbol list the portable side may import through `packageImport`. */
        symbols: z.array(z.string().min(1)).default([]),
        /**
         * Id of a reviewed adapter template (see `scaffoldTemplates`). Adapter
         * code is generated only from a template a human has already reviewed —
         * never synthesized ad hoc.
         */
        template: z.string().min(1).optional(),
      })
      .superRefine((boundary, ctx) => {
        if (boundary.strategy === "existing-package" && boundary.replacement === undefined) {
          ctx.addIssue({
            code: "custom",
            path: ["replacement"],
            message: 'strategy "existing-package" requires a "replacement" specifier and symbol list',
          });
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

/** `path/to/file.ts#TypeName` — a file path, a `#`, and an exported type name. */
const concreteTypeReference = z
  .string()
  .min(1)
  .regex(/^[^#\s]+\.tsx?#[A-Za-z_$][\w$]*$/, 'must be "path/to/file.ts#TypeName"');

/**
 * The backend vocabulary for the same boundary-preparation mechanism as
 * `compositionBoundaries`. A `portPromotion` names a library port (an
 * interface the portable package depends on), the app-owned concrete type
 * that currently satisfies it in place, and the package the port itself
 * should live in. As with `compositionBoundaries`, every field is required
 * together — a half-declared promotion fails to load rather than letting the
 * engine invent the missing half.
 */
export const portPromotions = z
  .array(
    z.strictObject({
      id: kebabId,
      /** App-owned roots this promotion is meant to unblock; at least one. */
      retainedRoots: z.array(relativePath).min(1),
      /** Package the port contract is declared in. */
      contractPackage: z.string().min(1),
      /** Module within `contractPackage` that exports the port. */
      contractModule: z.string().min(1),
      /** The app's current concrete type, as `"path/to/file.ts#TypeName"`. */
      appConcreteType: concreteTypeReference,
      /** Name of the port interface the library depends on instead. */
      libraryPort: z.string().min(1),
      /** Package the port declaration is promoted into. */
      targetPackage: z.string().min(1),
    }),
  )
  .default([])
  .superRefine((promotions, ctx) => {
    const seen = new Set<string>();
    for (const [index, promotion] of promotions.entries()) {
      if (seen.has(promotion.id)) ctx.addIssue({ code: "custom", path: [index, "id"], message: "portPromotions id must be unique" });
      seen.add(promotion.id);
    }
  });

export type PortPromotionsConfig = z.output<typeof portPromotions>;

/**
 * Reviewed exception to SCC-closure selection: promote one complete module as
 * a byte-identical package surface and let the compiler derive every importer.
 */
export const modulePromotions = z.array(z.strictObject({
  id: kebabId,
  source: relativePath,
  targetPackage: z.string().min(1),
  /** Public module key relative to the package root, without an extension. */
  targetModule: z.string().min(1).default("index"),
  /** False retains a compatibility re-export at the old path. */
  retireSource: z.boolean().default(true),
})).default([]).superRefine((items, ctx) => {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    if (seen.has(item.id)) ctx.addIssue({ code: "custom", path: [index, "id"], message: "modulePromotions id must be unique" });
    seen.add(item.id);
  });
});

export type ModulePromotionsConfig = z.output<typeof modulePromotions>;

/**
 * Reviewed exception for extracting one dependency-closed exported value SCC
 * from a mixed module. The compiler selects the declaration group itself and
 * retains a compatibility re-export at the donor; it never accepts declaration
 * spans or generated source text from configuration.
 */
export const valueSplits = z.array(z.strictObject({
  id: kebabId,
  source: relativePath,
  symbol: z.string().regex(/^[A-Za-z_$][\w$]*$/u, "must be a TypeScript identifier"),
  target: relativePath,
  /** Exact specifier rendered from the donor to the target module. */
  targetModuleSpecifier: z.string().min(1),
})).default([]).superRefine((items, ctx) => {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    if (seen.has(item.id)) ctx.addIssue({ code: "custom", path: [index, "id"], message: "valueSplits id must be unique" });
    seen.add(item.id);
    if (item.source === item.target) ctx.addIssue({ code: "custom", path: [index, "target"], message: "value split target must differ from source" });
  });
});

export type ValueSplitsConfig = z.output<typeof valueSplits>;

/** Explicit adoption of orphaned generated output as durable source. */
export const generatedSourceAdoptions = z.array(z.strictObject({
  id: kebabId,
  /** Application-owned path used to render repository policy for package-only adoptions. */
  policyAnchor: relativePath.optional(),
  artifacts: z.array(z.strictObject({
    path: relativePath,
    /** Must equal the missing source declared by the artifact header. */
    missingSource: relativePath,
    /** Exact leading line count removed from the artifact. */
    removeHeaderLines: z.number().int().positive(),
  })).min(1),
  /** Optional generator retired only when no other provenance header names it. */
  retireGenerator: relativePath.optional(),
})).default([]).superRefine((items, ctx) => {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    if (seen.has(item.id)) ctx.addIssue({ code: "custom", path: [index, "id"], message: "generatedSourceAdoptions id must be unique" });
    seen.add(item.id);
  });
});

export type GeneratedSourceAdoptionsConfig = z.output<typeof generatedSourceAdoptions>;

export const graph = z.strictObject({
  /**
   * Resolve type-only imports too. Required: a type-only edge is still a
   * containment violation, and missing it produces plans that do not compile.
   * Maps to dependency-cruiser's `--ts-pre-compilation-deps`.
   */
  tsPreCompilationDeps: z.boolean().default(true),
  /** Extra dependency-cruiser config to merge, repo-relative. */
  cruiserConfig: relativePath.optional(),
  /**
   * Patterns excluded from the scan entirely (vendored trees, generated code).
   *
   * Empty by default, and it should usually stay that way. An excluded module
   * does not merely vanish from the node list — dependency-cruiser also drops
   * every *edge pointing at it*, so excluding a path silently deletes facts the
   * model needs. In particular `node_modules` must NOT be listed here: dropping
   * those edges erases the external-package inventory, and the scaffolded
   * `package.json` then omits the runtime dependencies the moved code imports.
   * Traversal into `node_modules` is already prevented by `doNotFollow`, and
   * non-first-party modules are filtered out of the node set regardless.
   */
  exclude: z.array(z.string().min(1)).default([]),
  /** Cache scans keyed by tree hash. Disable when debugging the scanner. */
  cache: z.boolean().default(true),
});

export type GraphConfig = z.output<typeof graph>;
