/** Independent post-transaction proofs. Each proof fails independently. */

import { createPackageManagerAdapter } from "../adapters/registry.ts";
import type { PackageManagerAdapter } from "../adapters/types.ts";
import { resetCodemodCaches } from "../codemod/imports.ts";
import { isAnyMove, type MoveOperation, type MoveWithRewriteOperation } from "../plan/manifest.ts";
import { generatedArtifactsProof, lockfileIntegrityProof, postJournalDeclarativeProof } from "./audit-artifacts.ts";
import { byteFidelityProof } from "./audit-byte-fidelity.ts";
import { entrypointClosureProof } from "./audit-closure.ts";
import { sourceConservation as proveSourceConservation } from "./audit-conservation.ts";
import { consumerEvidence, type ConsumerEvidence } from "./audit-consumers.ts";
import { replayFailure } from "./audit-graph.ts";
import { unauditableManifest, unauditableReport } from "./audit-helpers.ts";
import { assembleReport, externalConsumerProof, type AuditProofs } from "./audit-report.ts";
import { entrypointSurfaceFailures, publicSubpathFailures } from "./audit-target-surface.ts";
import { proof, type AuditOptions, type AuditReport } from "./audit-types.ts";

export type { AuditOptions, AuditReport, GraphEvidence, ProofResult } from "./audit-types.ts";

export async function auditPlan(options: AuditOptions): Promise<AuditReport> {
  return auditPlanSync(options);
}

/**
 * Every proof, in report order. They are independent by construction: none
 * reads another's result, so the sequence here is presentation, not dependency.
 *
 * `evidence` is the single pass over the repository's sources that proof 2
 * makes. Proof 3 and the graph evidence read what that pass already saw rather
 * than walking the same tree again for the same bytes.
 */
function proveAll(
  options: AuditOptions,
  adapter: PackageManagerAdapter,
  moves: readonly (MoveOperation | MoveWithRewriteOperation)[],
  evidence: ConsumerEvidence,
): AuditProofs {
  const { config, manifest, rootDir } = options;

  /* -- 1. byte fidelity -------------------------------------------------- */

  const byteFidelity = byteFidelityProof(manifest, rootDir, moves);

  /* -- 2. consumer completeness ------------------------------------------ */

  const consumerCompleteness = proof(evidence.consumerFailures, manifest.consumers.length + evidence.sourceCount);

  /* -- 3. boundary rules ------------------------------------------------- */

  const boundaryFailures = [...evidence.boundaryFailures, ...entrypointSurfaceFailures(rootDir, manifest, moves), ...publicSubpathFailures(rootDir, manifest)];
  const boundaryRules = proof([...new Set(boundaryFailures)], manifest.target.requiredExports.length + (manifest.target.publicModules?.length ?? 0));

  /* -- 4. external-consumer compile proof -------------------------------- */

  const externalConsumerCompile = externalConsumerProof(options);

  /* -- 5. codemod replay proof ------------------------------------------- */

  const replays = manifest.operations.filter((operation): operation is MoveWithRewriteOperation => operation.kind === "move-with-rewrite");
  const replayFailures = replays.flatMap((operation) => replayFailure(config, manifest, operation, rootDir));
  const codemodReplay = proof(replayFailures, replays.length);

  /* -- 6. entrypoint evaluation closure ---------------------------------- */

  const entrypointClosure = entrypointClosureProof(manifest, rootDir, moves);

  /* -- lockfile + generated artifacts ------------------------------------ */

  const lockfileIntegrity = lockfileIntegrityProof(adapter, manifest, rootDir);
  const generatedArtifacts = generatedArtifactsProof(manifest, rootDir, options.regeneratedArtifacts);
  const postJournalDeclarativeIntegrity = postJournalDeclarativeProof(manifest, rootDir);

  /* -- source/test/asset conservation ----------------------------------- */

  const sourceConservation = proveSourceConservation(rootDir, manifest, moves);

  return {
    byteFidelity,
    consumerCompleteness,
    boundaryRules,
    externalConsumerCompile,
    codemodReplay,
    entrypointClosure,
    lockfileIntegrity,
    generatedArtifacts,
    postJournalDeclarativeIntegrity,
    sourceConservation,
  };
}

export function auditPlanSync(options: AuditOptions): AuditReport {
  const { config, manifest, rootDir } = options;
  // Before anything reads the manifest as though it were one. See
  // `unauditableManifest` for what a failure here looks like without it.
  const unauditable = unauditableManifest(config, manifest);
  if (unauditable.length > 0) return unauditableReport(manifest, rootDir, unauditable);
  // Proof 2 says every reference was re-resolved authoritatively. Resolution
  // answers cached by an earlier audit — of this root before it changed, or of a
  // simulation worktree — would make that a replay of a tree that is gone.
  resetCodemodCaches();
  const adapter = createPackageManagerAdapter(config);
  const moves = manifest.operations.filter(isAnyMove);
  const evidence = consumerEvidence(config, manifest, rootDir, moves);

  return assembleReport({
    manifest,
    rootDir,
    proofs: proveAll(options, adapter, moves, evidence),
    movedPathEdges: evidence.movedPathEdges,
    observedBaselineKeys: evidence.observedBaselineKeys,
  });
}
