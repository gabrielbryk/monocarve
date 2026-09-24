import { lstatSync, readFileSync, readlinkSync, readdirSync, realpathSync, type Dirent } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { byCodeUnit, hashBytes } from "../util/hash.ts";
import type { DirectoryMembership, InventoryEntry, InventoryNamespace } from "./input-inventory.ts";

export function inventoryEntry(rootDir: string, path: string): InventoryEntry {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  const named = inventoryName(rootDir, path);
  if (!stat) return { ...named, kind: "missing" };
  if (stat.isSymbolicLink()) {
    const target = readlinkSync(path);
    const durableTarget = isAbsolute(target) ? canonicalName(rootDir, resolve(target)) : target;
    return { ...named, kind: "symlink", target: durableTarget, canonicalPath: canonicalName(rootDir, realpathSync(path)) };
  }
  if (!stat.isFile()) return { ...named, kind: "missing" };
  const bytes = readFileSync(path);
  return { ...named, kind: "file", sha256: hashBytes(bytes), size: bytes.byteLength, canonicalPath: canonicalName(rootDir, realpathSync(path)) };
}

export function directoryMembership(rootDir: string, path: string, excluded: readonly string[]): DirectoryMembership {
  const named = inventoryName(rootDir, path);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat?.isDirectory() || excluded.some((root) => inside(root, path))) return { ...named, entries: [] };
  const entries = readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.name !== ".git" && !excluded.some((root) => inside(root, resolve(path, entry.name))))
    .map((entry) => ({ name: entry.name, kind: directoryEntryKind(entry) }))
    .toSorted((a, b) => byCodeUnit(a.name, b.name));
  return { ...named, entries };
}

function directoryEntryKind(entry: Dirent): DirectoryMembership["entries"][number]["kind"] {
  if (entry.isSymbolicLink()) return "symlink";
  if (entry.isDirectory()) return "directory";
  return "file";
}

export function inventoryName(rootDir: string, path: string): { namespace: InventoryNamespace; path: string } {
  const rel = relative(rootDir, path).replaceAll("\\", "/");
  if (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel)) {
    return { namespace: rel === "node_modules" || rel.startsWith("node_modules/") ? "installed" : "repository", path: rel || "." };
  }
  return { namespace: "external", path: externalDependencyPath(rootDir, path) };
}

/** Name a resolved dependency relative to its package, never by machine path. */
function externalDependencyPath(rootDir: string, path: string): string {
  let current = dirname(path);
  while (true) {
    const manifest = resolve(current, "package.json");
    const packageName = installedPackageName(manifest);
    if (packageName !== undefined) {
      // A package name is not an installation identity: duplicate copies can
      // resolve to different bytes under the same package-relative path. Hash
      // its position relative to the checkout so moving the whole checkout
      // and its external dependencies does not change analytical identity.
      const identity = relative(rootDir, current).replaceAll("\\", "/");
      return `${packageName}#${hashBytes(new TextEncoder().encode(identity))}/${relative(current, path).replaceAll("\\", "/") || "package.json"}`;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  // An unnamed external input has no package-relative namespace. Use an
  // opaque fingerprint of its checkout-relative location: content cannot distinguish
  // equal-byte files or missing resolver probes, while the fingerprint keeps
  // the machine path itself out of durable evidence.
  const identity = relative(rootDir, resolve(path)).replaceAll("\\", "/");
  return `unidentified/${hashBytes(new TextEncoder().encode(identity))}`;
}

function installedPackageName(manifest: string): string | undefined {
  if (!lstatSync(manifest, { throwIfNoEntry: false })?.isFile()) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown };
    return typeof parsed.name === "string" && parsed.name.length > 0 ? parsed.name : undefined;
  } catch {
    return undefined;
  }
}

function canonicalName(rootDir: string, path: string): string {
  const named = inventoryName(rootDir, path);
  return `${named.namespace}:${named.path}`;
}

/** Stable public name for a path observed by a scanner or resolver. */
export function canonicalInputPath(rootDir: string, path: string): string {
  return canonicalName(realpathSync(rootDir), path);
}

export function compareEntries(left: InventoryEntry, right: InventoryEntry): number {
  return byCodeUnit(left.namespace, right.namespace) || byCodeUnit(left.path, right.path);
}

export function compareDirectories(left: DirectoryMembership, right: DirectoryMembership): number {
  return byCodeUnit(left.namespace, right.namespace) || byCodeUnit(left.path, right.path);
}

export function inside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel));
}
