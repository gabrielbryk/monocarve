import { lstatSync, readFileSync, readdirSync, type Dirent } from "node:fs";
import { resolve } from "node:path";

import { byCodeUnit } from "../util/hash.ts";
import { validateBundle } from "./evidence.ts";

/** Discover complete evidence bundles without unbounded filesystem walking. */
export function discoverValidatedEvidenceRoots(rootDir: string, analyticalRoots: readonly string[], inside: (root: string, path: string) => boolean): string[] {
  const context: EvidenceDiscoveryContext = { analyticalRoots, discovered: [], visitedDirectories: 0, maxDepth: 8, maxDirectories: 4096, inside };
  visitValidatedEvidenceDirectory(rootDir, 0, context);
  return context.discovered.sort(byCodeUnit);
}

interface EvidenceDiscoveryContext {
  readonly analyticalRoots: readonly string[];
  readonly discovered: string[];
  readonly maxDepth: number;
  readonly maxDirectories: number;
  readonly inside: (root: string, path: string) => boolean;
  visitedDirectories: number;
}

function visitValidatedEvidenceDirectory(directory: string, depth: number, context: EvidenceDiscoveryContext): void {
  if (depth > context.maxDepth || context.visitedDirectories >= context.maxDirectories) return;
  const stat = lstatSync(directory, { throwIfNoEntry: false });
  if (!stat?.isDirectory() || stat.isSymbolicLink()) return;
  context.visitedDirectories += 1;
  const manifest = resolve(directory, "manifest.json");
  if (lstatSync(manifest, { throwIfNoEntry: false })?.isFile() && isValidatedEvidenceBundle(directory)) {
    if (!context.analyticalRoots.some((root) => context.inside(root, directory) || context.inside(directory, root))) context.discovered.push(directory);
    return;
  }
  let entries: Dirent[];
  try { entries = readdirSync(directory, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries.sort((left, right) => byCodeUnit(left.name, right.name))) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    if (entry.isDirectory() && !entry.isSymbolicLink()) visitValidatedEvidenceDirectory(resolve(directory, entry.name), depth + 1, context);
  }
}

function isValidatedEvidenceBundle(directory: string): boolean {
  try {
    validateBundle(directory);
    const value = JSON.parse(readFileSync(resolve(directory, "manifest.json"), "utf8")) as { kind?: unknown };
    return value.kind === "architecture-assessment" || value.kind === "declaration-analysis-batch";
  } catch {
    return false;
  }
}
