import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { byCodeUnit, stableStringify } from "../util/hash.ts";
import { EvidenceError } from "./evidence-error.ts";
import {
  assertIdentity,
  entryExists,
  fileIdentity,
  identityFromStat,
  sameFileIdentity,
  syncDirectory,
  writeDurable,
  type FileIdentity,
} from "./evidence-fs.ts";
import { equalOwnedBytes } from "./evidence-recovery-write.ts";
import { recoveryError } from "./evidence-recovery.ts";
import type { PublicationPaths } from "./evidence-types.ts";

export interface LockOwner {
  readonly schemaVersion: 1;
  readonly pid: number;
  readonly processStart: string | null;
}
export interface LockOwnership {
  readonly lockIdentity: FileIdentity;
  readonly ownerIdentity: FileIdentity;
  readonly ownerBytes: Uint8Array;
  readonly ownerFd: number;
}

export function acquireLock(paths: PublicationPaths): LockOwnership {
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
      releaseLock(paths.lock, identity, fileIdentity(resolve(paths.lock, "owner.json")), ownerBytes);
    } catch {
      /* replaced lock remains as recovery evidence */
    }
    if (ownerFd !== undefined) closeSync(ownerFd);
    throw error;
  }
}

export function releaseLock(lock: string, identity: FileIdentity, ownerIdentity: FileIdentity, ownerBytes: Uint8Array, ownerFd?: number): void {
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
