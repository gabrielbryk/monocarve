import { lstatSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { hashBytes, stableStringify, type Sha256 } from "../util/hash.ts";
import { EvidenceError } from "./evidence-error.ts";
import { entryExists } from "./evidence-fs.ts";
import { validateBundle } from "./evidence-manifest.ts";
import type { PublicationPaths, PublicationPhase } from "./evidence-types.ts";

export interface RecoveryRecord {
  readonly schemaVersion: 1;
  readonly phase: PublicationPhase;
  readonly target: string;
  readonly stage: string;
  readonly backup: string;
  readonly stagedManifestSha256: Sha256;
  readonly priorManifestSha256?: Sha256;
}
export type RecoveryBase = Omit<RecoveryRecord, "phase">;

export function assertNoRecovery(paths: PublicationPaths): void {
  if (recoveryResidue(paths).length > 0) throw recoveryError(paths);
}

export function recoveryError(paths: PublicationPaths): EvidenceError {
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

export function recoveryResidue(paths: PublicationPaths): string[] {
  return [paths.recovery, paths.stage, paths.backup].filter(entryExists);
}

export function recoveryBytes(base: RecoveryBase, phase: PublicationPhase): Uint8Array {
  return new TextEncoder().encode(`${stableStringify({ ...base, phase }, 2)}\n`);
}

export function manifestDigest(path: string): Sha256 {
  return hashBytes(readFileSync(resolve(path, "manifest.json")));
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
