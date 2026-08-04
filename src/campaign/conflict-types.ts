import type { GeneratedFileRecord, PlanOperation, PlanTarget } from "../plan/manifest.ts";

export interface CampaignPlan {
  /** Stable portfolio candidate id. */
  readonly candidateId: string;
  /** Higher-priority candidates are placed first; ties use candidate id. */
  readonly priority?: number;
  /** The deliberately narrow manifest surface needed by this read-only analysis. */
  readonly manifest: {
    readonly planId: string;
    readonly baselineCommit: string;
    readonly graphDigest: string;
    readonly target: Pick<PlanTarget, "packageName" | "packageRoot" | "projectId">;
    readonly operations: readonly PlanOperation[];
    readonly generatedFiles: readonly GeneratedFileRecord[];
  };
}

export type ConflictDisposition = "hard" | "mergeable";

export type ConflictCategory =
  | "moved-path"
  | "consumer-source"
  | "package-manifest"
  | "project-references"
  | "workspace-registry"
  | "task-registry"
  | "lockfile-importer"
  | "generated-artifact"
  | "path-key-artifact"
  | "scaffold-output"
  | "shared-path";

export type PathAccessMode = "read" | "write" | "read-write";

export type PathAccessRole =
  | "move-source"
  | "move-target"
  | "consumer-source"
  | "package-manifest"
  | "consumer-manifest"
  | "consumer-project-references"
  | "workspace-registry"
  | "task-registry"
  | "lockfile-importer"
  | "generated-artifact"
  | "generated-source"
  | "path-key-artifact"
  | "entrypoint"
  | "task-file"
  | "scaffold-output"
  | "operation-output";

/** Exact operation/path evidence behind one side of a conflict. */
export interface OperationPathAccess {
  readonly candidateId: string;
  readonly planId: string;
  readonly path: string;
  readonly scope: "exact" | "tree";
  readonly mode: PathAccessMode;
  readonly role: PathAccessRole;
  /** Null denotes regeneration metadata rather than a journal operation. */
  readonly operationIndex: number | null;
  readonly operationKind: PlanOperation["kind"] | "regenerate-artifact";
  /** Structured edit identity: importer root, donor, package, or project id. */
  readonly keys: readonly string[];
}

export interface PlanConflict {
  readonly id: string;
  readonly candidates: readonly [string, string];
  readonly planIds: readonly [string, string];
  /** Exact path, or the narrowest tree root, on which the accesses overlap. */
  readonly path: string;
  readonly category: ConflictCategory;
  readonly disposition: ConflictDisposition;
  /** Always true: even mergeable edits have incompatible same-baseline hashes. */
  readonly requiresReplan: true;
  readonly left: readonly OperationPathAccess[];
  readonly right: readonly OperationPathAccess[];
  readonly explanation: string;
}

export interface CampaignWave {
  readonly index: number;
  /** No candidates in one wave share a read/write or write/write path. */
  readonly candidateIds: readonly string[];
  /** A later wave is advisory until every applied earlier plan is replanned. */
  readonly requiresReplanAfterPreviousWave: boolean;
  /** Applying any child changes HEAD; path-disjointness never waives baseline checks. */
  readonly execution: "replan-between-every-child";
}

export interface PlanConflictAnalysis {
  readonly baselineCommit: string;
  readonly graphDigest: string;
  readonly conflicts: readonly PlanConflict[];
  readonly waves: readonly CampaignWave[];
}

export interface Subject {
  readonly candidateId: string;
  readonly priority: number;
  readonly manifest: CampaignPlan["manifest"];
  readonly accesses: readonly OperationPathAccess[];
}

interface CollisionBucket {
  readonly left: OperationPathAccess[];
  readonly right: OperationPathAccess[];
}

export type CollisionBuckets = ReadonlyMap<string, CollisionBucket>;
