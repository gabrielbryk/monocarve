/**
 * Cheap single-file AST facts.
 *
 * These exist because the module resolver does not tell you *how* a module was
 * imported, and the difference decides eligibility: a type-only edge vanishes at
 * runtime (so it becomes a devDependency), a dynamic edge survives only if its
 * specifier can be rewritten, and a file that exports nothing has no public
 * surface to extract. Everything here parses one file with no type checker, so
 * it is affordable per node of the graph.
 */

import { existsSync, readFileSync } from "node:fs";

import ts from "typescript";

export interface ImportKind {
  readonly typeOnly: boolean;
  readonly dynamic: boolean;
}

function parse(absolute: string, displayPath: string): ts.SourceFile | undefined {
  if (!existsSync(absolute)) return undefined;
  return ts.createSourceFile(
    displayPath,
    readFileSync(absolute, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    displayPath.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/**
 * How each specifier in a file is imported, keyed by the specifier as written.
 *
 * A specifier imported twice collapses to the strictest reading: type-only only
 * when *every* occurrence is type-only, dynamic when *any* occurrence is.
 */
export function importKinds(absolute: string, displayPath = absolute): Map<string, ImportKind> {
  const parsed = parse(absolute, displayPath);
  return parsed ? collectImportKinds(parsed) : new Map();
}

function collectImportKinds(parsed: ts.SourceFile): Map<string, ImportKind> {
  const result = new Map<string, ImportKind>();

  const record = (specifier: string, typeOnly: boolean, dynamic = false): void => {
    const previous = result.get(specifier);
    result.set(specifier, { typeOnly: previous ? previous.typeOnly && typeOnly : typeOnly, dynamic: previous?.dynamic === true || dynamic });
  };

  for (const statement of parsed.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const clause = statement.importClause;
      const named = clause?.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements : [];
      // `import { type A, type B } from "x"` is type-only in substance even
      // though the clause itself is not marked so.
      const typeOnly =
        clause?.phaseModifier === ts.SyntaxKind.TypeKeyword ||
        (clause !== undefined && clause.name === undefined && named.length > 0 && named.every((item) => item.isTypeOnly));
      record(statement.moduleSpecifier.text, typeOnly);
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      record(statement.moduleSpecifier.text, statement.isTypeOnly);
    }
  }

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments.length === 1 ? node.arguments[0] : undefined;
      if (argument && ts.isStringLiteral(argument)) record(argument.text, false, true);
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      record(node.argument.literal.text, true);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return result;
}

const exportProbeCache = new Map<string, boolean>();

function exportsAnything(parsed: ts.SourceFile | undefined): boolean {
  return (
    parsed?.statements.some(
      (statement) =>
        ts.isExportDeclaration(statement) ||
        ts.isExportAssignment(statement) ||
        (ts.canHaveModifiers(statement) && (ts.getModifiers(statement) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)),
    ) ?? false
  );
}

/**
 * Both facts from a single parse. The graph build asks for both of every node,
 * and parsing each file twice is the difference between a scan that is pleasant
 * to iterate on and one that is not.
 */
export function fileFacts(absolute: string, displayPath = absolute): { readonly kinds: Map<string, ImportKind>; readonly hasExports: boolean } {
  const parsed = parse(absolute, displayPath);
  const hasExports = exportsAnything(parsed);
  exportProbeCache.set(absolute, hasExports);
  return { kinds: parsed ? collectImportKinds(parsed) : new Map(), hasExports };
}

export function resetSyntaxCaches(): void {
  exportProbeCache.clear();
}
