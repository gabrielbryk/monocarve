/**
 * Assembly of the finished report: the external-consumer proof, the graph
 * evidence, the boundary-baseline evidence, and the flattened failure list.
 *
 * Nothing here re-derives a claim the proofs made. The failure list is the
 * proofs' own order, so a reader can map a message back to the proof that
 * raised it.
 */

import type { ExtractionManifest } from "../plan/manifest.ts";
import { boundaryEdgeKey, formatBoundaryEdge } from "../plan/boundary-baseline.ts";
import { compileExternalConsumer } from "./external-consumer.ts";
import { dynamicImportDelta } from "./audit-graph.ts";
import {
  proof,
  type AuditOptions,
  type AuditReport,
  type BoundaryBaselineEvidence,
  type GraphEvidence,
  type ProofResult,
} from "./audit-types.ts";

/** Proof 4: an external consumer can compile the declared surface. */
export function externalConsumerProof(options: AuditOptions): ProofResult {
  if (options.skipCompileProof) return proof([], 0);
  const result = compileExternalConsumer({
    config: options.config,
    manifest: options.manifest,
    rootDir: options.rootDir,
    ...(options.installedRoot === undefined ? {} : { installedRoot: options.installedRoot }),
  });
  return proof(result.passed ? [] : result.diagnostics, 1);
}

export type AuditProofs = Required<Pick<
  AuditReport,
  | "byteFidelity"
  | "consumerCompleteness"
  | "boundaryRules"
  | "externalConsumerCompile"
  | "codemodReplay"
  | "entrypointClosure"
  | "lockfileIntegrity"
  | "generatedArtifacts"
  | "postJournalDeclarativeIntegrity"
  | "sourceConservation"
>>;

export interface ReportInputs {
  readonly manifest: ExtractionManifest;
  readonly rootDir: string;
  readonly proofs: AuditProofs;
  readonly movedPathEdges: readonly string[];
  readonly observedBaselineKeys: ReadonlySet<string>;
}

function boundaryBaselineEvidence(
  manifest: ExtractionManifest,
  observedBaselineKeys: ReadonlySet<string>,
): BoundaryBaselineEvidence {
  const recordedEdges = manifest.boundaryBaseline?.edges ?? [];
  return {
    recorded: recordedEdges.length,
    observed: recordedEdges.filter((edge) => observedBaselineKeys.has(boundaryEdgeKey(edge))).map(formatBoundaryEdge),
    cleared: recordedEdges.filter((edge) => !observedBaselineKeys.has(boundaryEdgeKey(edge))).map(formatBoundaryEdge),
  };
}

export function assembleReport(inputs: ReportInputs): AuditReport {
  const { manifest, rootDir, proofs, movedPathEdges, observedBaselineKeys } = inputs;
  const observed = dynamicImportDelta(manifest, rootDir);
  const expected = manifest.expectedDynamicImportDelta;
  const deltaMatches =
    observed.added.join("\n") === [...expected.added].join("\n") &&
    observed.removed.join("\n") === [...expected.removed].join("\n");
  const graphEvidence: GraphEvidence = {
    dynamicImportDelta: observed,
    movedPathEdges: [...new Set(movedPathEdges)].sort(),
    passed: deltaMatches && movedPathEdges.length === 0,
  };
  const failures = [
    ...Object.values(proofs).flatMap((entry) => entry.failures),
    ...(deltaMatches ? [] : ["dynamic-import evidence does not match the declared plan"]),
  ];

  return {
    planId: manifest.planId,
    baselineCommit: manifest.baselineCommit,
    auditedRoot: rootDir,
    passed: failures.length === 0,
    ...proofs,
    boundaryBaseline: boundaryBaselineEvidence(manifest, observedBaselineKeys),
    graphEvidence,
    failures,
  };
}
