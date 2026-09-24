/**
 * bun workspace membership and package discovery.
 *
 * bun declares membership in the root `package.json` rather than a file of its
 * own, so the "workspace manifest" this adapter edits *is* that manifest. The
 * edit stays line-oriented for the same reason the lockfile splices do: a
 * re-serialized root manifest is a diff full of formatting the extraction did
 * not ask for, in the one file every reviewer reads.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { LockfileError } from "./lockfile-error.ts";
import type { AdapterEditResult, WorkspaceInspection, WorkspacePackage } from "./types.ts";
import { assertEnumerableGlobs, globsCoverPackage, resolveWorkspacePackages } from "./workspace-globs.ts";

const WORKSPACES_KEY = /^(\s*)"workspaces"\s*:\s*(.*)$/u;
const ARRAY_ENTRY = /^(\s*)"((?:[^"\\]|\\.)*)"(,?)\s*$/u;
const ARRAY_CLOSE = /^\s*\]/u;

export async function listPackages(rootDir: string, manifestName: string): Promise<WorkspacePackage[]> {
  return [...(await inspectWorkspace(rootDir, manifestName)).packages];
}

export async function inspectWorkspace(rootDir: string, manifestName: string): Promise<WorkspaceInspection> {
  const manifestPath = join(rootDir, manifestName);
  if (!existsSync(manifestPath)) return { packages: [], unmatchedPatterns: [] };
  const result = resolveWorkspacePackages(rootDir, workspaceGlobs(readFileSync(manifestPath, "utf8")));
  return { packages: result.packages, unmatchedPatterns: result.unmatched };
}

export function workspaceManifestEdit(manifestText: string, packageRoot: string): AdapterEditResult {
  if (globsCoverPackage(workspaceGlobs(manifestText), packageRoot)) return { kind: "already-satisfied" };
  const lines = manifestText.split("\n");
  const keyIndex = lines.findIndex((line) => WORKSPACES_KEY.test(line));
  if (keyIndex < 0) return { kind: "unmet-precondition", reason: "the root package.json declares no workspaces field" };
  const value = lines[keyIndex]!.match(WORKSPACES_KEY)![2]!;
  if (value.includes("[") && value.includes("]")) return { kind: "changed", contents: inlineEdit(lines, keyIndex, packageRoot) };
  if (value.trim() !== "[") {
    return { kind: "unmet-precondition", reason: `the root package.json workspaces field is not an array this adapter can edit: ${value.trim()}` };
  }
  return multilineEdit(lines, keyIndex, packageRoot);
}

/** The declared globs, in declaration order, refusing shapes we cannot walk. */
function workspaceGlobs(manifestText: string): string[] {
  const globs = declaredGlobs(manifestText);
  assertEnumerableGlobs(globs, "bun");
  return globs;
}

function declaredGlobs(manifestText: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestText);
  } catch {
    throw new LockfileError("the root package.json is not valid JSON, so bun workspace membership cannot be read");
  }
  const value = (parsed as { workspaces?: unknown } | null)?.workspaces;
  const list = Array.isArray(value) ? value : (value as { packages?: unknown } | undefined)?.packages;
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new LockfileError("the root package.json workspaces field is neither an array nor a { packages: [] } object");
  return list.filter((entry): entry is string => typeof entry === "string");
}

/** `"workspaces": ["apps/*", "libs/*"]` — rewrite the one line it occupies. */
function inlineEdit(lines: readonly string[], keyIndex: number, packageRoot: string): string {
  const line = lines[keyIndex]!;
  const open = line.indexOf("[");
  const close = line.lastIndexOf("]");
  const current = JSON.parse(line.slice(open, close + 1)) as string[];
  const next = [...current, packageRoot].sort();
  const rendered = `[${next.map((entry) => JSON.stringify(entry)).join(", ")}]`;
  const replaced = [...lines];
  replaced[keyIndex] = `${line.slice(0, open)}${rendered}${line.slice(close + 1)}`;
  return replaced.join("\n");
}

/** `"workspaces": [` with one glob per line — splice a line into it. */
function multilineEdit(lines: readonly string[], keyIndex: number, packageRoot: string): AdapterEditResult {
  const close = lines.findIndex((line, index) => index > keyIndex && ARRAY_CLOSE.test(line));
  if (close < 0) return { kind: "unmet-precondition", reason: "the root package.json workspaces array is not closed" };
  const entries = arrayEntries(lines, keyIndex + 1, close);
  // Every line between the key and the bracket has to be an entry. A comment or
  // a wrapped value this loop skipped would otherwise be spliced across.
  if (entries.length !== close - keyIndex - 1) {
    return { kind: "unmet-precondition", reason: "the root package.json workspaces array holds a line this adapter cannot read" };
  }
  const indent = entries[0]?.indent ?? `${lines[keyIndex]!.match(WORKSPACES_KEY)![1]!}  `;
  const following = entries.find((entry) => packageRoot < entry.value);
  const next = [...lines];
  if (following) next.splice(following.index, 0, `${indent}${JSON.stringify(packageRoot)},`);
  else next.splice(close, 0, `${indent}${JSON.stringify(packageRoot)}${trailingComma(entries)}`);
  if (!following && entries.length > 0) {
    const last = entries[entries.length - 1]!;
    if (last.comma === "") next[last.index] = `${indent}${JSON.stringify(last.value)},`;
  }
  return { kind: "changed", contents: next.join("\n") };
}

interface ArrayEntry {
  readonly index: number;
  readonly indent: string;
  readonly value: string;
  readonly comma: string;
}

function arrayEntries(lines: readonly string[], start: number, end: number): ArrayEntry[] {
  const entries: ArrayEntry[] = [];
  for (let index = start; index < end; index += 1) {
    const match = lines[index]!.match(ARRAY_ENTRY);
    if (match) entries.push({ index, indent: match[1]!, value: match[2]!, comma: match[3]! });
  }
  return entries;
}

/** A last entry that already carries a comma means the file tolerates one. */
function trailingComma(entries: readonly ArrayEntry[]): string {
  return entries[entries.length - 1]?.comma ?? "";
}
