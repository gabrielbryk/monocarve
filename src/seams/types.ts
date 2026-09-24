import type { DeclarationGroup, ExternalSymbolConsumer, SymbolSpace, WorkspaceSymbolAnalysis } from "../symbols/types.ts";
import type { Sha256 } from "../util/hash.ts";
import type { TypeOnlyExtractionRefusalCode, TypeOnlyExtractionSafety } from "./safety.ts";

/** A declaration partition is named by its role, never by a guessed module path. */
export type SeamPartition = "moved" | "retained";

/** Whether a conclusion follows from the symbol graph or is only a placement hint. */
export type SeamConfidence = "exact" | "heuristic";

export interface PlanSeamInput {
  /** The workspace-aware analysis for exactly one source file. */
  readonly analysis: WorkspaceSymbolAnalysis;
  /** Exact bytes used to build the source graph; stale bytes become refusal evidence. */
  readonly sourceText: string;
  /** An SCC candidate from `analysis.splitCandidates`; partial SCCs refuse. */
  readonly candidateId: Sha256;
  /**
   * A caller-selected repository-relative destination, if one is known.
   * The planner does not invent paths from affinity labels.
   */
  readonly targetPath?: string;
}

/** One cross-partition symbol dependency that a later transformation must wire. */
export interface RequiredSeamImport {
  readonly importer: SeamPartition;
  readonly exporter: SeamPartition;
  readonly importerGroupId: Sha256;
  readonly importerName: string;
  readonly importedGroupId: Sha256;
  readonly importedName: string;
  readonly space: SymbolSpace;
  readonly referenceCount: number;
  readonly confidence: "exact";
}

/** A consumer outside the source file whose import/re-export surface is affected. */
export interface AffectedSeamConsumer extends ExternalSymbolConsumer {
  readonly partition: "moved";
  readonly confidence: "exact";
}

/** A cycle that remains intentionally intact because its SCC is indivisible. */
export interface RetainedSeamCycle {
  readonly componentId: Sha256;
  readonly groupIds: readonly Sha256[];
  readonly confidence: "exact";
}

export type SeamBlockerCode =
  | "target-path-is-source"
  | "target-path-not-provided"
  | "cyclic-component"
  | "no-dominant-affinity"
  | "split-affinity"
  | "value-boundary-dependency"
  | "stale-source"
  | "target-collision"
  | TypeOnlyExtractionRefusalCode;

/** A fact a later executable preparation step must resolve before it can claim safety. */
export interface SeamBlocker {
  readonly code: SeamBlockerCode;
  readonly message: string;
  readonly confidence: SeamConfidence;
  readonly groupId?: Sha256;
  readonly declarationId?: Sha256;
  readonly start?: number;
  readonly end?: number;
}

/** The provenance of each part of the recommendation. */
export interface SeamPlanConfidence {
  readonly partition: "exact";
  readonly imports: "exact";
  readonly consumers: "exact";
  /** Affinity identifies likely ownership; it never proves a destination module. */
  readonly placement: "heuristic";
}

/**
 * A read-only declaration-level partition proposal.
 *
 * This is deliberately not a mutation recipe: it exposes every boundary a
 * later preparation manifest must prove, without claiming that imports or a
 * target module have been written.
 */
export interface SeamPlan {
  readonly schemaVersion: 1;
  readonly id: Sha256;
  readonly sourcePath: string;
  readonly sourceHash: Sha256;
  readonly candidateId: Sha256;
  readonly targetPath?: string;
  readonly movedGroups: readonly DeclarationGroup[];
  readonly retainedGroups: readonly DeclarationGroup[];
  readonly requiredImports: readonly RequiredSeamImport[];
  readonly affectedConsumers: readonly AffectedSeamConsumer[];
  /** No declaration SCC is split, so this planner never falsely claims a broken cycle. */
  readonly cyclesBroken: readonly never[];
  readonly cyclesRetained: readonly RetainedSeamCycle[];
  /** Exact declaration-level classifier results for every moved SCC group. */
  readonly typeOnlyPreparationSafety: readonly TypeOnlyExtractionSafety[];
  /** False for any unsafe declaration or value-space boundary dependency. */
  readonly eligibleForTypeOnlyPreparation: boolean;
  readonly remainingBlockers: readonly SeamBlocker[];
  readonly confidence: SeamPlanConfidence;
}

export interface PlanMultiFileSeamsInput {
  readonly rootDir: string;
  readonly tsconfigPath: string;
  /** Explicit, repository-relative source files from one configured TS program. */
  readonly sourcePaths: readonly string[];
  readonly affinityForPath: (path: string) => string;
  /** Optional caller observations; a mismatch is a refusal, never silently refreshed. */
  readonly expectedSourceHashes?: Readonly<Record<string, Sha256>>;
  /** Reviewed placement hints keyed by declaration-group id. */
  readonly targetPaths?: Readonly<Record<string, string>>;
}

export interface MultiFileSymbolEdge {
  readonly sourcePath: string;
  readonly sourceGroupId: Sha256;
  readonly sourceName: string;
  readonly targetPath: string;
  readonly targetGroupId: Sha256;
  readonly targetName: string;
  readonly space: SymbolSpace;
  readonly referenceCount: number;
  readonly confidence: "exact";
}

/** Groups backed by one compiler symbol and therefore indivisible across files. */
export interface MultiFileMergedSymbol {
  readonly groupIds: readonly Sha256[];
  readonly sourcePaths: readonly string[];
  readonly name: string;
  readonly confidence: "exact";
}

export interface MultiFileSeamCandidate {
  readonly id: Sha256;
  readonly groupIds: readonly Sha256[];
  readonly groups: readonly DeclarationGroup[];
  readonly sourcePaths: readonly string[];
  readonly cyclic: boolean;
  readonly placement: { readonly confidence: SeamConfidence; readonly targetPath?: string };
  readonly affectedConsumers: readonly ExternalSymbolConsumer[];
  readonly blockers: readonly SeamBlocker[];
}

export interface MultiFileSeamPlan {
  readonly schemaVersion: 1;
  readonly id: Sha256;
  readonly sourceHashes: Readonly<Record<string, Sha256>>;
  readonly edges: readonly MultiFileSymbolEdge[];
  readonly mergedSymbols: readonly MultiFileMergedSymbol[];
  readonly candidates: readonly MultiFileSeamCandidate[];
  readonly blockers: readonly SeamBlocker[];
}
