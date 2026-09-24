/** Config schemas for port and module promotions and value splits. */
import { z } from "zod";

import { kebabId, relativePath } from "./primitives.ts";

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
      id: kebabId.describe("Unique kebab-case boundary id, used with `boundary --id`."),
      /** App-owned roots this promotion is meant to unblock; at least one. */
      retainedRoots: z.array(relativePath).min(1).describe("Application-owned roots this promotion unblocks."),
      /** Package the port contract is declared in. */
      contractPackage: z.string().min(1).describe("Package the port contract is declared in."),
      /** Module within `contractPackage` that exports the port. */
      contractModule: z.string().min(1).describe("Module within `contractPackage` that exports the port."),
      /** Legacy singleton form of the app's current concrete type. */
      appConcreteType: concreteTypeReference.optional().describe("Legacy singleton form of the app's concrete type, as `path/to/file.ts#TypeName`."),
      /** Atomic declaration-group form; every declaration must come from one file. */
      appConcreteTypes: z.array(concreteTypeReference).min(1).optional().describe("Declaration-group form of the app's concrete types, all from one file."),
      /** Legacy singleton name of the port interface. */
      libraryPort: z.string().min(1).optional().describe("Legacy singleton name of the port interface, paired with `appConcreteType`."),
      /** Names paired with appConcreteTypes; declarations are never renamed. */
      libraryPorts: z.array(z.string().min(1)).min(1).optional().describe("Port names paired with `appConcreteTypes`; declarations are never renamed."),
      /** Package the port declaration is promoted into. */
      targetPackage: z.string().min(1).describe("Package the port declaration is promoted into."),
    }),
  )
  .default([])
  .superRefine((promotions, ctx) => {
    const seen = new Set<string>();
    for (const [index, promotion] of promotions.entries()) {
      if (seen.has(promotion.id)) ctx.addIssue({ code: "custom", path: [index, "id"], message: "portPromotions id must be unique" });
      seen.add(promotion.id);
      const singleton = promotion.appConcreteType !== undefined || promotion.libraryPort !== undefined;
      const group = promotion.appConcreteTypes !== undefined || promotion.libraryPorts !== undefined;
      if (singleton === group) {
        ctx.addIssue({
          code: "custom",
          path: [index],
          message: "portPromotions requires exactly one of appConcreteType/libraryPort or appConcreteTypes/libraryPorts",
        });
      } else if (singleton && (promotion.appConcreteType === undefined || promotion.libraryPort === undefined)) {
        ctx.addIssue({ code: "custom", path: [index], message: "appConcreteType and libraryPort must be declared together" });
      } else if (group && (promotion.appConcreteTypes === undefined || promotion.libraryPorts === undefined)) {
        ctx.addIssue({ code: "custom", path: [index], message: "appConcreteTypes and libraryPorts must be declared together" });
      } else if (promotion.appConcreteTypes && promotion.libraryPorts && promotion.appConcreteTypes.length !== promotion.libraryPorts.length) {
        ctx.addIssue({ code: "custom", path: [index, "libraryPorts"], message: "libraryPorts must have the same length as appConcreteTypes" });
      }
    }
  });

export type PortPromotionsConfig = z.output<typeof portPromotions>;

/**
 * Reviewed exception to SCC-closure selection: promote one complete module as
 * a byte-identical package surface and let the compiler derive every importer.
 */
export const modulePromotions = z
  .array(
    z.strictObject({
      id: kebabId.describe("Unique kebab-case boundary id, used with `boundary --id`."),
      source: relativePath.describe("Repo-relative module promoted whole."),
      targetPackage: z.string().min(1).describe("Package that receives the promoted module."),
      /** Public module key relative to the package root, without an extension. */
      targetModule: z.string().min(1).default("index").describe("Public module key relative to the package root, without an extension."),
      /** False retains a compatibility re-export at the old path. */
      retireSource: z.boolean().default(true).describe("Remove the source module; false keeps a compatibility re-export at the old path."),
    }),
  )
  .default([])
  .superRefine((items, ctx) => {
    const seen = new Set<string>();
    items.forEach((item, index) => {
      if (seen.has(item.id)) ctx.addIssue({ code: "custom", path: [index, "id"], message: "modulePromotions id must be unique" });
      seen.add(item.id);
    });
  });

/** Reviewed promotions of whole modules as byte-identical package surfaces. */
export type ModulePromotionsConfig = z.output<typeof modulePromotions>;

/**
 * Reviewed exception for extracting one dependency-closed exported value SCC
 * from a mixed module. The compiler selects the declaration group itself and
 * retains a compatibility re-export at the donor; it never accepts declaration
 * spans or generated source text from configuration.
 */
export const valueSplits = z
  .array(
    z.strictObject({
      id: kebabId.describe("Unique kebab-case boundary id, used with `boundary --id`."),
      source: relativePath.describe("Repo-relative mixed module the value is split out of."),
      symbol: z
        .string()
        .regex(/^[A-Za-z_$][\w$]*$/u, "must be a TypeScript identifier")
        .describe("Exported value whose dependency-closed declaration group is extracted."),
      target: relativePath.describe("Repo-relative module that receives the declaration group; must differ from `source`."),
      /** Exact specifier rendered from the donor to the target module. */
      targetModuleSpecifier: z.string().min(1).describe("Exact specifier the donor's compatibility re-export uses to reach `target`."),
    }),
  )
  .default([])
  .superRefine((items, ctx) => {
    const seen = new Set<string>();
    items.forEach((item, index) => {
      if (seen.has(item.id)) ctx.addIssue({ code: "custom", path: [index, "id"], message: "valueSplits id must be unique" });
      seen.add(item.id);
      if (item.source === item.target) ctx.addIssue({ code: "custom", path: [index, "target"], message: "value split target must differ from source" });
    });
  });

/** Reviewed splits of one declaration group out of a mixed module. */
export type ValueSplitsConfig = z.output<typeof valueSplits>;
