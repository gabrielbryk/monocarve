/** Byte-stable bun importer rendering and dependency wiring. */

import {
  type BunBlock,
  type BunSection,
  blockDependencies,
  dependencyLine,
  ENTRY_CLOSE,
  parseBlock,
  sectionInsertion,
  sectionLines,
  sectionRange,
  serializeBlock,
} from "./bun-block.ts";
import { entryName, importerKey, jsonString, parseBunLock, ROOT_IMPORTER_KEY, workspaceEntry } from "./bun-lock.ts";
import { LockfileError } from "./lockfile-error.ts";
import type { ConsumerDependencySection, RenderImporterInput } from "./types.ts";

/**
 * The composite block for a package, rendered from its manifest.
 *
 * bun mirrors the manifest's declared ranges into `workspaces` verbatim — there
 * is no resolved-version column to fill in, which is why this takes no
 * resolution out of `lockfileText` the way the pnpm renderer must. What it does
 * need, and what `RenderImporterInput` historically did not carry, is the
 * package's own name and version: they are two of the fields bun writes, and
 * the `packages` entry is keyed by the name. `lockfileText` is still read, for
 * one field only — see `nameField`, which mirrors the root entry's identity
 * rather than the manifest's.
 *
 * The result deliberately has no trailing newline. The planner appends the
 * `\n\n` separator, which makes what it stores byte-identical to what
 * `importerBlock` reads back out of the spliced file.
 */
export function renderImporterBlock(input: RenderImporterInput): string {
  const key = importerKey(input.packageRoot);
  const workspaceLines = [
    `    ${jsonString(key)}: {`,
    ...nameField(key, input),
    ...versionField(key, input.packageVersion),
    ...renderSections(input),
    ENTRY_CLOSE,
  ];
  return serializeBlock({ workspaceLines, packageLine: packageLine(key, input) }).replace(/\n+$/u, "");
}

export function addBlockDependency(
  block: string,
  name: string,
  specifier: string,
  _version: string,
  requestedSection: ConsumerDependencySection = "runtime",
): string {
  const parsed = parseBlock(block);
  const target: BunSection = requestedSection === "runtime" ? "dependencies" : "devDependencies";
  const lines = [...parsed.workspaceLines];
  if (removeConflicting(lines, name, specifier, target)) return serializeBlock(parsed);
  insertDependency(lines, target, name, specifier);
  return serializeBlock({ ...parsed, workspaceLines: lines });
}

export function addBlockDependencies(block: string, input: RenderImporterInput): string {
  let next = block;
  const declared: readonly (readonly [ConsumerDependencySection, Readonly<Record<string, string>>])[] = [
    ["runtime", input.dependencies],
    ["dev", input.devDependencies],
  ];
  for (const [section, dependencies] of declared) {
    for (const name of Object.keys(dependencies).toSorted()) next = addBlockDependency(next, name, dependencies[name]!, "", section);
  }
  return next;
}

/**
 * Remove one dependency from the block's `workspaces` half.
 *
 * The `packages` half is deliberately untouched. Pruning the last reference to
 * an external package leaves its resolution entry behind, exactly as the pnpm
 * adapter leaves an orphaned snapshot behind, and for the same reason: deciding
 * that nothing else needs it means walking every resolution chain in the file,
 * which is resolution work this module does not do. The orphan is a byte
 * divergence, so the regenerate-and-compare verification is what reports it.
 */
export function removeBlockDependency(block: string, name: string): string {
  const parsed = parseBlock(block);
  const matches = blockDependencies(parsed).filter((entry) => entry.name === name);
  if (matches.length === 0) return serializeBlock(parsed);
  if (matches.length > 1) throw new LockfileError(`cannot prune ${name}: importer declares it in more than one dependency section`);
  const lines = [...parsed.workspaceLines];
  const existing = matches[0]!;
  lines.splice(existing.index, 1);
  removeEmptySection(lines, existing.section);
  return serializeBlock({ ...parsed, workspaceLines: lines });
}

/**
 * The root entry's `name`, which the *lockfile* decides rather than the manifest.
 *
 * Measured against bun 1.3.14, not inferred. When bun creates a `workspaces`
 * entry it writes `name` for every package that declares one, root included.
 * When it updates an entry that already exists it rewrites the dependency
 * sections and leaves the identity fields exactly as it found them — so a root
 * entry that reached the file without a `name` never gains one, no matter how
 * many installs follow. Both halves were reproduced directly: deleting a real
 * repository's `bun.lock` and regenerating it produced `"name": "agent-html"`,
 * while adding a dependency to that same repository with its shipped lockfile
 * in place rewrote the entry and left the `name` absent.
 *
 * So the root is rendered to match the lockfile in front of us: this adapter
 * only ever splices into an existing file, and requiring the manifest's name
 * there would demand a byte bun itself will never write back. Every other
 * member is unconditional — bun always writes their `name`, and the key of
 * their `packages` link is that name.
 *
 * A lockfile with no root entry at all is a creation, which is the one case
 * where bun does write the name from the manifest.
 */
function nameField(key: string, input: RenderImporterInput): string[] {
  if (key === ROOT_IMPORTER_KEY && !rootEntryDeclaresName(input.lockfileText)) return [];
  return [`      ${jsonString("name")}: ${jsonString(requireName(input))},`];
}

function rootEntryDeclaresName(lockfileText: string): boolean {
  let parsed: ReturnType<typeof parseBunLock>;
  try {
    parsed = parseBunLock(lockfileText);
  } catch {
    // No readable lockfile to mirror — treat it as a creation, which is what
    // the caller is doing if it is rendering against nothing.
    return true;
  }
  const entry = workspaceEntry(parsed, ROOT_IMPORTER_KEY);
  return entry === undefined || entryName(parsed, entry.start, entry.end) !== undefined;
}

function requireName(input: RenderImporterInput): string {
  const name = input.packageName;
  if (name === undefined || name === "") {
    throw new LockfileError(`cannot render a bun.lock importer for ${input.packageRoot} without its package name`);
  }
  return name;
}

/**
 * bun omits `version` from the root entry even when the root manifest declares
 * one, and writes it for every other member. Rendering it either way round
 * produces a file the next install rewrites.
 */
function versionField(key: string, version: string | undefined): string[] {
  if (key === ROOT_IMPORTER_KEY || version === undefined || version === "") return [];
  return [`      ${jsonString("version")}: ${jsonString(version)},`];
}

/** The workspace root has no `packages` entry; every other member has one. */
function packageLine(key: string, input: RenderImporterInput): string | undefined {
  if (key === ROOT_IMPORTER_KEY) return undefined;
  const name = requireName(input);
  return `    ${jsonString(name)}: [${jsonString(`${name}@workspace:${key}`)}],`;
}

function renderSections(input: RenderImporterInput): string[] {
  const declared: readonly (readonly [BunSection, Readonly<Record<string, string>>])[] = [
    ["dependencies", input.dependencies],
    ["devDependencies", input.devDependencies],
    ["optionalDependencies", input.optionalDependencies ?? {}],
  ];
  return declared.flatMap(([section, values]) => {
    const names = Object.keys(values).toSorted();
    return names.length === 0
      ? []
      : sectionLines(
          section,
          names.map((name) => [name, values[name]!] as const),
        );
  });
}

/**
 * Drop an existing declaration that stands in the way, reporting whether the
 * block already says what was asked for.
 *
 * `true` means "nothing to do". Otherwise `lines` is left ready for the
 * insertion: a declaration in the other editable section is removed so the
 * dependency moves rather than being declared twice, while an optional or peer
 * declaration is a refusal rather than a promotion — bun resolves those under
 * different rules, and silently rewriting one would change what installs.
 */
function removeConflicting(lines: string[], name: string, specifier: string, target: BunSection): boolean {
  const matches = blockDependencies(asBlock(lines)).filter((entry) => entry.name === name);
  for (const section of ["optionalDependencies", "peerDependencies"] as const) {
    if (matches.some((entry) => entry.section === section)) throw new LockfileError(`cannot wire ${name}: importer declares it in ${section}`);
  }
  if (matches.length > 1) throw new LockfileError(`cannot wire ${name}: importer declares it in more than one dependency section`);
  const existing = matches[0];
  if (!existing) return false;
  if (existing.section === target && existing.specifier === specifier) return true;
  lines.splice(existing.index, 1);
  removeEmptySection(lines, existing.section);
  return false;
}

function removeEmptySection(lines: string[], section: BunSection): void {
  const range = sectionRange(asBlock(lines), section);
  if (range && range.end - range.start === 2) lines.splice(range.start, 2);
}

function insertDependency(lines: string[], target: BunSection, name: string, specifier: string): void {
  const range = sectionRange(asBlock(lines), target);
  if (!range) {
    lines.splice(sectionInsertion(asBlock(lines), target), 0, ...sectionLines(target, [[name, specifier]]));
    return;
  }
  const existing = blockDependencies(asBlock(lines)).filter((entry) => entry.section === target);
  const following = existing.find((entry) => name < entry.name);
  lines.splice(following?.index ?? range.end - 1, 0, dependencyLine(name, specifier));
}

function asBlock(workspaceLines: readonly string[]): BunBlock {
  return { workspaceLines, packageLine: undefined };
}
