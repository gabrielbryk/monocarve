import { basename } from "node:path";

import ts from "typescript";

import { MonocarveError } from "../errors.ts";
import { analyzeTypeScriptSource, referenceSpace } from "../symbols/analyze.ts";
import type { DeclarationGroup, SymbolDeclaration, SymbolGraph } from "../symbols/types.ts";
import { byCodeUnit, hashText, type Sha256 } from "../util/hash.ts";

/** A conservative refusal to turn a source declaration into a preparation plan. */
export class PreparationSelectionError extends MonocarveError {
  override readonly name = "PreparationSelectionError";
}

export interface SelectTypeOnlyDeclarationsInput {
  readonly sourcePath: string;
  readonly sourceText: string;
  /** Declaration-group identities from the source symbol graph. */
  readonly groupIds?: readonly Sha256[];
  /** Stable top-level declaration names. Names and IDs form one union. */
  readonly names?: readonly string[];
  /** Exact owning-application compiler policy. */
  readonly compilerOptions: ts.CompilerOptions;
}

export interface PreparationSourceSpan {
  readonly start: number;
  readonly end: number;
  readonly hash: Sha256;
}

export interface SelectedTypeDeclaration {
  readonly groupId: Sha256;
  readonly name: string;
  readonly kind: "interface" | "type-alias";
  /** The declaration itself, excluding preceding comments and whitespace. */
  readonly declaration: PreparationSourceSpan;
  /** The exact range which must travel with the declaration, including JSDoc. */
  readonly extraction: PreparationSourceSpan;
  /** Hash of text before the declaration that extraction will preserve verbatim. */
  readonly leadingTriviaHash: Sha256;
  /** Whether this name was part of the donor's public surface before extraction. */
  readonly originallyExported: boolean;
  /** Every selected declaration must be exported by the new type-only module. */
  readonly targetExport: true;
}

export interface RequiredImportBinding {
  readonly localName: string;
  readonly importedName: string | "default" | "*";
  readonly moduleSpecifier: string;
  readonly kind: "default" | "named" | "namespace";
  readonly originallyTypeOnly: boolean;
  readonly requiredAs: "type";
}

export interface CompatibilityTypeExport {
  readonly name: string;
  readonly groupId: Sha256;
  /** The source module must preserve this public name with `export type`. */
  readonly reexportAs: "type";
}

export interface RetainedTypeConsumer {
  readonly groupId: Sha256;
  readonly name: string;
  /** A local declaration that will need a type-only import after extraction. */
  readonly consumedByGroupIds: readonly Sha256[];
}

export interface RelativeInlineImportType {
  readonly originalSpecifier: string;
  readonly start: number;
  readonly end: number;
  readonly sourceHash: Sha256;
}

export interface TypeOnlyDeclarationSelection {
  readonly sourcePath: string;
  readonly sourceHash: Sha256;
  /** Requested groups plus their complete local type-only dependency closure. */
  readonly declarations: readonly SelectedTypeDeclaration[];
  readonly requestedGroupIds: readonly Sha256[];
  readonly closureGroupIds: readonly Sha256[];
  readonly imports: readonly RequiredImportBinding[];
  readonly relativeInlineImportTypes: readonly RelativeInlineImportType[];
  readonly compatibilitySurface: readonly CompatibilityTypeExport[];
  readonly retainedConsumers: readonly RetainedTypeConsumer[];
}

/**
 * Select a complete, type-only top-level declaration closure without writing.
 *
 * A failure is intentional: a caller must never turn an incomplete merge,
 * `typeof` value dependency, or executable declaration into a plausible plan.
 */
export function selectTypeOnlyDeclarations(input: SelectTypeOnlyDeclarationsInput): TypeOnlyDeclarationSelection {
  const graph = analyzeTypeScriptSource({ sourcePath: input.sourcePath, sourceText: input.sourceText });
  const requested = resolveRequestedGroups(graph, input);
  const closure = collectClosure(graph, requested);
  const semantic = createSemanticSource(graph.sourcePath, input.sourceText, input.compilerOptions);
  const statements = statementsByDeclaration(graph, semantic.sourceFile);
  const selected = [...closure].map((id) => groupForId(graph, id));
  for (const group of selected) assertEligibleGroup(group, graph, statements, input.sourceText);
  const selectedIds = new Set(selected.map((group) => group.id));
  const imports = collectRequiredImports(semantic.sourceFile, semantic.checker, selected, statements);
  const relativeInlineImportTypes = collectRelativeInlineImportTypes(selected, statements, input.sourceText);
  const declarations = selected.flatMap((group) => selectedDeclarations(group, graph, statements, input.sourceText));
  const compatibilitySurface = selected
    .filter((group) => group.exported)
    .map((group) => ({ name: group.name, groupId: group.id, reexportAs: "type" as const }))
    .sort(compareCompatibility);
  return {
    sourcePath: graph.sourcePath,
    sourceHash: graph.sourceHash,
    declarations: declarations.sort(compareSelectedDeclaration),
    requestedGroupIds: [...requested].sort(byCodeUnit),
    closureGroupIds: [...selectedIds].sort(byCodeUnit),
    imports,
    relativeInlineImportTypes,
    compatibilitySurface,
    retainedConsumers: retainedConsumers(graph, selectedIds),
  };
}

function resolveRequestedGroups(graph: SymbolGraph, input: SelectTypeOnlyDeclarationsInput): Set<Sha256> {
  const ids = input.groupIds ?? [];
  const names = input.names ?? [];
  if (ids.length + names.length === 0) throw new PreparationSelectionError("at least one declaration group ID or name is required");
  const knownIds = new Map(graph.groups.map((group) => [group.id, group]));
  const knownNames = new Map(graph.groups.map((group) => [group.name, group]));
  const result = new Set<Sha256>();
  for (const id of ids) {
    if (!knownIds.has(id)) throw new PreparationSelectionError(`unknown declaration group ID: ${id}`);
    if (result.has(id)) throw new PreparationSelectionError(`duplicate declaration group selector: ${id}`);
    result.add(id);
  }
  for (const name of names) {
    const group = knownNames.get(name);
    if (!group) throw new PreparationSelectionError(`unknown or ambiguous declaration name: ${name}`);
    if (result.has(group.id)) throw new PreparationSelectionError(`duplicate declaration group selector: ${name}`);
    result.add(group.id);
  }
  return result;
}

function collectClosure(graph: SymbolGraph, requested: ReadonlySet<Sha256>): Set<Sha256> {
  const result = new Set(requested);
  const pending = [...requested].sort(byCodeUnit);
  while (pending.length > 0) {
    const source = pending.shift();
    if (!source) continue;
    for (const edge of graph.edges.filter((candidate) => candidate.source === source)) {
      if (edge.space !== "type") throw new PreparationSelectionError(`type-only group ${source} has a value dependency on ${edge.target}`);
      if (!result.has(edge.target)) {
        result.add(edge.target);
        pending.push(edge.target);
        pending.sort(byCodeUnit);
      }
    }
  }
  return result;
}

function groupForId(graph: SymbolGraph, id: Sha256): DeclarationGroup {
  const group = graph.groups.find((candidate) => candidate.id === id);
  if (!group) throw new PreparationSelectionError(`unknown declaration group ID: ${id}`);
  return group;
}

function createSemanticSource(sourcePath: string, sourceText: string, compilerOptions: ts.CompilerOptions): SemanticSource {
  const virtualPath = `/__preparation_selector__/${basename(sourcePath)}`;
  const parsed = ts.createSourceFile(virtualPath, sourceText, ts.ScriptTarget.Latest, true);
  const host = ts.createCompilerHost(compilerOptions, true);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  const originalFileExists = host.fileExists.bind(host);
  const originalReadFile = host.readFile.bind(host);
  host.getSourceFile = (path, languageVersion, onError, shouldCreateNewSourceFile) =>
    path === virtualPath ? parsed : originalGetSourceFile(path, languageVersion, onError, shouldCreateNewSourceFile);
  host.fileExists = (path) => path === virtualPath || originalFileExists(path);
  host.readFile = (path) => (path === virtualPath ? sourceText : originalReadFile(path));
  const program = ts.createProgram([virtualPath], compilerOptions, host);
  const sourceFile = program.getSourceFile(virtualPath);
  if (!sourceFile) throw new PreparationSelectionError(`cannot parse ${sourcePath}`);
  return { sourceFile, checker: program.getTypeChecker() };
}

function statementsByDeclaration(graph: SymbolGraph, sourceFile: ts.SourceFile): Map<Sha256, ts.Statement> {
  const declarations = new Map(
    graph.declarations.map((declaration) => [`${declaration.name}\0${declaration.span.start}\0${declaration.span.end}`, declaration]),
  );
  const result = new Map<Sha256, ts.Statement>();
  for (const statement of sourceFile.statements) {
    const name = namedStatement(statement);
    if (!name) continue;
    const declaration = declarations.get(`${name}\0${statement.getStart(sourceFile)}\0${statement.end}`);
    if (declaration) result.set(declaration.id, statement);
  }
  return result;
}

function namedStatement(statement: ts.Statement): string | undefined {
  if (
    !ts.isInterfaceDeclaration(statement) &&
    !ts.isTypeAliasDeclaration(statement) &&
    !ts.isClassDeclaration(statement) &&
    !ts.isEnumDeclaration(statement) &&
    !ts.isFunctionDeclaration(statement) &&
    !ts.isModuleDeclaration(statement)
  )
    return undefined;
  const name = statement.name;
  return name && ts.isIdentifier(name) ? name.text : "default";
}

function assertEligibleGroup(group: DeclarationGroup, graph: SymbolGraph, statements: ReadonlyMap<Sha256, ts.Statement>, sourceText: string): void {
  if (group.space !== "type") throw new PreparationSelectionError(`${group.name} occupies type and/or value space`);
  const members = group.declarationIds.map((id) => declarationForId(graph.declarations, id));
  if (members.length !== group.declarationIds.length) throw new PreparationSelectionError(`incomplete declaration group: ${group.name}`);
  for (const member of members) {
    if (member.kind !== "interface" && member.kind !== "type-alias") throw new PreparationSelectionError(`${group.name} is not type-only`);
    const statement = statements.get(member.id);
    if (!statement) throw new PreparationSelectionError(`cannot locate exact top-level declaration for ${group.name}`);
    if (hasDefaultExport(statement)) throw new PreparationSelectionError(`default export ${group.name} cannot be extracted safely`);
    if (hasDeclareModifier(statement) && !member.exported) {
      throw new PreparationSelectionError(`non-exported ambient type ${group.name} may have script-global visibility`);
    }
    if (containsUnsafeTypeIdentity(statement)) throw new PreparationSelectionError(`${group.name} contains unsafe unique-symbol identity`);
    if (containsModuleAugmentation(statement)) throw new PreparationSelectionError(`${group.name} contains a module augmentation`);
    if (sourceText.slice(member.span.start, member.span.end).length === 0) throw new PreparationSelectionError(`empty declaration span: ${group.name}`);
  }
}

function declarationForId(declarations: readonly SymbolDeclaration[], id: Sha256): SymbolDeclaration {
  const declaration = declarations.find((candidate) => candidate.id === id);
  if (!declaration) throw new PreparationSelectionError(`incomplete declaration group: ${id}`);
  return declaration;
}

function hasDefaultExport(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
}

function hasDeclareModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword);
}

function containsUnsafeTypeIdentity(node: ts.Node): boolean {
  if (containsUniqueKeyword(node.getText())) return true;
  let typeQuery = false;
  const visit = (child: ts.Node): void => {
    if (ts.isTypeQueryNode(child)) typeQuery = true;
    ts.forEachChild(child, visit);
  };
  visit(node);
  return typeQuery;
}

function containsUniqueKeyword(text: string): boolean {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token === ts.SyntaxKind.UniqueKeyword) return true;
  }
  return false;
}

function containsModuleAugmentation(node: ts.Node): boolean {
  let augmentation = false;
  const visit = (child: ts.Node): void => {
    if (ts.isModuleDeclaration(child) && !ts.isIdentifier(child.name)) augmentation = true;
    ts.forEachChild(child, visit);
  };
  visit(node);
  return augmentation;
}

function collectRelativeInlineImportTypes(
  groups: readonly DeclarationGroup[],
  statements: ReadonlyMap<Sha256, ts.Statement>,
  sourceText: string,
): RelativeInlineImportType[] {
  const result: RelativeInlineImportType[] = [];
  for (const group of groups)
    for (const id of group.declarationIds) {
      const statement = statements.get(id);
      if (!statement) continue;
      const visit = (node: ts.Node): void => {
        if (ts.isImportTypeNode(node)) {
          if (node.isTypeOf) throw new PreparationSelectionError(`${group.name} contains a value-space inline import type`);
          if (!ts.isLiteralTypeNode(node.argument) || !ts.isStringLiteral(node.argument.literal)) {
            throw new PreparationSelectionError(`${group.name} contains an unsupported inline import type argument`);
          }
          const literal = node.argument.literal;
          if (literal.text.startsWith("./") || literal.text.startsWith("../")) {
            const start = literal.getStart(statement.getSourceFile());
            const end = literal.end;
            result.push({ originalSpecifier: literal.text, start, end, sourceHash: hashText(sourceText.slice(start, end)) });
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(statement);
    }
  return result.sort((left, right) => left.start - right.start || left.end - right.end || byCodeUnit(left.originalSpecifier, right.originalSpecifier));
}

function selectedDeclarations(
  group: DeclarationGroup,
  graph: SymbolGraph,
  statements: ReadonlyMap<Sha256, ts.Statement>,
  sourceText: string,
): SelectedTypeDeclaration[] {
  return group.declarationIds.map((id) => {
    const declaration = declarationForId(graph.declarations, id);
    const statement = statements.get(id);
    if (!statement || (declaration.kind !== "interface" && declaration.kind !== "type-alias")) {
      throw new PreparationSelectionError(`cannot select declaration ${group.name}`);
    }
    const extractionStart = statement.getFullStart();
    return {
      groupId: group.id,
      name: declaration.name,
      kind: declaration.kind,
      declaration: declaration.span,
      extraction: span(sourceText, extractionStart, declaration.span.end),
      leadingTriviaHash: hashText(sourceText.slice(extractionStart, declaration.span.start)),
      originallyExported: declaration.exported,
      targetExport: true,
    };
  });
}

function span(sourceText: string, start: number, end: number): PreparationSourceSpan {
  return { start, end, hash: hashText(sourceText.slice(start, end)) };
}

function collectRequiredImports(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  groups: readonly DeclarationGroup[],
  statements: ReadonlyMap<Sha256, ts.Statement>,
): RequiredImportBinding[] {
  const bindings = importBindings(sourceFile, checker);
  const result = new Map<string, RequiredImportBinding>();
  for (const group of groups) {
    for (const id of group.declarationIds) {
      const statement = statements.get(id);
      if (!statement) continue;
      visitReferences(statement, (identifier) => {
        const binding = symbolAt(checker, identifier, bindings);
        if (!binding) return;
        if (referenceSpace(identifier) !== "type") {
          throw new PreparationSelectionError(`${group.name} requires imported value ${identifier.text}`);
        }
        result.set(`${binding.moduleSpecifier}\0${binding.localName}`, binding);
      });
    }
  }
  return [...result.values()].sort(compareImport);
}

function importBindings(sourceFile: ts.SourceFile, checker: ts.TypeChecker): Map<ts.Symbol, RequiredImportBinding> {
  const result = new Map<ts.Symbol, RequiredImportBinding>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !statement.importClause) continue;
    const moduleSpecifier = statement.moduleSpecifier.text;
    const clauseTypeOnly = statement.importClause.isTypeOnly;
    if (statement.importClause.name) {
      addImport(result, checker, statement.importClause.name, {
        localName: statement.importClause.name.text,
        importedName: "default",
        moduleSpecifier,
        kind: "default",
        originallyTypeOnly: clauseTypeOnly,
        requiredAs: "type",
      });
    }
    const bindings = statement.importClause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      addImport(result, checker, bindings.name, {
        localName: bindings.name.text,
        importedName: "*",
        moduleSpecifier,
        kind: "namespace",
        originallyTypeOnly: clauseTypeOnly,
        requiredAs: "type",
      });
    }
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        addImport(result, checker, element.name, {
          localName: element.name.text,
          importedName: element.propertyName?.text ?? element.name.text,
          moduleSpecifier,
          kind: "named",
          originallyTypeOnly: clauseTypeOnly || element.isTypeOnly,
          requiredAs: "type",
        });
      }
    }
  }
  return result;
}

function addImport(result: Map<ts.Symbol, RequiredImportBinding>, checker: ts.TypeChecker, name: ts.Identifier, binding: RequiredImportBinding): void {
  const symbol = checker.getSymbolAtLocation(name);
  if (!symbol) throw new PreparationSelectionError(`cannot resolve imported binding: ${name.text}`);
  if (result.has(symbol)) throw new PreparationSelectionError(`ambiguous imported binding: ${name.text}`);
  result.set(symbol, binding);
}

function symbolAt(
  checker: ts.TypeChecker,
  identifier: ts.Identifier,
  bindings: ReadonlyMap<ts.Symbol, RequiredImportBinding>,
): RequiredImportBinding | undefined {
  const symbol = checker.getSymbolAtLocation(identifier);
  return symbol ? bindings.get(symbol) : undefined;
}

function visitReferences(node: ts.Node, onReference: (identifier: ts.Identifier) => void): void {
  const visit = (child: ts.Node): void => {
    if (ts.isIdentifier(child) && !isDeclarationName(child)) onReference(child);
    ts.forEachChild(child, visit);
  };
  visit(node);
}

function isDeclarationName(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
  if (ts.isQualifiedName(parent) && parent.right === node) return true;
  if (ts.isPropertySignature(parent) || ts.isMethodSignature(parent) || ts.isTypeParameterDeclaration(parent)) return parent.name === node;
  if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) return true;
  return ts.isInterfaceDeclaration(parent) || ts.isTypeAliasDeclaration(parent);
}

function retainedConsumers(graph: SymbolGraph, selectedIds: ReadonlySet<Sha256>): RetainedTypeConsumer[] {
  const consumers = new Map<Sha256, Set<Sha256>>();
  for (const edge of graph.edges) {
    if (!selectedIds.has(edge.target) || selectedIds.has(edge.source)) continue;
    if (edge.space !== "type") throw new PreparationSelectionError(`retained declaration has value dependency on extracted group ${edge.target}`);
    const set = consumers.get(edge.target) ?? new Set<Sha256>();
    set.add(edge.source);
    consumers.set(edge.target, set);
  }
  return [...consumers]
    .map(([groupId, ids]) => ({ groupId, name: groupForId(graph, groupId).name, consumedByGroupIds: [...ids].sort(byCodeUnit) }))
    .sort((left, right) => byCodeUnit(left.groupId, right.groupId));
}

function compareSelectedDeclaration(left: SelectedTypeDeclaration, right: SelectedTypeDeclaration): number {
  return left.declaration.start - right.declaration.start || byCodeUnit(left.groupId, right.groupId);
}

function compareImport(left: RequiredImportBinding, right: RequiredImportBinding): number {
  return byCodeUnit(left.moduleSpecifier, right.moduleSpecifier) || byCodeUnit(left.localName, right.localName);
}

function compareCompatibility(left: CompatibilityTypeExport, right: CompatibilityTypeExport): number {
  return byCodeUnit(left.name, right.name) || byCodeUnit(left.groupId, right.groupId);
}

interface SemanticSource {
  readonly sourceFile: ts.SourceFile;
  readonly checker: ts.TypeChecker;
}
