import { lstatSync, realpathSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { EvidenceError } from "./evidence-error.ts";
import { assertIdentity, entryExists, fileIdentity, type FileIdentity } from "./evidence-fs.ts";
import { assertRelativePath, validateBundle } from "./evidence-manifest.ts";
import { overlaps, within } from "./evidence-paths.ts";
import type { PriorBundle, PublicationPaths } from "./evidence-types.ts";

export interface PublicationBoundary {
  readonly root: FileIdentity;
  readonly parent: FileIdentity;
  readonly target?: FileIdentity;
}

/** Resolve and confine the canonical evidence destination, ready for staging/backup/lock siblings. */
export function publicationPaths(rootDir: string, destination: string, analyticalRoots: readonly string[]): PublicationPaths {
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

export function captureBoundary(paths: PublicationPaths, prior: PriorBundle | undefined): PublicationBoundary {
  return { root: fileIdentity(paths.root), parent: fileIdentity(dirname(paths.target)), ...(prior === undefined ? {} : { target: prior.identity }) };
}

export function revalidateBoundary(paths: PublicationPaths, boundary: PublicationBoundary, prior: PriorBundle | undefined): void {
  revalidateContainer(paths, boundary);
  if (boundary.target === undefined) {
    if (entryExists(paths.target)) throw new EvidenceError("EVIDENCE_REPLACEMENT_REFUSED", "evidence destination appeared during publication");
  } else {
    assertIdentity(paths.target, boundary.target, "prior evidence destination");
    if (prior?.manifest !== undefined) validateBundle(paths.target, prior.manifest);
  }
  if (entryExists(paths.backup)) throw new EvidenceError("EVIDENCE_RECOVERY_REQUIRED", `backup path appeared during publication: ${paths.backup}`);
}

export function revalidateContainer(paths: PublicationPaths, boundary: PublicationBoundary): void {
  const current = publicationPaths(paths.root, paths.requestedDestination, paths.analyticalRoots);
  if (current.target !== paths.target || current.stage !== paths.stage || current.backup !== paths.backup) {
    throw new EvidenceError("EVIDENCE_REPLACEMENT_REFUSED", "canonical evidence destination changed during publication");
  }
  assertIdentity(paths.root, boundary.root, "workspace root");
  assertIdentity(dirname(paths.target), boundary.parent, "evidence destination parent");
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
