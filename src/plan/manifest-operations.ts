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
  | WriteFileOperation
  | LockfileImporterOperation
  | MoveWithRewriteOperation
  | MigratePathKeysOperation;

export type PlanOperationKind = PlanOperation["kind"];
export const PURE_RENAME_KINDS: readonly PlanOperationKind[] = ["move"];
