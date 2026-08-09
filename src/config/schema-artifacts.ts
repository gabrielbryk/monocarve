import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";

import { TOOL_NAME } from "../branding.ts";
import { regexSource, relativePath } from "./primitives.ts";
import type { MonocarveConfig } from "./schema.ts";

export const generatedArtifacts = z.strictObject({
  provenance: z
    .strictObject({
      /** A file is generated when one of its first `headerLines` matches this. */
      marker: regexSource.default("@generated|DO NOT EDIT"),
      /** Capture group 1 yields the generating source path. */
      source: regexSource.default("^//\\s*Source(?:\\s+of\\s+truth)?:\\s*(.+)$"),
      /** Capture group 1 yields the regeneration command. */
      regenerate: regexSource.default("^//\\s*Regenerate:\\s*(.+)$"),
      headerLines: z.number().int().positive().default(12),
    })
    .prefault({}),
  /**
   * Per-regeneration timeout, in milliseconds.
   *
   * Deliberately its own field rather than `gates.timeoutMs`. A gate tier is a
   * whole lint/typecheck/test run and its budget is measured in tens of minutes;
   * a regeneration is one codegen command, and a generator that hangs should be
   * reported long before a plan has burned the gate budget it has not reached
   * yet. They are different kinds of command with different normal durations,
   * and one number cannot be right for both.
   */
  timeoutMs: z.number().int().positive().default(5 * 60 * 1000),
  artifacts: z
    .array(
      z.strictObject({
        /** The generated file, repo-relative. */
        path: relativePath,
        /** What it is generated from, repo-relative. */
        source: relativePath,
        /**
         * Shell command that regenerates it, run from the workspace root inside
         * the tree the plan is being applied to — the simulation worktree first,
         * then the real checkout during `apply --commit`. Recorded in the plan
         * so a reviewer can see it, and executed from *this* config so the
         * command that runs is one the repository declares rather than one a
         * manifest carries.
         */
        regenerate: z.string().min(1),
        /**
         * Regexes over moved paths. When any moved file matches, the artifact is
         * attached to the plan. Empty means "every extraction touches it".
         */
        triggers: z.array(regexSource).default([]),
        /**
         * Why the audit cannot hash-check it. Present means the artifact is
         * exempt from byte comparison and only its regeneration command is
         * carried; absent means the audit demands the recorded hash.
         */
        exemptReason: z.string().min(1).optional(),
      }),
    )
    .default([]),
});

export type GeneratedArtifactsConfig = z.output<typeof generatedArtifacts>;

/** One configured artifact: the generated file, its source, and its command. */
export type GeneratedArtifactConfig = GeneratedArtifactsConfig["artifacts"][number];

/**
 * Configured artifacts this set of moved paths invalidates.
 *
 * The single answer to "does this extraction touch that artifact?". Plan
 * compilation calls it to decide what the manifest records, and the transaction
 * calls it to decide what it regenerates — one predicate, so a plan can never
 * declare an artifact the transaction would skip, or skip one it declared.
 *
 * An artifact with no `triggers` is matched by every extraction; that is what
 * an empty list means, not "matched by nothing".
 */
export function triggeredArtifacts(
  config: MonocarveConfig,
  movedPaths: readonly string[],
): readonly GeneratedArtifactConfig[] {
  return config.generatedArtifacts.artifacts.filter((artifact) =>
    artifact.triggers.length === 0
      ? true
      : movedPaths.some((path) => artifact.triggers.some((pattern) => new RegExp(pattern).test(path))),
  );
}

/* -------------------------------------------------------------------------- */
/* Path-keyed artifacts                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Repository artifacts whose keys are workspace paths (complexity baselines,
 * coverage ledgers, ownership maps). A relocation does not invalidate their
 * values, but it does invalidate their keys.
 *
 * The configured command is a pure UTF-8 text filter. It receives one JSON object on
 * stdin: `{ artifact, contents, moves }`, where `moves` is the exact, sorted
 * source-to-target map declared by the plan. Its stdout is the complete UTF-8
 * replacement artifact. It runs in a disposable working directory, so relative
 * writes cannot leave workspace residue. Commands therefore need to be
 * self-contained and discoverable through `PATH`.
 */
export const pathMigrations = z.strictObject({
  timeoutMs: z.number().int().positive().default(5 * 60 * 1000),
  artifacts: z
    .array(
      z.strictObject({
        path: relativePath,
        command: z.string().min(1),
        /** Regexes over move sources. Empty means every extraction. */
        triggers: z.array(regexSource).default([]),
      }),
    )
    .superRefine((artifacts, context) => {
      const seen = new Set<string>();
      artifacts.forEach((artifact, index) => {
        if (seen.has(artifact.path)) {
          context.addIssue({ code: "custom", path: [index, "path"], message: `duplicate artifact path ${artifact.path}` });
        }
        seen.add(artifact.path);
      });
    })
    .default([]),
});

export type PathMigrationsConfig = z.output<typeof pathMigrations>;

/** Optional repository build proofs for emitted, tree-shaken assets. */
export const assetEmissionProofs = z.array(z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  command: z.string().min(1),
  roots: z.array(relativePath).min(1),
  extensions: z.array(z.string().regex(/^\./, "extension must start with a dot")).min(1),
  analyzer: z.literal("css-selectors"),
})).default([]).superRefine((items, context) => {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    if (seen.has(item.id)) context.addIssue({ code: "custom", path: [index, "id"], message: "asset-emission proof id must be unique" });
    seen.add(item.id);
  });
});

export type AssetEmissionProofConfig = z.output<typeof assetEmissionProofs>[number];

/** Declared-output commands which require the journal's moved tree. */
export const postJournalPreparers = z.array(z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  phase: z.literal("after-journal-before-gates"),
  command: z.string().min(1).optional(),
  replacements: z.array(z.strictObject({
    path: relativePath,
    before: z.string().min(1),
    after: z.string(),
    prefix: z.string().min(1).optional(),
    suffix: z.string().min(1).optional(),
  }).superRefine((replacement, ctx) => {
    if (replacement.prefix === undefined && replacement.suffix === undefined) ctx.addIssue({ code: "custom", message: "text replacement must configure prefix or suffix context" });
  })).min(1).optional(),
  creates: z.array(z.strictObject({ path: relativePath, contents: z.string(), mode: z.union([z.literal(0o644), z.literal(0o755)]).optional() })).min(1).optional(),
  outputs: z.array(relativePath).default([]),
  triggers: z.array(regexSource).default([]),
  verify: z.string().min(1).optional(),
  emittedModuleSpecifiers: z.array(z.strictObject({
    /** Generator/template source containing module specifiers emitted verbatim. */
    source: relativePath,
    /** Generated module whose directory is the emitted specifiers' resolution base. */
    resolutionBase: relativePath,
  })).default([]),
}).superRefine((item, context) => {
  if (item.command === undefined && item.replacements === undefined && item.creates === undefined) context.addIssue({ code: "custom", message: "post-journal preparer must configure command, replacements, or creates" });
})).default([]).superRefine((items, context) => {
  const ids = new Set<string>();
  const outputs = new Set<string>();
  items.forEach((item, index) => {
    if (ids.has(item.id)) context.addIssue({ code: "custom", path: [index, "id"], message: "post-journal preparer id must be unique" });
    ids.add(item.id);
    const creates = new Set(item.creates?.map((create) => create.path) ?? []);
    if (creates.size !== (item.creates?.length ?? 0)) context.addIssue({ code: "custom", path: [index, "creates"], message: "post-journal create path must be unique" });
    for (const replacement of item.replacements ?? []) {
      if (!item.outputs.includes(replacement.path)) context.addIssue({ code: "custom", path: [index, "replacements"], message: `post-journal replacement path is not a declared output: ${replacement.path}` });
      if (creates.has(replacement.path)) context.addIssue({ code: "custom", path: [index], message: `post-journal path cannot be both replaced and created: ${replacement.path}` });
    }
    for (const path of creates) if (item.outputs.includes(path)) context.addIssue({ code: "custom", path: [index, "creates"], message: `created path is automatically an output and must not be declared twice: ${path}` });
    for (const path of creates) {
      if (outputs.has(path)) context.addIssue({ code: "custom", path: [index, "creates"], message: `post-journal preparer output is duplicated: ${path}` });
      outputs.add(path);
    }
    item.outputs.forEach((output) => {
      if (outputs.has(output)) context.addIssue({ code: "custom", path: [index, "outputs"], message: `post-journal preparer output is duplicated: ${output}` });
      outputs.add(output);
    });
    const sources = new Set<string>();
    item.emittedModuleSpecifiers.forEach((declaration, declarationIndex) => {
      if (sources.has(declaration.source)) context.addIssue({ code: "custom", path: [index, "emittedModuleSpecifiers", declarationIndex, "source"], message: `emitted module specifier source is duplicated: ${declaration.source}` });
      sources.add(declaration.source);
      if (!item.outputs.includes(declaration.resolutionBase)) context.addIssue({ code: "custom", path: [index, "emittedModuleSpecifiers", declarationIndex, "resolutionBase"], message: "emitted module specifier resolutionBase must be one of the preparer's declared outputs" });
    });
  });
});

export type PostJournalPreparerConfig = z.output<typeof postJournalPreparers>[number];

/** Configured post-journal generators invalidated by moved or rewritten paths. */
export function triggeredPostJournalPreparers(
  config: MonocarveConfig,
  changedPaths: readonly string[],
): readonly PostJournalPreparerConfig[] {
  return config.postJournalPreparers.filter((preparer) =>
    preparer.triggers.length === 0 || changedPaths.some((path) => preparer.triggers.some((pattern) => new RegExp(pattern).test(path))),
  );
}
export type PathMigrationConfig = PathMigrationsConfig["artifacts"][number];

export function triggeredPathMigrations(
  config: MonocarveConfig,
  movedPaths: readonly string[],
): readonly PathMigrationConfig[] {
  return config.pathMigrations.artifacts.filter((artifact) =>
    artifact.triggers.length === 0
      ? true
      : movedPaths.some((path) => artifact.triggers.some((pattern) => new RegExp(pattern).test(path))),
  );
}

export const transaction = z.strictObject({
  /**
   * Repo-relative paths whose uncommitted changes may coexist with planning.
   *
   * This is intentionally an allow-list of paths, not a command-line escape
   * hatch: a plan remains tied to its baseline for every input and output it
   * describes.  The planner additionally rejects an allowed path when it
   * overlaps that baseline-sensitive set.
   */
  allowDirtyPaths: z.array(relativePath).default([]),
  /**
   * Where disposable simulation worktrees are created. Absolute, or
   * repo-relative — in which case it must be gitignored, since `apply` refuses
   * to run against a dirty tree. Defaults outside the repository for that reason.
   */
  worktreeRoot: z.string().min(1).default(join(tmpdir(), `${TOOL_NAME}-worktrees`)),
  /**
   * How the simulation worktree gets `node_modules`. `symlink` is the default
   * because a full install per simulation is minutes of wall clock for no added
   * signal; `install` exists for workspaces where symlinked deps break.
   */
  nodeModules: z.enum(["symlink", "install", "none"]).default("symlink"),
  /** Delete the simulation worktree when the run succeeds. */
  cleanup: z.boolean().default(true),
  /** Run the repository's gates inside the simulation before touching the real checkout. */
  simulateGates: z.boolean().default(true),
  /** Explicit retry count for each failed repository gate; every attempt remains evidence. */
  gateRetries: z.number().int().min(0).max(3).default(0),
});

export type TransactionConfig = z.output<typeof transaction>;
