/**
 * Composite importer splices against `bun.lock`.
 *
 * Every operation here moves both halves of a bun importer at once — the
 * `workspaces` entry and the `packages` workspace-link entry — and keeps each
 * region in the order bun writes it. Splicing one half was the defect this
 * shape exists to make impossible: a lockfile carrying a `workspaces` entry
 * with no `packages` entry behind it regenerates with the entry restored, so
 * the round-trip check fails on a file that looked complete.
 */

import { parseBlock } from "./bun-block.ts";
import { entryName, importerKey, packageEntry, packageInsertion, parseBunLock, type ParsedBunLock, workspaceEntry, workspaceInsertion } from "./bun-lock.ts";
import { LockfileError } from "./lockfile-error.ts";

export function importerBlock(lockfileText: string, packageRoot: string): string | undefined {
  const parsed = parseBunLock(lockfileText);
  const workspace = workspaceEntry(parsed, packageRoot);
  if (!workspace) return undefined;
  const name = entryName(parsed, workspace.start, workspace.end);
  const linked = name === undefined ? undefined : packageEntry(parsed, name);
  const lines = [...parsed.lines.slice(workspace.start, workspace.end), ...(linked ? [parsed.lines[linked.start]!] : [])];
  return `${lines.join("\n")}\n\n`;
}

/**
 * Whether a standalone block is keyed by `packageRoot`.
 *
 * A substring test would be wrong here in both directions: `libs/chart` occurs
 * inside the block's own workspace link, and the root's key is `""`, which
 * occurs in every block ever written. So this reads the key.
 */
export function blockDeclaresImporter(block: string, packageRoot: string): boolean {
  const first = block.split("\n")[0] ?? "";
  const match = first.match(/^ {4}("(?:[^"\\]|\\.)*"): \{$/u);
  return match !== null && (JSON.parse(match[1]!) as string) === importerKey(packageRoot);
}

export function insertImporter(lockfileText: string, packageRoot: string, block: string): string {
  const parsed = parseBunLock(lockfileText);
  if (workspaceEntry(parsed, packageRoot)) return lockfileText;
  const parsedBlock = parseBlock(block);
  const lines = [...parsed.lines];
  lines.splice(workspaceInsertion(parsed, importerKey(packageRoot)), 0, ...parsedBlock.workspaceLines);
  if (parsedBlock.packageLine === undefined) return lines.join("\n");
  return insertPackageLine(lines.join("\n"), parsedBlock.packageLine);
}

export function replaceImporter(lockfileText: string, packageRoot: string, block: string): string {
  const parsed = parseBunLock(lockfileText);
  const workspace = workspaceEntry(parsed, packageRoot);
  if (!workspace) throw new LockfileError(`bun.lock has no importer block to replace for ${packageRoot}`);
  const previousName = entryName(parsed, workspace.start, workspace.end);
  const parsedBlock = parseBlock(block);
  const lines = [...parsed.lines];
  lines.splice(workspace.start, workspace.end - workspace.start, ...parsedBlock.workspaceLines);
  const text = lines.join("\n");
  if (parsedBlock.packageLine === undefined) return text;
  const existing = previousName === undefined ? undefined : packageEntry(parseBunLock(text), previousName);
  if (existing && packageKey(parsedBlock.packageLine) === previousName) {
    const replaced = text.split("\n");
    replaced[existing.start] = parsedBlock.packageLine;
    return replaced.join("\n");
  }
  const pruned = existing ? removeEntry(text.split("\n"), existing.start, existing.end).join("\n") : text;
  return insertPackageLine(pruned, parsedBlock.packageLine);
}

export function deleteImporter(lockfileText: string, packageRoot: string): string {
  const parsed = parseBunLock(lockfileText);
  const workspace = workspaceEntry(parsed, packageRoot);
  if (!workspace) throw new LockfileError(`bun.lock has no importer block to delete for ${packageRoot}`);
  const name = entryName(parsed, workspace.start, workspace.end);
  const linked = name === undefined ? undefined : packageEntry(parsed, name);
  let lines = [...parsed.lines];
  // Highest line first, so the second splice is not reading shifted indices.
  const ranges = [{ start: workspace.start, end: workspace.end }, ...(linked ? [{ start: linked.start, end: linked.end }] : [])].toSorted(
    (left, right) => right.start - left.start,
  );
  for (const range of ranges) lines = removeEntry(lines, range.start, range.end);
  return lines.join("\n");
}

/** Every dependency an importer names that no `packages` key resolves.
 *
 * bun's `packages` keys are name chains rather than `name@version` ids, so this
 * is an *existence* check and cannot be more: the file carries no second copy
 * of the requested range to compare a resolution against, and this module
 * refuses to run semver. The incompleteness the pnpm adapter finds by
 * comparing versions is, for bun, found by the regenerate-and-compare half of
 * the verification instead — a `workspaces` entry whose range no longer matches
 * its resolution makes `bun install --lockfile-only` rewrite the `packages`
 * entry, and the rewritten bytes differ.
 *
 * Only the sections bun always resolves are checked. An `optionalDependencies`
 * or `peerDependencies` entry can legitimately have no `packages` key — the
 * platform excluded it, or a peer went unmet — and reporting those would make
 * every finding here noise.
 */
export function missingResolutions(lockfileText: string): readonly string[] {
  const parsed = parseBunLock(lockfileText);
  const resolved = new Set((parsed.packages?.entries ?? []).map((entry) => entry.key));
  if (resolved.size === 0) return [];
  return parsed.workspaces.entries.flatMap((entry) => {
    const owner = entry.key === "" ? "." : entry.key;
    const scope = entryName(parsed, entry.start, entry.end);
    return requiredDependencies(parsed, entry.start, entry.end)
      .filter(([name]) => !resolved.has(name) && !(scope !== undefined && resolved.has(`${scope}/${name}`)))
      .map(([name, specifier]) => `${owner} declares ${name}@${specifier}, and the lockfile has no packages entry for it`);
  });
}

function insertPackageLine(lockfileText: string, packageLine: string): string {
  const parsed = parseBunLock(lockfileText);
  if (!parsed.packages) throw new LockfileError("bun.lock has no packages section to register the workspace link in");
  const insertion = packageInsertion(parsed.packages, packageKey(packageLine));
  const lines = [...parsed.lines];
  lines.splice(insertion.index, 0, ...(insertion.blankBefore ? ["", packageLine] : [packageLine, ""]));
  return lines.join("\n");
}

function packageKey(packageLine: string): string {
  const key = packageLine.match(/^ {4}("(?:[^"\\]|\\.)*"):/u)?.[1];
  if (key === undefined) throw new LockfileError(`cannot parse the bun.lock packages entry: ${packageLine.trim()}`);
  return JSON.parse(key) as string;
}

/**
 * Remove `[start, end)` and the blank line that separated it from a neighbour.
 *
 * `packages` entries are blank-line separated and `workspaces` entries are not,
 * so this takes the separator only when one is actually adjacent — removing a
 * line that was never a separator would close a gap bun re-opens.
 */
function removeEntry(lines: readonly string[], start: number, end: number): string[] {
  const next = [...lines];
  if ((next[end] ?? "").trim() === "" && end < next.length - 1) next.splice(start, end - start + 1);
  else if (start > 0 && (next[start - 1] ?? "").trim() === "") next.splice(start - 1, end - start + 1);
  else next.splice(start, end - start);
  return next;
}

function requiredDependencies(parsed: ParsedBunLock, start: number, end: number): [string, string][] {
  const found: [string, string][] = [];
  let inRequired = false;
  for (let index = start + 1; index < end; index += 1) {
    const line = parsed.lines[index]!;
    const section = line.match(/^ {6}"(\w+)": \{$/u)?.[1];
    if (section) inRequired = section === "dependencies" || section === "devDependencies";
    if (!inRequired) continue;
    const match = line.match(/^ {8}("(?:[^"\\]|\\.)*"): "((?:[^"\\]|\\.)*)",$/u);
    if (match) found.push([JSON.parse(match[1]!) as string, match[2]!]);
  }
  return found;
}
