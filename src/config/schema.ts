import { z } from "zod";

import { SCRATCH_DIRNAME } from "../branding.ts";
import { DEFAULT_SOURCE_EXTENSIONS } from "../util/source-policy.ts";
import { regexSource, relativePath } from "./primitives.ts";
import { validateExtractionProfiles } from "./profiles.ts";
import { assetEmissionProofs, generatedArtifacts, pathMigrations, postJournalPreparers, transaction } from "./schema-artifacts.ts";
import { application, commitTemplates, extractionProfiles, firstPartyPackage, gates, preparationPolicy, preparers, scaffoldTemplates } from "./schema-core.ts";
import { generatedSourceAdoptions, graph, runtimeModuleRegistries } from "./schema-extensions.ts";
import {
  compositionBoundaries,
  integrationTestSuites,
  modulePromotions,
  pathReferences,
  pathReferenceRewrites,
  portfolio,
  portPromotions,
  testKinds,
  testRelocation,
  valueSplits,
} from "./schema-policy.ts";
import { validateFirstPartyPackages, validateIntegrationTestSuites, validateTestKinds } from "./validation.ts";

/**
 * Adapters the registry can actually build. The enums above still name the
 * unported ones so the registry seam keeps its exhaustive switch, but config
 * validation refuses them up front instead of failing later at runtime.
 */
const SUPPORTED_PACKAGE_MANAGERS: readonly string[] = ["pnpm", "bun"];
const SUPPORTED_TASK_RUNNERS: readonly string[] = ["moon", "none"];

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
    root: z.string().default("."),

    /** Applications whose code can be carved up. At least one. */
    applications: z.array(application).min(1),

    /**
     * Directories that hold workspace packages, in preference order
     * (e.g. `["libs", "packages"]`). New packages are created under the first
     * entry unless a plan overrides it. Also used to classify an import as
     * "already a package" during eligibility checks.
     */
    packageRoots: z.array(relativePath).min(1),

    /** npm scope prefix for generated package names, e.g. `"@acme/"` or `""`. */
    packageScope: z.string().default(""),

    /**
     * Roots that are first-party but neither an application nor a package root —
     * generated output, a shared directory, vendored-in code the graph must still
     * see. Imports into these are first-party edges, not external dependencies.
     */
    firstPartyRoots: z.array(relativePath).default([]),

    /**
     * First-party packages that live at an exact root — the root itself is one
     * package, not a `packageRoots`-style container of many. Distinct from
     * `firstPartyRoots`: entries here carry a declared package `name`, so a
     * bare-specifier import of that name resolves to this root for dependency
     * inference even before, or without, an on-disk `package.json` scan.
     */
    firstPartyPackages: z.array(firstPartyPackage).default([]),

    /** Source module extensions understood by this workspace's compiler policy. */
    sourceExtensions: z
      .array(z.string().regex(/^\./, "extension must start with a dot"))
      .min(1)
      .default([...DEFAULT_SOURCE_EXTENSIONS]),

    /**
     * Regex a generated package name must match. Defaults to the configured scope
     * followed by a kebab-case name. Override for workspaces with a different
     * naming convention.
     */
    packageNamePattern: regexSource.optional(),

    /** Selects the package-manager adapter: workspace membership + lockfile ops. */
    packageManager: z.enum(["pnpm", "bun", "npm", "yarn"]).default("pnpm").superRefine(supportedOnly(SUPPORTED_PACKAGE_MANAGERS, "package managers")),

    /** Selects the task-runner adapter: project files and gate invocation. */
    taskRunner: z.enum(["moon", "nx", "turbo", "none"]).default("none").superRefine(supportedOnly(SUPPORTED_TASK_RUNNERS, "task runners")),

    gates: gates.prefault({}),
    commitTemplates: commitTemplates.prefault({}),
    /** Repository-owned policy for type-only source preparation. */
    preparation: preparationPolicy,
    /** Repository-owned, declared-output commands run before an extraction. */
    preparers,

    /**
     * Regexes matching test files. Tests travel with the code they cover, are
     * excluded from the public-surface analysis, and land as devDependencies
     * rather than dependencies of the new package.
     */
    // Classification rules are a workspace convention. An empty list is an
    // intentional declaration that this repository has no separately-classified
    // test paths; guessing common naming schemes would silently change a plan.
    testPathPatterns: z.array(regexSource).default([]),
    testKinds,

    testRelocation: testRelocation.prefault({}),
    integrationTestSuites: integrationTestSuites.default({}),

    /** Qualified calls whose first argument is a module specifier, such as a workspace's mock API. */
    moduleSpecifierCalls: z.array(z.string().regex(/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/u)).default([]),

    /**
     * Non-TS extensions treated as movable assets. An asset reachable by relative
     * import from the closure moves WITH it, byte-identical, and therefore does
     * not count as a containment violation.
     */
    assetExtensions: z
      .array(z.string().regex(/^\./, "extension must start with a dot"))
      // The asset formats a repository moves are part of its source policy, not
      // a property of this tool. No declaration means no extension is assumed.
      .default([]),

    /** Configured asset extensions whose files use ordered CSS `@import` syntax. */
    cssImportExtensions: z.array(z.string().regex(/^\./, "extension must start with a dot")).default([]),

    /** Branches on which `apply` refuses to commit. Empty means none are declared. */
    guardedBranches: z.array(z.string().min(1)).default([]),

    scaffoldTemplates,
    portfolio: portfolio.prefault({}),
    graph: graph.prefault({}),
    pathReferences: pathReferences.prefault({}),
    pathReferenceRewrites: pathReferenceRewrites.prefault({}),
    runtimeModuleRegistries,
    /**
     * Frontend vocabulary for boundary preparation: replace an app shim with a
     * real package, or split a retained module into a portable contract plus an
     * app-owned adapter. See `src/config/schema-policy.ts` for why this and
     * `portPromotions` are one mechanism with two config surfaces.
     */
    compositionBoundaries,
    /** Backend vocabulary for the same boundary-preparation mechanism. */
    portPromotions,
    modulePromotions,
    valueSplits,
    generatedSourceAdoptions,
    transaction: transaction.prefault({}),
    generatedArtifacts: generatedArtifacts.prefault({}),
    pathMigrations: pathMigrations.prefault({}),
    assetEmissionProofs,
    postJournalPreparers,
    /** Report possible donor orphans; removal requires an explicit workspace policy. */
    dependencyPruning: z
      .strictObject({
        mode: z.enum(["report", "apply"]).default("report"),
        /** Dependencies retained by repository policy even when no import evidence exists. */
        keep: z.array(z.string().min(1)).default([]),
      })
      .prefault({}),
    extractionProfiles: extractionProfiles.prefault({}),

    /** Where compiled plan manifests are written. */
    planDir: relativePath.default(`${SCRATCH_DIRNAME}/plans`),
    /** Git-ignored operational campaign state; unlike reviewed plans this is mutable. */
    campaignDir: relativePath.default(`${SCRATCH_DIRNAME}/campaigns`),
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
