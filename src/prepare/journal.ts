/**
 * Atomic filesystem primitive for preparation plans.
 *
 * A preparation changes source text before the ordinary extraction journal can
 * run.  It consequently has a distinct journal: this one only knows rendered
 * writes and deletes, snapshots every touched leaf before changing anything,
 * and restores that snapshot when any later operation fails.
 */
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { SCRATCH_DIRNAME } from "../branding.ts";
import { HashMismatchError } from "../errors.ts";
import { hashBytes, hashText, MISSING, type FileState } from "../util/hash.ts";
import { relativeWorkspacePath, workspacePath } from "../util/paths.ts";
import { errorMessage, PreparationJournalError, restorationError } from "./journal-error.ts";
import {
  canonicalGitMode,
  type PreparationMutationRecord as MutationRecord,
  type PreparationProducedState as ProducedState,
  type PreparationSnapshot as Snapshot,
} from "./journal-state-types.ts";

export interface PreparationWrite {
  readonly kind: "write";
  readonly path: string;
  /** Rendered UTF-8 bytes. Preparation plans never normalize them on apply. */
  readonly contents: string;
  readonly preconditionHash: FileState;
  readonly preconditionMode: number | typeof MISSING;
  readonly resultHash: string;
  readonly resultMode: number;
}

export interface PreparationDelete {
  readonly kind: "delete";
  readonly path: string;
  readonly preconditionHash: FileState;
  readonly preconditionMode: number | typeof MISSING;
}

export type PreparationFilesystemOperation = PreparationWrite | PreparationDelete;

export interface PreparationJournalOptions {
  readonly rootDir: string;
  readonly operations: readonly PreparationFilesystemOperation[];
  /** Test seam: runs immediately before an operation mutates the filesystem. */
  readonly beforeOperation?: (index: number, operation: PreparationFilesystemOperation) => void;
  /** Test seam: runs after the final check and immediately before ownership transfer. */
  readonly beforeOwnershipTransfer?: (index: number, operation: PreparationFilesystemOperation) => void;
}

export interface PreparationJournalResult {
  readonly applied: readonly string[];
  /** CAS-aware undo for a later commit, audit, or gate failure. */
  readonly recovery: PreparationJournalRecovery;
}

export interface PreparationRestoreFailure {
  readonly path: string;
  readonly message: string;
}

export interface PreparationRestoreReport {
  readonly restored: readonly string[];
  readonly failures: readonly PreparationRestoreFailure[];
  readonly residue: readonly string[];
}

/** Opaque because only the journal may create a recovery proof. */
export interface PreparationJournalRecovery {
  readonly rollback: () => PreparationRestoreReport;
  readonly finalize: () => void;
}
export { PreparationJournalError } from "./journal-error.ts";

/**
 * Applies already-rendered operations, or restores every touched leaf before
 * throwing.  Preconditions and rendered result hashes are checked for the
 * complete batch before the first write, so a stale plan cannot partially run.
 */
export function executePreparationJournal(options: PreparationJournalOptions): PreparationJournalResult {
  const paths = validateOperations(options.rootDir, options.operations);
  const snapshots = new Map(paths.map((path): [string, Snapshot] => [path, snapshotPath(options.rootDir, path)]));
  for (const operation of options.operations) assertSnapshotPrecondition(options.rootDir, operation, snapshots);
  const applied: string[] = [];
  const mutations = new Map<string, MutationRecord>();
  const createdDirectories = new Set<string>();
  try {
    for (const [index, operation] of options.operations.entries()) {
      options.beforeOperation?.(index, operation);
      const path = canonicalPath(options.rootDir, operation.path);
      const snapshot = snapshots.get(path)!;
      assertSnapshotCurrent(options.rootDir, path, snapshot);
      options.beforeOwnershipTransfer?.(index, operation);
      const produced = producedState(operation, snapshot);
      applyOperation(options.rootDir, operation, produced, snapshot, createdDirectories, mutations);
      applied.push(operation.path);
    }
  } catch (error) {
    const report = restoreSnapshots(options.rootDir, snapshots, mutations, createdDirectories);
    throw restorationError(error, report.failures);
  }
  return { applied, recovery: recoveryHandle(options.rootDir, snapshots, mutations, createdDirectories) };
}

/** Restore a completed journal after a later transaction stage fails. */
export function rollbackCompletedPreparationJournal(recovery: PreparationJournalRecovery): PreparationRestoreReport {
  return recovery.rollback();
}

/** Release private backups only after commit and audit have both succeeded. */
export function finalizeCompletedPreparationJournal(recovery: PreparationJournalRecovery): void {
  recovery.finalize();
}

function recoveryHandle(
  rootDir: string,
  snapshots: ReadonlyMap<string, Snapshot>,
  mutations: ReadonlyMap<string, MutationRecord>,
  createdDirectories: ReadonlySet<string>,
): PreparationJournalRecovery {
  let completed: PreparationRestoreReport | undefined;
  let finalized = false;
  return {
    rollback() {
      if (finalized) return { restored: [], failures: [{ path: ".", message: "preparation recovery was finalized" }], residue: ["."] };
      completed ??= restoreSnapshots(rootDir, snapshots, mutations, createdDirectories);
      return completed;
    },
    finalize() {
      if (completed || finalized) return;
      for (const mutation of mutations.values()) rmSync(mutation.privateDirectory, { recursive: true, force: true });
      finalized = true;
    },
  };
}

/** Verify all predicates without writing. Exported for dry-run preparation. */
export function verifyPreparationOperations(rootDir: string, operations: readonly PreparationFilesystemOperation[]): void {
  validateOperations(rootDir, operations);
}

function validateOperations(rootDir: string, operations: readonly PreparationFilesystemOperation[]): string[] {
  const paths = new Set<string>();
  for (const operation of operations) {
    const path = canonicalPath(rootDir, operation.path);
    if (paths.has(path)) throw new PreparationJournalError(`duplicate preparation operation path: ${operation.path}`);
    paths.add(path);
    verifyPrecondition(rootDir, operation);
    verifyPreconditionMode(operation, snapshotPath(rootDir, path));
    if (operation.kind === "write") {
      verifyWriteHash(operation);
      if (!validMode(operation.resultMode)) {
        throw new PreparationJournalError(`invalid preparation result mode for ${operation.path}`);
      }
    }
  }
  assertNoNestedPaths(paths);
  return [...paths];
}

function validMode(mode: number): boolean {
  return mode === 0o644 || mode === 0o755;
}

function verifyPreconditionMode(operation: PreparationFilesystemOperation, snapshot: Snapshot): void {
  const actual = snapshot.kind === "missing" ? MISSING : canonicalGitMode(snapshot.mode);
  if (actual !== operation.preconditionMode) {
    throw new PreparationJournalError(`mode precondition failed for ${operation.path}: expected ${operation.preconditionMode}, got ${actual}`);
  }
}

function canonicalPath(rootDir: string, path: string): string {
  return relativeWorkspacePath(rootDir, workspacePath(rootDir, path));
}

function verifyPrecondition(rootDir: string, operation: PreparationFilesystemOperation): void {
  const actual = stateAt(rootDir, operation.path);
  if (actual !== operation.preconditionHash) {
    throw new HashMismatchError(operation.path, operation.preconditionHash, actual);
  }
}

function assertSnapshotPrecondition(
  rootDir: string,
  operation: PreparationFilesystemOperation,
  snapshots: ReadonlyMap<string, Snapshot>,
): void {
  const snapshot = snapshots.get(canonicalPath(rootDir, operation.path))!;
  const actual = snapshotState(snapshot);
  if (actual !== operation.preconditionHash) {
    throw new HashMismatchError(operation.path, operation.preconditionHash, actual);
  }
}

function snapshotState(snapshot: Snapshot): FileState {
  if (snapshot.kind === "missing") return MISSING;
  if (snapshot.kind === "symlink") return hashText(snapshot.target);
  return hashBytes(snapshot.bytes);
}

function verifyWriteHash(operation: PreparationWrite): void {
  const actual = hashText(operation.contents);
  if (actual !== operation.resultHash) throw new HashMismatchError(operation.path, operation.resultHash, actual);
}

function assertNoNestedPaths(paths: ReadonlySet<string>): void {
  for (const path of paths) {
    for (const other of paths) {
      if (path !== other && other.startsWith(`${path}/`)) {
        throw new PreparationJournalError(`preparation operations may not overlap: ${path} and ${other}`);
      }
    }
  }
}

function stateAt(rootDir: string, path: string): FileState {
  const absolute = workspacePath(rootDir, path);
  const stat = lstatOrMissing(absolute);
  if (stat === undefined) return MISSING;
  if (stat.isFile()) return hashBytes(readFileSync(absolute));
  if (stat.isSymbolicLink()) return hashText(readlinkSync(absolute));
  throw new PreparationJournalError(`unsupported preparation path type: ${path}`);
}

function snapshotPath(rootDir: string, path: string): Snapshot {
  const absolute = workspacePath(rootDir, path);
  const absentAncestors = missingAncestorDirectories(rootDir, path);
  const stat = lstatOrMissing(absolute);
  if (stat === undefined) return { kind: "missing", absentAncestors };
  if (stat.isFile()) {
    return { kind: "file", bytes: readFileSync(absolute), mode: Number(stat.mode) & 0o777, absentAncestors };
  }
  if (stat.isSymbolicLink()) {
    return { kind: "symlink", target: readlinkSync(absolute), mode: Number(stat.mode) & 0o777, absentAncestors };
  }
  throw new PreparationJournalError(`cannot snapshot unsupported preparation path type: ${path}`);
}

function missingAncestorDirectories(rootDir: string, path: string): string[] {
  const missing: string[] = [];
  let directory = dirname(path);
  while (directory !== "." && directory !== "") {
    const absolute = workspacePath(rootDir, directory);
    const stat = lstatOrMissing(absolute);
    if (stat === undefined) {
      missing.push(directory);
      directory = dirname(directory);
      continue;
    }
    if (!stat.isDirectory()) throw new PreparationJournalError(`preparation parent is not a directory: ${directory}`);
    return missing;
  }
  return missing;
}

function producedState(operation: PreparationFilesystemOperation, snapshot: Snapshot): ProducedState {
  if (operation.kind === "delete") return { kind: "missing" };
  const mode = snapshot.kind === "file" && canonicalGitMode(snapshot.mode) === operation.resultMode
    ? snapshot.mode
    : operation.resultMode;
  return { kind: "file", hash: operation.resultHash, mode };
}

function applyOperation(
  rootDir: string,
  operation: PreparationFilesystemOperation,
  produced: ProducedState,
  snapshot: Snapshot,
  createdDirectories: Set<string>,
  mutations: Map<string, MutationRecord>,
): void {
  const absolute = workspacePath(rootDir, operation.path);
  const existing = lstatOrMissing(absolute);
  if (existing !== undefined && !existing.isFile() && !existing.isSymbolicLink()) {
    throw new PreparationJournalError(`cannot replace directory: ${operation.path}`);
  }
  if (operation.kind === "delete") {
    if (existing === undefined) return;
    acquireExistingPath(rootDir, operation.path, snapshot, produced, mutations);
    return;
  }
  createMissingDirectories(rootDir, snapshot.absentAncestors, createdDirectories);
  const temporaryDirectory = createPrivateDirectory(rootDir);
  const temporaryFile = `${temporaryDirectory}/result`;
  try {
    writeFileSync(temporaryFile, operation.contents, "utf8");
    chmodSync(temporaryFile, produced.kind === "file" ? produced.mode : 0o644);
    const record = existing === undefined
      ? { snapshot, privateDirectory: temporaryDirectory }
      : acquireExistingPath(rootDir, operation.path, snapshot, undefined, mutations, temporaryDirectory);
    mutations.set(canonicalPath(rootDir, operation.path), record);
    linkSync(temporaryFile, absolute);
    record.produced = produced;
    unlinkSync(temporaryFile);
  } catch (error) {
    if (!mutations.has(canonicalPath(rootDir, operation.path))) rmSync(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}

function acquireExistingPath(
  rootDir: string,
  path: string,
  snapshot: Snapshot,
  produced: ProducedState | undefined,
  mutations: Map<string, MutationRecord>,
  existingPrivateDirectory?: string,
): MutationRecord {
  const absolute = workspacePath(rootDir, path);
  const privateDirectory = existingPrivateDirectory ?? createPrivateDirectory(rootDir);
  const backupPath = `${privateDirectory}/original`;
  const record: MutationRecord = { snapshot, privateDirectory, backupPath, ...(produced === undefined ? {} : { produced }) };
  try {
    renameSync(absolute, backupPath);
  } catch (error) {
    rmSync(privateDirectory, { recursive: true, force: true });
    throw error;
  }
  mutations.set(canonicalPath(rootDir, path), record);
  if (!matchesSnapshotAt(backupPath, snapshot)) {
    throw new PreparationJournalError(`preparation ownership verification failed for ${path}`);
  }
  return record;
}

function createPrivateDirectory(rootDir: string): string {
  return mkdtempSync(join(dirname(resolve(rootDir)), `${SCRATCH_DIRNAME}-prepare-`));
}

function createMissingDirectories(rootDir: string, absentAncestors: readonly string[], created: Set<string>): void {
  for (const directory of [...absentAncestors].reverse()) {
    if (created.has(directory)) continue;
    try {
      mkdirSync(workspacePath(rootDir, directory));
      created.add(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new PreparationJournalError(`preparation compare-and-swap failed for directory ${directory}`);
      }
      throw error;
    }
  }
}

function restoreSnapshots(
  rootDir: string,
  snapshots: ReadonlyMap<string, Snapshot>,
  mutations: ReadonlyMap<string, MutationRecord>,
  createdDirectories: ReadonlySet<string>,
): PreparationRestoreReport {
  const failures: PreparationRestoreFailure[] = [];
  const restored: string[] = [];
  for (const [path, mutation] of mutations) {
    const snapshot = snapshots.get(path)!;
    if (matchesSnapshot(rootDir, path, snapshot)) {
      rmSync(mutation.privateDirectory, { recursive: true, force: true });
      restored.push(path);
      continue;
    }
    if (restoreOwnedMutation(rootDir, path, mutation, failures)) restored.push(path);
  }
  pruneCreatedDirectories(rootDir, createdDirectories, failures);
  return { restored, failures, residue: failures.map((failure) => failure.path) };
}

function restoreOwnedMutation(
  rootDir: string,
  path: string,
  mutation: MutationRecord,
  failures: PreparationRestoreFailure[],
): boolean {
  const absolute = workspacePath(rootDir, path);
  try {
    if (mutation.produced?.kind === "file") {
      const resultBackup = `${mutation.privateDirectory}/journal-result`;
      renameSync(absolute, resultBackup);
      if (!matchesProducedAt(resultBackup, mutation.produced)) {
        restoreDetachedNoReplace(resultBackup, absolute);
        throw new PreparationJournalError("current state was not written by the preparation journal; concurrent state preserved");
      }
      if (mutation.snapshot.kind === "missing") unlinkSync(resultBackup);
      else {
        restoreOriginalNoReplace(mutation, absolute);
        unlinkSync(resultBackup);
      }
    } else if (mutation.snapshot.kind !== "missing") {
      if (lstatOrMissing(absolute) !== undefined) {
        throw new PreparationJournalError("deleted path was concurrently recreated; refusing to overwrite it");
      }
      restoreOriginalNoReplace(mutation, absolute);
    }
    rmSync(mutation.privateDirectory, { recursive: true, force: true });
    return true;
  } catch (error) {
    failures.push({ path, message: `${errorMessage(error)}; recovery data retained at ${mutation.privateDirectory}` });
    return false;
  }
}

function restoreOriginalNoReplace(mutation: MutationRecord, absolute: string): void {
  const backup = mutation.backupPath;
  if (backup === undefined) return;
  restoreDetachedNoReplace(backup, absolute);
}

function restoreDetachedNoReplace(detached: string, absolute: string): void {
  const stat = lstatSync(detached);
  if (stat.isSymbolicLink()) symlinkSync(readlinkSync(detached), absolute);
  else linkSync(detached, absolute);
  unlinkSync(detached);
}

function assertSnapshotCurrent(rootDir: string, path: string, snapshot: Snapshot): void {
  if (!matchesSnapshot(rootDir, path, snapshot)) {
    throw new PreparationJournalError(`preparation compare-and-swap failed for ${path}`);
  }
}

function matchesProducedAt(absolute: string, produced: Extract<ProducedState, { kind: "file" }>): boolean {
  const stat = lstatOrMissing(absolute);
  return stat?.isFile() === true &&
    (Number(stat.mode) & 0o777) === produced.mode &&
    hashBytes(readFileSync(absolute)) === produced.hash;
}

function matchesSnapshotAt(absolute: string, snapshot: Snapshot): boolean {
  const stat = lstatOrMissing(absolute);
  if (snapshot.kind === "missing") return stat === undefined;
  if (stat === undefined) return false;
  if (snapshot.kind === "symlink") {
    return stat.isSymbolicLink() && (Number(stat.mode) & 0o777) === snapshot.mode && readlinkSync(absolute) === snapshot.target;
  }
  return stat.isFile() && (Number(stat.mode) & 0o777) === snapshot.mode && hashBytes(readFileSync(absolute)) === hashBytes(snapshot.bytes);
}

function matchesSnapshot(rootDir: string, path: string, snapshot: Snapshot): boolean {
  return matchesSnapshotAt(workspacePath(rootDir, path), snapshot);
}

function pruneCreatedDirectories(
  rootDir: string,
  directories: ReadonlySet<string>,
  failures: PreparationRestoreFailure[],
): void {
  for (const directory of [...directories].sort((left, right) => right.split("/").length - left.split("/").length || (left < right ? 1 : -1))) {
    try {
      rmdirSync(workspacePath(rootDir, directory));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") failures.push({ path: directory, message: errorMessage(error) });
    }
  }
}

function lstatOrMissing(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
    throw error;
  }
}
