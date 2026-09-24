/** Structural predicates and issue helpers shared by the preparation manifest validators. */
import { byCodeUnit, hashText, isFileState, isSha256, type FileState } from "../util/hash.ts";
import type { PreparationDeclarationGroupSelector } from "./manifest-types.ts";

export type AddIssue = (rule: string, message: string, path?: string) => void;

export interface ValidatedMutation {
  readonly path: string;
  readonly preconditionHash: FileState;
  readonly preconditionMode: number | "missing";
  readonly resultHash: string;
  readonly resultMode: number;
}

export function validateMutation(mutation: ValidatedMutation, contents: string, rule: string, add: AddIssue): void {
  if (!isFileState(mutation.preconditionHash) || !isSha256(mutation.resultHash)) add(rule, "file mutation hashes are invalid", mutation.path);
  if ((mutation.preconditionHash === "missing") !== (mutation.preconditionMode === "missing"))
    add(`${rule}-mode`, "preconditionMode must be missing exactly when the precondition hash is missing", mutation.path);
  if (mutation.preconditionMode !== "missing" && !isFileMode(mutation.preconditionMode))
    add(`${rule}-mode`, "preconditionMode must be canonical Git mode 0644 or 0755", mutation.path);
  if (!isFileMode(mutation.resultMode)) add(`${rule}-mode`, "resultMode must be canonical Git mode 0644 or 0755", mutation.path);
  if (hashText(contents) !== mutation.resultHash) add(rule, "resultHash does not match replay contents", mutation.path);
}

export function groupKey(group: PreparationDeclarationGroupSelector): string {
  const first = group.declarations[0];
  return `${group.sourcePath}\u0000${String(first?.span.start ?? -1).padStart(12, "0")}\u0000${group.groupId}`;
}

/** Each adjacent `[previous, current]` pair, in order. */
function* adjacentPairs<T>(values: Iterable<T>): Generator<[T, T]> {
  let previous: { readonly value: T } | undefined;
  for (const value of values) {
    if (previous !== undefined) yield [previous.value, value];
    previous = { value };
  }
}

export function validateSorted<T>(values: readonly T[], key: (value: T) => string, rule: string, message: string, add: AddIssue): void {
  for (const [previous, current] of adjacentPairs(values)) if (byCodeUnit(key(previous), key(current)) >= 0) add(rule, message);
}

export function validateSortedStrings(values: readonly string[] | undefined, rule: string, label: string, add: AddIssue): void {
  if (!values) {
    add(rule, `${label} must be an array`);
    return;
  }
  for (const value of values) if (typeof value !== "string" || value.length === 0) add(rule, `${label} entries must be non-empty strings`);
  for (const [previous, current] of adjacentPairs(values)) if (byCodeUnit(previous, current) >= 0) add(rule, `${label} must be sorted and unique`);
}

/**
 * Order `items` by region, then by `tiebreak`, and report every adjacent pair
 * whose regions overlap.
 */
export function reportOverlaps<T>(
  items: readonly T[],
  region: (item: T) => { readonly start: number; readonly end: number },
  tiebreak: (item: T) => string,
  onOverlap: (previous: T, current: T) => void,
): void {
  const ordered = [...items].toSorted(
    (left, right) => region(left).start - region(right).start || region(left).end - region(right).end || byCodeUnit(tiebreak(left), tiebreak(right)),
  );
  for (const [previous, current] of adjacentPairs(ordered)) if (region(current).start < region(previous).end) onOverlap(previous, current);
}

export function isWorkspacePath(path: string): boolean {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.startsWith("\\") &&
    !path.split("/").some((part) => part === "" || part === "." || part === "..")
  );
}

/** Relative specifiers may begin with `./` or any number of `../` segments. */
export function isModuleSpecifier(specifier: string): boolean {
  if (typeof specifier !== "string" || specifier.length === 0 || /[\\\r\n\u0000]/.test(specifier) || specifier.startsWith("/")) return false;
  if (!specifier.startsWith(".")) return true;
  const segments = specifier.split("/");
  let index = 0;
  if (segments[0] === ".") index = 1;
  while (segments[index] === "..") index += 1;
  if (index === 0 || index === segments.length) return false;
  return segments.slice(index).every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

export function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isFileMode(value: number): boolean {
  return value === 0o644 || value === 0o755;
}
