import { z } from "zod";

import { SCRATCH_DIRNAME } from "../branding.ts";
import { DEFAULT_SOURCE_EXTENSIONS } from "../util/source-policy.ts";
import { regexSource, relativePath } from "./primitives.ts";
import { validateExtractionProfiles } from "./profiles.ts";
import { assetEmissionProofs, generatedArtifacts, pathMigrations, postJournalPreparers, transaction } from "./schema-artifacts.ts";
import { application, commitTemplates, extractionProfiles, firstPartyPackage, gates, preparationPolicy, preparers, scaffoldTemplates } from "./schema-core.ts";
import { generatedSourceAdoptions, graph, runtimeModuleRegistries } from "./schema-extensions.ts";
import { compositionBoundaries, integrationTestSuites, pathReferences, pathReferenceRewrites, portfolio, testKinds, testRelocation } from "./schema-policy.ts";
import { modulePromotions, portPromotions, valueSplits } from "./schema-promotions.ts";
import { validateFirstPartyPackages, validateIntegrationTestSuites, validateTestKinds } from "./validation.ts";

/**
 * Adapters the registry can actually build. The enums above still name the
 * unported ones so the registry seam keeps its exhaustive switch, but config
 * validation refuses them up front instead of failing later at runtime.
 */
export const SUPPORTED_PACKAGE_MANAGERS: readonly string[] = ["pnpm", "bun"];
export const SUPPORTED_TASK_RUNNERS: readonly string[] = ["moon", "none"];

function supportedOnly(supported: readonly string[], noun: string): (value: string, context: z.RefinementCtx) => void {
  return (value, context) => {
    if (!supported.includes(value)) context.addIssue({ code: "custom", message: `${value} is not supported yet; supported ${noun}: ${supported.join(", ")}` });
  };
}

/** Zod schema for the complete monocarve config; `parse` applies every default. */
export const monocarveConfigSchema = z
  .strictObject({
    /**
     * Repo root, relative to the config file. Almost always `"."` — override only
     * when the config lives in a subdirectory of the workspace it describes.
     */
    root: z.string().default(".").describe("Repo root, relative to the config file; almost always `.`."),

    /** Applications whose code can be carved up. At least one. */
    applications: z.array(application).min(1).describe("Applications whose code can be carved into packages; at least one."),

    /**
     * Directories that hold workspace packages, in preference order
     * (e.g. `["libs", "packages"]`). New packages are created under the first
     * entry unless a plan overrides it. Also used to classify an import as
     * "already a package" during eligibility checks.
     */
    packageRoots: z.array(relativePath).min(1).describe("Directories holding workspace packages, in preference order; new packages go under the first."),

    /** npm scope prefix for generated package names, e.g. `"@acme/"` or `""`. */
    packageScope: z.string().default("").describe("npm scope prefix for generated package names, e.g. `@acme/`."),

    /**
     * Roots that are first-party but neither an application nor a package root —
     * generated output, a shared directory, vendored-in code the graph must still
     * see. Imports into these are first-party edges, not external dependencies.
     */
    firstPartyRoots: z
      .array(relativePath)
      .default([])
      .describe("First-party roots that are neither applications nor package roots; imports into them are first-party edges."),

    /**
     * First-party packages that live at an exact root — the root itself is one
     * package, not a `packageRoots`-style container of many. Distinct from
     * `firstPartyRoots`: entries here carry a declared package `name`, so a
     * bare-specifier import of that name resolves to this root for dependency
     * inference even before, or without, an on-disk `package.json` scan.
     */
    firstPartyPackages: z
      .array(firstPartyPackage)
      .default([])
      .describe("First-party packages at an exact root, with a declared name for bare-specifier resolution."),

    /** Source module extensions understood by this workspace's compiler policy. */
    sourceExtensions: z
      .array(z.string().regex(/^\./, "extension must start with a dot"))
      .min(1)
      .default([...DEFAULT_SOURCE_EXTENSIONS])
      .describe("Source module extensions understood by this workspace's compiler policy."),

    /**
     * Regex a generated package name must match. Defaults to the configured scope
     * followed by a kebab-case name. Override for workspaces with a different
     * naming convention.
     */
    packageNamePattern: regexSource.optional().describe("Regex a generated package name must match; defaults to the scope followed by a kebab-case name."),

    /** Selects the package-manager adapter: workspace membership + lockfile ops. */
    packageManager: z
      .enum(["pnpm", "bun", "npm", "yarn"])
      .default("pnpm")
      .superRefine(supportedOnly(SUPPORTED_PACKAGE_MANAGERS, "package managers"))
      .describe("Package-manager adapter for workspace membership and lockfile operations; supported: `pnpm`, `bun`."),

    /** Selects the task-runner adapter: project files and gate invocation. */
    taskRunner: z
      .enum(["moon", "nx", "turbo", "none"])
      .default("none")
      .superRefine(supportedOnly(SUPPORTED_TASK_RUNNERS, "task runners"))
      .describe("Task-runner adapter for project files and gate invocation; supported: `moon`, `none`."),

    gates: gates.prefault({}).describe("Repository gate commands run after an extraction, by package, project, and workspace tier."),
    commitTemplates: commitTemplates.prefault({}).describe("Conventional Commit subjects and trailer for the commits `apply` creates."),
    /** Repository-owned policy for type-only source preparation. */
    preparation: preparationPolicy.describe("Repository-owned gates and commit policy for type-only declaration preparation."),
    /** Repository-owned, declared-output commands run before an extraction. */
    preparers: preparers.describe("Repository-owned, declared-output commands or edits run before an extraction."),

    /**
     * Regexes matching test files. Tests travel with the code they cover, are
     * excluded from the public-surface analysis, and land as devDependencies
     * rather than dependencies of the new package.
     */
    // Classification rules are a workspace convention. An empty list is an
    // intentional declaration that this repository has no separately-classified
    // test paths; guessing common naming schemes would silently change a plan.
    testPathPatterns: z.array(regexSource).default([]).describe("Regexes matching test files, which travel with their code as devDependencies."),
    testKinds: testKinds.describe("Explicit test intent by path pattern; when present it replaces `testPathPatterns`."),

    testRelocation: testRelocation.prefault({}).describe("How co-located tests follow extracted modules: `all-importers` or `self-contained`."),
    integrationTestSuites: integrationTestSuites
      .default({})
      .describe("Configured integration-test suites that `relocate-tests` can compile into leaf packages."),

    /** Qualified calls whose first argument is a module specifier, such as a workspace's mock API. */
    moduleSpecifierCalls: z
      .array(z.string().regex(/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/u))
      .default([])
      .describe("Qualified calls whose first argument is a module specifier, such as a mock API."),

    /**
     * Non-TS extensions treated as movable assets. An asset reachable by relative
     * import from the closure moves WITH it, byte-identical, and therefore does
     * not count as a containment violation.
     */
    assetExtensions: z
      .array(z.string().regex(/^\./, "extension must start with a dot"))
      // The asset formats a repository moves are part of its source policy, not
      // a property of this tool. No declaration means no extension is assumed.
      .default([])
      .describe("Non-TypeScript extensions treated as movable assets that travel byte-identical with their closure."),

    /** Configured asset extensions whose files use ordered CSS `@import` syntax. */
    cssImportExtensions: z
      .array(z.string().regex(/^\./, "extension must start with a dot"))
      .default([])
      .describe("Asset extensions whose files use ordered CSS `@import` syntax; each must also be an asset extension."),

    /** Branches on which `apply` refuses to commit. Empty means none are declared. */
    guardedBranches: z.array(z.string().min(1)).default([]).describe("Branches on which `apply` refuses to commit."),

    scaffoldTemplates: scaffoldTemplates.describe("Templates for the files scaffolded into a new workspace package."),
    portfolio: portfolio.prefault({}).describe("Candidate domain, eligibility, scoring, and recommendation policy."),
    graph: graph.prefault({}).describe("Dependency-graph scanning options."),
    pathReferences: pathReferences.prefault({}).describe("Static path-string references that must be tracked when files move."),
    pathReferenceRewrites: pathReferenceRewrites.prefault({}).describe("Rules for rewriting path-string references to moved files."),
    runtimeModuleRegistries: runtimeModuleRegistries.describe("JSON-pointer fields in registry files whose module paths resolve from a declared root."),
    /**
     * Frontend vocabulary for boundary preparation: replace an app shim with a
     * real package, or split a retained module into a portable contract plus an
     * app-owned adapter. See `src/config/schema-policy.ts` for why this and
     * `portPromotions` are one mechanism with two config surfaces.
     */
    compositionBoundaries: compositionBoundaries.describe(
      "Frontend boundary preparations: replace an app shim with a package, or split a contract from its adapter.",
    ),
    /** Backend vocabulary for the same boundary-preparation mechanism. */
    portPromotions: portPromotions.describe("Backend boundary preparations that promote a port contract out of an application."),
    modulePromotions: modulePromotions.describe("Reviewed promotions of one complete module to a byte-identical package surface."),
    valueSplits: valueSplits.describe("Reviewed extractions of one dependency-closed exported value SCC from a mixed module."),
    generatedSourceAdoptions: generatedSourceAdoptions.describe("Reviewed adoptions of orphaned generated output as durable source."),
    transaction: transaction.prefault({}).describe("Simulation worktree, dirty-path, and gate-retry policy for applying plans."),
    generatedArtifacts: generatedArtifacts.prefault({}).describe("Generated files that gates or generators produce and plans must declare."),
    pathMigrations: pathMigrations.prefault({}).describe("Commands that rewrite path-bearing artifacts after files move."),
    assetEmissionProofs: assetEmissionProofs.describe("Optional repository build proofs that emitted, tree-shaken assets survive a move."),
    postJournalPreparers: postJournalPreparers.describe("Declared-output preparers that need the journal's moved tree; run before gates."),
    /** Report possible donor orphans; removal requires an explicit workspace policy. */
    dependencyPruning: z
      .strictObject({
        mode: z.enum(["report", "apply"]).default("report").describe("Whether possible donor orphan dependencies are only reported or removed."),
        /** Dependencies retained by repository policy even when no import evidence exists. */
        keep: z.array(z.string().min(1)).default([]).describe("Dependencies retained by repository policy even without import evidence."),
      })
      .prefault({})
      .describe("Report or remove donor dependencies left unused by an extraction."),
    extractionProfiles: extractionProfiles.prefault({}).describe("Named package-kind profiles with destination, naming, scaffold, and gate overrides."),

    /** Where compiled plan manifests are written. */
    planDir: relativePath.default(`${SCRATCH_DIRNAME}/plans`).describe("Where compiled plan manifests are written."),
    /** Git-ignored operational campaign state; unlike reviewed plans this is mutable. */
    campaignDir: relativePath.default(`${SCRATCH_DIRNAME}/campaigns`).describe("Git-ignored directory for mutable campaign ledgers."),
  })
  .superRefine((config, ctx) => {
    validateExtractionProfiles(config, ctx);
    validateIntegrationTestSuites(config, ctx);
    validateTestKinds(config, ctx);
    validateFirstPartyPackages(config, ctx);
    const boundaryIds = new Map<string, string>();
    for (const item of config.compositionBoundaries) boundaryIds.set(item.id, "compositionBoundaries");
    for (const item of config.portPromotions) if (!boundaryIds.has(item.id)) boundaryIds.set(item.id, "portPromotions");
    for (const [field, items] of [
      ["modulePromotions", config.modulePromotions],
      ["valueSplits", config.valueSplits],
      ["generatedSourceAdoptions", config.generatedSourceAdoptions],
    ] as const) {
      items.forEach((item, index) => {
        const prior = boundaryIds.get(item.id);
        if (prior !== undefined) ctx.addIssue({ code: "custom", path: [field, index, "id"], message: `boundary id is already declared in ${prior}` });
        else boundaryIds.set(item.id, field);
      });
    }
    config.cssImportExtensions.forEach((extension, index) => {
      if (!config.assetExtensions.includes(extension))
        ctx.addIssue({ code: "custom", path: ["cssImportExtensions", index], message: "CSS import extension must also be an asset extension" });
    });
  });

/** Fully-defaulted, validated configuration. */
export type MonocarveConfig = z.output<typeof monocarveConfigSchema>;

/** Shape a user writes; every defaulted field is optional. */
export type MonocarveUserConfig = z.input<typeof monocarveConfigSchema>;

/** Identity helper giving editors completion and type errors in a `.ts` config. */
export function defineConfig(config: MonocarveUserConfig): MonocarveUserConfig {
  return config;
}

/* -------------------------------------------------------------------------- */
