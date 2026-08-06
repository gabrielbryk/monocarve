import { operationTargets, type ExtractionManifest, type PlanOperation } from "../plan/manifest.ts";
import { ReconciliationValidationError } from "./validate.ts";
import type { ReconciliationRecord } from "./types.ts";

/** In-memory audit view only; this is never a replacement extraction manifest. */
export function reconciliationAuditManifest(manifest: ExtractionManifest, record: ReconciliationRecord): ExtractionManifest {
  const accepted = new Map(record.discrepancies.map((entry) => [entry.path, entry.actual]));
  const last = new Map<string, number>();
  manifest.operations.forEach((operation, index) => operationTargets(operation).forEach((path) => last.set(path, index)));
  for (const path of accepted.keys()) {
    const generated = manifest.generatedFiles.some((entry) => entry.path === path && entry.regenerateOnApply && entry.expectedHash);
    if (!last.has(path) && !generated) throw new ReconciliationValidationError(`reconciliation path is no longer owned by the manifest: ${path}`);
    if (accepted.get(path) === "missing") throw new ReconciliationValidationError(`reconciliation cannot accept a missing owned path: ${path}`);
  }
  const operations = manifest.operations.map((operation, index): PlanOperation => {
    const path = operationTargets(operation).find((candidate) => last.get(candidate) === index && accepted.has(candidate));
    return path === undefined ? operation : { ...operation, resultHash: accepted.get(path)! };
  });
  const generatedFiles = manifest.generatedFiles.map((entry) => accepted.has(entry.path) && entry.regenerateOnApply
    ? { ...entry, expectedHash: accepted.get(entry.path)! }
    : entry);
  return { ...manifest, operations, generatedFiles };
}
