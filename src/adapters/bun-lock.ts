/**
 * Line-oriented `bun.lock` region parsing.
 *
 * `bun.lock` is JSONC whose formatting is load-bearing: trailing commas, two
 * space indentation, one blank line between `packages` entries, and a fixed
 * section order inside a workspace entry. `JSON.parse` followed by
 * `JSON.stringify` produces a file bun rewrites on the next install, which is
 * exactly the divergence the verification exists to catch — so nothing here
 * round-trips the document. Every read and every edit is a splice on lines,
 * the same discipline the pnpm modules use on YAML.
 *
 * A bun importer is *composite*: a package occupies an entry in `workspaces`
 * (its manifest, mirrored) and an entry in `packages` (`name@workspace:dir`).
 * Both have to move together, so the adapter's "block" carries both and this
 * module reports both regions.
 */

import { LockfileError } from "./lockfile-error.ts";

/** bun keys the workspace root by the empty string; the engine calls it `.`. */
export const ROOT_IMPORTER_KEY = "";

/** Engine package root -> the key bun writes for it. */
export function importerKey(packageRoot: string): string {
  return packageRoot === "." || packageRoot === "" ? ROOT_IMPORTER_KEY : packageRoot;
}

/** A `"key": …` entry, as the half-open line range `[start, end)` it owns. */
export interface LockEntry {
  readonly key: string;
  readonly start: number;
  readonly end: number;
}

/** A top-level section: its opening line, and the line holding its `}`. */
export interface LockSection {
  readonly open: number;
  readonly close: number;
  readonly entries: readonly LockEntry[];
}

export interface ParsedBunLock {
  readonly lines: readonly string[];
  readonly workspaces: LockSection;
  /** Absent only in a lockfile with no `packages` map at all. */
  readonly packages: LockSection | undefined;
}

const SECTION_OPEN = (name: string): string => `  "${name}": {`;
const OBJECT_ENTRY = /^ {4}("(?:[^"\\]|\\.)*"): \{$/u;
const ARRAY_ENTRY = /^ {4}("(?:[^"\\]|\\.)*"): \[/u;
const ENTRY_CLOSE = /^ {4}\},$/u;
const SECTION_CLOSE = /^ {2}\},?$/u;

export function parseBunLock(text: string): ParsedBunLock {
  const lines = text.split("\n");
  const workspaces = objectSection(lines, "workspaces");
  if (!workspaces) throw new LockfileError("bun.lock has no workspaces section");
  return { lines, workspaces, packages: arraySection(lines, "packages") };
}

/** The `workspaces` entry for `packageRoot`, or undefined when it has none. */
export function workspaceEntry(parsed: ParsedBunLock, packageRoot: string): LockEntry | undefined {
  const key = importerKey(packageRoot);
  return parsed.workspaces.entries.find((entry) => entry.key === key);
}

/** The `packages` entry for a package *name*, or undefined when it has none. */
export function packageEntry(parsed: ParsedBunLock, packageName: string): LockEntry | undefined {
  return parsed.packages?.entries.find((entry) => entry.key === packageName);
}

/**
 * The line index a new `workspaces` entry belongs at, keeping the map sorted.
 *
 * `""` sorts before every directory, which is also where bun writes the root,
 * so plain code-unit ordering is the whole rule.
 */
export function workspaceInsertion(parsed: ParsedBunLock, key: string): number {
  return parsed.workspaces.entries.find((entry) => key < entry.key)?.start ?? parsed.workspaces.close;
}

/**
 * Where a new *top-level* `packages` entry goes, and whether it needs a blank
 * line before or after it.
 *
 * bun separates `packages` entries with one blank line and writes nested
 * resolution chains (`@acme/app/left-pad`) after the top-level keys they hang
 * off. This adapter only ever inserts a top-level workspace-link entry, so it
 * sorts among the top-level keys and lands before the first nested one.
 */
export function packageInsertion(section: LockSection, key: string): { index: number; blankBefore: boolean } {
  const topLevel = section.entries.filter((entry) => isTopLevelKey(entry.key));
  if (topLevel.length === 0) return { index: section.open + 1, blankBefore: false };
  const following = topLevel.find((entry) => key < entry.key);
  if (following) return { index: following.start, blankBefore: false };
  return { index: topLevel[topLevel.length - 1]!.end, blankBefore: true };
}

/** A registry name, as opposed to a `parent/child` resolution chain. */
export function isTopLevelKey(key: string): boolean {
  const slashes = key.split("/").length - 1;
  return key.startsWith("@") ? slashes === 1 : slashes === 0;
}

/** Serialize a JSON string the way bun writes one. */
export function jsonString(value: string): string {
  return JSON.stringify(value);
}

/** Read a JSON string literal, refusing anything else. */
export function parseJsonString(literal: string): string {
  const value: unknown = JSON.parse(literal);
  if (typeof value !== "string") throw new LockfileError(`bun.lock key is not a string: ${literal}`);
  return value;
}

function objectSection(lines: readonly string[], name: string): LockSection | undefined {
  const open = lines.indexOf(SECTION_OPEN(name));
  if (open < 0) return undefined;
  const close = sectionClose(lines, open, name);
  const entries: LockEntry[] = [];
  for (let index = open + 1; index < close; index += 1) {
    const match = lines[index]?.match(OBJECT_ENTRY);
    if (!match) continue;
    const end = entryClose(lines, index, close, name);
    entries.push({ key: parseJsonString(match[1]!), start: index, end });
    index = end - 1;
  }
  return { open, close, entries };
}

function arraySection(lines: readonly string[], name: string): LockSection | undefined {
  const open = lines.indexOf(SECTION_OPEN(name));
  if (open < 0) return undefined;
  const close = sectionClose(lines, open, name);
  const entries: LockEntry[] = [];
  for (let index = open + 1; index < close; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() === "") continue;
    const match = line.match(ARRAY_ENTRY);
    if (!match) throw new LockfileError(`cannot parse unfamiliar bun.lock ${name} entry: ${line.trim()}`);
    entries.push({ key: parseJsonString(match[1]!), start: index, end: index + 1 });
  }
  return { open, close, entries };
}

function sectionClose(lines: readonly string[], open: number, name: string): number {
  for (let index = open + 1; index < lines.length; index += 1) {
    if (SECTION_CLOSE.test(lines[index] ?? "")) return index;
  }
  throw new LockfileError(`bun.lock ${name} section is not closed`);
}

function entryClose(lines: readonly string[], start: number, limit: number, name: string): number {
  for (let index = start + 1; index < limit; index += 1) {
    if (ENTRY_CLOSE.test(lines[index] ?? "")) return index + 1;
  }
  throw new LockfileError(`bun.lock ${name} entry is not closed: ${lines[start]?.trim() ?? ""}`);
}
