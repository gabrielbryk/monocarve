import type { FileState, Sha256 } from "../util/hash.ts";

export interface MoveOperation {
  readonly kind: "move";
  readonly source: string;
  readonly target: string;
  readonly preconditionHash: FileState;
  readonly resultHash: Sha256;
}

export interface ImportRewrite {
  readonly from: string;
  readonly to: string;
  readonly donor?: string;
}

export interface RewriteImportOperation {
  readonly kind: "rewrite-import";
  readonly file: string;
  readonly donors: readonly string[];
  readonly rewrites: readonly ImportRewrite[];
  readonly preconditionHash: FileState;
  readonly resultHash: Sha256;
}

export interface FsReferenceRewrite {
  readonly from: string;
  readonly to: string;
  /** Moved source this rewrite targets, workspace-relative at its pre-move path. */
  readonly donor: string;
}

export interface RewriteFsReferenceOperation {
  readonly kind: "rewrite-fs-reference";
  readonly file: string;
  readonly rewrites: readonly FsReferenceRewrite[];
  readonly preconditionHash: FileState;
  readonly resultHash: Sha256;
}

/**
 * Path reference rewrites fix inline documentation and configuration references
 * when files move. Unlike fs-reference rewrites (which target string literals in code),
 * these target path tokens embedded in prose and structured data. Line and column track
 * the exact location within the document for audit and manual verification.
 */
export interface PathReferenceRewrite {
  readonly from: string;
  readonly to: string;
  /** Moved source this rewrite targets, workspace-relative at its pre-move path. */
  readonly donor: string;
  /** 1-based line number in the document. */
  readonly line: number;
  /** 1-based column number in the document. */
  readonly column: number;
  /** Structured-registry identity; absent for ordinary path-token rewrites. */
  readonly jsonPointer?: string;
  /** Workspace-relative root from which the registry value resolves. */
  readonly resolutionBase?: string;
  /** Exact registry prefix the modeled runtime removes before path resolution. */
  readonly strippedPrefix?: string;
  /** This string is emitted by a generator and resolves from `resolutionBase`. */
  readonly emittedModuleSpecifier?: true;
  /** Ordinary token was resolved from this declared repo-relative base. */
  readonly referenceBase?: string;
}

export interface RewritePathReferenceOperation {
  readonly kind: "rewrite-path-reference";
  readonly file: string;
  /**
   * Document format: markdown, JSON, or plain-text. Determines token extraction
   * and normalization rules. Recorded here so audit and review tooling can
   * reason about mutations without re-reading the file.
   */
  readonly documentKind: "markdown" | "json" | "plain-text";
  readonly rewrites: readonly PathReferenceRewrite[];
  readonly preconditionHash: FileState;
  readonly resultHash: Sha256;
}

export interface WriteFileOperation {
  readonly kind: "write-file";
  readonly path: string;
  readonly contents: string;
  readonly preconditionHash: FileState;
  readonly resultHash: Sha256;
  readonly generator?: string;
}

export type LockfileImporterMode = "insert" | "replace";

export interface LockfileImporterOperation {
  readonly kind: "lockfile-importer";
  readonly lockfile: string;
  readonly packageRoot: string;
  readonly block: string;
  readonly mode?: LockfileImporterMode;
  readonly preconditionHash: FileState;
  readonly resultHash: Sha256;
}

export interface EscapeRewrite {
  readonly donorlessSpecifier: string;
  readonly packageSpecifier: string;
}

export interface MoveWithRewriteOperation {
  readonly kind: "move-with-rewrite";
  readonly source: string;
  readonly target: string;
  readonly rewrites: readonly EscapeRewrite[];
  readonly preconditionHash: FileState;
  readonly resultHash: Sha256;
}

export interface PathMove {
  readonly source: string;
  readonly target: string;
}

export interface MigratePathKeysOperation {
  readonly kind: "migrate-path-keys";
  readonly path: string;
  readonly command: string;
  readonly moves: readonly PathMove[];
  readonly preconditionHash: FileState;
  readonly resultHash: Sha256;
}

export type PlanOperation =
  | MoveOperation
  | RewriteImportOperation
  | RewriteFsReferenceOperation
  | RewritePathReferenceOperation
  | WriteFileOperation
  | LockfileImporterOperation
  | MoveWithRewriteOperation
  | MigratePathKeysOperation;

export type PlanOperationKind = PlanOperation["kind"];
export const PURE_RENAME_KINDS: readonly PlanOperationKind[] = ["move"];
