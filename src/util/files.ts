/** Filesystem walking and source-file classification. */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { DEFAULT_SOURCE_EXTENSIONS } from "../config/source-policy.ts";
import { hashBytes, MISSING, type FileState } from "./hash.ts";

/** Extensions the engine treats as TypeScript/JavaScript modules. */
export const SOURCE_EXTENSIONS = DEFAULT_SOURCE_EXTENSIONS;

/** True for anything the module graph can contain as a node. */
export function isSourceModulePath(path: string, extensions: readonly string[] = SOURCE_EXTENSIONS): boolean {
  return extensions.some((extension) => path.endsWith(extension));
}

export function isDeclarationPath(path: string): boolean {
  return path.endsWith(".d.ts");
}

/**
 * Every source module under `directory`, absolute, recursively, in ascending
 * lexical order.
 *
 * The sort is load-bearing, not cosmetic. `readdirSync` returns the order the
 * filesystem stores entries in — hash order on ext4 and tmpfs — so an unsorted
 * walk makes the result a fact about the machine rather than about the tree, and
 * anything derived from it (plan intermediates, audit inventories) inherits that.
 * Sorting here means no caller has to remember to.
 */
export function sourceFiles(
  directory: string,
  skip: ReadonlySet<string> = new Set(["node_modules"]),
  extensions: readonly string[] = SOURCE_EXTENSIONS,
): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return skip.has(entry.name) ? [] : sourceFiles(path, skip, extensions);
      return isSourceModulePath(entry.name, extensions) ? [path] : [];
    })
    .toSorted();
}

/** Physical line count, matching what a reviewer sees. Missing files count zero. */
export function lineCount(absolute: string): number {
  if (!existsSync(absolute)) return 0;
  return Math.max(0, readFileSync(absolute, "utf8").split("\n").length - 1);
}

/** Hash of a file's bytes, or {@link MISSING} when it does not exist. */
export function fileState(absolute: string): FileState {
  return existsSync(absolute) ? hashBytes(readFileSync(absolute)) : MISSING;
}

export function isFile(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isFile() === true;
}

export function isDirectory(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
}
