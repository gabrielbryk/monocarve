import { basename, isAbsolute, posix } from "node:path";

import ts from "typescript";

import { byCodeUnit, hashText } from "../util/hash.ts";
import {
  buildGroups,
  collectDeclarations,
  collectExportedSymbols,
  compareDeclarations,
} from "./declarations.ts";
import { SymbolAnalysisError } from "./error.ts";
import { collectEdges, stronglyConnectedComponents } from "./relations.ts";
import type { AnalyzeTypeScriptSourceInput, DeclarationGroup, SymbolAnalysisDiagnostic, SymbolGraph } from "./types.ts";

export { SymbolAnalysisError } from "./error.ts";
export { referenceSpace } from "./relations.ts";

const AMBIGUOUS_BINDING_DIAGNOSTICS = new Set([2300, 2323, 2393, 2395, 2428, 2440, 2451, 2484, 2567]);

/** Analyze one source file without reading or mutating the workspace. */
export function analyzeTypeScriptSource(input: AnalyzeTypeScriptSourceInput): SymbolGraph {
  const sourcePath = normalizeSourcePath(input.sourcePath);
  const { sourceFile, checker, diagnostics } = createIsolatedProgram(sourcePath, input.sourceText);
  return buildSymbolGraph(sourcePath, input.sourceText, sourceFile, checker, diagnostics);
}

/** Build a symbol graph from a source file in its real workspace program. */
export function analyzeProgramSource(input: {
  readonly sourcePath: string;
  readonly sourceText: string;
  readonly sourceFile: ts.SourceFile;
  readonly checker: ts.TypeChecker;
  readonly syntacticDiagnostics: readonly ts.Diagnostic[];
  readonly semanticDiagnostics: readonly ts.Diagnostic[];
}): SymbolGraph {
  const sourcePath = normalizeSourcePath(input.sourcePath);
  const diagnostics = [
    ...input.syntacticDiagnostics.map((entry) => toDiagnostic(entry, "syntactic")),
    ...input.semanticDiagnostics.map((entry) => toDiagnostic(entry, "semantic")),
  ].sort(compareDiagnostics);
  return buildSymbolGraph(sourcePath, input.sourceText, input.sourceFile, input.checker, diagnostics);
}

function buildSymbolGraph(
  sourcePath: string,
  sourceText: string,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  diagnostics: readonly SymbolAnalysisDiagnostic[],
): SymbolGraph {
  const fatalDiagnostics = diagnostics.filter(isFatalDiagnostic);
  if (fatalDiagnostics.length > 0) {
    throw new SymbolAnalysisError(
      `cannot build a complete symbol graph for ${sourcePath}: ${fatalDiagnostics[0]?.message ?? "invalid TypeScript"}`,
      fatalDiagnostics,
    );
  }
  const physical = collectDeclarations(sourceFile, checker, sourcePath, sourceText);
  const exportedSymbols = collectExportedSymbols(sourceFile, checker);
  const declarations = physical.map(({ record, symbol }) => ({
    ...record,
    exported: record.exported || (symbol !== undefined && exportedSymbols.has(symbol)),
  })).sort(compareDeclarations);
  const recordById = new Map(declarations.map((record) => [record.id, record]));
  const physicalById = new Map(physical.map((item) => [item.record.id, item]));
  const groups = buildGroups(sourcePath, declarations);
  const groupByName = new Map(groups.map((group) => [group.name, group]));
  const groupBySymbol = groupsForSymbols(declarations, physicalById, groupByName);
  const edges = collectEdges(checker, sourceText, physicalById, recordById, groupByName, groupBySymbol);
  return {
    schemaVersion: 1,
    sourcePath,
    sourceHash: hashText(sourceText),
    diagnostics,
    declarations,
    groups,
    edges,
    components: stronglyConnectedComponents(groups, edges),
  };
}

function normalizeSourcePath(value: string): string {
  const slashPath = value.replaceAll("\\", "/");
  if (slashPath.length === 0 || isAbsolute(value) || /^[A-Za-z]:\//.test(slashPath)) {
    throw new SymbolAnalysisError("sourcePath must be a non-empty repository-relative path", []);
  }
  const normalized = posix.normalize(slashPath);
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new SymbolAnalysisError("sourcePath may not leave the repository", []);
  }
  return normalized.startsWith("./") ? normalized.slice(2) : normalized;
}

function createIsolatedProgram(sourcePath: string, sourceText: string): IsolatedProgram {
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    jsx: ts.JsxEmit.Preserve,
    skipLibCheck: true,
    noEmit: true,
  };
  const virtualPath = `/__symbol_graph__/${basename(sourcePath)}`;
  const sourceFile = ts.createSourceFile(virtualPath, sourceText, ts.ScriptTarget.Latest, true, scriptKind(sourcePath));
  const host = isolatedHost(compilerOptions, virtualPath, sourceFile, sourceText);
  const program = ts.createProgram([virtualPath], compilerOptions, host);
  const programSource = program.getSourceFile(virtualPath);
  if (!programSource) throw new SymbolAnalysisError(`TypeScript did not load ${sourcePath}`, []);
  const diagnostics = [
    ...program.getSyntacticDiagnostics(programSource).map((diagnostic) => toDiagnostic(diagnostic, "syntactic")),
    ...program.getSemanticDiagnostics(programSource).map((diagnostic) => toDiagnostic(diagnostic, "semantic")),
  ].sort(compareDiagnostics);
  return { sourceFile: programSource, checker: program.getTypeChecker(), diagnostics };
}

function groupsForSymbols(
  declarations: readonly { readonly id: string; readonly name: string }[],
  physicalById: ReadonlyMap<string, { readonly symbol: ts.Symbol | undefined }>,
  groupByName: ReadonlyMap<string, DeclarationGroup>,
): Map<ts.Symbol, DeclarationGroup> {
  const result = new Map<ts.Symbol, DeclarationGroup>();
  for (const declaration of declarations) {
    const symbol = physicalById.get(declaration.id)?.symbol;
    const group = groupByName.get(declaration.name);
    if (symbol && group) result.set(symbol, group);
  }
  return result;
}

function isolatedHost(
  compilerOptions: ts.CompilerOptions,
  virtualPath: string,
  sourceFile: ts.SourceFile,
  sourceText: string,
): ts.CompilerHost {
  const host = ts.createCompilerHost(compilerOptions, true);
  const getSourceFile = host.getSourceFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const readFile = host.readFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => fileName === virtualPath
    ? sourceFile
    : getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  host.fileExists = (fileName) => fileName === virtualPath || fileExists(fileName);
  host.readFile = (fileName) => fileName === virtualPath ? sourceText : readFile(fileName);
  return host;
}

function isFatalDiagnostic(diagnostic: SymbolAnalysisDiagnostic): boolean {
  return diagnostic.category === "error" && (diagnostic.phase === "syntactic" || AMBIGUOUS_BINDING_DIAGNOSTICS.has(diagnostic.code));
}

function scriptKind(path: string): ts.ScriptKind {
  const lower = path.toLowerCase();
  if (lower.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (lower.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function toDiagnostic(diagnostic: ts.Diagnostic, phase: SymbolAnalysisDiagnostic["phase"]): SymbolAnalysisDiagnostic {
  const category = ts.DiagnosticCategory[diagnostic.category]?.toLowerCase();
  const normalizedCategory = category === "error" || category === "warning" || category === "suggestion" || category === "message" ? category : "message";
  return {
    phase,
    code: diagnostic.code,
    category: normalizedCategory,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    ...(diagnostic.start === undefined ? {} : { start: diagnostic.start }),
    ...(diagnostic.length === undefined ? {} : { length: diagnostic.length }),
  };
}

function compareDiagnostics(left: SymbolAnalysisDiagnostic, right: SymbolAnalysisDiagnostic): number {
  return (left.start ?? -1) - (right.start ?? -1) || left.code - right.code || byCodeUnit(left.message, right.message);
}

interface IsolatedProgram {
  readonly sourceFile: ts.SourceFile;
  readonly checker: ts.TypeChecker;
  readonly diagnostics: readonly SymbolAnalysisDiagnostic[];
}
