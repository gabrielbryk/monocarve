/** Path-reference rewrites for a retired existing-package boundary: config, scripts, and docs that name the shim by path. */
import { readdirSync, statSync } from "node:fs";
import { extname, relative, resolve } from "node:path";

import ts from "typescript";

import type { MonocarveConfig } from "../config.ts";
import { PlanningError } from "../plan/context.ts";
import { rewritePathReferenceText, scanPathReferenceRewrites } from "../plan/path-reference-rewrites.ts";
import { showBaseline } from "../util/git.ts";
import { hashText } from "../util/hash.ts";
import type { ResolvedBoundary } from "./boundary-resolve.ts";
import { baselineFileMode } from "./build-shared.ts";
import type { PreparationReplayOperation } from "./manifest-types.ts";

type PathMove = { readonly source: string; readonly target: string };
type ScanSettings = Parameters<typeof scanPathReferenceRewrites>[3];

export function planRetiredBoundaryPathReferences(
  rootDir: string,
  config: MonocarveConfig,
  boundary: Extract<ResolvedBoundary, { strategy: "existing-package" }>,
  baselineCommit: string,
  compilerOptions: ts.CompilerOptions,
): PreparationReplayOperation[] {
  const settings = config.pathReferenceRewrites;
  if (!settings.enabled || settings.roots.length === 0) return [];
  const resolved = ts.resolveModuleName(boundary.replacementSpecifier, resolve(rootDir, boundary.retained), compilerOptions, ts.sys).resolvedModule
    ?.resolvedFileName;
  if (!resolved) throw new PlanningError(`boundary ${boundary.id} replacement ${boundary.replacementSpecifier} does not resolve to a workspace path`);
  const target = relative(rootDir, resolved).replaceAll("\\", "/");
  const moves = [{ source: boundary.retained, target }];
  const scanSettings = { onAmbiguousMatch: settings.onAmbiguousMatch, matchExtensionless: settings.matchExtensionless, minSegments: settings.minSegments };
  const operations: PreparationReplayOperation[] = [];
  for (const root of settings.roots) {
    for (const absolute of boundaryReferenceFiles(resolve(rootDir, root.root), root.extensions).toSorted()) {
      if ((statSync(absolute, { throwIfNoEntry: false })?.size ?? 0) > settings.maxBytes) continue;
      const operation = pathReferenceRewrite(rootDir, baselineCommit, relative(rootDir, absolute).replaceAll("\\", "/"), moves, scanSettings);
      if (operation) operations.push(operation);
    }
  }
  return operations;
}

/** One baseline file's rewritten path references, or nothing when it names no moved path. */
function pathReferenceRewrite(
  rootDir: string,
  baselineCommit: string,
  path: string,
  moves: readonly PathMove[],
  scanSettings: ScanSettings,
): PreparationReplayOperation | undefined {
  const text = showBaseline(rootDir, baselineCommit, path);
  if (text === null) return undefined;
  const scan = scanPathReferenceRewrites(text, path, moves, scanSettings);
  if (scan.rewrites.length === 0) return undefined;
  const contents = rewritePathReferenceText(text, scan.rewrites);
  return {
    kind: "write-file",
    purpose: "wiring",
    file: {
      path,
      preconditionHash: hashText(text),
      preconditionMode: baselineFileMode(rootDir, baselineCommit, path),
      resultHash: hashText(contents),
      resultMode: baselineFileMode(rootDir, baselineCommit, path),
    },
    contents,
  };
}

function boundaryReferenceFiles(directory: string, extensions: readonly string[]): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return boundaryReferenceFiles(path, extensions);
    return extensions.includes(extname(entry.name)) ? [path] : [];
  });
}
