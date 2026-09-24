/**
 * The configured CLI import-extension check.
 *
 * Enforces explicit file extensions on relative specifiers inside workspace
 * packages.
 *
 * Why this is a check and not a lint rule: published-quality resolution
 * (NodeNext) requires `./x.ts`, while the bundler-style resolution most
 * applications typecheck with silently accepts `./x`. Extensionless specifiers
 * therefore accumulate unnoticed inside packages and only surface later — as
 * failures in the extraction tooling's stricter gate, at the least convenient
 * moment. Making them visible year-round is much cheaper than discovering a
 * hundred of them mid-extraction.
 *
 * It is scoped to `packageRoots` because that is where the strict resolution
 * applies; applications are free to use whatever their bundler accepts.
 */

import { readFileSync, readdirSync } from "node:fs";
import { extname, resolve } from "node:path";

import { inventoryModuleReferences } from "../codemod/imports.ts";
import type { MonocarveConfig } from "../config.ts";
import { byCodeUnit } from "../util/hash.ts";
import { relativePosix } from "../util/paths.ts";

interface ExtensionViolation {
  readonly file: string;
  readonly line: number;
  readonly specifier: string;
}

export interface ExtensionCheckResult {
  readonly filesChecked: number;
  readonly violations: readonly ExtensionViolation[];
}

const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "build", ".turbo"]);

function walk(directory: string, extensions: ReadonlySet<string>): string[] {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return SKIPPED_DIRECTORIES.has(entry.name) ? [] : walk(path, extensions);
    if (entry.name.endsWith(".d.ts")) return [];
    return extensions.has(extname(entry.name)) ? [path] : [];
  });
}

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

/**
 * A reference's offsets span the whole declaration, which can start lines above
 * the specifier itself. Locating the quoted literal inside that span is what
 * makes the reported line point at the import the reader has to fix.
 */
function specifierOffset(source: string, start: number, end: number, specifier: string): number {
  const window = source.slice(start, end);
  const candidates = [`"${specifier}"`, `'${specifier}'`].map((quoted) => window.indexOf(quoted)).filter((index) => index >= 0);
  if (candidates.length === 0) return start;
  return start + Math.min(...candidates) + 1;
}

export function checkImportExtensions(config: MonocarveConfig, rootDir: string): ExtensionCheckResult {
  const approved = [...config.sourceExtensions, ...config.assetExtensions];
  const checked = new Set(config.sourceExtensions);
  const files = config.packageRoots.flatMap((root) => walk(resolve(rootDir, root), checked));

  const violations = files
    .flatMap((path): ExtensionViolation[] => {
      const source = readFileSync(path, "utf8");
      return inventoryModuleReferences(source, path, false, rootDir, config.moduleSpecifierCalls).flatMap((reference) => {
        const specifier = reference.specifier;
        if (!specifier || !specifier.startsWith(".")) return [];
        if (approved.some((extension) => specifier.endsWith(extension))) return [];
        return [{ file: relativePosix(rootDir, path), line: lineAt(source, specifierOffset(source, reference.start, reference.end, specifier)), specifier }];
      });
    })
    .toSorted((left, right) => byCodeUnit(left.file, right.file) || left.line - right.line);

  return { filesChecked: files.length, violations };
}

/** Human-readable report. Returns the text and whether the check passed. */
export function formatExtensionReport(result: ExtensionCheckResult): string {
  if (result.violations.length === 0) {
    return `import-extensions: clean (${result.filesChecked} files checked).`;
  }
  const lines = [
    `import-extensions: ${result.violations.length} relative specifier(s) missing an explicit extension:`,
    "",
    ...result.violations.map((violation) => `  ${violation.file}:${violation.line} -> ${JSON.stringify(violation.specifier)}`),
    "",
    "NodeNext resolution requires an explicit extension on every relative specifier.",
    'Append the real target\'s extension: "./foo" -> "./foo.ts", or "./foo" -> "./foo/index.ts".',
  ];
  return lines.join("\n");
}
