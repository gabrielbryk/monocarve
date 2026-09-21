/**
 * The composite bun importer block, parsed and re-serialized without reflow.
 *
 * One package occupies two places in `bun.lock`. The `workspaces` entry mirrors
 * its manifest; the `packages` entry declares the workspace link. The adapter
 * treats the pair as a single block so a plan's `lockfileImporterHash` covers
 * both — a block that carried only the manifest half would let a `packages`
 * entry drift with the audit still green.
 */

import { LockfileError } from "./lockfile-error.ts";
import { jsonString, parseJsonString } from "./bun-lock.ts";

/** The dependency maps bun writes inside a `workspaces` entry, in its order. */
export const BUN_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;
export type BunSection = (typeof BUN_SECTIONS)[number];

export const ENTRY_OPEN = /^ {4}("(?:[^"\\]|\\.)*"): \{$/u;
export const ENTRY_CLOSE = "    },";
export const PACKAGE_LINE = /^ {4}("(?:[^"\\]|\\.)*"): \[/u;
const SECTION_OPEN = /^ {6}("(?:[^"\\]|\\.)*"): \{$/u;
const SECTION_CLOSE = "      },";
const SCALAR_FIELD = /^ {6}("(?:[^"\\]|\\.)*"): (?:"(?:[^"\\]|\\.)*"),$/u;
const DEPENDENCY = /^ {8}("(?:[^"\\]|\\.)*"): "((?:[^"\\]|\\.)*)",$/u;

export interface BunBlock {
  /** The `workspaces` entry, from its `"root": {` line to its `},`. */
  readonly workspaceLines: readonly string[];
  /** The `packages` entry line. Absent for the workspace root, which has none. */
  readonly packageLine: string | undefined;
}

/** A dependency inside a block, as the line it occupies. */
export interface BlockDependency {
  readonly section: BunSection;
  readonly name: string;
  readonly specifier: string;
  readonly index: number;
}

export function parseBlock(block: string): BunBlock {
  const lines = block.split("\n");
  while (lines.length > 0 && (lines[lines.length - 1] ?? "").trim() === "") lines.pop();
  if (lines.length === 0) throw new LockfileError("bun.lock importer block is empty");
  const last = lines[lines.length - 1]!;
  const packageLine = PACKAGE_LINE.test(last) ? lines.pop() : undefined;
  assertWorkspaceEntry(lines);
  return { workspaceLines: lines, packageLine };
}

/**
 * The block's canonical bytes.
 *
 * The trailing blank line is the separator the splicers strip on the way in and
 * re-add on the way out, so `renderImporterBlock(...) + "\n\n"` — what the
 * planner writes into an operation — is byte-identical to `importerBlock(...)`
 * read back out of the spliced file.
 */
export function serializeBlock(block: BunBlock): string {
  return `${blockLines(block).join("\n")}\n\n`;
}

export function blockLines(block: BunBlock): string[] {
  return [...block.workspaceLines, ...(block.packageLine === undefined ? [] : [block.packageLine])];
}

/** Every dependency the block declares, across every section bun writes. */
export function blockDependencies(block: BunBlock): BlockDependency[] {
  const found: BlockDependency[] = [];
  let section: BunSection | undefined;
  for (let index = 1; index < block.workspaceLines.length - 1; index += 1) {
    const line = block.workspaceLines[index]!;
    const opened = sectionName(line);
    if (opened !== undefined) {
      section = opened;
      continue;
    }
    if (line === SECTION_CLOSE) {
      section = undefined;
      continue;
    }
    if (section === undefined) continue;
    const match = line.match(DEPENDENCY);
    if (!match) throw new LockfileError(`cannot parse unfamiliar bun.lock dependency line: ${line.trim()}`);
    found.push({ section, name: parseJsonString(match[1]!), specifier: match[2]!, index });
  }
  return found;
}

/** The `[start, end)` lines a section occupies, or undefined when absent. */
export function sectionRange(block: BunBlock, section: BunSection): { start: number; end: number } | undefined {
  const start = block.workspaceLines.findIndex((line) => sectionName(line) === section);
  if (start < 0) return undefined;
  const end = block.workspaceLines.indexOf(SECTION_CLOSE, start + 1);
  if (end < 0) throw new LockfileError(`bun.lock ${section} map is not closed`);
  return { start, end: end + 1 };
}

/** Where a section that is absent has to be opened to keep bun's order. */
export function sectionInsertion(block: BunBlock, section: BunSection): number {
  const following = BUN_SECTIONS.slice(BUN_SECTIONS.indexOf(section) + 1)
    .map((candidate) => sectionRange(block, candidate)?.start)
    .find((index): index is number => index !== undefined);
  return following ?? block.workspaceLines.length - 1;
}

export function dependencyLine(name: string, specifier: string): string {
  return `        ${jsonString(name)}: ${jsonString(specifier)},`;
}

export function sectionLines(section: BunSection, entries: readonly (readonly [string, string])[]): string[] {
  return [`      ${jsonString(section)}: {`, ...entries.map(([name, specifier]) => dependencyLine(name, specifier)), SECTION_CLOSE];
}

function sectionName(line: string): BunSection | undefined {
  const match = line.match(SECTION_OPEN);
  if (!match) return undefined;
  const name = parseJsonString(match[1]!);
  return (BUN_SECTIONS as readonly string[]).includes(name) ? (name as BunSection) : undefined;
}

/**
 * Refuse a workspace entry whose shape this module cannot edit.
 *
 * The failure being refused is silent: an unrecognised 6-space line inside the
 * entry (a field bun added, or a hand edit) would otherwise be counted as part
 * of whichever section preceded it and moved, duplicated, or dropped by a
 * splice that believed it understood the block.
 */
function assertWorkspaceEntry(lines: readonly string[]): void {
  if (!ENTRY_OPEN.test(lines[0] ?? "")) throw new LockfileError(`cannot parse bun.lock workspace entry: ${(lines[0] ?? "").trim()}`);
  if (lines[lines.length - 1] !== ENTRY_CLOSE) throw new LockfileError("bun.lock workspace entry is not closed");
  let inSection = false;
  for (const line of lines.slice(1, -1)) {
    if (inSection) {
      if (line === SECTION_CLOSE) inSection = false;
      else if (!DEPENDENCY.test(line)) throw new LockfileError(`cannot parse unfamiliar bun.lock dependency line: ${line.trim()}`);
      continue;
    }
    if (sectionName(line) !== undefined) inSection = true;
    else if (!SCALAR_FIELD.test(line)) throw new LockfileError(`cannot parse unfamiliar bun.lock workspace field: ${line.trim()}`);
  }
  if (inSection) throw new LockfileError("bun.lock dependency map is not closed");
}
