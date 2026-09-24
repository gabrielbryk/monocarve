import ts from "typescript";

import type { DependencyGraph } from "../graph/model.ts";
import type { WorkspaceContext } from "../plan/context.ts";
import type { CompatibilityShim } from "./types.ts";

/**
 * Find high-fan-in modules whose complete runtime behavior is forwarding one
 * workspace package surface. This is evidence for a compatibility migration,
 * never permission to rewrite or delete the module.
 */
export function detectCompatibilityShims(context: WorkspaceContext, graph: DependencyGraph): readonly CompatibilityShim[] {
  const packageNames = [...graph.workspace.packageNames.keys()].toSorted();
  const result: CompatibilityShim[] = [];
  for (const path of graph.paths) {
    const parsed = context.parsedSource(path);
    if (!parsed) continue;
    const described = describePureReexport(parsed, packageNames);
    if (!described) continue;
    const productionConsumers = [...(graph.incoming.get(path) ?? [])].toSorted();
    if (productionConsumers.length < context.config.portfolio.compatibilityShimMinInbound) continue;
    result.push({
      path,
      packageName: described.packageName,
      replacementSpecifier: described.specifier,
      symbols: described.symbols,
      productionConsumers,
      testConsumers: [...(graph.testImporters.get(path) ?? [])].toSorted(),
      lineCount: graph.nodes.get(path)?.lineCount ?? 0,
    });
  }
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

interface ImportedBindings {
  readonly imported: ReadonlyMap<string, string>;
  readonly specifiers: readonly string[];
}

export function describePureReexport(
  source: ts.SourceFile,
  packageNames: readonly string[],
): { packageName: string; specifier: string; symbols: string[] } | undefined {
  const exports = source.statements.filter(ts.isExportDeclaration);
  const imports = source.statements.filter(ts.isImportDeclaration);
  if (exports.length === 0 || source.statements.some((statement) => !ts.isExportDeclaration(statement) && !ts.isImportDeclaration(statement))) return undefined;
  const bindings = collectImportBindings(imports);
  if (!bindings) return undefined;
  const specifier = soleSpecifier(bindings.specifiers, exports);
  if (specifier === undefined) return undefined;
  const packageName = packageNames.find((name) => specifier === name || specifier.startsWith(`${name}/`));
  if (!packageName) return undefined;
  const symbols = exportedSymbols(exports, bindings.imported);
  if (!symbols) return undefined;
  return { packageName, specifier, symbols: [...new Set(symbols)].toSorted() };
}

function collectImportBindings(imports: readonly ts.ImportDeclaration[]): ImportedBindings | undefined {
  const imported = new Map<string, string>();
  const specifiers: string[] = [];
  for (const statement of imports) {
    if (!ts.isStringLiteral(statement.moduleSpecifier) || !statement.importClause) return undefined;
    specifiers.push(statement.moduleSpecifier.text);
    if (!recordImportClause(statement.importClause, imported)) return undefined;
  }
  return { imported, specifiers };
}

/** Record a clause's local bindings; false when it uses a namespace import. */
function recordImportClause(clause: ts.ImportClause, imported: Map<string, string>): boolean {
  if (clause.name) imported.set(clause.name.text, "default");
  if (!clause.namedBindings) return true;
  if (!ts.isNamedImports(clause.namedBindings)) return false;
  for (const element of clause.namedBindings.elements) imported.set(element.name.text, element.propertyName?.text ?? element.name.text);
  return true;
}

function soleSpecifier(importSpecifiers: readonly string[], exports: readonly ts.ExportDeclaration[]): string | undefined {
  const directSpecifiers = exports.flatMap((statement) =>
    statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) ? [statement.moduleSpecifier.text] : [],
  );
  const unique = [...new Set([...importSpecifiers, ...directSpecifiers])];
  return unique.length === 1 ? unique[0] : undefined;
}

function exportedSymbols(exports: readonly ts.ExportDeclaration[], imported: ReadonlyMap<string, string>): string[] | undefined {
  const symbols: string[] = [];
  for (const statement of exports) {
    if (!statement.moduleSpecifier && !statement.exportClause) return undefined;
    if (!statement.exportClause) {
      symbols.push("*");
      continue;
    }
    if (!ts.isNamedExports(statement.exportClause)) return undefined;
    for (const element of statement.exportClause.elements) {
      const symbol = exportedSymbol(element, statement.moduleSpecifier !== undefined, imported);
      if (symbol === undefined) return undefined;
      symbols.push(symbol);
    }
  }
  return symbols;
}

/** The package symbol one export specifier forwards, or undefined when it renames or forwards a non-import. */
function exportedSymbol(element: ts.ExportSpecifier, direct: boolean, imported: ReadonlyMap<string, string>): string | undefined {
  if (!direct) {
    const local = element.propertyName?.text ?? element.name.text;
    const original = imported.get(local);
    return !original || element.name.text !== local ? undefined : original;
  }
  if (element.propertyName && element.propertyName.text !== element.name.text) return undefined;
  return element.name.text;
}
