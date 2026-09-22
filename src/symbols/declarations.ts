import ts from "typescript";

import { byCodeUnit, hashJson, hashText, type Sha256 } from "../util/hash.ts";
import { SymbolAnalysisError } from "./error.ts";
import type { DeclarationGroup, DeclarationKind, SourceSpan, SymbolDeclaration, SymbolSpace } from "./types.ts";

export interface PhysicalDeclaration {
  readonly record: SymbolDeclaration;
  readonly node: ts.Declaration;
  readonly symbol: ts.Symbol | undefined;
}

export function collectDeclarations(sourceFile: ts.SourceFile, checker: ts.TypeChecker, sourcePath: string, sourceText: string): PhysicalDeclaration[] {
  const result: PhysicalDeclaration[] = [];
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        for (const identifier of bindingIdentifiers(declaration.name)) {
          result.push(makeDeclaration(sourcePath, sourceText, declaration, identifier.text, "variable", checker, identifier));
        }
      }
      continue;
    }

    const kind = declarationKind(statement);
    if (!kind) continue;
    const declaration = statement as
      | ts.ClassDeclaration
      | ts.EnumDeclaration
      | ts.FunctionDeclaration
      | ts.InterfaceDeclaration
      | ts.ModuleDeclaration
      | ts.TypeAliasDeclaration;
    if (ts.isModuleDeclaration(declaration) && !ts.isIdentifier(declaration.name)) {
      throw new SymbolAnalysisError("string-literal module declarations cannot be assigned a movable declaration identity", []);
    }
    const nameNode = declaration.name;
    const name = nameNode && ts.isIdentifier(nameNode) ? nameNode.text : defaultDeclarationName(declaration);
    result.push(makeDeclaration(sourcePath, sourceText, declaration, name, kind, checker, nameNode));
  }
  return result;
}

export function collectExportedSymbols(sourceFile: ts.SourceFile, checker: ts.TypeChecker): Set<ts.Symbol> {
  const result = new Set<ts.Symbol>();
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) return result;
  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    result.add(exported);
    if ((exported.flags & ts.SymbolFlags.Alias) !== 0) {
      const target = checker.getAliasedSymbol(exported);
      if (target) result.add(target);
    }
  }
  return result;
}

export function compareDeclarations(left: SymbolDeclaration, right: SymbolDeclaration): number {
  return left.span.start - right.span.start || byCodeUnit(left.name, right.name) || byCodeUnit(left.id, right.id);
}

export function buildGroups(sourcePath: string, declarations: readonly SymbolDeclaration[]): DeclarationGroup[] {
  const byName = new Map<string, SymbolDeclaration[]>();
  for (const declaration of declarations) {
    const existing = byName.get(declaration.name) ?? [];
    existing.push(declaration);
    byName.set(declaration.name, existing);
  }
  return [...byName.entries()]
    .sort(([left], [right]) => byCodeUnit(left, right))
    .map(([name, members]) => {
      const declarationIds = members.map((member) => member.id);
      return {
        id: hashJson({ sourcePath, name, declarationIds }),
        sourcePath,
        name,
        declarationIds,
        exported: members.some((member) => member.exported),
        space: mergeSpaces(members.map((member) => member.space)),
      };
    });
}

export function makeSpan(sourceText: string, start: number, end: number): SourceSpan {
  return { start, end, hash: hashText(sourceText.slice(start, end)) };
}

export function mergeSpaces(spaces: readonly SymbolSpace[]): SymbolSpace {
  const hasType = spaces.some((space) => space === "type" || space === "both");
  const hasValue = spaces.some((space) => space === "value" || space === "both");
  return hasType && hasValue ? "both" : hasType ? "type" : "value";
}

function bindingIdentifiers(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) return [name];
  return name.elements.flatMap((element) => (ts.isOmittedExpression(element) ? [] : bindingIdentifiers(element.name)));
}

function declarationKind(node: ts.Statement): DeclarationKind | undefined {
  if (ts.isClassDeclaration(node)) return "class";
  if (ts.isEnumDeclaration(node)) return "enum";
  if (ts.isFunctionDeclaration(node)) return "function";
  if (ts.isInterfaceDeclaration(node)) return "interface";
  if (ts.isModuleDeclaration(node)) return "namespace";
  if (ts.isTypeAliasDeclaration(node)) return "type-alias";
  return undefined;
}

function defaultDeclarationName(node: ts.Declaration): string {
  const modifiers = ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : [];
  if (modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) return "default";
  throw new SymbolAnalysisError(`anonymous ${ts.SyntaxKind[node.kind] ?? "declaration"} has no stable symbol name`, []);
}

function makeDeclaration(
  sourcePath: string,
  sourceText: string,
  node: ts.Declaration,
  name: string,
  kind: DeclarationKind,
  checker: ts.TypeChecker,
  nameNode: ts.Node | undefined,
): PhysicalDeclaration {
  const start = node.getStart();
  const end = node.end;
  const span = makeSpan(sourceText, start, end);
  const symbol = nameNode ? checker.getSymbolAtLocation(nameNode) : undefined;
  // Classify the physical declaration, not its potentially merged symbol. An
  // `interface Token` merged with `const Token` remains a type declaration and
  // a value declaration; their declaration group is what becomes `both`.
  const space = declarationSpace(kind);
  const id: Sha256 = hashJson({ sourcePath, name, kind, start, end, spanHash: span.hash });
  return { node, symbol, record: { id, sourcePath, name, kind, span, exported: hasExportModifier(node), space } };
}

function hasExportModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword || modifier.kind === ts.SyntaxKind.DefaultKeyword)
  );
}

function declarationSpace(kind: DeclarationKind): SymbolSpace {
  if (kind === "class" || kind === "enum") return "both";
  if (kind === "interface" || kind === "type-alias") return "type";
  return "value";
}
