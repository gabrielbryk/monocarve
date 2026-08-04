/** Byte-stable pnpm importer block rendering and dependency wiring. */

import { LockfileError } from "./pnpm-error.ts";
import {
  blockDependencies,
  DEPENDENCY_SECTIONS,
  EMPTY_MAP,
  IMPORTER_KEY,
  pnpmSection,
  type PnpmDependencySection,
  yamlKey,
  yamlValue,
} from "./pnpm-importers.ts";
import { dependencyVersion } from "./pnpm-resolutions.ts";
import type { ConsumerDependencySection, RenderImporterInput } from "./types.ts";

export function renderImporterBlock(input: RenderImporterInput, linkVersion: (from: string, to: string) => string): string {
  const sections = importerSections(input, linkVersion);
  return sections.length === 0 ? `  ${input.packageRoot}: ${EMPTY_MAP}` : [`  ${input.packageRoot}:`, ...sections].join("\n");
}

function importerSections(input: RenderImporterInput, linkVersion: (from: string, to: string) => string): string[] {
  const sections: readonly [string, Readonly<Record<string, string>>][] = [
    ["dependencies", input.dependencies],
    ["devDependencies", input.devDependencies],
    ["optionalDependencies", input.optionalDependencies ?? {}],
  ];
  return sections
    .map(([section, values]) => renderSection(section, values, input, linkVersion))
    .filter((section): section is string => section !== undefined);
}

function renderSection(
  section: string,
  values: Readonly<Record<string, string>>,
  input: RenderImporterInput,
  linkVersion: (from: string, to: string) => string,
): string | undefined {
  const names = Object.keys(values).sort();
  if (names.length === 0) return undefined;
  const lines = [`    ${section}:`];
  for (const name of names) lines.push(...renderDependency(name, values[name]!, input, linkVersion));
  return lines.join("\n");
}

function renderDependency(
  name: string,
  specifier: string,
  input: RenderImporterInput,
  linkVersion: (from: string, to: string) => string,
): string[] {
  const version = specifier.startsWith("workspace:") ? workspaceVersion(name, input, linkVersion) : dependencyVersion(input.lockfileText, name, specifier);
  return [`      ${yamlKey(name)}:`, `        specifier: ${yamlValue(specifier)}`, `        version: ${version}`];
}

function workspaceVersion(name: string, input: RenderImporterInput, linkVersion: (from: string, to: string) => string): string {
  const owner = input.workspaceRoots[name];
  if (!owner) throw new LockfileError(`workspace dependency has no package reference: ${name}`);
  return linkVersion(input.packageRoot, owner);
}

export function addBlockDependency(
  block: string,
  name: string,
  specifier: string,
  version: string,
  requestedSection: ConsumerDependencySection = "runtime",
): string {
  const lines = expandableLines(block);
  const target = pnpmSection(requestedSection);
  if (removeConflictingDependency(lines, name, target)) return block;
  insertDependency(lines, target, dependencyEntry(name, specifier, version));
  return `${lines.join("\n")}\n`;
}

export function addBlockDependencies(
  block: string,
  input: RenderImporterInput,
  linkVersion: (from: string, to: string) => string,
): string {
  let next = block;
  const sections: readonly [ConsumerDependencySection, Readonly<Record<string, string>>][] = [
    ["runtime", input.dependencies],
    ["dev", input.devDependencies],
  ];
  for (const [section, dependencies] of sections) {
    for (const name of Object.keys(dependencies).sort()) {
      const specifier = dependencies[name]!;
      if (blockHasSpecifier(next, name, specifier, section)) continue;
      const version = specifier.startsWith("workspace:")
        ? workspaceVersion(name, input, linkVersion)
        : dependencyVersion(input.lockfileText, name, specifier);
      next = addBlockDependency(next, name, specifier, version, section);
    }
  }
  return next;
}

function blockHasSpecifier(block: string, name: string, specifier: string, section: ConsumerDependencySection): boolean {
  const lines = expandableLines(block);
  const dependency = blockDependencies(lines).find((entry) => entry.name === name && entry.section === pnpmSection(section));
  if (!dependency) return false;
  return lines.slice(dependency.start + 1, dependency.end)
    .some((line) => line.match(/^ {8}specifier:\s*(.+)$/)?.[1]?.replace(/^['"]|['"]$/g, "") === specifier);
}

export function removeBlockDependency(block: string, name: string): string {
  const lines = expandableLines(block);
  const dependencies = blockDependencies(lines).filter((dependency) => dependency.name === name);
  if (dependencies.length === 0) return block;
  if (dependencies.length > 1) throw new LockfileError(`cannot prune ${name}: importer declares it in more than one dependency section`);
  const existing = dependencies[0]!;
  lines.splice(existing.start, existing.end - existing.start);
  removeEmptySection(lines, existing.section);
  const remaining = lines.slice(1).some((line) => line.trim() !== "");
  return remaining ? `${lines.join("\n")}\n` : `${lines[0]!.replace(/:\s*$/u, ": {}")}\n\n`;
}

function expandableLines(block: string): string[] {
  const lines = block.replace(/\n$/, "").split("\n");
  const inline = lines[0]?.match(IMPORTER_KEY);
  if (inline?.[2] === undefined) return lines;
  if (inline[2] !== EMPTY_MAP) throw new LockfileError(`cannot expand an inline importer that is not empty: ${lines[0]!.trim()}`);
  lines[0] = `  ${inline[1]!}:`;
  return lines;
}

function removeConflictingDependency(lines: string[], name: string, target: PnpmDependencySection): boolean {
  const dependencies = blockDependencies(lines).filter((dependency) => dependency.name === name);
  if (dependencies.some((dependency) => dependency.section === "optionalDependencies")) {
    throw new LockfileError(`cannot wire ${name}: importer declares it in optionalDependencies`);
  }
  if (dependencies.length > 1) throw new LockfileError(`cannot wire ${name}: importer declares it in more than one dependency section`);
  const existing = dependencies[0];
  if (existing?.section === target) return true;
  if (!existing) return false;
  lines.splice(existing.start, existing.end - existing.start);
  removeEmptySection(lines, existing.section);
  return false;
}

function removeEmptySection(lines: string[], section: PnpmDependencySection): void {
  const header = lines.findIndex((line) => line === `    ${section}:`);
  const next = header < 0 ? "" : (lines[header + 1] ?? "");
  if (header >= 0 && (next === "" || /^ {4}\S/.test(next))) lines.splice(header, 1);
}

function insertDependency(lines: string[], target: PnpmDependencySection, entry: readonly string[]): void {
  const sections = sectionPositions(lines);
  const sectionStart = sections.get(target);
  if (sectionStart === undefined) {
    const insertion = missingSectionInsertion(lines, sections, target);
    lines.splice(insertion, 0, `    ${target}:`, ...entry);
    return;
  }
  lines.splice(dependencyInsertion(lines, sectionStart, entry[0]!), 0, ...entry);
}

function dependencyEntry(name: string, specifier: string, version: string): readonly string[] {
  return [`      ${yamlKey(name)}:`, `        specifier: ${yamlValue(specifier)}`, `        version: ${version}`];
}

function sectionPositions(lines: readonly string[]): Map<PnpmDependencySection, number> {
  const sections = new Map<PnpmDependencySection, number>();
  for (let index = 1; index < lines.length; index += 1) {
    const section = lines[index]?.match(/^    (dependencies|devDependencies|optionalDependencies):$/)?.[1] as PnpmDependencySection | undefined;
    if (section) sections.set(section, index);
  }
  return sections;
}

function missingSectionInsertion(lines: readonly string[], sections: ReadonlyMap<PnpmDependencySection, number>, target: PnpmDependencySection): number {
  const following = DEPENDENCY_SECTIONS.slice(DEPENDENCY_SECTIONS.indexOf(target) + 1)
    .map((section) => sections.get(section))
    .find((index): index is number => index !== undefined);
  const trailingBlank = lines.findIndex((line) => line === "");
  return following ?? (trailingBlank < 0 ? lines.length : trailingBlank);
}

function dependencyInsertion(lines: readonly string[], sectionStart: number, newKey: string): number {
  const name = dependencyName(newKey);
  let cursor = sectionStart + 1;
  for (; cursor < lines.length; cursor += 1) {
    const line = lines[cursor] ?? "";
    if (/^ {4}\S/.test(line) || line.trim().length === 0) break;
    const key = line.match(/^ {6}(?:'([^']+)'|([^:]+)):\s*$/);
    const existing = key?.[1] ?? key?.[2];
    if (existing !== undefined && name < existing) return cursor;
  }
  return cursor;
}

function dependencyName(keyLine: string): string {
  return keyLine.match(/^ {6}(?:'([^']+)'|([^:]+)):/)?.[1] ?? keyLine.match(/^ {6}(?:'([^']+)'|([^:]+)):/)?.[2] ?? "";
}
