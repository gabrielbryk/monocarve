/**
 * The public surface of a module: what a package built from it would export.
 *
 * This one analysis uses a real TypeScript program rather than a bare AST pass,
 * because `export *` and re-export chains cannot be resolved syntactically —
 * and getting them wrong produces a package whose declared surface is narrower
 * than what consumers already use, which the external-consumer compile proof
 * would then reject for reasons nobody can see from the plan.
 */

import ts from "typescript";
import { relative, resolve } from "node:path";

import { MonocarveError } from "../errors.ts";
import { showBaseline } from "../util/git.ts";
import { resolveExportSurface } from "./public-surface-analysis.ts";

export interface ExportSurface {
  readonly name: string;
  /** True when the symbol carries no runtime value — it is a type or interface. */
  readonly typeOnly: boolean;
}

export class PublicSurfaceError extends MonocarveError {
  override readonly name = "PublicSurfaceError";
}

/**
 * Exported symbols of one file, sorted by name.
 *
 * `export =` is rejected rather than approximated: it has no ES-module
 * equivalent, so a package built around it would not import the way the plan
 * claims it does.
 */
export function sourceExportsFromFile(absolute: string, displayPath = absolute): ExportSurface[] {
  return sourceExportsFromProgram(absolute, displayPath, ts.createProgram([absolute], compilerOptions()));
}

/**
 * Exported symbols as they existed at an immutable repository commit.
 *
 * The compiler host serves every workspace file from the baseline, so re-export
 * chains remain resolvable after the live donor tree has been moved away.
 */
export function sourceExportsFromBaseline(workspaceRoot: string, commit: string, path: string): ExportSurface[] {
  const absolute = resolve(workspaceRoot, path);
  const options = compilerOptions();
  const fallback = ts.createCompilerHost(options);
  const cache = new Map<string, string | null>();
  const workspacePathOf = (fileName: string): string | null => {
    const workspacePath = relative(resolve(workspaceRoot), resolve(fileName)).replaceAll("\\", "/");
    return workspacePath === ".." || workspacePath.startsWith("../") ? null : workspacePath;
  };
  const baselinePathText = (workspacePath: string): string | null => {
    if (!cache.has(workspacePath)) cache.set(workspacePath, showBaseline(workspaceRoot, commit, workspacePath));
    return cache.get(workspacePath) ?? null;
  };
  const allowed = baselineSurfaceClosure(path, baselinePathText);
  const baselineText = (fileName: string): string | null => {
    const workspacePath = workspacePathOf(fileName);
    return workspacePath !== null && allowed.has(workspacePath) ? baselinePathText(workspacePath) : null;
  };
  const host: ts.CompilerHost = {
    ...fallback,
    getCurrentDirectory: () => workspaceRoot,
    directoryExists: (directoryName) => {
      const workspacePath = workspacePathOf(directoryName);
      if (workspacePath === null) return fallback.directoryExists?.(directoryName) ?? false;
      const prefix = workspacePath === "" ? "" : `${workspacePath}/`;
      return [...allowed].some((candidate) => candidate.startsWith(prefix));
    },
    fileExists: (fileName) => workspacePathOf(fileName) === null ? fallback.fileExists(fileName) : baselineText(fileName) !== null,
    readFile: (fileName) => workspacePathOf(fileName) === null ? fallback.readFile(fileName) : baselineText(fileName) ?? undefined,
    getSourceFile: (fileName, languageVersion) => {
      const contents = baselineText(fileName);
      return contents === null
        ? fallback.getSourceFile(fileName, languageVersion)
        : ts.createSourceFile(fileName, contents, languageVersion, true);
    },
  };
  return sourceExportsFromProgram(absolute, path, ts.createProgram([absolute], options, host));
}

/** Keep Git reads bounded to files that can affect the declared export surface. */
function baselineSurfaceClosure(path: string, read: (path: string) => string | null): Set<string> {
  const allowed = new Set<string>();
  const visit = (current: string, followExports: boolean): void => {
    if (allowed.has(current)) return;
    const contents = read(current);
    if (contents === null) return;
    allowed.add(current);
    if (!followExports) return;
    const source = ts.createSourceFile(current, contents, ts.ScriptTarget.Latest, true);
    for (const statement of source.statements) {
      const specifier = (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
        && statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text
        : undefined;
      if (!specifier?.startsWith(".")) continue;
      const resolved = resolveBaselineModule(current, specifier, read);
      if (resolved !== null) visit(resolved, followExports && ts.isExportDeclaration(statement));
    }
  };
  visit(path, true);
  return allowed;
}

function resolveBaselineModule(importer: string, specifier: string, read: (path: string) => string | null): string | null {
  const base = resolve("/", importer, "..", specifier).slice(1).replaceAll("\\", "/");
  const withoutRuntimeExtension = base.replace(/\.(?:mjs|cjs|js|jsx)$/, "");
  const candidates = [base, withoutRuntimeExtension, ...[".ts", ".tsx", ".mts", ".cts", ".d.ts"].map((extension) => `${withoutRuntimeExtension}${extension}`), ...[".ts", ".tsx", ".mts", ".cts", ".d.ts"].map((extension) => `${withoutRuntimeExtension}/index${extension}`)];
  return candidates.find((candidate) => read(candidate) !== null) ?? null;
}

function compilerOptions(): ts.CompilerOptions {
  return {
    allowJs: false,
    noEmit: true,
    skipLibCheck: true,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    jsx: ts.JsxEmit.ReactJSX,
  };
}

function sourceExportsFromProgram(absolute: string, displayPath: string, program: ts.Program): ExportSurface[] {
  const sourceFile = program.getSourceFile(absolute);
  if (!sourceFile) return [];
  if (sourceFile.statements.some((statement) => ts.isExportAssignment(statement) && statement.isExportEquals)) {
    throw new PublicSurfaceError(`unsupported export assignment in ${displayPath}`);
  }

  return resolveExportSurface(program.getTypeChecker(), sourceFile);
}
