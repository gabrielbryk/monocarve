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
  const packageNames = [...graph.workspace.packageNames.keys()].sort();
  const result: CompatibilityShim[] = [];
  for (const path of graph.paths) {
    const parsed = context.parsedSource(path);
    if (!parsed) continue;
    const described = describePureReexport(parsed, packageNames);
    if (!described) continue;
    const productionConsumers = [...(graph.incoming.get(path) ?? [])].sort();
    if (productionConsumers.length < context.config.portfolio.compatibilityShimMinInbound) continue;
    result.push({
      path,
      packageName: described.packageName,
      replacementSpecifier: described.specifier,
      symbols: described.symbols,
      productionConsumers,
      testConsumers: [...(graph.testImporters.get(path) ?? [])].sort(),
      lineCount: graph.nodes.get(path)?.lineCount ?? 0,
    });
  }
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

export function describePureReexport(
  source: ts.SourceFile,
  packageNames: readonly string[],
): { packageName: string; specifier: string; symbols: string[] } | undefined {
  const exports = source.statements.filter(ts.isExportDeclaration);
  const imports = source.statements.filter(ts.isImportDeclaration);
  if (exports.length === 0 || source.statements.some((statement) => !ts.isExportDeclaration(statement) && !ts.isImportDeclaration(statement))) return undefined;
  const imported = new Map<string, string>();
  const importSpecifiers: string[] = [];
  for (const statement of imports) {
    if (!ts.isStringLiteral(statement.moduleSpecifier) || !statement.importClause) return undefined;
    importSpecifiers.push(statement.moduleSpecifier.text);
    const clause = statement.importClause;
    if (clause.name) imported.set(clause.name.text, "default");
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) imported.set(element.name.text, element.propertyName?.text ?? element.name.text);
    } else if (clause.namedBindings) return undefined;
  }
  const directSpecifiers = exports.flatMap((statement) =>
    statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) ? [statement.moduleSpecifier.text] : [],
  );
  const unique = [...new Set([...importSpecifiers, ...directSpecifiers])];
  if (unique.length !== 1) return undefined;
  const specifier = unique[0]!;
  const packageName = packageNames.find((name) => specifier === name || specifier.startsWith(`${name}/`));
  if (!packageName) return undefined;
  const symbols: string[] = [];
  for (const statement of exports) {
    if (!statement.moduleSpecifier && !statement.exportClause) return undefined;
    if (!statement.exportClause) symbols.push("*");
    else if (ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        if (!statement.moduleSpecifier) {
          const local = element.propertyName?.text ?? element.name.text;
          const original = imported.get(local);
          if (!original || element.name.text !== local) return undefined;
          symbols.push(original);
          continue;
        }
        if (element.propertyName && element.propertyName.text !== element.name.text) return undefined;
        symbols.push(element.name.text);
      }
    } else return undefined;
  }
  return { packageName, specifier, symbols: [...new Set(symbols)].sort() };
}
