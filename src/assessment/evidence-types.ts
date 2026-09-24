import type { Sha256 } from "../util/hash.ts";
import type { FileIdentity } from "./evidence-fs.ts";

export interface EvidenceArtifactRecord {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: Sha256;
  readonly required: boolean;
}
export interface EvidenceManifestBase {
  readonly schemaVersion: 1;
  readonly kind: "architecture-assessment" | "declaration-analysis-batch";
  readonly tool: string;
  readonly artifacts: readonly EvidenceArtifactRecord[];
}
export type PublicationPhase = "staged" | "prior-preserved" | "published";
export interface PublicationPaths {
  readonly root: string;
  readonly requestedDestination: string;
  readonly analyticalRoots: readonly string[];
  readonly target: string;
  readonly stage: string;
  readonly backup: string;
  readonly recovery: string;
  readonly lock: string;
}
export interface PriorBundle {
  readonly identity: FileIdentity;
  readonly manifest?: EvidenceManifestBase;
}
