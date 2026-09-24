/**
 * The public surface of a module: what a package built from it would export.
 *
 * This one analysis uses a real TypeScript program rather than a bare AST pass,
 * because `export *` and re-export chains cannot be resolved syntactically —
 * and getting them wrong produces a package whose declared surface is narrower
 * than what consumers already use, which the external-consumer compile proof
 * would then reject for reasons nobody can see from the plan.
 */

import { realpathSync } from "node:fs";
import { relative, resolve } from "node:path";
import ts from "typescript";

import { MonocarveError } from "../errors.ts";
import { git, repositoryPrefix, showBaseline } from "../util/git.ts";
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
  const prefix = repositoryPrefix(workspaceRoot);
  const baselineFiles = new Set(
    git({ cwd: workspaceRoot }, "ls-tree", "-r", "--name-only", commit, "--", prefix || ".")
      .split("\n")
      .filter(Boolean)
      .map((entry) => (prefix && entry.startsWith(prefix) ? entry.slice(prefix.length) : entry)),
  );
  const baselineDirectories = new Set<string>([""]);
  for (const file of baselineFiles) {
    const parts = file.split("/");
    for (let index = 1; index < parts.length; index += 1) baselineDirectories.add(parts.slice(0, index).join("/"));
  }
  const workspacePathOf = (fileName: string): string | null => {
    const workspacePath = relative(resolve(workspaceRoot), resolve(fileName)).replaceAll("\\", "/");
    return workspacePath === ".." || workspacePath.startsWith("../") ? null : workspacePath;
  };
  const baselineWorkspacePathOf = (fileName: string, known: ReadonlySet<string>): string | null => {
    const direct = workspacePathOf(fileName);
    if (direct !== null && known.has(direct)) return direct;
    try {
      const physical = workspacePathOf(realpathSync.native(fileName));
      return physical !== null && known.has(physical) ? physical : null;
    } catch {
      return null;
    }
  };
  const baselinePathText = (workspacePath: string): string | null => {
    if (!cache.has(workspacePath)) cache.set(workspacePath, showBaseline(workspaceRoot, commit, workspacePath));
    return cache.get(workspacePath) ?? null;
  };
  const baselineText = (fileName: string): string | null => {
    const workspacePath = baselineWorkspacePathOf(fileName, baselineFiles);
    return workspacePath !== null ? baselinePathText(workspacePath) : null;
  };
  const host: ts.CompilerHost = {
    ...fallback,
    getCurrentDirectory: () => workspaceRoot,
    // Directory traversal may follow a workspace-package symlink out of
    // node_modules. File reads remain pinned to Git below, so admitting a live
    // directory can only help TypeScript locate immutable baseline files.
    directoryExists: (directoryName) => {
      const workspacePath = baselineWorkspacePathOf(directoryName, baselineDirectories);
      return workspacePath !== null || (fallback.directoryExists?.(directoryName) ?? false);
    },
    fileExists: (fileName) => baselineText(fileName) !== null || fallback.fileExists(fileName),
    readFile: (fileName) => baselineText(fileName) ?? fallback.readFile(fileName),
    getSourceFile: (fileName, languageVersion) => {
      const contents = baselineText(fileName);
      return contents === null ? fallback.getSourceFile(fileName, languageVersion) : ts.createSourceFile(fileName, contents, languageVersion, true);
    },
  };
  return sourceExportsFromProgram(absolute, path, ts.createProgram([absolute], options, host));
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
