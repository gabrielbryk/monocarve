import type { MonocarveConfig } from "../config.ts";
import type { Sha256 } from "../util/hash.ts";
import type { PreparationManifest } from "./manifest-types.ts";

/** One independently meaningful preparation-audit claim. */
export interface PreparationProofResult {
  readonly passed: boolean;
  readonly checked: number;
  readonly failures: readonly string[];
}

/** Fresh rescan evidence required before a preparation may be audited/applied. */
export interface PreparationFreshGraphEvidence {
  readonly commit: string;
  readonly digest: Sha256;
}

/** Results are intentionally separated: a passing proof only establishes its own claim. */
export interface PreparationAuditReport {
  readonly planId: string;
  readonly baselineCommit: string;
  readonly auditedRoot: string;
  readonly passed: boolean;
  readonly byteReplay: PreparationProofResult;
  /** Filesystem permission bits match the rendered preparation outputs. */
  readonly fileModes: PreparationProofResult;
  readonly renderedReplay: PreparationProofResult;
  readonly selectorIntegrity: PreparationProofResult;
  readonly declarationOwnership: PreparationProofResult;
  readonly compatibilitySurface: PreparationProofResult;
  readonly targetImportResolution: PreparationProofResult;
  readonly changedPathScope: PreparationProofResult;
  readonly typeValueClaims: PreparationProofResult;
  /** The plan selection was based on this exact fresh workspace graph. */
  readonly graphDigest: PreparationProofResult;
  /** Declared generator outputs exist and, during replay, match the observed post-generator hashes. */
  readonly generatedArtifactFreshness?: PreparationProofResult;
  /**
   * Independent re-proof that every importer a boundary's `delete-module`
   * operation retired no longer holds a value-level import into the retained
   * root. Empty (0 checked, passed) for a manifest with no boundary deletion.
   */
  readonly retainedRootClearance: PreparationProofResult;
  /**
   * Independent re-proof that a boundary's rendered app adapter exports
   * exactly its promoted contract's surface. Empty (0 checked, passed) for a
   * manifest that carries no unambiguous single contract/adapter pair.
   */
  readonly adapterSurfaceParity: PreparationProofResult;
  readonly failures: readonly string[];
}

export interface PreparationAuditOptions {
  readonly rootDir: string;
  readonly config: MonocarveConfig;
  readonly manifest: PreparationManifest;
  /** A committed plan record is provenance, not a preparation mutation. */
  readonly approvedManifestPath?: string;
  /** A caller must rescan the baseline; stale graph evidence is a refusal. */
  readonly freshGraph: PreparationFreshGraphEvidence;
  /** Exact hashes observed by the generator runner in this replay. */
  readonly regeneratedArtifacts?: Readonly<Record<string, Sha256>>;
}

export function preparationProof(failures: readonly string[], checked: number): PreparationProofResult {
  return { passed: failures.length === 0, checked, failures };
}
