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
  .refine((value) => !value.startsWith("/") && !/^[A-Za-z]:(?:$|\/)/.test(value), {
    message: "must be a repo-relative path",
  })
  .refine((value) => !value.split("/").includes(".."), { message: "must not escape the repo root" });

export const regexSource = z.string().min(1).refine(isValidRegex, { message: "must be a valid regular expression" });

function isValidRegex(source: string): boolean {
  try {
    new RegExp(source);
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
  z.strictObject({ contents: z.string() }),
  z.strictObject({ file: relativePath }),
]);

export type TemplateSource = z.output<typeof templateSource>;

export const publicSurfaceSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("barrel") }),
  z.strictObject({
    mode: z.literal("subpaths"),
    /** Package export key, e.g. `./{pathNoExtension}`. */
    keyTemplate: z.string().min(1),
    /** Package export target, e.g. `./src/{path}`. */
    targetTemplate: z.string().min(1),
  }),
]).superRefine((surface, ctx) => {
  if (surface.mode !== "subpaths") return;
  for (const [field, template] of [["keyTemplate", surface.keyTemplate], ["targetTemplate", surface.targetTemplate]] as const) {
    const unknown = templatePlaceholders(template).filter(
      (placeholder) => !["path", "pathNoExtension", "pathJs"].includes(placeholder),
    );
    if (unknown.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: [field],
        message: `unknown module placeholder(s): ${unknown.join(", ")}`,
      });
    }
  }
});

export const publicSurface = publicSurfaceSchema.default({ mode: "barrel" });

export type PublicSurfaceConfig = z.output<typeof publicSurface>;

/**
 * The scaffold fields a profile or application may replace. Keeping this as a
 * partial schema is deliberate: profiles select a package kind, while the
 * root scaffold remains the generic baseline every profile inherits.
 */
export const scaffoldTemplateOverrides = z.strictObject({
  packageJson: templateSource.optional(),
  tsconfig: templateSource.optional(),
  taskFile: templateSource.optional(),
  extraFiles: z.record(z.string().min(1), templateSource).optional(),
  devDependencies: z.record(z.string().min(1), z.string().min(1)).optional(),
  publicSurface: publicSurfaceSchema.optional(),
});

export type ScaffoldTemplateOverrides = z.output<typeof scaffoldTemplateOverrides>;
