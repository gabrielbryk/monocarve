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
  return parsed ? collectImportKinds(parsed) : new Map<string, ImportKind>();
}

function collectImportKinds(parsed: ts.SourceFile): Map<string, ImportKind> {
  const result = new Map<string, ImportKind>();
  const record = (specifier: string, typeOnly: boolean, dynamic = false): void => recordImport(result, specifier, typeOnly, dynamic);
  for (const statement of parsed.statements) {
    const edge = staticEdge(statement);
    if (edge) record(edge.specifier, edge.typeOnly);
  }
  const visit = (node: ts.Node): void => {
    const edge = expressionEdge(node);
    if (edge) record(edge.specifier, edge.typeOnly, edge.dynamic);
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return result;
}

/** Merge one occurrence: type-only only if every occurrence is, dynamic if any is. */
function recordImport(result: Map<string, ImportKind>, specifier: string, typeOnly: boolean, dynamic: boolean): void {
  const previous = result.get(specifier);
  result.set(specifier, { typeOnly: previous ? previous.typeOnly && typeOnly : typeOnly, dynamic: previous?.dynamic === true || dynamic });
}

/** A top-level `import … from "x"` or `export … from "x"`. */
function staticEdge(statement: ts.Statement): { readonly specifier: string; readonly typeOnly: boolean } | undefined {
  if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
    return { specifier: statement.moduleSpecifier.text, typeOnly: importClauseIsTypeOnly(statement.importClause) };
  }
  if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
    return { specifier: statement.moduleSpecifier.text, typeOnly: statement.isTypeOnly };
  }
  return undefined;
}

function importClauseIsTypeOnly(clause: ts.ImportClause | undefined): boolean {
  if (clause === undefined) return false;
  if (clause.phaseModifier === ts.SyntaxKind.TypeKeyword) return true;
  const named = clause.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements : [];
  // `import { type A, type B } from "x"` is type-only in substance even
  // though the clause itself is not marked so.
  return clause.name === undefined && named.length > 0 && named.every((item) => item.isTypeOnly);
}

/** A dynamic `import("x")` call or an `import("x")` type reference anywhere in the file. */
function expressionEdge(node: ts.Node): { readonly specifier: string; readonly typeOnly: boolean; readonly dynamic: boolean } | undefined {
  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    const argument = node.arguments.length === 1 ? node.arguments[0] : undefined;
    return argument && ts.isStringLiteral(argument) ? { specifier: argument.text, typeOnly: false, dynamic: true } : undefined;
  }
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
    return { specifier: node.argument.literal.text, typeOnly: true, dynamic: false };
  }
  return undefined;
}

const exportProbeCache = new Map<string, boolean>();

function exportsAnything(parsed: ts.SourceFile | undefined): boolean {
  return parsed?.statements.some(isExportStatement) ?? false;
}

function isExportStatement(statement: ts.Statement): boolean {
  if (ts.isExportDeclaration(statement) || ts.isExportAssignment(statement)) return true;
  return ts.canHaveModifiers(statement) && (ts.getModifiers(statement) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
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
  return { kinds: parsed ? collectImportKinds(parsed) : new Map<string, ImportKind>(), hasExports };
}

export function resetSyntaxCaches(): void {
  exportProbeCache.clear();
}
