import { existsSync, readFileSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";
import ts from "typescript";
import { applyEscapeRewrites, inventoryModuleReferences } from "../codemod/imports.ts";
import type { MonocarveConfig } from "../config.ts";
import { isAnyMove, type DynamicImportDelta, type ExtractionManifest, type MoveOperation, type MoveWithRewriteOperation } from "../plan/manifest.ts";
import { showBaseline } from "../util/git.ts";
import { hashText } from "../util/hash.ts";
import { relativePosix } from "../util/paths.ts";
import { textAt } from "./audit-helpers.ts";

/**
 * A module identity that three different sources can be reduced to and
 * compared: a specifier written in the entrypoint, a specifier written in the
 * *baseline* entrypoint, and a target path the plan declares.
 *
 * Extensionless and lexically normalised, because the same module is written
 * `./widget/widget.ts`, `./widget/widget.js` and `./widget/widget` depending on
 * the configured barrel style, and none of those is more true than the others.
 * Deliberately lexical: it touches no filesystem, so it means the same thing for
 * the baseline blob — whose targets may no longer exist — as for the landed one.
 */
function moduleKey(specifier: string): string {
  return posix.normalize(specifier.replace(/[?#].*$/u, "").replace(/\.[cm]?[jt]sx?$/u, ""));
}
export function entrypointRelativeKey(entrypointRelative: string, target: string): string {
  return moduleKey(posix.relative(posix.dirname(entrypointRelative), target));
}
export function evaluatedModuleKeys(source: string, path: string): Set<string> {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const keys = new Set<string>();
  for (const statement of file.statements) {
    const specifier =
      ts.isImportDeclaration(statement) && statement.importClause?.phaseModifier !== ts.SyntaxKind.TypeKeyword
        ? statement.moduleSpecifier
        : ts.isExportDeclaration(statement) && !statement.isTypeOnly
          ? statement.moduleSpecifier
          : undefined;
    if (specifier && ts.isStringLiteral(specifier) && specifier.text.startsWith(".")) keys.add(moduleKey(specifier.text));
  }
  return keys;
}
export function stillNamesADonor(
  _config: MonocarveConfig,
  rootDir: string,
  absolute: string,
  references: readonly { specifier: string | null }[],
  moves: readonly (MoveOperation | MoveWithRewriteOperation)[],
): boolean {
  return moves.some((move) =>
    references.some((reference) => {
      if (!reference.specifier) return false;
      const expected = relativePosix(dirname(absolute), resolve(rootDir, move.source));
      const normalized = reference.specifier.replace(/^\.\//, "").replace(/\.js$/, ".ts");
      const donorIsIndex = /(?:^|\/)index\.(?:ts|tsx|mts|cts)$/.test(move.source);
      const indexDirectory = donorIsIndex ? expected.replace(/\/?index\.(?:ts|tsx|mts|cts)$/, "") : "";
      return (
        normalized === expected ||
        normalized === expected.replace(/\.(?:ts|tsx|mts|cts)$/, "") ||
        (indexDirectory.length > 0 && normalized === indexDirectory) ||
        (donorIsIndex && indexDirectory.length === 0 && (reference.specifier === "." || reference.specifier === "./"))
      );
    }),
  );
}
export function replayFailure(config: MonocarveConfig, manifest: ExtractionManifest, operation: MoveWithRewriteOperation, rootDir: string): string[] {
  const baseline = showBaseline(rootDir, manifest.baselineCommit, operation.source);
  if (baseline === null || baseline.length === 0) return [`no baseline blob to replay for ${operation.source}`];
  const replayed = applyEscapeRewrites(
    baseline,
    resolve(rootDir, operation.source),
    operation.rewrites,
    rootDir,
    config.moduleSpecifierCalls,
    config.assetExtensions,
    config.cssImportExtensions,
  );
  const landedPath = resolve(rootDir, operation.target);
  if (!existsSync(landedPath)) return [`move-with-rewrite target is missing: ${operation.target}`];
  const landed = readFileSync(landedPath, "utf8");
  return landed !== replayed || hashText(replayed) !== operation.resultHash
    ? [`move-with-rewrite replay proof does not reproduce the landed file: ${operation.target}`]
    : [];
}
function dynamicSignatures(source: string, importer: string, rootDir: string): string[] {
  return inventoryModuleReferences(source, importer, false, rootDir)
    .filter((reference) => reference.dynamic)
    .map((reference) => reference.specifier ?? "<unsupported>")
    .toSorted();
}
function multisetDelta(before: readonly string[], after: readonly string[]): DynamicImportDelta {
  const counts = (values: readonly string[]): Map<string, number> =>
    values.reduce((map, value) => map.set(value, (map.get(value) ?? 0) + 1), new Map<string, number>());
  const left = counts(before);
  const right = counts(after);
  const added: string[] = [];
  const removed: string[] = [];
  for (const [value, count] of right) for (let index = 0; index < Math.max(0, count - (left.get(value) ?? 0)); index += 1) added.push(value);
  for (const [value, count] of left) for (let index = 0; index < Math.max(0, count - (right.get(value) ?? 0)); index += 1) removed.push(value);
  return { added: added.sort(), removed: removed.sort() };
}
export function dynamicImportDelta(manifest: ExtractionManifest, rootDir: string): DynamicImportDelta {
  const before: string[] = [];
  const after: string[] = [];
  for (const operation of manifest.operations) {
    if (
      operation.kind === "lockfile-importer" ||
      operation.kind === "migrate-path-keys" ||
      operation.kind === "rewrite-path-reference" ||
      operation.kind === "delete-file"
    )
      continue;
    if (isAnyMove(operation)) {
      before.push(...dynamicSignatures(showBaseline(rootDir, manifest.baselineCommit, operation.source) ?? "", resolve(rootDir, operation.source), rootDir));
      after.push(...dynamicSignatures(textAt(rootDir, operation.target), resolve(rootDir, operation.target), rootDir));
      continue;
    }
    const path = operation.kind === "write-file" ? operation.path : operation.file;
    before.push(...dynamicSignatures(showBaseline(rootDir, manifest.baselineCommit, path) ?? "", resolve(rootDir, path), rootDir));
    after.push(...dynamicSignatures(textAt(rootDir, path), resolve(rootDir, path), rootDir));
  }
  return multisetDelta(before, after);
}
