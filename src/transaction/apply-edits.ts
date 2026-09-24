/**
 * Post-interruption edit detection for `apply-recover`.
 *
 * Restoring a checkpoint writes the pre-apply bytes of every snapshotted path
 * back and replaces the index. That is exactly right for bytes the interrupted
 * apply produced, and silently destructive for anything the developer changed
 * after the interruption. Before a restore, each snapshotted path must hold
 * either its checkpointed pre-apply state or a state the transaction itself
 * can have produced: an operation's declared result, a declared generated or
 * preparer output, or a state the apply durably observed at a stage boundary.
 * The index is held to the same rule, and any staged path outside the
 * transaction's paths is the developer's. Anything else is reported, and the
 * restore runs only when the operator explicitly discards those changes.
 */
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { resolve } from "node:path";

import type { ExtractionManifest } from "../plan/manifest.ts";
import { gitBytes, repositoryPrefix, tryGit } from "../util/git.ts";
import { hashBytes, hashText, MISSING, type FileState } from "../util/hash.ts";
import type { PersistedCheckpoint } from "./apply-checkpoint.ts";

/** A path's current worktree state, comparable with a snapshot's `state`; undefined for directories and other unsupported types. */
export function currentPathState(rootDir: string, path: string): FileState | undefined {
  const absolute = resolve(rootDir, path);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(absolute);
  } catch {
    return MISSING;
  }
  if (stat.isSymbolicLink()) return hashText(readlinkSync(absolute));
  return stat.isFile() ? hashBytes(readFileSync(absolute)) : undefined;
}

/** Every state the manifest declares a path can hold while (or after) its journal runs. */
function journalProducedStates(manifest: ExtractionManifest): Map<string, Set<FileState>> {
  const produced = new Map<string, Set<FileState>>();
  const add = (path: string, state: FileState | undefined): void => {
    if (state === undefined) return;
    const states = produced.get(path) ?? new Set<FileState>();
    states.add(state);
    produced.set(path, states);
  };
  for (const operation of manifest.operations) {
    if (operation.kind === "move" || operation.kind === "move-with-rewrite") {
      add(operation.source, MISSING);
      add(operation.target, operation.resultHash);
      // `git mv` stages the source bytes at the target before any rewrite lands.
      add(operation.target, operation.preconditionHash);
    } else if (operation.kind === "delete-file") add(operation.path, MISSING);
    else if (operation.kind === "lockfile-importer") add(operation.lockfile, operation.resultHash);
    else if (operation.kind === "write-file" || operation.kind === "migrate-path-keys") add(operation.path, operation.resultHash);
    else add(operation.file, operation.resultHash);
  }
  for (const generated of manifest.generatedFiles) add(generated.path, generated.expectedHash);
  for (const preparer of manifest.postJournalPreparers ?? []) for (const mutation of preparer.mutations) add(mutation.path, mutation.resultHash);
  for (const artifact of manifest.projectedArtifacts ?? []) add(artifact.path, artifact.resultHash);
  return produced;
}

/**
 * Paths whose worktree or staged state the interrupted apply cannot have
 * produced, each suffixed with where the difference is. Empty means a restore
 * discards only the transaction's own work.
 */
export function postInterruptionEdits(rootDir: string, checkpoint: PersistedCheckpoint, manifest: ExtractionManifest): string[] {
  const produced = journalProducedStates(manifest);
  const acceptable = new Map<string, Set<FileState>>();
  for (const snapshot of checkpoint.snapshots) {
    const states = new Set<FileState>([snapshot.kind === "missing" ? MISSING : snapshot.state, ...(produced.get(snapshot.path) ?? [])]);
    for (const state of checkpoint.observed?.[snapshot.path] ?? []) states.add(state);
    acceptable.set(snapshot.path, states);
  }
  const edits: string[] = [];
  for (const snapshot of checkpoint.snapshots) {
    const state = currentPathState(rootDir, snapshot.path);
    if (!isAcceptable(acceptable, snapshot.path, state)) edits.push(`${snapshot.path} (working tree)`);
    else if (snapshot.kind === "file" && state === snapshot.state && modeOf(rootDir, snapshot.path) !== snapshot.mode) edits.push(`${snapshot.path} (mode)`);
  }
  return [...edits, ...stagedEdits(rootDir, checkpoint, acceptable)];
}

function isAcceptable(acceptable: ReadonlyMap<string, ReadonlySet<FileState>>, path: string, state: FileState | undefined): boolean {
  return state !== undefined && acceptable.get(path)?.has(state) === true;
}

function modeOf(rootDir: string, path: string): number {
  return lstatSync(resolve(rootDir, path)).mode & 0o777;
}

/** Index entries that differ from the checkpointed pre-apply index in a way the apply cannot have staged. */
function stagedEdits(rootDir: string, checkpoint: PersistedCheckpoint, acceptable: ReadonlyMap<string, ReadonlySet<FileState>>): string[] {
  if (checkpoint.indexTree === undefined) return [];
  const prefix = repositoryPrefix(rootDir);
  const changed = decodeNulList(gitBytes({ cwd: rootDir }, "diff-index", "--cached", "--name-only", "--no-renames", "-z", checkpoint.indexTree, "--"));
  const edits: string[] = [];
  for (const repositoryPath of changed) {
    const path = repositoryPath.startsWith(prefix) ? repositoryPath.slice(prefix.length) : undefined;
    if (path === undefined || !acceptable.has(path) || !isAcceptable(acceptable, path, stagedState(rootDir, path)))
      edits.push(`${path ?? repositoryPath} (staged)`);
  }
  return edits;
}

/** Staged state of `path`; undefined for a conflicted, ambiguous, or non-blob entry. */
function stagedState(rootDir: string, path: string): FileState | undefined {
  const entries = decodeNulList(gitBytes({ cwd: rootDir }, "ls-files", "--stage", "-z", "--", path));
  const [entry] = entries;
  if (entry === undefined) return MISSING;
  const [meta = ""] = entry.split("\t");
  const [, object, stage] = meta.split(" ");
  if (entries.length !== 1 || stage !== "0" || object === undefined || tryGit({ cwd: rootDir }, "cat-file", "-t", object) !== "blob") return undefined;
  return hashBytes(gitBytes({ cwd: rootDir }, "cat-file", "blob", object));
}

function decodeNulList(bytes: Uint8Array): string[] {
  return new TextDecoder().decode(bytes).split("\0").filter(Boolean);
}
