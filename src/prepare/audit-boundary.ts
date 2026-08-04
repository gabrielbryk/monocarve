/**
 * The boundary-specific audit proofs (`retainedRootClearance` /
 * `adapterSurfaceParity`), split out of `audit.ts` purely to keep that file
 * under the line-count gate: this module owns nothing about byte replay,
 * selectors, ownership, or compatibility surfaces — only the two proofs a
 * composition/port boundary preparation adds on top of an ordinary
 * declaration preparation. `audit.ts` still owns `auditPreparationSync` and
 * folds this module's proofs into its report and failure list.
 */
import type { PreparationReplayOperation } from "./manifest-types.ts";
import type { PreparationProofResult } from "./audit-types.ts";
import { preparationProof } from "./audit-types.ts";
import { verifyRetainedRootsClearOfValueImports } from "./audit-imports.ts";
import { verifyAdapterSurfaceAgainstContract } from "./audit-surface.ts";

export function computeBoundaryAuditProofs(
  rootDir: string,
  operations: readonly PreparationReplayOperation[],
): { retainedRootClearance: PreparationProofResult; adapterSurfaceParity: PreparationProofResult } {
  const retainedRootFailures: string[] = [];
  const adapterSurfaceFailures: string[] = [];
  verifyRetainedRootsClearOfValueImports(rootDir, operations, retainedRootFailures);
  verifyAdapterSurfaceAgainstContract(rootDir, operations, adapterSurfaceFailures);
  const deletions = operations.filter((operation) => operation.kind === "delete-module");
  const retainedRootClearance = preparationProof(retainedRootFailures, deletions.reduce((total, operation) => total + operation.importerProof.length, 0));
  const writes = operations.filter((operation) => operation.kind === "write-file");
  const hasUnambiguousAdapterPair = writes.filter((operation) => operation.purpose === "port-contract").length === 1
    && writes.filter((operation) => operation.purpose === "app-adapter").length === 1;
  const adapterSurfaceParity = preparationProof(adapterSurfaceFailures, hasUnambiguousAdapterPair ? 1 : 0);
  return { retainedRootClearance, adapterSurfaceParity };
}
