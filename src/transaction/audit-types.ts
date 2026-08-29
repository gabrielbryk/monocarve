import type { MonocarveConfig } from "../config.ts";
import type { DynamicImportDelta, ExtractionManifest } from "../plan/manifest.ts";
import type { FileState } from "../util/hash.ts";

/**
 * The audit proves fidelity to one extraction plan, not general behavioural
 * equivalence. Its independent proofs are deliberately kept separate: a
 * pass means that exact claim held and a failure identifies the broken claim.
 *
 * 1. moved, rewritten, and declared-write bytes match their evidence;
 * 2. no source still resolves into a donor path;
 * 3. the package's public surface exists and does not reach application code;
 * 4. an external consumer can compile the declared surface;
 * 5. every move-with-rewrite is reproduced from its baseline blob;
 * 6. the entrypoint evaluates no newly undeclared module;
 * 7. lockfile importer blocks and regenerated artifacts match their evidence;
 * 8. the dynamic-import multiset matches the plan.
 *
 * It intentionally does not prove that a declared `write-file` was a good
 * design, that evaluation effects are benign or ordered safely, or that a
 * later extraction has not legitimately changed an earlier plan's package.
 * Those claims require different evidence; calling any of them audited here
 * would make a pass look stronger than it is.
 */

export interface ProofResult {
  readonly passed: boolean;
  readonly checked: number;
  readonly failures: readonly string[];
}

export interface GraphEvidence {
  /** Observed change in dynamic imports, as a multiset diff. */
  readonly dynamicImportDelta: DynamicImportDelta;
  /** Edges still pointing at a moved path. Non-empty means the audit failed. */
  readonly movedPathEdges: readonly string[];
  readonly passed: boolean;
}

export interface AuditReport {
  readonly planId: string;
  readonly baselineCommit: string;
  readonly auditedRoot: string;
  readonly passed: boolean;
  readonly byteFidelity: ProofResult;
  readonly consumerCompleteness: ProofResult;
  readonly boundaryRules: ProofResult;
  readonly externalConsumerCompile: ProofResult;
  readonly codemodReplay: ProofResult;
  readonly entrypointClosure: ProofResult;
  readonly lockfileIntegrity: ProofResult;
  readonly generatedArtifacts: ProofResult;
  readonly postJournalDeclarativeIntegrity?: ProofResult;
  /** Exact planned source/test/asset counts and their landed move targets. */
  readonly sourceConservation: ProofResult & {
    readonly plannedFiles: number;
    readonly plannedTests: number;
    readonly plannedAssets: number;
    readonly landedFiles: number;
    readonly landedTests: number;
    readonly landedAssets: number;
  };
  /**
   * What became of the boundary violations the reviewed plan recorded as
   * pre-existing. Informational by construction: these edges never fail the
   * audit, which is the whole point of recording them, and `boundaryRules`
   * still fails on every edge outside the recorded set.
   */
  readonly boundaryBaseline: BoundaryBaselineEvidence;
  readonly graphEvidence: GraphEvidence;
  readonly failures: readonly string[];
  readonly unauditable?: readonly string[];
}

export interface BoundaryBaselineEvidence {
  /** Edges the manifest recorded. Zero for a plan compiled without a baseline. */
  readonly recorded: number;
  /** Recorded edges still present in the audited tree. */
  readonly observed: readonly string[];
  /** Recorded edges the transaction happened to remove. */
  readonly cleared: readonly string[];
}

export interface AuditOptions {
  readonly config: MonocarveConfig;
  readonly rootDir: string;
  readonly manifest: ExtractionManifest;
  readonly skipCompileProof?: boolean;
  readonly installedRoot?: string;
  readonly regeneratedArtifacts?: Readonly<Record<string, FileState>>;
}

export function proof(failures: readonly string[], checked: number): ProofResult {
  return { passed: failures.length === 0, checked, failures };
}
