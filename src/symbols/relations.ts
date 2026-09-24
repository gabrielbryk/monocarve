import ts from "typescript";

import { byCodeUnit, hashText, stableStringify, type Sha256 } from "../util/hash.ts";
import { makeSpan, mergeSpaces, type PhysicalDeclaration } from "./declarations.ts";
import type { DeclarationComponent, DeclarationGroup, SymbolDeclaration, SymbolEdge, SymbolReference } from "./types.ts";

interface MutableReferenceEdge {
  readonly source: Sha256;
  readonly target: Sha256;
  readonly references: SymbolReference[];
}

export function collectEdges(
  checker: ts.TypeChecker,
  sourceText: string,
  physicalById: ReadonlyMap<Sha256, PhysicalDeclaration>,
  recordById: ReadonlyMap<Sha256, SymbolDeclaration>,
  groupByName: ReadonlyMap<string, DeclarationGroup>,
  groupBySymbol: ReadonlyMap<ts.Symbol, DeclarationGroup>,
): SymbolEdge[] {
  const mutable = new Map<string, MutableReferenceEdge>();
  for (const [declarationId, physical] of physicalById) {
    const sourceRecord = recordById.get(declarationId);
    const sourceGroup = sourceRecord ? groupByName.get(sourceRecord.name) : undefined;
    if (!sourceGroup) continue;
    collectDeclarationEdges(checker, sourceText, declarationId, physical.node, sourceGroup, groupBySymbol, mutable);
  }
  return [...mutable.values()].map(finalizeEdge).toSorted(compareEdges);
}

export function referenceSpace(identifier: ts.Identifier): "type" | "value" {
  let node: ts.Node = identifier;
  while (node.parent && !ts.isStatement(node.parent) && !ts.isSourceFile(node.parent)) {
    const parent = node.parent;
    if (ts.isTypeQueryNode(parent)) return "value";
    if (ts.isExpressionWithTypeArguments(parent)) {
      const heritage = parent.parent;
      if (ts.isHeritageClause(heritage)) {
        if (heritage.token === ts.SyntaxKind.ImplementsKeyword) return "type";
        return ts.isInterfaceDeclaration(heritage.parent) ? "type" : "value";
      }
    }
    if (ts.isTypeNode(parent)) return "type";
    node = parent;
  }
  return "value";
}

export function stronglyConnectedComponents(groups: readonly DeclarationGroup[], edges: readonly SymbolEdge[]): DeclarationComponent[] {
  const adjacency = new Map(groups.map((group) => [group.id, [] as Sha256[]]));
  for (const edge of edges) adjacency.get(edge.source)?.push(edge.target);
  for (const targets of adjacency.values()) targets.sort(byCodeUnit);
  const state = createTraversalState();
  for (const group of [...groups].toSorted((left, right) => byCodeUnit(left.id, right.id))) {
    if (!state.indices.has(group.id)) visitComponent(group.id, adjacency, state);
  }
  const selfEdges = new Set(edges.filter((edge) => edge.source === edge.target).map((edge) => edge.source));
  return state.components
    .map((groupIds) => ({
      id: hashText(stableStringify(groupIds)),
      groupIds,
      cyclic: groupIds.length > 1 || (groupIds[0] !== undefined && selfEdges.has(groupIds[0])),
    }))
    .toSorted((left, right) => byCodeUnit(left.groupIds[0] ?? "", right.groupIds[0] ?? ""));
}

function collectDeclarationEdges(
  checker: ts.TypeChecker,
  sourceText: string,
  declarationId: Sha256,
  node: ts.Declaration,
  sourceGroup: DeclarationGroup,
  groupBySymbol: ReadonlyMap<ts.Symbol, DeclarationGroup>,
  mutable: Map<string, MutableReferenceEdge>,
): void {
  const visit = (current: ts.Node): void => {
    if (ts.isIdentifier(current) && !isDeclarationName(current)) {
      const targetGroup = groupForIdentifier(checker, current, groupBySymbol);
      if (targetGroup) addReference(sourceText, declarationId, sourceGroup, targetGroup, current, mutable);
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
}

function groupForIdentifier(
  checker: ts.TypeChecker,
  node: ts.Identifier,
  groupBySymbol: ReadonlyMap<ts.Symbol, DeclarationGroup>,
): DeclarationGroup | undefined {
  let symbol =
    ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
      ? checker.getShorthandAssignmentValueSymbol(node.parent)
      : checker.getSymbolAtLocation(node);
  if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol);
  return symbol ? groupBySymbol.get(symbol) : undefined;
}

function addReference(
  sourceText: string,
  declarationId: Sha256,
  sourceGroup: DeclarationGroup,
  targetGroup: DeclarationGroup,
  node: ts.Identifier,
  mutable: Map<string, MutableReferenceEdge>,
): void {
  const reference: SymbolReference = { sourceDeclarationId: declarationId, span: makeSpan(sourceText, node.getStart(), node.end), space: referenceSpace(node) };
  const key = `${sourceGroup.id}\0${targetGroup.id}`;
  const edge = mutable.get(key) ?? { source: sourceGroup.id, target: targetGroup.id, references: [] };
  edge.references.push(reference);
  mutable.set(key, edge);
}

function finalizeEdge(edge: MutableReferenceEdge): SymbolEdge {
  edge.references.sort(
    (left, right) =>
      left.span.start - right.span.start || byCodeUnit(left.sourceDeclarationId, right.sourceDeclarationId) || byCodeUnit(left.space, right.space),
  );
  return { source: edge.source, target: edge.target, space: mergeSpaces(edge.references.map((reference) => reference.space)), references: edge.references };
}

function compareEdges(left: SymbolEdge, right: SymbolEdge): number {
  return byCodeUnit(left.source, right.source) || byCodeUnit(left.target, right.target);
}

function isDeclarationName(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === identifier) return true;
  if (ts.isPropertyAssignment(parent) && parent.name === identifier && !ts.isComputedPropertyName(parent.name)) return true;
  if (ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent) || ts.isParameter(parent)) return parent.name === identifier;
  if (isNamedDeclaration(parent)) return parent.name === identifier;
  if (ts.isBindingElement(parent)) return parent.name === identifier || parent.propertyName === identifier;
  return ts.isImportClause(parent) || ts.isImportSpecifier(parent) || ts.isNamespaceImport(parent);
}

function isNamedDeclaration(node: ts.Node): node is ts.NamedDeclaration {
  return (
    ts.isClassDeclaration(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isModuleDeclaration(node) ||
    ts.isVariableDeclaration(node) ||
    ts.isTypeParameterDeclaration(node)
  );
}

interface TraversalState {
  nextIndex: number;
  readonly indices: Map<Sha256, number>;
  readonly lowLinks: Map<Sha256, number>;
  readonly stack: Sha256[];
  readonly onStack: Set<Sha256>;
  readonly components: Sha256[][];
}

function createTraversalState(): TraversalState {
  return { nextIndex: 0, indices: new Map(), lowLinks: new Map(), stack: [], onStack: new Set(), components: [] };
}

function visitComponent(id: Sha256, adjacency: ReadonlyMap<Sha256, readonly Sha256[]>, state: TraversalState): void {
  const index = state.nextIndex++;
  state.indices.set(id, index);
  state.lowLinks.set(id, index);
  state.stack.push(id);
  state.onStack.add(id);
  for (const target of adjacency.get(id) ?? []) updateTraversalForTarget(id, target, adjacency, state, index);
  if (state.lowLinks.get(id) === state.indices.get(id)) state.components.push(popComponent(id, state));
}

function updateTraversalForTarget(id: Sha256, target: Sha256, adjacency: ReadonlyMap<Sha256, readonly Sha256[]>, state: TraversalState, index: number): void {
  if (!state.indices.has(target)) {
    visitComponent(target, adjacency, state);
    state.lowLinks.set(id, Math.min(state.lowLinks.get(id) ?? index, state.lowLinks.get(target) ?? index));
  } else if (state.onStack.has(target)) {
    state.lowLinks.set(id, Math.min(state.lowLinks.get(id) ?? index, state.indices.get(target) ?? index));
  }
}

function popComponent(id: Sha256, state: TraversalState): Sha256[] {
  const members: Sha256[] = [];
  while (state.stack.length > 0) {
    const member = state.stack.pop();
    if (!member) break;
    state.onStack.delete(member);
    members.push(member);
    if (member === id) break;
  }
  return members.sort(byCodeUnit);
}
