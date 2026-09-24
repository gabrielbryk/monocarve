import { closeSync, lstatSync, mkdirSync, readdirSync, renameSync, type Stats } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { TOOL_NAME } from "../branding.ts";
import { byCodeUnit, hashBytes, stableStringify } from "../util/hash.ts";
import { removeQuarantinedDirectory, removeQuarantinedFile } from "./evidence-cleanup.ts";
import { captureBoundary, publicationPaths, revalidateBoundary, revalidateContainer, type PublicationBoundary } from "./evidence-destination.ts";
import { EvidenceError } from "./evidence-error.ts";
import {
  assertIdentity,
  entryExists,
  fileIdentity,
  identityFromStat,
  syncBundleDirectories,
  syncDirectory,
  writeDurable,
  type FileIdentity,
} from "./evidence-fs.ts";
import { acquireLock, releaseLock, type LockOwnership } from "./evidence-lock.ts";
import {
  enforceBudget,
  readEvidenceManifest,
  validateArtifactNames,
  validateBundle,
  validateIfPresent,
  validateMaxBytes,
  writeArtifacts,
} from "./evidence-manifest.ts";
import { systemReason } from "./evidence-paths.ts";
import { writeRecoveryFile } from "./evidence-recovery-write.ts";
import { assertNoRecovery, manifestDigest, recoveryBytes, type RecoveryBase } from "./evidence-recovery.ts";
import { rollbackCaughtFailure } from "./evidence-rollback.ts";
import type { EvidenceArtifactRecord, EvidenceManifestBase, PriorBundle, PublicationPaths } from "./evidence-types.ts";
import { type PublicationPhase } from "./evidence-types.ts";

export { readEvidenceManifest, validateBundle } from "./evidence-manifest.ts";
export { EvidenceError } from "./evidence-error.ts";
export type { EvidenceArtifactRecord, EvidenceManifestBase, PublicationPhase } from "./evidence-types.ts";

type PublicationTestPhase =
  | PublicationPhase
  | "prior-renamed-before-sync"
  | "published-renamed-before-sync"
  | "published-before-recovery"
  | "cleanup-before-backup"
  | "backup-removal-started"
  | "backup-removed"
  | "cleanup-quarantined";
export interface PublishEvidenceOptions<T extends EvidenceManifestBase> {
  readonly rootDir: string;
  readonly destination: string;
  readonly analyticalRoots: readonly string[];
  readonly artifacts: Readonly<Record<string, string | Uint8Array>>;
  readonly requiredArtifacts: ReadonlySet<string>;
  readonly manifest: (records: readonly EvidenceArtifactRecord[]) => Omit<T, "artifacts" | "tool" | "schemaVersion">;
  readonly replaceGenerated?: boolean;
  readonly maxBytes?: number;
  /** Test seam for caught failures; process termination tests use testPhaseHook. */
  readonly failAfter?: PublicationPhase;
  /** Test-only phase notification. A child process may block here and be terminated. */
  readonly testPhaseHook?: (phase: PublicationTestPhase) => void;
  /** Recheck analytical inputs at the last safe point before the publish rename. */
  readonly verifyBeforeRename?: (
    operationalPaths: Readonly<{ readonly target: string; readonly stage: string; readonly backup: string; readonly recovery: string; readonly lock: string }>,
  ) => void;
}
export interface PublishEvidenceResult<T> {
  readonly manifest: T;
  readonly totalBytes: number;
  readonly destination: string;
}
/** Mutable rollback bookkeeping threaded through the publish attempt; read by rollbackCaughtFailure on failure. */
interface PublicationProgress {
  stageCreated: boolean;
  priorPreserved: boolean;
  published: boolean;
  recoveryCreated: boolean;
  priorIdentity: FileIdentity | undefined;
  priorManifest: EvidenceManifestBase | undefined;
  stageIdentity: FileIdentity | undefined;
  recoveryIdentity: FileIdentity | undefined;
  ownedRecoveryBytes: readonly Uint8Array[];
}
/** Validate confinement/overlap before inventory capture or artifact generation. */
export function assertEvidenceDestination(rootDir: string, destination: string, analyticalRoots: readonly string[]): string {
  const paths = publicationPaths(rootDir, destination, analyticalRoots);
  return relative(paths.root, paths.target).replaceAll("\\", "/");
}
/** Publish an authoritative bundle under one canonical-destination ownership record. */
export function publishEvidence<T extends EvidenceManifestBase>(options: PublishEvidenceOptions<T>): PublishEvidenceResult<T> {
  validateMaxBytes(options.maxBytes);
  validateArtifactNames(Object.keys(options.artifacts).toSorted(byCodeUnit), options.requiredArtifacts);
  const paths = publicationPaths(options.rootDir, options.destination, options.analyticalRoots);
  if (!entryExists(paths.lock)) assertNoRecovery(paths);
  const progress: PublicationProgress = {
    stageCreated: false,
    priorPreserved: false,
    published: false,
    recoveryCreated: false,
    priorIdentity: undefined,
    priorManifest: undefined,
    stageIdentity: undefined,
    recoveryIdentity: undefined,
    ownedRecoveryBytes: [],
  };
  const ownership = acquireLock(paths);
  try {
    return runPublication(paths, options, ownership, progress);
  } catch (error) {
    rollbackCaughtFailure(paths, progress, {
      assertIdentity,
      validateBundle,
      syncDirectory,
      removeOwnedDirectory: (path) => removeOwnedEvidenceBundle(path, options),
    });
    throw error;
  } finally {
    if (entryExists(paths.lock)) {
      try {
        releaseLock(paths.lock, ownership.lockIdentity, ownership.ownerIdentity, ownership.ownerBytes, ownership.ownerFd);
      } catch {
        /* uncertain lock remains and blocks the next writer */
      }
    }
    closeSync(ownership.ownerFd);
  }
}
function runPublication<T extends EvidenceManifestBase>(
  paths: PublicationPaths,
  options: PublishEvidenceOptions<T>,
  ownership: LockOwnership,
  progress: PublicationProgress,
): PublishEvidenceResult<T> {
  // Close the check/acquire race without ever cleaning residue owned by another invocation.
  assertNoRecovery(paths);
  const prior = validatePrior(paths.target, options.replaceGenerated === true);
  progress.priorIdentity = prior?.identity;
  progress.priorManifest = prior?.manifest;
  const boundary = captureBoundary(paths, prior);
  const stageIdentity = createStage(paths, progress);
  progress.stageIdentity = stageIdentity;
  const staged = stageEvidence(paths, options, prior, stageIdentity);
  progress.recoveryCreated = true;
  progress.recoveryIdentity = staged.recoveryIdentity;
  progress.ownedRecoveryBytes = (["staged", "prior-preserved", "published"] as const).map((phase) => recoveryBytes(staged.recoveryBase, phase));
  options.testPhaseHook?.("staged");
  if (options.failAfter === "staged") throw new Error("injected evidence failure after staging");
  revalidateBoundary(paths, boundary, prior);
  assertIdentity(paths.stage, stageIdentity, "staging directory");
  validateBundle(paths.stage, staged.manifest);
  publishStagedBundle(paths, options, staged, prior, boundary, ownership, stageIdentity, staged.recoveryIdentity, progress);
  return { manifest: staged.manifest, totalBytes: staged.totalBytes, destination: relative(paths.root, paths.target).replaceAll("\\", "/") };
}
function createStage(paths: PublicationPaths, progress: PublicationProgress): FileIdentity {
  try {
    mkdirSync(paths.stage);
    progress.stageCreated = true;
  } catch (error) {
    throw new EvidenceError("EVIDENCE_RECOVERY_REQUIRED", `could not create confined staging directory ${paths.stage}: ${systemReason(error)}`);
  }
  syncDirectory(dirname(paths.stage));
  return fileIdentity(paths.stage);
}
function publishStagedBundle<T extends EvidenceManifestBase>(
  paths: PublicationPaths,
  options: PublishEvidenceOptions<T>,
  staged: { manifest: T; totalBytes: number; recoveryBase: RecoveryBase; recoveryIdentity: FileIdentity },
  prior: PriorBundle | undefined,
  boundary: PublicationBoundary,
  ownership: LockOwnership,
  stageIdentity: FileIdentity,
  recoveryIdentity: FileIdentity,
  progress: PublicationProgress,
): void {
  if (prior !== undefined) {
    renameSync(paths.target, paths.backup);
    progress.priorPreserved = true;
    options.testPhaseHook?.("prior-renamed-before-sync");
    syncDirectory(dirname(paths.target));
    writeRecoveryFile(paths.recovery, recoveryBytes(staged.recoveryBase, "prior-preserved"), recoveryIdentity);
    options.testPhaseHook?.("prior-preserved");
    if (options.failAfter === "prior-preserved") throw new Error("injected evidence failure after preserving prior bundle");
  }
  if (entryExists(paths.target)) throw new EvidenceError("EVIDENCE_REPLACEMENT_REFUSED", "evidence destination changed before publication");
  revalidateContainer(paths, boundary);
  assertIdentity(paths.stage, stageIdentity, "staging directory");
  validateBundle(paths.stage, staged.manifest);
  // Run the analytical-input check after preservation and filesystem revalidation so failures roll back safely.
  options.verifyBeforeRename?.(paths);
  renameSync(paths.stage, paths.target);
  progress.published = true;
  options.testPhaseHook?.("published-renamed-before-sync");
  syncDirectory(dirname(paths.target));
  options.testPhaseHook?.("published-before-recovery");
  writeRecoveryFile(paths.recovery, recoveryBytes(staged.recoveryBase, "published"), recoveryIdentity);
  options.testPhaseHook?.("published");
  if (options.failAfter === "published") throw new Error("injected evidence failure after publication");
  completePublication(paths, progress.priorPreserved, progress.priorIdentity, recoveryIdentity, options.testPhaseHook);
  progress.recoveryCreated = false;
  releaseLock(paths.lock, ownership.lockIdentity, ownership.ownerIdentity, ownership.ownerBytes, ownership.ownerFd);
}
function removeOwnedEvidenceBundle<T extends EvidenceManifestBase>(path: string, options: PublishEvidenceOptions<T>): void {
  let manifest: EvidenceManifestBase;
  try {
    manifest = readEvidenceManifest(path);
  } catch {
    const artifactPaths = Object.keys(options.artifacts).toSorted(byCodeUnit);
    try {
      validateArtifactNames(artifactPaths, new Set());
    } catch {
      artifactPaths.length = 0;
    }
    manifest = {
      schemaVersion: 1,
      kind: "architecture-assessment",
      tool: TOOL_NAME,
      artifacts: artifactPaths.map((artifactPath) => ({ path: artifactPath, bytes: 0, sha256: "0".repeat(64), required: false })),
    };
  }
  if (entryExists(resolve(path, "manifest.json"))) validateBundle(path, manifest);
  removeQuarantinedDirectory(
    path,
    fileIdentity(path),
    manifest,
    undefined,
    "owned directory",
    assertIdentity,
    entryExists,
    syncDirectory,
    (message) => new EvidenceError("EVIDENCE_REPLACEMENT_REFUSED", message),
    validateIfPresent,
  );
}
function stageEvidence<T extends EvidenceManifestBase>(
  paths: PublicationPaths,
  options: PublishEvidenceOptions<T>,
  prior: PriorBundle | undefined,
  stageIdentity: FileIdentity,
): { manifest: T; totalBytes: number; recoveryBase: RecoveryBase; recoveryIdentity: FileIdentity } {
  const records = writeArtifacts(paths.stage, options.artifacts, options.requiredArtifacts);
  const base = options.manifest(records);
  const manifest = { ...base, schemaVersion: 1, tool: TOOL_NAME, artifacts: records } as unknown as T;
  const manifestBytes = new TextEncoder().encode(`${stableStringify(manifest, 2)}\n`);
  const totalBytes = records.reduce((sum, entry) => sum + entry.bytes, 0) + manifestBytes.byteLength;
  enforceBudget(options.maxBytes, totalBytes, records, manifestBytes.byteLength);
  writeDurable(resolve(paths.stage, "manifest.json"), manifestBytes);
  syncBundleDirectories(paths.stage);
  validateBundle(paths.stage, manifest);
  assertIdentity(paths.stage, stageIdentity, "staging directory");
  const recoveryBase: RecoveryBase = {
    schemaVersion: 1,
    target: basename(paths.target),
    stage: basename(paths.stage),
    backup: basename(paths.backup),
    stagedManifestSha256: hashBytes(manifestBytes),
    ...(prior?.manifest === undefined ? {} : { priorManifestSha256: manifestDigest(paths.target) }),
  };
  const recoveryIdentity = writeRecoveryFile(paths.recovery, recoveryBytes(recoveryBase, "staged"));
  return { manifest, totalBytes, recoveryBase, recoveryIdentity };
}
function completePublication(
  paths: PublicationPaths,
  priorPreserved: boolean,
  priorIdentity: FileIdentity | undefined,
  recoveryIdentity: FileIdentity,
  testPhaseHook?: (phase: PublicationTestPhase) => void,
): void {
  // Ownership remains held through cleanup; a dead owner's lock requires manual recovery if termination interrupts it.
  testPhaseHook?.("cleanup-before-backup");
  if (priorPreserved) {
    testPhaseHook?.("backup-removal-started");
    if (priorIdentity === undefined) throw new EvidenceError("EVIDENCE_REPLACEMENT_REFUSED", "preserved prior bundle identity is unavailable");
    assertIdentity(paths.backup, priorIdentity, "preserved prior bundle");
    removeQuarantinedDirectory(
      paths.backup,
      priorIdentity,
      readEvidenceManifest(paths.backup),
      testPhaseHook,
      "backup",
      assertIdentity,
      entryExists,
      syncDirectory,
      (message) => new EvidenceError("EVIDENCE_REPLACEMENT_REFUSED", message),
      validateBundle,
    );
    testPhaseHook?.("backup-removed");
    syncDirectory(dirname(paths.backup));
  }
  assertIdentity(paths.recovery, recoveryIdentity, "recovery record");
  removeQuarantinedFile(
    paths.recovery,
    recoveryIdentity,
    testPhaseHook,
    "recovery",
    assertIdentity,
    entryExists,
    syncDirectory,
    (message) => new EvidenceError("EVIDENCE_REPLACEMENT_REFUSED", message),
  );
}
function validatePrior(target: string, replace: boolean): PriorBundle | undefined {
  if (!entryExists(target)) return undefined;
  let stat: Stats;
  try {
    stat = lstatSync(target);
  } catch {
    throw new EvidenceError("EVIDENCE_REPLACEMENT_REFUSED", "evidence destination is not a regular directory");
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new EvidenceError("EVIDENCE_REPLACEMENT_REFUSED", "evidence destination is not a regular directory");
  const identity = identityFromStat(stat);
  if (readdirSync(target).length === 0) return { identity };
  if (!replace) throw new EvidenceError("EVIDENCE_REPLACEMENT_REFUSED", "evidence directory is nonempty; use --replace-generated for a valid prior bundle");
  const manifest = readEvidenceManifest(target);
  validateBundle(target, manifest);
  return { identity, manifest };
}
