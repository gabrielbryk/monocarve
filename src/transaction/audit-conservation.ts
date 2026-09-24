import type { ExtractionManifest, WriteFileOperation } from "../plan/manifest.ts";
import { MISSING } from "../util/hash.ts";
import { stateAt } from "./audit-helpers.ts";
import { proof, type AuditReport } from "./audit-types.ts";

export function sourceConservation(
  rootDir: string,
  manifest: ExtractionManifest,
  moves: readonly { readonly source: string; readonly target: string }[],
): AuditReport["sourceConservation"] {
  const categories = { files: manifest.source.files, tests: manifest.source.tests, assets: manifest.source.assets ?? [] };
  const landed = { files: 0, tests: 0, assets: 0 };
  const failures: string[] = [];
  const compatibility =
    manifest.modulePromotion?.retireSource === false
      ? manifest.operations.find(
          (operation): operation is WriteFileOperation =>
            operation.kind === "write-file" &&
            operation.path === manifest.modulePromotion?.source &&
            operation.generator === "module-promotion:compatibility-reexport",
        )
      : undefined;
  for (const [category, sources] of Object.entries(categories) as [keyof typeof categories, readonly string[]][]) {
    for (const source of sources) {
      const operation = moves.find((move) => move.source === source);
      if (!operation) {
        failures.push(`${category} source has no move operation: ${source}`);
      } else if (
        (stateAt(rootDir, source) !== MISSING && (compatibility?.path !== source || stateAt(rootDir, source) !== compatibility.resultHash)) ||
        stateAt(rootDir, operation.target) === MISSING
      ) {
        failures.push(`${category} source was not conserved at its target: ${source} -> ${operation.target}`);
      } else {
        landed[category] += 1;
      }
    }
  }
  return {
    ...proof(failures, categories.files.length + categories.tests.length + categories.assets.length),
    plannedFiles: categories.files.length,
    plannedTests: categories.tests.length,
    plannedAssets: categories.assets.length,
    landedFiles: landed.files,
    landedTests: landed.tests,
    landedAssets: landed.assets,
  };
}
