import { MonocarveError } from "../errors.ts";
import type { SymbolAnalysisDiagnostic } from "./types.ts";

/** A graph is never returned when its local bindings are syntactically ambiguous. */
export class SymbolAnalysisError extends MonocarveError {
  override readonly name = "SymbolAnalysisError";
  readonly diagnostics: readonly SymbolAnalysisDiagnostic[];

  constructor(message: string, diagnostics: readonly SymbolAnalysisDiagnostic[]) {
    super(message);
    this.diagnostics = diagnostics;
  }
}
