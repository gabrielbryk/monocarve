import type { Sha256 } from "../util/hash.ts";

/** The TypeScript declaration space occupied by a symbol or reference. */
export type SymbolSpace = "type" | "value" | "both";

export type DeclarationKind = "class" | "enum" | "function" | "interface" | "namespace" | "type-alias" | "variable";

export interface SourceSpan {
  /** Zero-based UTF-16 offsets, matching the TypeScript compiler API. */
  readonly start: number;
  readonly end: number;
  readonly hash: Sha256;
}

/** One physical, top-level declaration in a source file. */
export interface SymbolDeclaration {
  readonly id: Sha256;
  readonly sourcePath: string;
  readonly name: string;
  readonly kind: DeclarationKind;
  readonly span: SourceSpan;
  readonly exported: boolean;
  readonly space: SymbolSpace;
}

/**
 * Declarations that TypeScript requires to travel together.
 *
 * Function overloads and legal type/value or namespace merges share a group.
 * A future file splitter should move groups, never individual declarations.
 */
export interface DeclarationGroup {
  readonly id: Sha256;
  readonly sourcePath: string;
  readonly name: string;
  readonly declarationIds: readonly Sha256[];
  readonly exported: boolean;
  readonly space: SymbolSpace;
}

export interface SymbolReference {
  readonly sourceDeclarationId: Sha256;
  readonly span: SourceSpan;
  readonly space: Exclude<SymbolSpace, "both">;
}

/** Aggregated intra-file references between declaration groups. */
export interface SymbolEdge {
  readonly source: Sha256;
  readonly target: Sha256;
  readonly space: SymbolSpace;
  readonly references: readonly SymbolReference[];
}

export interface DeclarationComponent {
  readonly id: Sha256;
  readonly groupIds: readonly Sha256[];
  readonly cyclic: boolean;
}

export interface SymbolGraph {
  readonly schemaVersion: 1;
  readonly sourcePath: string;
  readonly sourceHash: Sha256;
  /** Non-binding diagnostics are reported, never silently discarded. */
  readonly diagnostics: readonly SymbolAnalysisDiagnostic[];
  readonly declarations: readonly SymbolDeclaration[];
  readonly groups: readonly DeclarationGroup[];
  readonly edges: readonly SymbolEdge[];
  readonly components: readonly DeclarationComponent[];
}

export interface SymbolAnalysisDiagnostic {
  readonly phase: "syntactic" | "semantic";
  readonly code: number;
  readonly category: "error" | "warning" | "suggestion" | "message";
  readonly message: string;
  readonly start?: number;
  readonly length?: number;
}

export interface AnalyzeTypeScriptSourceInput {
  /** Stable repository-relative display path. Absolute and parent paths refuse. */
  readonly sourcePath: string;
  readonly sourceText: string;
}

export interface ExternalSymbolConsumer {
  readonly groupId: Sha256;
  readonly groupName: string;
  readonly consumerPath: string;
  readonly affinity: string;
  readonly space: SymbolSpace;
  readonly referenceCount: number;
}

/** One declaration SCC considered as an atomic, read-only split suggestion. */
export interface SymbolSplitCandidate {
  readonly id: Sha256;
  readonly groupIds: readonly Sha256[];
  readonly names: readonly string[];
  readonly space: SymbolSpace;
  readonly exported: boolean;
  readonly consumers: readonly ExternalSymbolConsumer[];
  readonly affinities: Readonly<Record<string, number>>;
  readonly dominantAffinity?: string;
  readonly affinityConcentration: number;
  readonly incomingBoundaryEdges: number;
  readonly outgoingBoundaryEdges: number;
  /** Deterministic diagnostic ranking only; it is not an executability claim. */
  readonly score: number;
}

export interface WorkspaceSymbolAnalysis {
  readonly schemaVersion: 1;
  readonly source: SymbolGraph;
  readonly consumers: readonly ExternalSymbolConsumer[];
  readonly splitCandidates: readonly SymbolSplitCandidate[];
}

export interface AnalyzeWorkspaceSymbolsInput {
  readonly rootDir: string;
  readonly tsconfigPath: string;
  readonly sourcePath: string;
  /** Workspace-derived domain/owner label. The analyzer never guesses domains. */
  readonly affinityForPath: (path: string) => string;
}
