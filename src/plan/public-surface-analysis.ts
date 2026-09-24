import ts from "typescript";

import { byCodeUnit } from "../util/hash.ts";
import type { ExportSurface } from "./public-surface.ts";

interface ExportMetadata {
  readonly explicitTypeOnly: ReadonlyMap<string, boolean>;
  readonly explicitlyExported: ReadonlySet<string>;
  readonly hasExportStar: boolean;
}

function symbolIsTypeOnly(symbol: ts.Symbol): boolean {
  const declarations = symbol.declarations ?? [];
  const onlyTypes = declarations.length > 0 && declarations.every(isTypeOnlyDeclaration);
  return onlyTypes || ((symbol.flags & ts.SymbolFlags.Type) !== 0 && (symbol.flags & ts.SymbolFlags.Value) === 0);
}

function isTypeOnlyDeclaration(declaration: ts.Declaration): boolean {
  return (
    ts.isInterfaceDeclaration(declaration) ||
    ts.isTypeAliasDeclaration(declaration) ||
    ts.isTypeParameterDeclaration(declaration) ||
    (ts.isImportSpecifier(declaration) && declaration.isTypeOnly)
  );
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) => (ts.isBindingElement(element) ? bindingNames(element.name) : []));
}

function recordModifierExport(statement: ts.Statement, exported: Set<string>): void {
  const modifiers = ts.canHaveModifiers(statement) ? (ts.getModifiers(statement) ?? []) : [];
  if (!modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) return;
  if (modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) {
    exported.add("default");
    return;
  }
  if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      for (const name of bindingNames(declaration.name)) exported.add(name);
    }
    return;
  }
  const name = namedDeclarationName(statement);
  if (name) exported.add(name);
}

function namedDeclarationName(statement: ts.Statement): string | undefined {
  if (
    ts.isFunctionDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isEnumDeclaration(statement)
  ) {
    return statement.name?.text;
  }
  return undefined;
}

function recordExportDeclaration(statement: ts.ExportDeclaration, exported: Set<string>, typeOnly: Map<string, boolean>): boolean {
  if (!statement.exportClause) return true;
  if (ts.isNamespaceExport(statement.exportClause)) {
    exported.add(statement.exportClause.name.text);
    return false;
  }
  for (const element of statement.exportClause.elements) {
    const name = element.name.text;
    exported.add(name);
    typeOnly.set(name, (typeOnly.get(name) ?? true) && (statement.isTypeOnly || element.isTypeOnly));
  }
  return false;
}

function exportMetadata(sourceFile: ts.SourceFile): ExportMetadata {
  const explicitTypeOnly = new Map<string, boolean>();
  const explicitlyExported = new Set<string>();
  let hasExportStar = false;
  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement)) {
      explicitlyExported.add("default");
    } else {
      recordModifierExport(statement, explicitlyExported);
    }
    if (ts.isExportDeclaration(statement)) {
      hasExportStar = recordExportDeclaration(statement, explicitlyExported, explicitTypeOnly) || hasExportStar;
    }
  }
  return { explicitTypeOnly, explicitlyExported, hasExportStar };
}

/** Resolves and classifies the exported symbols of an already-loaded source file. */
export function resolveExportSurface(checker: ts.TypeChecker, sourceFile: ts.SourceFile): ExportSurface[] {
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) return [];
  const metadata = exportMetadata(sourceFile);
  return checker
    .getExportsOfModule(moduleSymbol)
    .filter((symbol) => metadata.hasExportStar || metadata.explicitlyExported.has(symbol.getName()))
    .map((symbol) => ({ name: symbol.getName(), typeOnly: metadata.explicitTypeOnly.get(symbol.getName()) ?? symbolIsTypeOnly(symbol) }))
    .sort((left, right) => byCodeUnit(left.name, right.name));
}
