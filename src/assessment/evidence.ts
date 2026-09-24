import {
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { TOOL_NAME } from "../branding.ts";
import { MonocarveError } from "../errors.ts";
import { byCodeUnit, hashBytes, stableStringify, type Sha256 } from "../util/hash.ts";
import { listBundleEntries, removeQuarantinedDirectory, removeQuarantinedFile } from "./evidence-cleanup.ts";
import { overlaps, systemReason, within } from "./evidence-paths.ts";
import { equalOwnedBytes, writeRecoveryFile } from "./evidence-recovery-write.ts";
import { rollbackCaughtFailure } from "./evidence-rollback.ts";
export interface EvidenceArtifactRecord {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: Sha256;
  readonly required: boolean;
}
export interface EvidenceManifestBase {
  readonly schemaVersion: 1;
  readonly kind: "architecture-assessment" | "declaration-analysis-batch";
  readonly tool: string;
  readonly artifacts: readonly EvidenceArtifactRecord[];
}
export class EvidenceError extends MonocarveError {
  override readonly name = "EvidenceError";
  constructor(
    readonly code:
      | "EVIDENCE_DESTINATION_BUSY"
      | "EVIDENCE_RECOVERY_REQUIRED"
      | "EVIDENCE_DESTINATION_UNSAFE"
      | "EVIDENCE_REPLACEMENT_REFUSED"
      | "EVIDENCE_BUDGET_EXCEEDED",
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}
type PublicationPhase = "staged" | "prior-preserved" | "published";
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
interface PublicationPaths {
  readonly root: string;
  readonly requestedDestination: string;
  readonly analyticalRoots: readonly string[];
  readonly target: string;
  readonly stage: string;
  readonly backup: string;
  readonly recovery: string;
  readonly lock: string;
}
interface FileIdentity {
  readonly device: number;
  readonly inode: number;
  readonly mode: number;
}
interface PriorBundle {
  readonly identity: FileIdentity;
  readonly manifest?: EvidenceManifestBase;
}
interface PublicationBoundary {
  readonly root: FileIdentity;
  readonly parent: FileIdentity;
  readonly target?: FileIdentity;
}
interface RecoveryRecord {
  readonly schemaVersion: 1;
  readonly phase: PublicationPhase;
  readonly target: string;
  readonly stage: string;
  readonly backup: string;
  readonly stagedManifestSha256: Sha256;
  readonly priorManifestSha256?: Sha256;
}
type RecoveryBase = Omit<RecoveryRecord, "phase">;
interface LockOwner {
  readonly schemaVersion: 1;
  readonly pid: number;
  readonly processStart: string | null;
}
/** Validate confinement/overlap before inventory capture or artifact generation. */
export function assertEvidenceDestination(rootDir: string, destination: string, analyticalRoots: readonly string[]): string {
  const paths = publicationPaths(rootDir, destination, analyticalRoots);
  return relative(paths.root, paths.target).replaceAll("\\", "/");
}
/** Publish an authoritative bundle under one canonical-destination ownership record. */
export function publishEvidence<T extends EvidenceManifestBase>(options: PublishEvidenceOptions<T>): PublishEvidenceResult<T> {
  validateMaxBytes(options.maxBytes);
  validateArtifactNames(Object.keys(options.artifacts).sort(byCodeUnit), options.requiredArtifacts);
  const paths = publicationPaths(options.rootDir, options.destination, options.analyticalRoots);
  if (!entryExists(paths.lock)) assertNoRecovery(paths);
  let stageCreated = false,
    priorPreserved = false,
    published = false,
    recoveryCreated = false;
  let priorIdentity: FileIdentity | undefined, stageIdentity: FileIdentity | undefined, recoveryIdentity: FileIdentity | undefined;
  let ownedRecoveryBytes: readonly Uint8Array[] = [];
  const ownership = acquire(paths);
  const lockIdentity = ownership.lockIdentity;
  let priorManifest: EvidenceManifestBase | undefined;
  try {
    // Close the check/acquire race without ever cleaning residue owned by another invocation.
    assertNoRecovery(paths);
    const prior = validatePrior(paths.target, options.replaceGenerated === true);
    priorIdentity = prior?.identity;
    priorManifest = prior?.manifest;
    const boundary = captureBoundary(paths, prior);
    try {
      mkdirSync(paths.stage);
      stageCreated = true;
    } catch (error) {
      throw new EvidenceError("EVIDENCE_RECOVERY_REQUIRED", `could not create confined staging directory ${paths.stage}: ${systemReason(error)}`);
    }
    syncDirectory(dirname(paths.stage));
    stageIdentity = fileIdentity(paths.stage);
    const staged = stageEvidence(paths, options, prior, stageIdentity);
    recoveryCreated = true;
    recoveryIdentity = staged.recoveryIdentity;
    ownedRecoveryBytes = (["staged", "prior-preserved", "published"] as const).map((phase) => recoveryBytes(staged.recoveryBase, phase));
    options.testPhaseHook?.("staged");
    if (options.failAfter === "staged") throw new Error("injected evidence failure after staging");
    revalidateBoundary(paths, boundary, prior);
    assertIdentity(paths.stage, stageIdentity, "staging directory");
    validateBundle(paths.stage, staged.manifest);
    if (prior !== undefined) {
      renameSync(paths.target, paths.backup);
      priorPreserved = true;
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
    published = true;
    options.testPhaseHook?.("published-renamed-before-sync");
    syncDirectory(dirname(paths.target));
    options.testPhaseHook?.("published-before-recovery");
    writeRecoveryFile(paths.recovery, recoveryBytes(staged.recoveryBase, "published"), recoveryIdentity);
    options.testPhaseHook?.("published");
    if (options.failAfter === "published") throw new Error("injected evidence failure after publication");
    completePublication(paths, priorPreserved, priorIdentity, recoveryIdentity, options.testPhaseHook);
    recoveryCreated = false;
    release(paths.lock, lockIdentity, ownership.ownerIdentity, ownership.ownerBytes, ownership.ownerFd);
    return { manifest: staged.manifest, totalBytes: staged.totalBytes, destination: relative(paths.root, paths.target).replaceAll("\\", "/") };
  } catch (error) {
    rollbackCaughtFailure(
      paths,
      { stageCreated, priorPreserved, published, recoveryCreated, priorIdentity, priorManifest, stageIdentity, recoveryIdentity, ownedRecoveryBytes },
      {
        assertIdentity,
        validateBundle,
        syncDirectory,
        removeOwnedDirectory: (path) => {
          let manifest: EvidenceManifestBase;
          try {
            manifest = readEvidenceManifest(path);
          } catch {
            const artifactPaths = Object.keys(options.artifacts).sort(byCodeUnit);
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
        },
      },
    );
    throw error;
  } finally {
    if (entryExists(paths.lock)) {
      try {
        release(paths.lock, lockIdentity, ownership.ownerIdentity, ownership.ownerBytes, ownership.ownerFd);
      } catch {
        /* uncertain lock remains and blocks the next writer */
      }
    }
    closeSync(ownership.ownerFd);
  }
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
export function readEvidenceManifest(path: string): EvidenceManifestBase {
  let value: unknown;
  const manifestPath = resolve(path, "manifest.json");
  try {
    const stat = lstatSync(manifestPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("manifest is not a regular file");
    value = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
  } catch (error) {
    throw new EvidenceError("EVIDENCE_REPLACEMENT_REFUSED", `could not read prior manifest: ${systemReason(error)}`);
  }
  if (!isManifest(value)) throw new EvidenceError("EVIDENCE_REPLACEMENT_REFUSED", "prior manifest has an unsupported shape or tool identity");
  return value;
}
export function validateBundle(path: string, manifest: EvidenceManifestBase = readEvidenceManifest(path)): void {
  if (!isManifest(manifest)) throw new EvidenceError("EVIDENCE_REPLACEMENT_REFUSED", "manifest has an unsupported shape or tool identity");
  const rootStat = lstatSync(path, { throwIfNoEntry: false });
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) throw new EvidenceError("EVIDENCE_REPLACEMENT_REFUSED", "bundle is not a regular directory");
  validateArtifactRecords(manifest.artifacts);
  const names = new Set<string>();
  for (const artifact of manifest.artifacts) {
    names.add(artifact.path);
    const absolute = resolve(path, artifact.path);
    const stat = lstatSync(absolute, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.isSymbolicLink())
      throw new EvidenceError("EVIDENCE_REPLACEMENT_REFUSED", `prior artifact is missing or not a regular file: ${artifact.path}`);
    const bytes = readFileSync(absolute);
    if (bytes.byteLength !== artifact.bytes || hashBytes(bytes) !== artifact.sha256)
      throw new EvidenceError("EVIDENCE_REPLACEMENT_REFUSED", `prior artifact does not match its manifest: ${artifact.path}`);
  }
  const disk = listBundleEntries(path, (message) => new EvidenceError("EVIDENCE_REPLACEMENT_REFUSED", message)).filter((entry) => entry !== "manifest.json");
  const expectedDirectories = new Set(
    [...names].flatMap((name) => {
      const parents: string[] = [];
      for (let parent = dirname(name); parent !== "."; parent = dirname(parent)) parents.push(parent.replaceAll("\\", "/"));
      return parents;
    }),
  );
  const unrelated = disk.filter((entry) => !names.has(entry) && !expectedDirectories.has(entry));
  if (unrelated.length > 0) throw new EvidenceError("EVIDENCE_REPLACEMENT_REFUSED", `evidence directory contains unrelated paths: ${unrelated.join(", ")}`);
}
function publicationPaths(rootDir: string, destination: string, analyticalRoots: readonly string[]): PublicationPaths {
  const root = realpathSync(rootDir);
  assertRelativePath(destination, "evidence destination", "EVIDENCE_DESTINATION_UNSAFE");
  const target = resolve(root, destination);
  if (target === root || !within(root, target))
    throw new EvidenceError("EVIDENCE_DESTINATION_UNSAFE", "evidence destination escapes or names the workspace root");
  const ancestor = existingAncestor(target);
  const canonical = resolve(realpathSync(ancestor), relative(ancestor, target));
  if (!within(root, canonical) || canonical === root) throw new EvidenceError("EVIDENCE_DESTINATION_UNSAFE", "evidence destination escapes through a symlink");
  const parent = dirname(canonical);
  const parentStat = lstatSync(parent, { throwIfNoEntry: false });
  if (!parentStat?.isDirectory() || parentStat.isSymbolicLink()) {
    throw new EvidenceError("EVIDENCE_DESTINATION_UNSAFE", "evidence destination parent must be an existing regular directory");
  }
  for (const entry of analyticalRoots) {
    const input = canonicalCandidate(root, entry);
    if (overlaps(canonical, input))
      throw new EvidenceError("EVIDENCE_DESTINATION_UNSAFE", `evidence destination overlaps analytical input ${relative(root, input)}`);
  }
  return {
    root,
    requestedDestination: destination,
    analyticalRoots,
    target: canonical,
    stage: `${canonical}.staging`,
    backup: `${canonical}.backup`,
    recovery: `${canonical}.recovery.json`,
    lock: `${canonical}.lock`,
  };
}
function acquire(paths: PublicationPaths): { lockIdentity: FileIdentity; ownerIdentity: FileIdentity; ownerBytes: Uint8Array; ownerFd: number } {
  try {
    mkdirSync(paths.lock);
  } catch {
    const owner = ownerState(paths.lock);
    if (owner === "live" || owner === "uncertain")
      throw new EvidenceError("EVIDENCE_DESTINATION_BUSY", `publication ownership is already held at ${paths.lock}`);
    throw recoveryError(paths);
  }
  const identity = fileIdentity(paths.lock);
  const owner: LockOwner = { schemaVersion: 1, pid: process.pid, processStart: processStart(process.pid) };
  const ownerBytes = new TextEncoder().encode(`${stableStringify(owner, 2)}\n`);
  let ownerFd: number | undefined;
  try {
    writeDurable(resolve(paths.lock, "owner.json"), ownerBytes);
    // Keep the original inode open so unlink + rewrite cannot reuse its inode number.
    ownerFd = openSync(resolve(paths.lock, "owner.json"), "r");
    const ownerIdentity = identityFromStat(fstatSync(ownerFd));
    assertIdentity(resolve(paths.lock, "owner.json"), ownerIdentity, "publication lock owner");
    syncDirectory(paths.lock);
    return { lockIdentity: identity, ownerIdentity, ownerBytes, ownerFd };
  } catch (error) {
    // Only remove the directory created by this acquisition attempt.
    try {
      release(paths.lock, identity, fileIdentity(resolve(paths.lock, "owner.json")), ownerBytes);
    } catch {
      /* replaced lock remains as recovery evidence */
    }
    if (ownerFd !== undefined) closeSync(ownerFd);
    throw error;
  }
}
function release(lock: string, identity: FileIdentity, ownerIdentity: FileIdentity, ownerBytes: Uint8Array, ownerFd?: number): void {
  assertIdentity(lock, identity, "publication lock");
  const ownerPath = resolve(lock, "owner.json");
  assertIdentity(ownerPath, ownerIdentity, "publication lock owner");
  if (ownerFd !== undefined && !sameFileIdentity(identityFromStat(fstatSync(ownerFd)), ownerIdentity))
    throw new EvidenceError("EVIDENCE_REPLACEMENT_REFUSED", "publication lock owner handle changed during publication");
  if (!equalOwnedBytes(readFileSync(ownerPath), ownerBytes))
    throw new EvidenceError("EVIDENCE_REPLACEMENT_REFUSED", "publication lock owner changed during publication");
  const entries = readdirSync(lock).sort(byCodeUnit);
  if (entries.length !== 1 || entries[0] !== "owner.json")
    throw new EvidenceError("EVIDENCE_REPLACEMENT_REFUSED", "publication lock directory contents changed during publication");
  assertIdentity(lock, identity, "publication lock");
  assertIdentity(ownerPath, ownerIdentity, "publication lock owner");
  const quarantine = resolve(lock, "owner.json.quarantine");
  if (entryExists(quarantine)) throw new EvidenceError("EVIDENCE_REPLACEMENT_REFUSED", "publication lock owner quarantine already exists");
  renameSync(ownerPath, quarantine);
  assertIdentity(quarantine, ownerIdentity, "publication lock owner quarantine");
  if (!equalOwnedBytes(readFileSync(quarantine), ownerBytes))
    throw new EvidenceError("EVIDENCE_REPLACEMENT_REFUSED", "publication lock owner changed during quarantine");
  unlinkSync(quarantine);
  rmdirSync(lock);
  syncDirectory(dirname(lock));
}
function assertNoRecovery(paths: PublicationPaths): void {
  if (recoveryResidue(paths).length > 0) throw recoveryError(paths);
}
function recoveryError(paths: PublicationPaths): EvidenceError {
  const residue = [...recoveryResidue(paths), ...(entryExists(paths.lock) ? [paths.lock] : [])];
  let recorded = "unreadable or absent recovery record";
  let recovery: Partial<RecoveryRecord> | undefined;
  if (entryExists(paths.recovery)) {
    try {
      recovery = JSON.parse(readFileSync(paths.recovery, "utf8")) as Partial<RecoveryRecord>;
      recorded = `recorded phase=${String(recovery.phase)}`;
    } catch {
      recorded = "unreadable recovery record";
    }
  }
  const observed = [
    `${basename(paths.target)}=${observedBundle(paths.target, recovery?.stagedManifestSha256, "staged", recovery?.priorManifestSha256, "prior")}`,
    `${basename(paths.stage)}=${observedBundle(paths.stage, recovery?.stagedManifestSha256, "staged")}`,
    `${basename(paths.backup)}=${observedBundle(paths.backup, recovery?.priorManifestSha256, "prior")}`,
  ].join(", ");
  return new EvidenceError(
    "EVIDENCE_RECOVERY_REQUIRED",
    `preserved publication state requires manual recovery (${recorded}; ${observed}): ${residue.join(", ")}`,
  );
}
function recoveryResidue(paths: PublicationPaths): string[] {
  return [paths.recovery, paths.stage, paths.backup].filter(entryExists);
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
function captureBoundary(paths: PublicationPaths, prior: PriorBundle | undefined): PublicationBoundary {
  return { root: fileIdentity(paths.root), parent: fileIdentity(dirname(paths.target)), ...(prior === undefined ? {} : { target: prior.identity }) };
}
function revalidateBoundary(paths: PublicationPaths, boundary: PublicationBoundary, prior: PriorBundle | undefined): void {
  revalidateContainer(paths, boundary);
  if (boundary.target === undefined) {
    if (entryExists(paths.target)) throw new EvidenceError("EVIDENCE_REPLACEMENT_REFUSED", "evidence destination appeared during publication");
  } else {
    assertIdentity(paths.target, boundary.target, "prior evidence destination");
    if (prior?.manifest !== undefined) validateBundle(paths.target, prior.manifest);
  }
  if (entryExists(paths.backup)) throw new EvidenceError("EVIDENCE_RECOVERY_REQUIRED", `backup path appeared during publication: ${paths.backup}`);
}
function revalidateContainer(paths: PublicationPaths, boundary: PublicationBoundary): void {
  const current = publicationPaths(paths.root, paths.requestedDestination, paths.analyticalRoots);
  if (current.target !== paths.target || current.stage !== paths.stage || current.backup !== paths.backup) {
    throw new EvidenceError("EVIDENCE_REPLACEMENT_REFUSED", "canonical evidence destination changed during publication");
  }
  assertIdentity(paths.root, boundary.root, "workspace root");
  assertIdentity(dirname(paths.target), boundary.parent, "evidence destination parent");
}
function writeArtifacts(stage: string, artifacts: Readonly<Record<string, string | Uint8Array>>, required: ReadonlySet<string>): EvidenceArtifactRecord[] {
  const paths = Object.keys(artifacts).sort(byCodeUnit);
  validateArtifactNames(paths, required);
  return paths.map((path) => {
    const value = artifacts[path]!;
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
    const absolute = resolve(stage, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeDurable(absolute, bytes);
    return { path, bytes: bytes.byteLength, sha256: hashBytes(bytes), required: required.has(path) };
  });
}
function validateArtifactNames(paths: readonly string[], required: ReadonlySet<string>): void {
  const seen = new Set<string>();
  for (const path of paths) {
    assertArtifactPath(path);
    if (path === "manifest.json") throw new EvidenceError("EVIDENCE_REPLACEMENT_REFUSED", "manifest may not list or hash itself");
    const parent = path
      .split("/")
      .slice(0, -1)
      .reduce((prefix, part) => (prefix === "" ? part : `${prefix}/${part}`), "");
    if (parent !== "" && [...seen].some((entry) => parent === entry || parent.startsWith(`${entry}/`))) {
      throw new EvidenceError("EVIDENCE_REPLACEMENT_REFUSED", `artifact paths collide as file and directory: ${path}`);
    }
    seen.add(path);
  }
  const available = new Set(paths);
  const missing = [...required].filter((path) => !available.has(path)).sort(byCodeUnit);
  if (missing.length > 0) throw new EvidenceError("EVIDENCE_REPLACEMENT_REFUSED", `required artifacts were not generated: ${missing.join(", ")}`);
}
function validateArtifactRecords(records: readonly EvidenceArtifactRecord[]): void {
  const paths = records.map((record) => record.path);
  validateArtifactNames(paths, new Set());
  const sorted = [...paths].sort(byCodeUnit);
  if (new Set(paths).size !== paths.length) throw new EvidenceError("EVIDENCE_REPLACEMENT_REFUSED", "prior manifest lists duplicate artifact paths");
  if (paths.some((path, index) => path !== sorted[index]))
    throw new EvidenceError("EVIDENCE_REPLACEMENT_REFUSED", "prior manifest artifact inventory is not in canonical order");
  for (const record of records) {
    if (!Number.isSafeInteger(record.bytes) || record.bytes < 0 || !/^[a-f0-9]{64}$/u.test(record.sha256) || typeof record.required !== "boolean") {
      throw new EvidenceError("EVIDENCE_REPLACEMENT_REFUSED", `prior manifest has an invalid artifact record: ${record.path}`);
    }
  }
}
function validateMaxBytes(max: number | undefined): void {
  if (max !== undefined && (!Number.isSafeInteger(max) || max <= 0)) {
    throw new EvidenceError("EVIDENCE_BUDGET_EXCEEDED", "--max-bytes must be a positive integer");
  }
}
function enforceBudget(max: number | undefined, total: number, records: readonly EvidenceArtifactRecord[], manifestBytes: number): void {
  if (max === undefined || total <= max) return;
  const largest = [...records.map(({ path, bytes, required }) => ({ path, bytes, required })), { path: "manifest.json", bytes: manifestBytes, required: true }]
    .sort((left, right) => right.bytes - left.bytes || byCodeUnit(left.path, right.path))
    .slice(0, 5);
  const required = records.filter((entry) => entry.required).reduce((sum, entry) => sum + entry.bytes, manifestBytes);
  const optional = records
    .filter((entry) => !entry.required)
    .map((entry) => entry.path)
    .sort(byCodeUnit);
  const advice =
    required > max || optional.length === 0
      ? "required evidence alone exceeds the budget; no optional omission can satisfy it"
      : `omit only requested optional evidence (${optional.join(", ")}) or increase --max-bytes`;
  throw new EvidenceError(
    "EVIDENCE_BUDGET_EXCEEDED",
    `bundle needs ${total} bytes but budget is ${max}; largest: ${largest.map((entry) => `${entry.path}=${entry.bytes}`).join(", ")}; ${advice}`,
  );
}
function recoveryBytes(base: RecoveryBase, phase: PublicationPhase): Uint8Array {
  return new TextEncoder().encode(`${stableStringify({ ...base, phase }, 2)}\n`);
}
function writeDurable(path: string, bytes: Uint8Array): void {
  const fd = openSync(path, "wx");
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  syncDirectory(dirname(path));
}
/** Persist directory-entry transitions as well as file contents. */
function syncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function syncBundleDirectories(current: string): void {
  for (const entry of readdirSync(current, { withFileTypes: true }))
    if (entry.isDirectory() && !entry.isSymbolicLink()) syncBundleDirectories(resolve(current, entry.name));
  syncDirectory(current);
}
function assertRelativePath(path: string, label: string, code: "EVIDENCE_DESTINATION_UNSAFE" | "EVIDENCE_REPLACEMENT_REFUSED"): void {
  if (
    path.length === 0 ||
    isAbsolute(path) ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new EvidenceError(code, `${label} is not a confined relative path: ${path}`);
  }
}
function assertArtifactPath(path: string): void {
  assertRelativePath(path, "artifact path", "EVIDENCE_REPLACEMENT_REFUSED");
}
function isManifest(value: unknown): value is EvidenceManifestBase {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entry = value as Partial<EvidenceManifestBase>;
  return (
    entry.schemaVersion === 1 &&
    entry.tool === TOOL_NAME &&
    (entry.kind === "architecture-assessment" || entry.kind === "declaration-analysis-batch") &&
    Array.isArray(entry.artifacts) &&
    entry.artifacts.every(
      (artifact) =>
        typeof artifact === "object" &&
        artifact !== null &&
        typeof (artifact as EvidenceArtifactRecord).path === "string" &&
        typeof (artifact as EvidenceArtifactRecord).bytes === "number" &&
        typeof (artifact as EvidenceArtifactRecord).sha256 === "string" &&
        typeof (artifact as EvidenceArtifactRecord).required === "boolean",
    )
  );
}
function validateIfPresent(path: string, manifest: EvidenceManifestBase): void {
  if (entryExists(resolve(path, "manifest.json"))) validateBundle(path, manifest);
}
function fileIdentity(path: string): FileIdentity {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new EvidenceError("EVIDENCE_REPLACEMENT_REFUSED", `path changed to a symlink: ${path}`);
  return identityFromStat(stat);
}
function identityFromStat(stat: Stats): FileIdentity {
  return { device: stat.dev, inode: stat.ino, mode: stat.mode };
}
function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode && left.mode === right.mode;
}
function assertIdentity(path: string, expected: FileIdentity, label: string): void {
  let actual: FileIdentity;
  try {
    actual = fileIdentity(path);
  } catch {
    throw new EvidenceError("EVIDENCE_REPLACEMENT_REFUSED", `${label} changed during publication`);
  }
  if (!sameFileIdentity(actual, expected)) throw new EvidenceError("EVIDENCE_REPLACEMENT_REFUSED", `${label} changed during publication`);
}
function observedBundle(
  path: string,
  expectedHash?: Sha256,
  expectedLabel?: "staged" | "prior",
  alternateHash?: Sha256,
  alternateLabel?: "staged" | "prior",
): string {
  if (!entryExists(path)) return "absent";
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return "non-bundle";
    const digest = manifestDigest(path);
    const match =
      digest === expectedHash
        ? `matches-recorded-${expectedLabel}-hash`
        : digest === alternateHash
          ? `matches-recorded-${alternateLabel}-hash`
          : expectedHash !== undefined || alternateHash !== undefined
            ? "matches-neither-recorded-hash"
            : "uncompared";
    let integrity = "intact";
    try {
      validateBundle(path);
    } catch {
      integrity = "incomplete-or-invalid";
    }
    return `${integrity} manifest:${digest} (${match})`;
  } catch {
    return "unreadable";
  }
}
function manifestDigest(path: string): Sha256 {
  return hashBytes(readFileSync(resolve(path, "manifest.json")));
}
function ownerState(lock: string): "live" | "dead" | "uncertain" {
  try {
    const owner = JSON.parse(readFileSync(resolve(lock, "owner.json"), "utf8")) as Partial<LockOwner>;
    if (owner.schemaVersion !== 1 || !Number.isSafeInteger(owner.pid) || typeof owner.pid !== "number" || !("processStart" in owner)) return "uncertain";
    const current = processStart(owner.pid);
    if (current === null) return "dead";
    return current === owner.processStart ? "live" : "dead";
  } catch {
    return "uncertain";
  }
}
function processStart(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8"),
      close = stat.lastIndexOf(")");
    return (
      stat
        .slice(close + 2)
        .trim()
        .split(/\s+/u)[19] ?? null
    );
  } catch {
    return null;
  }
}
function canonicalCandidate(root: string, path: string): string {
  const candidate = resolve(root, path);
  const ancestor = existingAncestor(candidate);
  return resolve(realpathSync(ancestor), relative(ancestor, candidate));
}
function existingAncestor(path: string): string {
  let current = path;
  while (true) {
    if (entryExists(current)) {
      const stat = lstatSync(current);
      if (!stat.isSymbolicLink()) return current;
    }
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}
/** lstat sees dangling symlinks and every other occupied directory entry. */
function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return false;
    throw error;
  }
}
