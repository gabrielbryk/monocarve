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

import { MonocarveError } from "../errors.ts";
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
  const program = ts.createProgram([absolute], {
    allowJs: false,
    noEmit: true,
    skipLibCheck: true,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    jsx: ts.JsxEmit.ReactJSX,
  });
  const sourceFile = program.getSourceFile(absolute);
  if (!sourceFile) return [];
  if (sourceFile.statements.some((statement) => ts.isExportAssignment(statement) && statement.isExportEquals)) {
    throw new PublicSurfaceError(`unsupported export assignment in ${displayPath}`);
  }

  return resolveExportSurface(program.getTypeChecker(), sourceFile);
}
