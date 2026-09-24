/** Caught publication failures only undo paths whose ownership can still be proven. */
import { lstatSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";

import { equalOwnedBytes } from "./evidence-recovery-write.ts";
import type { EvidenceManifestBase } from "./evidence.ts";

interface FileIdentity {
  readonly device: number;
  readonly inode: number;
  readonly mode: number;
}
interface RollbackPaths {
  readonly target: string;
  readonly backup: string;
  readonly stage: string;
  readonly recovery: string;
}
interface RollbackProgress {
  readonly stageCreated: boolean;
  readonly priorPreserved: boolean;
  readonly published: boolean;
  readonly recoveryCreated: boolean;
  readonly priorIdentity: FileIdentity | undefined;
  readonly priorManifest: EvidenceManifestBase | undefined;
  readonly stageIdentity: FileIdentity | undefined;
  readonly recoveryIdentity: FileIdentity | undefined;
  readonly ownedRecoveryBytes: readonly Uint8Array[];
}
interface RollbackOperations {
  readonly assertIdentity: (path: string, identity: FileIdentity, label: string) => void;
  readonly validateBundle: (path: string, manifest: EvidenceManifestBase) => void;
  readonly syncDirectory: (path: string) => void;
  readonly removeOwnedDirectory: (path: string) => void;
}

export function rollbackCaughtFailure(paths: RollbackPaths, progress: RollbackProgress, operations: RollbackOperations): void {
  const canRestorePrior = progress.priorPreserved && intactPriorBackup(paths.backup, progress.priorIdentity, progress.priorManifest, operations);
  const published = rollbackPublished(paths, progress, canRestorePrior, operations);
  const priorPreserved = restorePrior(paths, progress.priorPreserved, canRestorePrior, operations);
  removeStage(paths, progress, published, operations);
  removeRecovery(paths, progress, priorPreserved, published, operations);
}

function rollbackPublished(paths: RollbackPaths, progress: RollbackProgress, canRestorePrior: boolean, operations: RollbackOperations): boolean {
  if (!progress.published || (progress.priorPreserved && !canRestorePrior) || progress.stageIdentity === undefined) return progress.published;
  try {
    operations.assertIdentity(paths.target, progress.stageIdentity, "published bundle");
    operations.removeOwnedDirectory(paths.target);
    return false;
  } catch {
    return true; /* uncertain published state is recovery evidence */
  }
}

function restorePrior(paths: RollbackPaths, priorPreserved: boolean, canRestorePrior: boolean, operations: RollbackOperations): boolean {
  if (!canRestorePrior || entryExists(paths.target)) return priorPreserved;
  try {
    renameSync(paths.backup, paths.target);
    operations.syncDirectory(dirname(paths.target));
    return false;
  } catch {
    return priorPreserved; /* ambiguous rename outcome requires operator recovery */
  }
}

function removeStage(paths: RollbackPaths, progress: RollbackProgress, published: boolean, operations: RollbackOperations): void {
  if (!progress.stageCreated || published || progress.stageIdentity === undefined || !entryExists(paths.stage)) return;
  try {
    operations.assertIdentity(paths.stage, progress.stageIdentity, "staging directory");
    operations.removeOwnedDirectory(paths.stage);
  } catch {
    /* uncertain residue is recovery evidence */
  }
}

function removeRecovery(paths: RollbackPaths, progress: RollbackProgress, priorPreserved: boolean, published: boolean, operations: RollbackOperations): void {
  if (!progress.recoveryCreated || priorPreserved || published || progress.recoveryIdentity === undefined || !entryExists(paths.recovery)) return;
  try {
    if (!sameIdentity(paths.recovery, progress.recoveryIdentity)) return;
    const observed = readFileSync(paths.recovery);
    if (!progress.ownedRecoveryBytes.some((expected) => equalOwnedBytes(observed, expected))) return;
    rmSync(paths.recovery);
    operations.syncDirectory(dirname(paths.recovery));
  } catch {
    /* uncertain residue is recovery evidence */
  }
}

function sameIdentity(path: string, identity: FileIdentity): boolean {
  const stat = lstatSync(path);
  return !stat.isSymbolicLink() && stat.dev === identity.device && stat.ino === identity.inode && stat.mode === identity.mode;
}

function intactPriorBackup(
  path: string,
  identity: FileIdentity | undefined,
  manifest: EvidenceManifestBase | undefined,
  operations: RollbackOperations,
): boolean {
  if (!entryExists(path) || identity === undefined) return false;
  try {
    operations.assertIdentity(path, identity, "preserved prior bundle");
    if (manifest === undefined) return readdirSync(path).length === 0;
    operations.validateBundle(path, manifest);
    return true;
  } catch {
    return false;
  }
}

function entryExists(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
}
