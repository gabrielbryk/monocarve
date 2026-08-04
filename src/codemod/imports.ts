/**
 * The one place module specifiers are read and rewritten.
 *
 * Everything downstream — containment analysis, consumer discovery, the
 * `rewrite-import` and `move-with-rewrite` operations, and the audit's replay
 * proof — goes through this module, and that is deliberate: the replay proof is
 * only evidence if the codemod that produced a file is byte-for-byte the same
 * function the audit re-runs against the baseline blob.
 *
 * Rewrites are textual splices at AST-located offsets, not a printer round-trip.
 * A printer would reformat untouched code and turn a one-specifier change into a
 * whole-file diff, which destroys the property the whole design rests on: every
 * byte that changed, changed because the plan said so.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";

import ts from "typescript";
import { JAVASCRIPT_SOURCE_EXTENSIONS, TYPESCRIPT_RESOLUTION_EXTENSIONS } from "../config/source-policy.ts";

export type ModuleReferenceKind =
  | "static-import"
  | "static-export"
  | "import-type"
  | "dynamic-import"
  | "require"
  | "require-resolve"
  | "import-equals"
  | "configured-call"
  | "asset-import";

/** Half-open offset range into the source text: `[start, end)`. */
export interface SourceSpan {
  readonly start: number;
  readonly end: number;
}

export interface ModuleReference {
  readonly kind: ModuleReferenceKind;
  /** Literal specifier, or null when it is computed (a template, a variable). */
  readonly specifier: string | null;
  /** Absolute resolved path, when resolution was attempted and succeeded. */
  readonly resolved: string | null;
  readonly dynamic: boolean;
  readonly typeOnly: boolean;
  /** False for computed specifiers: they cannot be rewritten, so they block a plan. */
  readonly supported: boolean;
  /** Offsets of the whole declaration, not of the specifier literal. */
  readonly start: number;
  readonly end: number;
  /**
   * Offsets of the *specifier literal itself*, delimiters included — the only
   * span a rewrite may splice, and null exactly when `specifier` is null.
   *
   * Recorded here because this is where it is known for certain. Searching the
   * declaration text for a quoted run instead finds the first quoted run in the
   * declaration, which is the specifier only when nothing else in the
   * declaration is quoted: not for `import /* see "./x" *\/ { a } from "./y"`,
   * not for `export { a as "weird name" } from "./y"`, and not for any
   * specifier that itself contains a quote character.
   */
  readonly specifierSpan: SourceSpan | null;
}

export interface Replacement {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

const optionsCache = new Map<string, ts.CompilerOptions>();
const resolutionCache = new Map<string, string | null>();
const SUFFIXES: readonly string[] = TYPESCRIPT_RESOLUTION_EXTENSIONS;

/**
 * Drop everything resolution remembered. Call this at a *tree boundary*.
 *
 * Both caches are keyed on (boundary, importer, specifier) and on nothing that
 * says *when* the answer was true, so an entry survives the tree it describes.
 * A tree boundary is any point where the filesystem the codemod is about to read
 * is a different tree, or the same tree at a different time — and there are four:
 * a CLI command beginning (a process may serve more than one), entering a
 * simulation worktree, returning from that worktree to the primary checkout in
 * `applyPlan`, and every audit, whose entire claim is that it re-resolved against
 * the tree as it is now.
 *
 * Not a boundary: the journal's per-operation loop. Resolution answers
 * legitimately change as files move mid-journal, `matchesDonor` is written to
 * work regardless, and resetting per operation would re-read every
 * `tsconfig.json` for no proof.
 */
export function resetCodemodCaches(): void {
  optionsCache.clear();
  resolutionCache.clear();
}

/**
 * Compiler options from the nearest `tsconfig.json` above the importer, so
 * resolution matches what the repository's own typechecker does. Falls back to
 * NodeNext, the strictest of the common configurations.
 *
 * `boundary` is the last directory the walk is allowed to look at. Without one
 * the walk ends at the filesystem root, so a `tsconfig.json` that happens to sit
 * above the tree under analysis — in the system temp directory, say, where
 * simulation worktrees live by default — silently decides how that tree
 * resolves. What a repository imports has to be a function of the repository.
 */
function compilerOptions(importerPath: string, boundary?: string): ts.CompilerOptions {
  const stopAt = boundary === undefined ? undefined : resolve(boundary);
  let directory = dirname(importerPath);
  for (;;) {
    const configPath = resolve(directory, "tsconfig.json");
    if (existsSync(configPath)) {
      const key = cacheKey(boundary, configPath);
      const cached = optionsCache.get(key);
      if (cached) return cached;
      const config = ts.readConfigFile(configPath, (path) => readFileSync(path, "utf8"));
      if (!config.error) {
        const options = ts.parseJsonConfigFileContent(config.config, ts.sys, directory).options;
        optionsCache.set(key, options);
        return options;
      }
    }
    if (directory === stopAt) break;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return { moduleResolution: ts.ModuleResolutionKind.NodeNext, module: ts.ModuleKind.NodeNext };
}

/**
 * Cache key for anything resolution-dependent. The boundary belongs in it
 * because it changes the answer: serving a bounded result to an unbounded
 * caller, or the reverse, would reintroduce exactly the leak the boundary
 * exists to prevent — intermittently, and depending on call order.
 */
function cacheKey(boundary: string | undefined, ...parts: readonly string[]): string {
  return [boundary ?? "", ...parts].join("\0");
}

function resolvedImport(importerPath: string, specifier: string, boundary?: string, extraSuffixes: readonly string[] = []): string | null {
  const key = cacheKey(boundary, importerPath, specifier, extraSuffixes.join(","));
  const cached = resolutionCache.get(key);
  if (cached !== undefined) return cached;
  if (!specifier.startsWith(".")) return resolveWithTypeScript(key, importerPath, specifier, boundary);

  const base = resolve(dirname(importerPath), specifier.replace(/[?#].*$/u, ""));
  if (extraSuffixes.some((suffix) => base.endsWith(suffix)) && existsSync(base)) {
    resolutionCache.set(key, base);
    return base;
  }
  if (SUFFIXES.includes(extname(base))) {
    resolutionCache.set(key, base);
    return base;
  }
  // `./x.js` in TypeScript source means `./x.ts` on disk under NodeNext.
  const javascriptBase = JAVASCRIPT_SOURCE_EXTENSIONS.includes(extname(base) as typeof JAVASCRIPT_SOURCE_EXTENSIONS[number])
    ? base.slice(0, -extname(base).length)
    : base;
  const direct = [
    ...SUFFIXES.map((suffix) => base + suffix),
    ...SUFFIXES.map((suffix) => javascriptBase + suffix),
    ...SUFFIXES.map((suffix) => resolve(base, `index${suffix}`)),
  ].find(existsSync);
  if (direct) {
    resolutionCache.set(key, direct);
    return direct;
  }
  const result = resolveWithTypeScript(key, importerPath, specifier, boundary);
  resolutionCache.set(key, result);
  return result;
}

function resolveWithTypeScript(
  key: string,
  importerPath: string,
  specifier: string,
  boundary?: string,
): string | null {
  const module = ts.resolveModuleName(specifier, importerPath, compilerOptions(importerPath, boundary), ts.sys)
    .resolvedModule;
  const result = module ? resolve(module.resolvedFileName) : null;
  resolutionCache.set(key, result);
  return result;
}

/**
 * Whether a specifier written in `importerPath` names `donorPath`.
 *
 * Resolution alone is not enough: once the donor has been moved, nothing
 * resolves to it any more, and the rewrite still has to find the specifier that
 * used to point there. So the candidate-path comparison runs regardless.
 */
function matchesDonor(importerPath: string, specifier: string, donorPath: string, boundary?: string, extraSuffixes: readonly string[] = []): boolean {
  if (resolvedImport(importerPath, specifier, boundary, extraSuffixes) === resolve(donorPath)) return true;
  const base = resolve(dirname(importerPath), specifier.replace(/[?#].*$/u, ""));
  return [
    base,
    ...SUFFIXES.map((suffix) => base + suffix),
    ...SUFFIXES.map((suffix) => resolve(base, `index${suffix}`)),
  ].some((candidate) => candidate === resolve(donorPath));
}

/**
 * The text of a specifier that is statically known, or null when it is not.
 *
 * A no-substitution template — `` import(`./x`) `` — is statically known, so it
 * counts. That is a decision, not an accident: `resolved` is computed from it,
 * consumer discovery indexes on `resolved`, and the splicer below repoints it
 * like any other literal. The alternative — calling it unsupported so the plan
 * blocks — would have to null the specifier to be self-consistent, which nulls
 * `resolved`, which drops the file out of the consumer index entirely; the
 * unsupported check only ever runs on files that index found. A specifier with a
 * substitution stays unsupported: its text is not knowable before it runs.
 */
function literal(node: ts.Node): string | null {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : null;
}

function scriptKind(path: string): ts.ScriptKind {
  return path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

/**
 * Every module reference in a file: static imports and exports, `import type`,
 * `import()`, `require()`, `require.resolve()`, and `import x = require()`.
 *
 * `resolveNonRelative` exists because resolving bare specifiers costs a full
 * module-resolution pass per specifier; callers that only care about relative
 * edges turn it off. `boundary` is the root of the tree under analysis: pass it
 * and no `tsconfig.json` above that root can influence resolution.
 */
export function inventoryModuleReferences(
  source: string,
  importerPath: string,
  resolveNonRelative = true,
  boundary?: string,
  moduleSpecifierCalls: readonly string[] = [],
  resolutionExtensions: readonly string[] = [],
  cssImportExtensions: readonly string[] = [],
): ModuleReference[] {
  if (cssImportExtensions.some((extension) => importerPath.endsWith(extension))) {
    return inventoryCssImports(source, importerPath, boundary, resolutionExtensions);
  }
  const file = ts.createSourceFile(importerPath, source, ts.ScriptTarget.Latest, true, scriptKind(importerPath));
  const references: ModuleReference[] = [];

  const add = (
    kind: ModuleReferenceKind,
    node: ts.Node,
    argument: ts.Node | undefined,
    typeOnly: boolean,
    dynamic: boolean,
  ): void => {
    const specifier = argument ? literal(argument) : null;
    references.push({
      kind,
      specifier,
      resolved:
        specifier && (resolveNonRelative || specifier.startsWith("."))
          ? resolvedImport(importerPath, specifier, boundary, resolutionExtensions)
          : null,
      dynamic,
      typeOnly,
      supported: specifier !== null,
      start: node.getStart(file),
      end: node.end,
      // `getStart(file)` skips the literal's leading trivia, so this is the
      // opening delimiter and `end` is one past the closing one.
      specifierSpan:
        argument && specifier !== null ? { start: argument.getStart(file), end: argument.end } : null,
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      add("static-import", node, node.moduleSpecifier, node.importClause?.isTypeOnly ?? false, false);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      add("static-export", node, node.moduleSpecifier, node.isTypeOnly, false);
    } else if (ts.isImportTypeNode(node)) {
      add("import-type", node, ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined, true, false);
    } else if (ts.isImportEqualsDeclaration(node)) {
      add(
        "import-equals",
        node,
        ts.isExternalModuleReference(node.moduleReference) ? node.moduleReference.expression : undefined,
        false,
        false,
      );
    } else if (ts.isCallExpression(node)) {
      addCall(node, add, moduleSpecifierCalls);
    }
    ts.forEachChild(node, visit);
  };

  visit(file);
  return references;
}

function inventoryCssImports(source: string, importerPath: string, boundary: string | undefined, resolutionExtensions: readonly string[]): ModuleReference[] {
  const references: ModuleReference[] = [];
  const pattern = /@import\s+(?:url\(\s*)?(["'])([^"']+)\1\s*\)?/gu;
  for (const match of source.matchAll(pattern)) {
    const specifier = match[2]!;
    const start = match.index;
    const literalOffset = match[0].indexOf(`${match[1]}${specifier}${match[1]}`);
    references.push({
      kind: "asset-import", specifier, resolved: resolvedImport(importerPath, specifier, boundary, resolutionExtensions),
      dynamic: false, typeOnly: false, supported: true, start, end: start + match[0].length,
      specifierSpan: { start: start + literalOffset, end: start + literalOffset + specifier.length + 2 },
    });
  }
  return references;
}

type AddReference = (
  kind: ModuleReferenceKind,
  node: ts.Node,
  argument: ts.Node | undefined,
  typeOnly: boolean,
  dynamic: boolean,
) => void;

function addCall(node: ts.CallExpression, add: AddReference, moduleSpecifierCalls: readonly string[]): void {
  const expression = node.expression;
  const argument = node.arguments.length === 1 ? node.arguments[0] : undefined;
  if (expression.kind === ts.SyntaxKind.ImportKeyword) add("dynamic-import", node, argument, false, true);
  else if (ts.isIdentifier(expression) && expression.text === "require") add("require", node, argument, false, false);
  else if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "require" &&
    expression.name.text === "resolve"
  ) {
    add("require-resolve", node, argument, false, false);
  } else if (moduleSpecifierCalls.includes(qualifiedName(expression) ?? "")) {
    add("configured-call", node, node.arguments[0], false, false);
  }
}

function qualifiedName(node: ts.Expression): string | undefined {
  if (ts.isIdentifier(node)) return node.text;
  if (!ts.isPropertyAccessExpression(node)) return undefined;
  const parent = qualifiedName(node.expression);
  return parent === undefined ? undefined : `${parent}.${node.name.text}`;
}

/**
 * References whose specifier is computed. A file containing one cannot be
 * planned: no codemod can prove what it will import at runtime.
 */
export function unsupportedModuleReferences(
  source: string,
  importerPath: string,
  boundary?: string,
): ModuleReference[] {
  return inventoryModuleReferences(source, importerPath, false, boundary).filter(
    (reference) => reference.specifier === null,
  );
}

export function applyReplacements(source: string, replacements: readonly Replacement[]): string {
  return [...replacements]
    .sort((left, right) => right.start - left.start)
    .reduce((result, replacement) => result.slice(0, replacement.start) + replacement.text + result.slice(replacement.end), source);
}

/**
 * Whether `text` can stand between `delimiter`s and still be the string it is.
 *
 * The splice writes the package specifier raw, so anything that would end the
 * literal (the delimiter), start an escape (a backslash), break the line, or —
 * inside a template — interpolate, would produce a file that means something
 * else or does not parse at all. No package name in any ecosystem contains one
 * of these; the point is that if one ever does, the caller hears about it.
 */
export function fitsInLiteral(text: string, delimiter: string): boolean {
  if (delimiter !== '"' && delimiter !== "'" && delimiter !== "`") return false;
  if (text.includes(delimiter) || text.includes("\\") || /[\r\n]/.test(text)) return false;
  return delimiter !== "`" || !text.includes("${");
}

/**
 * Repoint every specifier in `source` that names `donorPath` at
 * `packageSpecifier`, preserving the original quote style and every other byte.
 *
 * The splice covers the *inside* of the literal only, so the delimiters survive
 * by never being written: a single-quoted specifier stays single-quoted, a
 * backtick one stays a backtick one, and a specifier containing a quote
 * character is no different from any other.
 */
export function rewriteResolvedImportSpecifier(
  source: string,
  importerPath: string,
  donorPath: string,
  packageSpecifier: string,
  boundary?: string,
  moduleSpecifierCalls: readonly string[] = [],
  resolutionExtensions: readonly string[] = [],
  cssImportExtensions: readonly string[] = [],
): string {
  const replacements: Replacement[] = [];
  for (const reference of inventoryModuleReferences(source, importerPath, false, boundary, moduleSpecifierCalls, resolutionExtensions, cssImportExtensions)) {
    const span = reference.specifierSpan;
    if (!reference.specifier || !span) continue;
    if (!matchesDonor(importerPath, reference.specifier, donorPath, boundary, resolutionExtensions)) continue;
    const delimiter = source.slice(span.start, span.start + 1);
    if (!fitsInLiteral(packageSpecifier, delimiter)) {
      throw new Error(
        `cannot rewrite ${importerPath}: the specifier ${JSON.stringify(packageSpecifier)} ` +
          `cannot be written inside ${JSON.stringify(source.slice(span.start, span.end))}`,
      );
    }
    replacements.push({ start: span.start + 1, end: span.end - 1, text: packageSpecifier });
  }
  return applyReplacements(source, replacements);
}

/** Apply a plan's escape rewrites to a moved file, in declaration order. */
export function applyEscapeRewrites(
  source: string,
  sourcePath: string,
  rewrites: readonly { readonly donorlessSpecifier: string; readonly packageSpecifier: string }[],
  boundary?: string,
  moduleSpecifierCalls: readonly string[] = [],
  resolutionExtensions: readonly string[] = [],
  cssImportExtensions: readonly string[] = [],
): string {
  return rewrites.reduce(
    (value, rewrite) =>
      rewriteResolvedImportSpecifier(
        value,
        sourcePath,
        resolve(dirname(sourcePath), rewrite.donorlessSpecifier),
        rewrite.packageSpecifier,
        boundary,
        moduleSpecifierCalls,
        resolutionExtensions,
        cssImportExtensions,
      ),
    source,
  );
}
