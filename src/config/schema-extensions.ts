import { z } from "zod";

import { relativePath } from "./primitives.ts";

const kebabId = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "must be a lowercase kebab-case identifier");

/** Explicit adoption of orphaned generated output as durable source. */
export const generatedSourceAdoptions = z
  .array(
    z.strictObject({
      id: kebabId,
      /** Application-owned path used to render repository policy for package-only adoptions. */
      policyAnchor: relativePath.optional(),
      artifacts: z
        .array(
          z.strictObject({
            path: relativePath,
            /** Must equal the missing source declared by the artifact header. */
            missingSource: relativePath,
            /** Exact leading line count removed from the artifact. */
            removeHeaderLines: z.number().int().positive(),
          }),
        )
        .min(1),
      /** Optional generator retired only when no other provenance header names it. */
      retireGenerator: relativePath.optional(),
    }),
  )
  .default([])
  .superRefine((items, ctx) => {
    const seen = new Set<string>();
    items.forEach((item, index) => {
      if (seen.has(item.id)) ctx.addIssue({ code: "custom", path: [index, "id"], message: "generatedSourceAdoptions id must be unique" });
      seen.add(item.id);
    });
  });

/** Reviewed adoptions of orphaned generated output as durable source. */
export type GeneratedSourceAdoptionsConfig = z.output<typeof generatedSourceAdoptions>;

/** Exact JSON-pointer fields whose module paths resolve from a declared root. */
export const runtimeModuleRegistries = z
  .array(
    z.strictObject({
      file: relativePath,
      pointer: z.string().regex(/^\/(?:[^/]+\/)*[^/]+$/, "must be an absolute JSON pointer pattern"),
      resolveFrom: relativePath,
      /** Exact prefix removed by the runtime consumer before resolving the value. */
      stripPrefix: z.string().min(1).optional(),
    }),
  )
  .default([]);

/** JSON-pointer fields whose module paths resolve from a declared root. */
export type RuntimeModuleRegistriesConfig = z.output<typeof runtimeModuleRegistries>;

export const graph = z.strictObject({
  /** Resolve type-only imports so containment checks see type edges too. */
  tsPreCompilationDeps: z.boolean().default(true),
  /** Extra dependency-cruiser config to merge, repo-relative. */
  cruiserConfig: relativePath.optional(),
  /** Patterns excluded from the scan entirely. Exclusions remove incoming edges too. */
  exclude: z.array(z.string().min(1)).default([]),
  /** Cache scans keyed by tree hash. Disable when debugging the scanner. */
  cache: z.boolean().default(true),
});

/** Dependency-graph scanning options. */
export type GraphConfig = z.output<typeof graph>;
