/** Line-oriented pnpm importer parsing and mutation helpers. */

import { LockfileError } from "./pnpm-error.ts";
import type { ConsumerDependencySection } from "./types.ts";

export interface ImporterEntry {
  readonly root: string;
  readonly start: number;
  /** One past the owned lines, including the separating blank line. */
  end: number;
}

export interface ParsedImporters {
  readonly lines: string[];
  readonly entries: ImporterEntry[];
  readonly end: number;
}

export const IMPORTER_KEY = /^ {2}([^\s].*?):(?: (.*))?$/;
export const EMPTY_MAP = "{}";
export const DEPENDENCY_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies"] as const;
export type PnpmDependencySection = (typeof DEPENDENCY_SECTIONS)[number];

export interface BlockDependency {
  readonly section: PnpmDependencySection;
  readonly name: string;
  readonly start: number;
  readonly end: number;
}

export function yamlKey(name: string): string {
  return name.startsWith("@") ? `'${name}'` : name;
}

export function yamlValue(value: string): string {
  return value.endsWith(":") ? `'${value}'` : value;
}

export function yamlScalar(value: string): string {
  return value.replace(/^['"]|['"]$/g, "");
}

export function pnpmSection(section: ConsumerDependencySection): PnpmDependencySection {
  return section === "runtime" ? "dependencies" : "devDependencies";
}

/** Finds block and inline (`root: {}`) importer entries without YAML reformatting. */
export function parseImporters(text: string): ParsedImporters {
  const lines = text.split("\n");
  const importers = lines.findIndex((line) => line === "importers:");
  if (importers < 0) throw new LockfileError("lockfile has no importers section");
  const following = lines.slice(importers + 1).findIndex((line) => /^[^\s]/.test(line));
  const end = following < 0 ? lines.length : importers + 1 + following;
  const entries = importerEntries(lines, importers + 1, end);
  return { lines, entries, end };
}

function importerEntries(lines: readonly string[], start: number, end: number): ImporterEntry[] {
  const entries: ImporterEntry[] = [];
  for (let index = start; index < end; index += 1) {
    const match = lines[index]?.match(IMPORTER_KEY);
    if (!match) continue;
    const previous = entries.at(-1);
    if (previous) previous.end = index;
    entries.push({ root: match[1]!, start: index, end });
  }
  return entries;
}

/** Parse only the dependency form this adapter emits; unknown mappings refuse edits. */
export function blockDependencies(lines: readonly string[]): BlockDependency[] {
  const found: BlockDependency[] = [];
  let section: PnpmDependencySection | undefined;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const sectionName = dependencySection(line);
    if (sectionName) {
      section = sectionName;
      continue;
    }
    if (/^ {4}\S/.test(line)) throw new LockfileError(`cannot parse unfamiliar importer mapping ${line.trim()}`);
    if (!section) continue;
    const key = line.match(/^ {6}(?:'([^']+)'|([^:]+)):\s*$/);
    if (!key) continue;
    found.push({ section, name: key[1] ?? key[2]!, start: index, end: dependencyEnd(lines, index + 1) });
  }
  return found;
}

function dependencySection(line: string): PnpmDependencySection | undefined {
  return line.match(/^    (dependencies|devDependencies|optionalDependencies):$/)?.[1] as PnpmDependencySection | undefined;
}

function dependencyEnd(lines: readonly string[], start: number): number {
  let end = start;
  while (end < lines.length && !/^ {6}\S/.test(lines[end] ?? "") && !/^ {4}\S/.test(lines[end] ?? "")) end += 1;
  return end;
}

export function importerBlock(lockfileText: string, packageRoot: string): string | undefined {
  const { lines, entries } = parseImporters(lockfileText);
  const entry = entries.find((candidate) => candidate.root === packageRoot);
  return entry ? `${lines.slice(entry.start, entry.end).join("\n")}\n` : undefined;
}

export function insertImporter(lockfileText: string, packageRoot: string, block: string): string {
  const parsed = parseImporters(lockfileText);
  if (parsed.entries.some((entry) => entry.root === packageRoot)) return lockfileText;
  const insertion = parsed.entries.find((entry) => packageRoot < entry.root)?.start ?? parsed.end;
  const lines = [...parsed.lines];
  lines.splice(insertion, 0, ...block.replace(/\n$/, "").split("\n"));
  return lines.join("\n");
}

export function replaceImporter(lockfileText: string, packageRoot: string, block: string): string {
  const parsed = parseImporters(lockfileText);
  const entry = parsed.entries.find((candidate) => candidate.root === packageRoot);
  if (!entry) throw new LockfileError(`lockfile has no importer block to replace for ${packageRoot}`);
  const lines = [...parsed.lines];
  lines.splice(entry.start, entry.end - entry.start, ...block.replace(/\n$/, "").split("\n"));
  return lines.join("\n");
}
