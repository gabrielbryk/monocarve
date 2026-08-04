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
    })
    .prefault({}),
  /** Candidate ids already extracted; `next`/`backlog` skip these. */
  extracted: z.array(z.string()).default([]),
  /**
   * Files or directory trees a candidate must never move. A value protects that
   * exact path and its descendants; similarly named siblings remain eligible.
   */
  protectedPaths: z.array(protectedPath).default([]),
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
