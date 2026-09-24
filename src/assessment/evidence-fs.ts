import { closeSync, fsyncSync, lstatSync, openSync, readdirSync, writeFileSync, type Stats } from "node:fs";
import { dirname, resolve } from "node:path";
import { EvidenceError } from "./evidence-error.ts";

export interface FileIdentity {
  readonly device: number;
  readonly inode: number;
  readonly mode: number;
}

export function identityFromStat(stat: Stats): FileIdentity {
  return { device: stat.dev, inode: stat.ino, mode: stat.mode };
}

export function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode && left.mode === right.mode;
}

export function fileIdentity(path: string): FileIdentity {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new EvidenceError("EVIDENCE_REPLACEMENT_REFUSED", `path changed to a symlink: ${path}`);
  return identityFromStat(stat);
}

export function assertIdentity(path: string, expected: FileIdentity, label: string): void {
  let actual: FileIdentity;
  try {
    actual = fileIdentity(path);
  } catch {
    throw new EvidenceError("EVIDENCE_REPLACEMENT_REFUSED", `${label} changed during publication`);
  }
  if (!sameFileIdentity(actual, expected)) throw new EvidenceError("EVIDENCE_REPLACEMENT_REFUSED", `${label} changed during publication`);
}

/** Persist directory-entry transitions as well as file contents. */
export function syncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function syncBundleDirectories(current: string): void {
  for (const entry of readdirSync(current, { withFileTypes: true }))
    if (entry.isDirectory() && !entry.isSymbolicLink()) syncBundleDirectories(resolve(current, entry.name));
  syncDirectory(current);
}

export function writeDurable(path: string, bytes: Uint8Array): void {
  const fd = openSync(path, "wx");
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  syncDirectory(dirname(path));
}

/** lstat sees dangling symlinks and every other occupied directory entry. */
export function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return false;
    throw error;
  }
}
