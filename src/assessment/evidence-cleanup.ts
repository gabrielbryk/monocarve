import { readdirSync, renameSync, rmdirSync, unlinkSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { byCodeUnit } from "../util/hash.ts";
import type { EvidenceArtifactRecord, EvidenceManifestBase } from "./evidence-types.ts";

interface FileIdentity {
  readonly device: number;
  readonly inode: number;
  readonly mode: number;
}
type Hook = ((phase: "cleanup-quarantined") => void) | undefined;
type AssertIdentity = (path: string, identity: FileIdentity, label: string) => void;
type Exists = (path: string) => boolean;
type SyncDirectory = (path: string) => void;
type Refusal = (message: string) => Error;
type VerifyBundle = (path: string, manifest: EvidenceManifestBase) => void;

export function removeQuarantinedFile(
  path: string,
  identity: FileIdentity,
  hook: Hook,
  label: string,
  assertIdentity: AssertIdentity,
  exists: Exists,
  syncDirectory: SyncDirectory,
  refusal: Refusal,
): void {
  const quarantine = `${path}.quarantine`;
  if (exists(quarantine)) throw refusal(`cleanup quarantine already exists: ${quarantine}`);
  assertIdentity(path, identity, `${label} entry`);
  renameSync(path, quarantine);
  hook?.("cleanup-quarantined");
  if (exists(path)) throw refusal(`${label} path was replaced during quarantine cleanup`);
  assertIdentity(quarantine, identity, `${label} quarantine`);
  unlinkSync(quarantine);
  syncDirectory(dirname(path));
}

export function listBundleEntries(root: string, refusal: Refusal, current = root): string[] {
  return readdirSync(current, { withFileTypes: true })
    .flatMap((entry) => {
      const absolute = resolve(current, entry.name);
      if (entry.isSymbolicLink()) throw refusal(`bundle contains symlink ${relative(root, absolute)}`);
      const name = relative(root, absolute).replaceAll("\\", "/");
      return entry.isDirectory() ? [name, ...listBundleEntries(root, refusal, absolute)] : [name];
    })
    .toSorted(byCodeUnit);
}

export function removeQuarantinedDirectory(
  path: string,
  identity: FileIdentity | undefined,
  manifest: EvidenceManifestBase | undefined,
  hook: Hook,
  label: string,
  assertIdentity: AssertIdentity,
  exists: Exists,
  syncDirectory: SyncDirectory,
  refusal: Refusal,
  verifyBundle?: VerifyBundle,
): void {
  const quarantine = `${path}.quarantine`;
  if (exists(quarantine)) throw refusal(`cleanup quarantine already exists: ${quarantine}`);
  if (identity !== undefined) assertIdentity(path, identity, label);
  renameSync(path, quarantine);
  hook?.("cleanup-quarantined");
  if (exists(path)) throw refusal(`${label} path was replaced during quarantine cleanup`);
  if (identity !== undefined) assertIdentity(quarantine, identity, `${label} quarantine`);
  const expected = expectedEntries(quarantine, manifest, exists);
  const actual = listEntries(quarantine);
  if (actual.length !== expected.length || actual.some((entry, index) => entry !== expected[index])) {
    throw refusal(`${label} cleanup found unexpected paths; preserved quarantine at ${quarantine}`);
  }
  if (manifest !== undefined) verifyBundle?.(quarantine, manifest);
  const directories = expectedDirectories(expected);
  for (const file of expected
    .filter((entry) => !directories.has(entry))
    .toSorted(byCodeUnit)
    .reverse())
    unlinkSync(resolve(quarantine, file));
  for (const directory of [...directories].toSorted((a, b) => b.length - a.length || byCodeUnit(b, a))) rmdirSync(resolve(quarantine, directory));
  rmdirSync(quarantine);
  syncDirectory(dirname(path));
}

function expectedEntries(root: string, manifest: EvidenceManifestBase | undefined, exists: Exists): string[] {
  if (manifest === undefined) return [];
  const artifacts: readonly EvidenceArtifactRecord[] = manifest.artifacts;
  const paths = [...(exists(resolve(root, "manifest.json")) ? ["manifest.json"] : []), ...artifacts.map(({ path }) => path)];
  return [...new Set([...paths, ...expectedDirectories(paths)])].toSorted(byCodeUnit);
}

function expectedDirectories(paths: readonly string[]): Set<string> {
  const result = new Set<string>();
  for (const path of paths) for (let parent = dirname(path); parent !== "."; parent = dirname(parent)) result.add(parent.replaceAll("\\", "/"));
  return result;
}

function listEntries(root: string, current = root): string[] {
  return readdirSync(current, { withFileTypes: true })
    .flatMap((entry) => {
      const child = resolve(current, entry.name);
      if (entry.isSymbolicLink()) return [`${relativeName(root, child)}\0symlink`];
      const name = relativeName(root, child);
      return entry.isDirectory() ? [name, ...listEntries(root, child)] : [name];
    })
    .toSorted(byCodeUnit);
}

function relativeName(root: string, path: string): string {
  const suffix = path.slice(root.length + 1).replaceAll("\\", "/");
  return suffix;
}
