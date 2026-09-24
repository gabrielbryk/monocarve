import { z } from "zod";

import { relativePath } from "./primitives.ts";

const kebabId = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "must be a lowercase kebab-case identifier");

/** Explicit adoption of orphaned generated output as durable source. */
export const generatedSourceAdoptions = z
  .array(
    z.strictObject({
      id: kebabId.describe("Unique kebab-case boundary identifier."),
      /** Application-owned path used to render repository policy for package-only adoptions. */
      policyAnchor: relativePath.optional().describe("Application-owned path used to render repository policy for package-only adoptions."),
      artifacts: z
        .array(
          z.strictObject({
            path: relativePath.describe("Repo-relative generated file to adopt as source."),
            /** Must equal the missing source declared by the artifact header. */
            missingSource: relativePath.describe("Missing source path; must equal the source declared by the artifact header."),
            /** Exact leading line count removed from the artifact. */
            removeHeaderLines: z.number().int().positive().describe("Exact number of leading header lines removed from the artifact."),
          }),
        )
        .min(1)
        .describe("Generated files adopted as durable source."),
      /** Optional generator retired only when no other provenance header names it. */
      retireGenerator: relativePath.optional().describe("Generator to retire, only when no other provenance header names it."),
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
      file: relativePath.describe("Repo-relative JSON registry file."),
      pointer: z
        .string()
        .regex(/^\/(?:[^/]+\/)*[^/]+$/, "must be an absolute JSON pointer pattern")
        .describe(
          "Absolute JSON pointer pattern selecting the module-path string values in the file; a `*` segment matches every key or array index at that level.",
        ),
      resolveFrom: relativePath.describe("Repo-relative directory the module paths resolve from."),
      /** Exact prefix removed by the runtime consumer before resolving the value. */
      stripPrefix: z.string().min(1).optional().describe("Exact prefix the runtime consumer removes before resolving a value."),
    }),
  )
  .default([]);

/** JSON-pointer fields whose module paths resolve from a declared root. */
export type RuntimeModuleRegistriesConfig = z.output<typeof runtimeModuleRegistries>;

export const graph = z.strictObject({
  /** Resolve type-only imports so containment checks see type edges too. */
  tsPreCompilationDeps: z.boolean().default(true).describe("Resolve type-only imports so containment checks see type edges too."),
  /** Extra dependency-cruiser config to merge, repo-relative. */
  cruiserConfig: relativePath.optional().describe("Repo-relative dependency-cruiser config to merge into the scan."),
  /** Patterns excluded from the scan entirely. Exclusions remove incoming edges too. */
  exclude: z.array(z.string().min(1)).default([]).describe("Patterns excluded from the scan entirely, including their incoming edges."),
  /** Cache scans keyed by tree hash. Disable when debugging the scanner. */
  cache: z.boolean().default(true).describe("Cache scans keyed by tree hash; disable when debugging the scanner."),
});

/** Dependency-graph scanning options. */
export type GraphConfig = z.output<typeof graph>;
