import type { EvaluationEffectKind } from "../codemod/side-effects.ts";
import type { PublicSurfaceConfig } from "../config.ts";
import type { FileState, Sha256 } from "../util/hash.ts";
import type { ExportSurface } from "./public-surface.ts";
import type { ImportRewrite, PlanOperation } from "./manifest-operations.ts";

/**
 * v2 requires dependency sections; v3 adds compiler provenance; v4 persists
 * architectural assessment.
 *
 * `boundaryBaseline` is additive within v4 and carries no version of its own:
 * every reader that predates it treats a manifest carrying it exactly as it
 * treats one without, and every reader that knows it treats an absent field as
 * the older, stricter behaviour of an empty baseline. Nothing can be misread,
 * so nothing needs a new version to be told apart.
 */
export const LEGACY_PLAN_SCHEMA_VERSION = 2 as const;
export const PREVIOUS_PLAN_SCHEMA_VERSION = 3 as const;
export const PLAN_SCHEMA_VERSION = 4 as const;

export function isSupportedExtractionManifestVersion(value: unknown): value is typeof LEGACY_PLAN_SCHEMA_VERSION | typeof PREVIOUS_PLAN_SCHEMA_VERSION | typeof PLAN_SCHEMA_VERSION {
  return value === LEGACY_PLAN_SCHEMA_VERSION || value === PREVIOUS_PLAN_SCHEMA_VERSION || value === PLAN_SCHEMA_VERSION;
}

/** Structural routing only; full extraction validation remains authoritative. */
export function isExtractionManifestLike(value: unknown): value is ExtractionManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as { readonly schemaVersion?: unknown; readonly baselineCommit?: unknown };
  return isSupportedExtractionManifestVersion(candidate.schemaVersion) || "baselineCommit" in candidate;
}

export interface CommitSpec { readonly subject: string; readonly body?: string }
export interface ConsumerRewrite {
  readonly file: string;
  readonly owner: string;
  readonly expectedImporter: string;
  readonly specifiers: readonly ImportRewrite[];
  readonly external: boolean;
  readonly dependencySection: "runtime" | "dev";
}
export interface PublicModule {
  readonly source: string;
  readonly target: string;
  readonly specifier: string;
  readonly exportKey: string;
  readonly exportTarget: string;
  readonly requiredExports: readonly ExportSurface[];
}
/** One import from a package-owned file into application code. */
export interface BoundaryEdge {
  readonly file: string;
  readonly target: string;
}
/**
 * Boundary violations already present at the plan's baseline, reviewed and
 * approved with it. See `boundary-baseline.ts` for identity and audit meaning;
 * an absent record is an empty baseline, not a waiver.
 */
export interface BoundaryBaselineRecord {
  readonly digest: Sha256;
  readonly edges: readonly BoundaryEdge[];
}
export interface PlanTarget {
  readonly packageName: string;
  readonly packageRoot: string;
  readonly entrypoint: string;
  readonly projectId?: string;
  readonly profile?: { readonly name: string; readonly candidateName: string };
  readonly requiredExports: readonly ExportSurface[];
  readonly publicModules?: readonly PublicModule[];
  /** Explicit planner override for the package's public module surface. */
  readonly publicSurface?: PublicSurfaceConfig;
}
export interface PlanSource {
  readonly files: readonly string[];
  readonly tests: readonly string[];
  readonly assets?: readonly string[];
  readonly sccs: Readonly<Record<string, readonly string[]>>;
}
export interface PlanDependencies {
  readonly runtime: Readonly<Record<string, string>>;
  readonly dev: Readonly<Record<string, string>>;
  readonly packageReferences: readonly string[];
}
export interface DependencyDecisionEvidence {
  readonly name: string;
  readonly decision: "target-runtime" | "target-dev" | "donor-review" | "donor-remove";
  readonly sources: readonly string[];
  readonly reasons: readonly ("production-import" | "test-import" | "type-only-import" | "no-retained-consumer")[];
}
export interface ProjectedArtifactEvidence {
  readonly path: string;
  readonly kind: "json" | "lockfile" | "structured";
  readonly resultHash: Sha256;
}
export interface IntegrationTestSuiteRecord {
  readonly name: string;
  readonly sourceRoot: string;
  readonly donorApplication: string;
  readonly donorImports: readonly { readonly source: string; readonly specifier: string }[];
}
export interface GeneratedFileRecord {
  readonly path: string;
  readonly source: string;
  readonly regenerate: string;
  readonly expectedHash?: Sha256;
  readonly exemptReason?: string;
  readonly regenerateOnApply?: true;
  readonly preparerId?: string;
  readonly verify?: string;
}
export interface PostJournalPreparerRecord {
  readonly id: string;
  readonly command?: string;
  readonly outputs: readonly string[];
  readonly replacements?: readonly { readonly path: string; readonly before: string; readonly after: string; readonly prefix?: string; readonly suffix?: string }[];
  readonly creates?: readonly { readonly path: string; readonly contents: string; readonly mode: number }[];
  readonly mutations: readonly { readonly path: string; readonly preconditionHash: FileState; readonly preconditionMode: number | "missing"; readonly resultHash: Sha256; readonly resultMode: number }[];
  readonly emittedModuleSpecifiers: readonly { readonly source: string; readonly resolutionBase: string }[];
  readonly verify?: string;
}
export interface DynamicImportDelta { readonly added: readonly string[]; readonly removed: readonly string[] }
export interface PlanAdapterProvenance {
  readonly id: string;
  readonly contractVersion: number;
  readonly declaredVersion?: string;
}
export interface PlanProvenance {
  readonly configDigest: Sha256;
  readonly policyDigest: Sha256;
  readonly compiler: { readonly artifactIntegrity: Sha256; readonly sourceRevision?: string };
  readonly adapters: {
    readonly packageManager: PlanAdapterProvenance;
    readonly taskRunner: PlanAdapterProvenance;
  };
  /** Present only for an explicit evacuation that authorizes configured protected roots. */
  readonly evacuation?: {
    readonly id: string;
    readonly requested: readonly string[];
    readonly retainedComposition: readonly string[];
    readonly authorizedProtectedRoots: readonly string[];
    readonly includedCompositionRoots?: readonly string[];
  };
}
export type EvaluationReach = "moved" | "generated" | "reached";
export interface EvaluationModuleRecord {
  readonly subject: "module";
  readonly reach: EvaluationReach;
  readonly path: string;
  readonly kinds: readonly EvaluationEffectKind[];
}
export type SideEffectsDeclaration = "none" | "some" | "undeclared" | "unresolved";
export interface EvaluationPackageRecord {
  readonly subject: "package";
  readonly name: string;
  readonly sideEffects: SideEffectsDeclaration;
}
export type EvaluationEffectRecord = EvaluationModuleRecord | EvaluationPackageRecord;

export interface ExtractionManifest {
  readonly schemaVersion: typeof LEGACY_PLAN_SCHEMA_VERSION | typeof PREVIOUS_PLAN_SCHEMA_VERSION | typeof PLAN_SCHEMA_VERSION;
  readonly planId: string;
  readonly createdAt: string;
  readonly generator: { readonly name: string; readonly version: string };
  /** Absent only on legacy schema-v2 manifests. */
  readonly provenance?: PlanProvenance;
  readonly baselineCommit: string;
  readonly graphDigest: Sha256;
  readonly application: string;
  /** Architectural judgment captured at compile time, independent of mechanical validity. */
  readonly assessment?: {
    readonly status: "recommended" | "review-required" | "discouraged";
    readonly cohesion: "high" | "medium" | "low";
    readonly reasons: readonly { readonly code: string; readonly detail: string; readonly paths: readonly string[] }[];
    readonly compatibilityShims: readonly {
      readonly path: string;
      readonly packageName: string;
      readonly replacementSpecifier: string;
      readonly productionConsumers: readonly string[];
      readonly testConsumers: readonly string[];
    }[];
    readonly targetOptions: readonly {
      readonly packageName: string;
      readonly action: "extend" | "create";
      readonly confidence: "high" | "medium" | "low";
      readonly compatibility: "compatible" | "requires-review";
      readonly reasons: readonly string[];
    }[];
    readonly selectedTarget: {
      readonly packageName: string;
      readonly packageRoot: string;
      readonly action: "extend" | "create";
    };
  };
  /** Present only for a reviewed complete-module architectural boundary cut. */
  readonly modulePromotion?: {
    readonly id: string;
    readonly source: string;
    readonly targetModule: string;
    readonly retireSource: boolean;
    readonly importerProof: readonly string[];
    readonly cycleCut?: {
      readonly before: readonly string[];
      readonly after: readonly (readonly string[])[];
      readonly removedEdges: readonly { readonly from: string; readonly to: string }[];
    };
    readonly containmentCut?: {
      readonly architecturalEdgesBefore: number;
      readonly architecturalEdgesAfter: number;
      readonly removedEdges: readonly { readonly from: string; readonly to: string }[];
      readonly introducedApplicationDependencies: readonly string[];
    };
  };
  /**
   * Boundary violations that already existed at `baselineCommit`, recorded so
   * the audit fails only on edges this plan introduced. Absent on manifests
   * compiled before the baseline existed, which the audit reads as an empty
   * baseline — the strict, pre-existing behaviour.
   */
  readonly boundaryBaseline?: BoundaryBaselineRecord;
  readonly target: PlanTarget;
  readonly source: PlanSource;
  readonly dependencies: PlanDependencies;
  readonly dependencyDecisions?: readonly DependencyDecisionEvidence[];
  readonly projectedArtifacts?: readonly ProjectedArtifactEvidence[];
  readonly donorDependencyPruning?: {
    readonly mode: "report" | "apply";
    readonly candidates: readonly { readonly name: string; readonly section: "runtime" | "dev" | "optional" }[];
  };
  readonly integrationTestSuite?: IntegrationTestSuiteRecord;
  readonly sourceBlobs: Readonly<Record<string, Sha256>>;
  readonly operations: readonly PlanOperation[];
  /** Configured path migrations proven byte-identical at plan time. */
  readonly pathMigrationNoops?: readonly {
    readonly path: string;
    readonly command: string;
    readonly moves: readonly { readonly source: string; readonly target: string }[];
    readonly artifactHash: Sha256;
  }[];
  readonly consumers: readonly ConsumerRewrite[];
  readonly generatedFiles: readonly GeneratedFileRecord[];
  readonly postJournalPreparers?: readonly PostJournalPreparerRecord[];
  readonly changedFiles: readonly string[];
  readonly lockfileImporter?: { readonly packageRoot: string; readonly hash: Sha256 };
  readonly expectedDynamicImportDelta: DynamicImportDelta;
  readonly evaluationEffects: readonly EvaluationEffectRecord[];
  readonly metrics: {
    readonly movedFiles: number;
    readonly movedLines: number;
    readonly applicationLinesBefore: number;
    readonly applicationLinesAfter: number;
    readonly consumers: number;
  };
  readonly commits: { readonly move: CommitSpec; readonly wiring: CommitSpec; readonly plan?: CommitSpec };
  readonly gates: { readonly package: readonly string[]; readonly project: readonly string[]; readonly workspace: readonly string[] };
}
