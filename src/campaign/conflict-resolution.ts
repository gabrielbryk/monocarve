import { byCodeUnit, hashJson } from "../util/hash.ts";
import { compareAccesses } from "./conflict-accesses.ts";
import type { CollisionBuckets, ConflictCategory, ConflictDisposition, OperationPathAccess, PlanConflict, Subject } from "./conflict-types.ts";

export function conflictsBetween(left: Subject, right: Subject): PlanConflict[] {
  const buckets = collisionBuckets(left.accesses, right.accesses);
  return [...buckets.entries()].map(([path, bucket]) => conflictFromBucket(left, right, path, bucket.left, bucket.right));
}

function collisionBuckets(left: readonly OperationPathAccess[], right: readonly OperationPathAccess[]): CollisionBuckets {
  const buckets = new Map<string, { left: OperationPathAccess[]; right: OperationPathAccess[] }>();
  for (const leftAccess of left)
    for (const rightAccess of right) {
      if (!overlaps(leftAccess, rightAccess) || (!writes(leftAccess) && !writes(rightAccess))) continue;
      const path = overlapPath(leftAccess, rightAccess);
      const bucket = buckets.get(path) ?? { left: [], right: [] };
      bucket.left.push(leftAccess);
      bucket.right.push(rightAccess);
      buckets.set(path, bucket);
    }
  return buckets;
}

function conflictFromBucket(
  left: Subject,
  right: Subject,
  path: string,
  leftAccesses: readonly OperationPathAccess[],
  rightAccesses: readonly OperationPathAccess[],
): PlanConflict {
  const leftEvidence = uniqueAccesses(leftAccesses);
  const rightEvidence = uniqueAccesses(rightAccesses);
  const pairs = leftEvidence.flatMap((leftAccess) =>
    rightEvidence
      .filter((rightAccess) => overlaps(leftAccess, rightAccess) && (writes(leftAccess) || writes(rightAccess)))
      .map((rightAccess) => [leftAccess, rightAccess] as const),
  );
  const disposition: ConflictDisposition = pairs.length > 0 && pairs.every(([first, second]) => isMergeablePair(first, second)) ? "mergeable" : "hard";
  const category = categoryFor([...leftEvidence, ...rightEvidence]);
  return {
    id: `pc-${hashJson({ candidates: [left.candidateId, right.candidateId], path, category, disposition }).slice(0, 12)}`,
    candidates: [left.candidateId, right.candidateId],
    planIds: [left.manifest.planId, right.manifest.planId],
    path,
    category,
    disposition,
    requiresReplan: true,
    left: leftEvidence,
    right: rightEvidence,
    explanation: explain(left.candidateId, right.candidateId, path, category, disposition),
  };
}

function writes(access: OperationPathAccess): boolean {
  return access.mode !== "read";
}

function overlaps(left: OperationPathAccess, right: OperationPathAccess): boolean {
  if (left.scope === "exact" && right.scope === "exact") return left.path === right.path;
  if (left.scope === "tree" && right.scope === "tree") return contains(left.path, right.path) || contains(right.path, left.path);
  const tree = left.scope === "tree" ? left : right;
  const exact = left.scope === "exact" ? left : right;
  return contains(tree.path, exact.path);
}

function contains(root: string, path: string): boolean {
  return root === path || path.startsWith(`${root}/`);
}

function overlapPath(left: OperationPathAccess, right: OperationPathAccess): string {
  if (left.scope === "exact") return left.path;
  if (right.scope === "exact") return right.path;
  return contains(left.path, right.path) ? right.path : left.path;
}

function uniqueAccesses(accesses: readonly OperationPathAccess[]): OperationPathAccess[] {
  const unique = new Map<string, OperationPathAccess>();
  for (const current of accesses) {
    const key = JSON.stringify([current.path, current.scope, current.mode, current.role, current.operationIndex, current.operationKind, current.keys]);
    unique.set(key, current);
  }
  return [...unique.values()].toSorted(compareAccesses);
}

function isMergeablePair(left: OperationPathAccess, right: OperationPathAccess): boolean {
  if (left.role !== right.role || left.keys.length === 0 || right.keys.length === 0) return false;
  const structured = new Set([
    "consumer-source",
    "consumer-manifest",
    "consumer-project-references",
    "workspace-registry",
    "task-registry",
    "lockfile-importer",
  ]);
  return structured.has(left.role) && left.keys.every((key) => !right.keys.includes(key));
}

/** First match wins: a conflict takes the category of the most specific role it touches. */
const CATEGORY_PRECEDENCE: readonly (readonly [ConflictCategory, readonly OperationPathAccess["role"][]])[] = [
  ["generated-artifact", ["generated-artifact", "generated-source"]],
  ["moved-path", ["move-source", "move-target"]],
  ["consumer-source", ["consumer-source"]],
  ["lockfile-importer", ["lockfile-importer"]],
  ["workspace-registry", ["workspace-registry"]],
  ["task-registry", ["task-registry"]],
  ["path-key-artifact", ["path-key-artifact"]],
  ["package-manifest", ["package-manifest", "consumer-manifest"]],
  ["project-references", ["consumer-project-references"]],
  ["scaffold-output", ["scaffold-output", "entrypoint", "task-file"]],
];

function categoryFor(accesses: readonly OperationPathAccess[]): ConflictCategory {
  const roles = new Set(accesses.map((access) => access.role));
  return CATEGORY_PRECEDENCE.find(([, triggers]) => triggers.some((role) => roles.has(role)))?.[0] ?? "shared-path";
}

function explain(left: string, right: string, path: string, category: ConflictCategory, disposition: ConflictDisposition): string {
  return disposition === "mergeable"
    ? `${left} and ${right} make distinct structured ${category} edits at ${path}; compose them by replanning because their current result hashes cannot both apply`
    : `${left} and ${right} have incompatible ${category} access at ${path}`;
}

export function compareConflicts(left: PlanConflict, right: PlanConflict): number {
  return (
    byCodeUnit(left.candidates[0], right.candidates[0]) ||
    byCodeUnit(left.candidates[1], right.candidates[1]) ||
    byCodeUnit(left.path, right.path) ||
    byCodeUnit(left.category, right.category) ||
    byCodeUnit(left.id, right.id)
  );
}
