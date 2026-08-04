/** Snapshot and restore primitives for a transaction tree. */
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

import { fileState, isDirectory } from "../util/files.ts";
import { hashBytes, hashText, MISSING, type FileState } from "../util/hash.ts";
import { JournalError } from "./journal-error.ts";

export interface Snapshot {
  readonly exists: boolean;
  readonly kind: "missing" | "file" | "symlink";
  readonly content?: Uint8Array;
  readonly state: FileState;
  readonly mode?: number;
  readonly linkTarget?: string;
  readonly absentAncestors: readonly string[];
}

export interface RestoreFailure {
  readonly path: string;
  readonly message: string;
}

export interface RestoreReport {
  readonly restored: readonly string[];
  readonly failures: readonly RestoreFailure[];
}

type ExistingPathKind = "file" | "symlink" | "other";

function pathAt(root: string, path: string): string {
  return resolve(root, path);
}

function absentAncestors(root: string, path: string): string[] {
  const absent: string[] = [];
  let directory = dirname(path);
  while (directory !== "." && directory !== "" && directory !== "/" && directory !== dirname(directory)) {
    if (isDirectory(pathAt(root, directory))) break;
    absent.push(directory);
    directory = dirname(directory);
  }
  return absent;
}

export function snapshotPaths(root: string, paths: readonly string[]): Map<string, Snapshot> {
  return new Map(paths.map((path): [string, Snapshot] => [path, snapshotPath(root, path)]));
}

function snapshotPath(root: string, path: string): Snapshot {
  const absolute = pathAt(root, path);
  const absent = absentAncestors(root, path);
  const stat = lstatOrMissing(absolute);
  if (stat === undefined) return { exists: false, kind: "missing", state: MISSING, absentAncestors: absent };
  if (stat.isSymbolicLink()) {
    const linkTarget = readlinkSync(absolute);
    return { exists: true, kind: "symlink", state: hashText(linkTarget), linkTarget, absentAncestors: absent };
  }
  if (!stat.isFile()) throw new JournalError(`cannot snapshot unsupported path type: ${path}`);
  const content = readFileSync(absolute);
  return {
    exists: true,
    kind: "file",
    content,
    state: hashBytes(content),
    mode: Number(stat.mode) & 0o777,
    absentAncestors: absent,
  };
}

function lstatOrMissing(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
    throw error;
  }
}

function existingPathKind(path: string): ExistingPathKind | undefined {
  const stat = lstatOrMissing(path);
  if (stat === undefined) return undefined;
  if (stat.isFile()) return "file";
  if (stat.isSymbolicLink()) return "symlink";
  return "other";
}

export function snapshotMismatch(root: string, path: string, snapshot: Snapshot): string | undefined {
  const absolute = pathAt(root, path);
  const actualKind = existingPathKind(absolute);
  if (snapshot.kind === "missing") return actualKind === undefined ? undefined : `expected missing, got ${actualKind}`;
  if (actualKind === undefined) return `expected ${snapshot.kind}, got missing`;
  if (actualKind !== snapshot.kind) return `expected ${snapshot.kind}, got ${actualKind}`;
  if (snapshot.kind === "symlink") {
    const actualTarget = readlinkSync(absolute);
    return actualTarget === snapshot.linkTarget ? undefined : `expected link to ${snapshot.linkTarget}, got ${actualTarget}`;
  }
  const actualMode = Number(lstatSync(absolute).mode) & 0o777;
  if (actualMode !== snapshot.mode) return `expected mode ${snapshot.mode?.toString(8)}, got ${actualMode.toString(8)}`;
  const actualState = fileState(absolute);
  return actualState === snapshot.state ? undefined : `expected ${snapshot.state}, got ${actualState}`;
}

export function restoreSnapshot(root: string, snapshots: ReadonlyMap<string, Snapshot>): RestoreReport {
  const restored: string[] = [];
  const failures: RestoreFailure[] = [];
  for (const [path, snapshot] of snapshots) restorePath(root, path, snapshot, restored, failures);
  pruneCreatedDirectories(root, snapshots);
  return { restored, failures };
}

function restorePath(
  root: string,
  path: string,
  snapshot: Snapshot,
  restored: string[],
  failures: RestoreFailure[],
): void {
  const absolute = pathAt(root, path);
  try {
    if (snapshotMismatch(root, path, snapshot) === undefined) return;
    if (lstatOrMissing(absolute) !== undefined) unlinkSync(absolute);
    if (snapshot.kind !== "missing") {
      mkdirSync(dirname(absolute), { recursive: true });
      if (snapshot.kind === "symlink") symlinkSync(snapshot.linkTarget!, absolute);
      else {
        writeFileSync(absolute, snapshot.content!);
        chmodSync(absolute, snapshot.mode!);
      }
    }
    restored.push(path);
  } catch (error) {
    failures.push({ path, message: (error as Error).message });
  }
}

function pruneCreatedDirectories(root: string, snapshots: ReadonlyMap<string, Snapshot>): void {
  const created = new Set<string>();
  for (const snapshot of snapshots.values()) for (const directory of snapshot.absentAncestors) created.add(directory);
  const deepestFirst = [...created].sort((a, b) => b.split("/").length - a.split("/").length || (a < b ? 1 : -1));
  for (const directory of deepestFirst) {
    try {
      rmdirSync(pathAt(root, directory));
    } catch {
      // Not empty, already gone, or refused. Empty directories are not content.
    }
  }
}
