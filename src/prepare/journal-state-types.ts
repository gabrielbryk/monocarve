/** Internal state captured while a preparation journal owns filesystem paths. */
export type PreparationSnapshot = MissingSnapshot | FileSnapshot | SymlinkSnapshot;

interface MissingSnapshot {
  readonly kind: "missing";
  readonly absentAncestors: readonly string[];
}

interface FileSnapshot {
  readonly kind: "file";
  readonly bytes: Uint8Array;
  readonly mode: number;
  readonly absentAncestors: readonly string[];
}

interface SymlinkSnapshot {
  readonly kind: "symlink";
  readonly target: string;
  readonly mode: number;
  readonly absentAncestors: readonly string[];
}

export type PreparationProducedState =
  | { readonly kind: "missing" }
  | { readonly kind: "file"; readonly hash: string; readonly mode: number };

export interface PreparationMutationRecord {
  readonly snapshot: PreparationSnapshot;
  readonly privateDirectory: string;
  readonly backupPath?: string;
  produced?: PreparationProducedState;
}

export function canonicalGitMode(mode: number): 0o644 | 0o755 {
  return (mode & 0o111) === 0 ? 0o644 : 0o755;
}
