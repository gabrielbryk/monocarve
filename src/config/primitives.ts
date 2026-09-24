import { isAbsolute, posix } from "node:path";
import { z } from "zod";

import { templatePlaceholders } from "../util/template.ts";

export const relativePath = z
  .string()
  .min(1)
  .refine((value) => !isAbsolute(value), { message: "must be a repo-relative path" })
  .refine((value) => !value.startsWith("../"), { message: "must not escape the repo root" });

/**
 * A protected path is compared to graph paths, which are always POSIX,
 * repo-relative strings. Normalize it at the config boundary so a policy
 * authored on another platform protects the same files.
 */
export const protectedPath = z
  .string()
  .min(1)
  .transform((value) => posix.normalize(value.replaceAll("\\", "/")).replace(/\/+$/, ""))
  .refine((value) => value !== "" && value !== ".", { message: "must name a path below the repo root" })
  .refine((value) => !value.startsWith("/") && !/^[A-Za-z]:(?:$|\/)/.test(value), { message: "must be a repo-relative path" })
  .refine((value) => !value.split("/").includes(".."), { message: "must not escape the repo root" });

export const regexSource = z.string().min(1).refine(isValidRegex, { message: "must be a valid regular expression" });

function isValidRegex(source: string): boolean {
  try {
    RegExp(source);
    return true;
  } catch {
    return false;
  }
}

/**
 * A template body, supplied either inline or as a file next to the config.
 * Both forms go through the same `{placeholder}` rendering.
 */
export const templateSource = z.union([
  z.strictObject({ contents: z.string().describe("Inline template text.") }),
  z.strictObject({ file: relativePath.describe("Repo-relative file holding the template text.") }),
]);

/** Template text given inline (`contents`) or as a repo-relative `file`. */
export type TemplateSource = z.output<typeof templateSource>;

const publicSurfaceSchema = z
  .discriminatedUnion("mode", [
    z.strictObject({ mode: z.literal("barrel").describe("Export everything through the single entrypoint barrel.") }),
    z.strictObject({
      mode: z.literal("subpaths").describe("Export each moved module as its own package subpath."),
      /** Package export key, e.g. `./{pathNoExtension}`. */
      keyTemplate: z.string().min(1).describe("Package export key template, e.g. `./{pathNoExtension}`."),
      /** Package export target, e.g. `./src/{path}`. */
      targetTemplate: z.string().min(1).describe("Package export target template, e.g. `./src/{path}`."),
    }),
  ])
  .superRefine((surface, ctx) => {
    if (surface.mode !== "subpaths") return;
    for (const [field, template] of [
      ["keyTemplate", surface.keyTemplate],
      ["targetTemplate", surface.targetTemplate],
    ] as const) {
      const unknown = templatePlaceholders(template).filter((placeholder) => !["path", "pathNoExtension", "pathJs"].includes(placeholder));
      if (unknown.length > 0) {
        ctx.addIssue({ code: "custom", path: [field], message: `unknown module placeholder(s): ${unknown.join(", ")}` });
      }
    }
  });

export const publicSurface = publicSurfaceSchema.default({ mode: "barrel" });

/** How an extracted package exposes its public surface (defaults to a barrel). */
export type PublicSurfaceConfig = z.output<typeof publicSurface>;

/**
 * The project config which owns inferred workspace dependency references.
 *
 * A simple package can keep its entire program in `tsconfig.json`. A solution
 * package can keep that root config as an aggregator and put its production
 * program in `tsconfig.lib.json`; in that shape both sides of an inferred
 * reference must name the library project rather than the solution root.
 */
export const projectReferences = z
  .strictObject({
    /** Package-local tsconfig file that receives inferred workspace references. */
    target: relativePath.default("tsconfig.json").describe("Package-local tsconfig that receives inferred workspace project references."),
    /** tsconfig file to reference in each inferred workspace dependency. */
    dependencyTarget: relativePath.default("tsconfig.json").describe("tsconfig file referenced in each inferred workspace dependency."),
  })
  .prefault({});

/**
 * The scaffold fields a profile or application may replace. Keeping this as a
 * partial schema is deliberate: profiles select a package kind, while the
 * root scaffold remains the generic baseline every profile inherits.
 */
export const scaffoldTemplateOverrides = z.strictObject({
  packageJson: templateSource.optional().describe("Replacement `package.json` template for generated packages."),
  tsconfig: templateSource.optional().describe("Replacement `tsconfig` template for generated packages."),
  taskFile: templateSource.optional().describe("Replacement task-runner project file template."),
  extraFiles: z.record(z.string().min(1), templateSource).optional().describe("Additional files to scaffold, keyed by package-relative path."),
  projectReferences: projectReferences.optional().describe("Replacement tsconfig project-reference targets."),
  devDependencies: z.record(z.string().min(1), z.string().min(1)).optional().describe("Replacement devDependencies added to every generated package."),
  devDependenciesByDependency: z
    .record(z.string().min(1), z.record(z.string().min(1), z.string().min(1)))
    .optional()
    .describe("Replacement extra devDependencies keyed by an inferred dependency."),
  publicSurface: publicSurfaceSchema.optional().describe("Replacement public-surface mode for generated packages."),
});

export type ScaffoldTemplateOverrides = z.output<typeof scaffoldTemplateOverrides>;

/** A lowercase kebab-case identifier. */
export const kebabId = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "must be a lowercase kebab-case identifier");
