import { constants, closeSync, fstatSync, ftruncateSync, fsyncSync, lstatSync, openSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { EvidenceError } from "./evidence-error.ts";

interface FileIdentity {
  readonly device: number;
  readonly inode: number;
  readonly mode: number;
}

export function equalOwnedBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

export function writeRecoveryFile(path: string, bytes: Uint8Array, expected?: FileIdentity): FileIdentity {
  const flags =
    expected === undefined ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW : constants.O_WRONLY | constants.O_NOFOLLOW;
  const fd = openSync(path, flags, 0o600);
  try {
    const stat = fstatSync(fd);
    if (expected !== undefined && (stat.dev !== expected.device || stat.ino !== expected.inode || stat.mode !== expected.mode)) {
      throw new EvidenceError("EVIDENCE_REPLACEMENT_REFUSED", "recovery record changed during publication");
    }
    ftruncateSync(fd, 0);
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const directory = openSync(dirname(path), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
  const stat = lstatSync(path);
  return { device: stat.dev, inode: stat.ino, mode: stat.mode };
}
