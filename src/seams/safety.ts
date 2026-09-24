import ts from "typescript";

import type { DeclarationGroup, SymbolDeclaration, SymbolGraph } from "../symbols/types.ts";
import { byCodeUnit, hashText, type Sha256 } from "../util/hash.ts";

/** A reason a declaration group cannot be extracted by the type-only preparer. */
export type TypeOnlyExtractionRefusalCode =
  | "graph-source-mismatch"
  | "unknown-declaration-group"
  | "incomplete-declaration-group"
  | "declaration-span-mismatch"
  | "type-value-mixed-group"
  | "default-export"
  | "runtime-namespace"
  | "enum-declaration"
  | "module-augmentation"
  | "ambient-declaration"
  | "function-overload-group"
  | "non-type-declaration";

/** Stable source evidence; offsets are UTF-16 offsets used by TypeScript. */
export interface TypeOnlyExtractionEvidence {
  readonly code: TypeOnlyExtractionRefusalCode;
  readonly message: string;
  readonly start?: number;
  readonly end?: number;
  readonly declarationId?: Sha256;
}

/** Input deliberately contains no filesystem or checker state, so classification is pure. */
export interface ClassifyTypeOnlyExtractionInput {
  readonly sourceText: string;
  readonly graph: SymbolGraph;
  readonly groupId: Sha256;
  /** A caller choosing less than the complete group must be refused. */
  readonly selectedDeclarationIds?: readonly Sha256[];
}

export interface TypeOnlyExtractionSafety {
  readonly groupId: Sha256;
  readonly eligible: boolean;
  readonly declarationIds: readonly Sha256[];
  readonly evidence: readonly TypeOnlyExtractionEvidence[];
}

/**
 * Classify whether a graph group is safe for the first writable preparer.
 *
 * This intentionally permits only complete groups made exclusively of
 * interfaces and type aliases. `declare` is accepted on those two forms because
 * it does not add a value-space binding or emitted JavaScript. Every other
 * ambient declaration remains outside the writable boundary. A passing result
 * does not prove wiring is valid; it proves this syntactic safety boundary did
 * not reject the group.
 */
export function classifyTypeOnlyExtraction(input: ClassifyTypeOnlyExtractionInput): TypeOnlyExtractionSafety {
  const group = input.graph.groups.find((candidate) => candidate.id === input.groupId);
  if (!group)
    return refused(
      input.groupId,
      [],
      [{ code: "unknown-declaration-group", message: `declaration group ${input.groupId} is not present in the symbol graph` }],
    );

  const members = groupMembers(input.graph, group);
  const evidence: TypeOnlyExtractionEvidence[] = [];
  if (hashText(input.sourceText) !== input.graph.sourceHash) {
    evidence.push({ code: "graph-source-mismatch", message: "source text does not match the symbol graph source hash" });
  }
  evidence.push(...selectionEvidence(group, input.selectedDeclarationIds));
  if (members.length !== group.declarationIds.length) {
    evidence.push({ code: "incomplete-declaration-group", message: `group ${group.name} references declaration identities absent from the graph` });
  }
  if (group.space === "both") {
    evidence.push({ code: "type-value-mixed-group", message: `group ${group.name} occupies both TypeScript declaration spaces` });
  }

  const sourceFile = ts.createSourceFile(input.graph.sourcePath, input.sourceText, ts.ScriptTarget.Latest, true);
  const nodes = topLevelDeclarationNodes(sourceFile);
  const expectedSpans = new Set(members.map((member) => spanKey(member.span.start, member.span.end)));
  const actualNamed = nodes.filter((node) => node.names.includes(group.name));
  const actualSpans = new Set(actualNamed.map((node) => spanKey(node.node.getStart(sourceFile), node.node.end)));
  if (!sameSet(expectedSpans, actualSpans)) {
    evidence.push({ code: "incomplete-declaration-group", message: `group ${group.name} does not cover every same-name top-level declaration in source` });
  }

  for (const member of members) {
    const node = nodes.find((candidate) => spanKey(candidate.node.getStart(sourceFile), candidate.node.end) === spanKey(member.span.start, member.span.end));
    if (!node) {
      evidence.push({
        code: "declaration-span-mismatch",
        message: `graph declaration ${member.name} does not match a top-level source declaration`,
        start: member.span.start,
        end: member.span.end,
        declarationId: member.id,
      });
      continue;
    }
    evidence.push(...nodeRefusals(node.node, member, sourceFile));
  }
  return refused(group.id, group.declarationIds, evidence);
}

function groupMembers(graph: SymbolGraph, group: DeclarationGroup): SymbolDeclaration[] {
  const byId = new Map(graph.declarations.map((declaration) => [declaration.id, declaration]));
  return group.declarationIds.flatMap((id) => {
    const member = byId.get(id);
    return member ? [member] : [];
  });
}

function selectionEvidence(group: DeclarationGroup, selected: readonly Sha256[] | undefined): TypeOnlyExtractionEvidence[] {
  if (!selected) return [];
  const expected = [...group.declarationIds].toSorted(byCodeUnit);
  const actual = [...new Set(selected)].toSorted(byCodeUnit);
  return sameSet(new Set(expected), new Set(actual))
    ? []
    : [{ code: "incomplete-declaration-group", message: `selection must include every declaration in merged group ${group.name}` }];
}

function nodeRefusals(node: ts.Declaration, declaration: SymbolDeclaration, sourceFile: ts.SourceFile): TypeOnlyExtractionEvidence[] {
  const at = { start: node.getStart(sourceFile), end: node.end, declarationId: declaration.id };
  const modifiers = ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : [];
  const has = (kind: ts.SyntaxKind) => modifiers.some((modifier) => modifier.kind === kind);
  if (has(ts.SyntaxKind.DefaultKeyword))
    return [{ code: "default-export", message: `default export ${declaration.name} cannot retain a compatible named re-export`, ...at }];
  if (ts.isModuleDeclaration(node)) {
    if (ts.isStringLiteral(node.name))
      return [{ code: "module-augmentation", message: "string-literal module declarations cannot be extracted as type-only declarations", ...at }];
    return [
      {
        code: has(ts.SyntaxKind.DeclareKeyword) ? "module-augmentation" : "runtime-namespace",
        message: has(ts.SyntaxKind.DeclareKeyword)
          ? `ambient namespace ${declaration.name} may augment another declaration context`
          : `namespace ${declaration.name} is runtime-emitting`,
        ...at,
      },
    ];
  }
  if (ts.isEnumDeclaration(node)) return [{ code: "enum-declaration", message: `enum ${declaration.name} is both a type and a runtime value`, ...at }];
  if (has(ts.SyntaxKind.DeclareKeyword) && !ts.isInterfaceDeclaration(node) && !ts.isTypeAliasDeclaration(node))
    return [{ code: "ambient-declaration", message: `ambient declaration ${declaration.name} is outside the writable preparer's scope`, ...at }];
  if (has(ts.SyntaxKind.DeclareKeyword) && !declaration.exported)
    return [
      {
        code: "ambient-declaration",
        message: `non-exported ambient type ${declaration.name} may provide script-global visibility that extraction cannot preserve`,
        ...at,
      },
    ];
  if (ts.isFunctionDeclaration(node))
    return [{ code: "function-overload-group", message: `function declaration ${declaration.name} may be an overload group and is runtime-emitting`, ...at }];
  if (declaration.space !== "type") return [{ code: "non-type-declaration", message: `${declaration.kind} ${declaration.name} is not type-only`, ...at }];
  return [];
}

function topLevelDeclarationNodes(sourceFile: ts.SourceFile): TopLevelDeclaration[] {
  const result: TopLevelDeclaration[] = [];
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const node of statement.declarationList.declarations) result.push({ node, names: bindingNames(node.name) });
      continue;
    }
    if (isNamedDeclaration(statement)) result.push({ node: statement, names: statement.name ? [declarationName(statement)] : [] });
  }
  return result;
}

function isNamedDeclaration(
  node: ts.Statement,
): node is ts.ClassDeclaration | ts.EnumDeclaration | ts.FunctionDeclaration | ts.InterfaceDeclaration | ts.ModuleDeclaration | ts.TypeAliasDeclaration {
  return (
    ts.isClassDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isModuleDeclaration(node) ||
    ts.isTypeAliasDeclaration(node)
  );
}

function declarationName(node: ts.NamedDeclaration): string {
  return node.name && ts.isIdentifier(node.name) ? node.name.text : "default";
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) => (ts.isOmittedExpression(element) ? [] : bindingNames(element.name)));
}

function refused(groupId: Sha256, declarationIds: readonly Sha256[], evidence: readonly TypeOnlyExtractionEvidence[]): TypeOnlyExtractionSafety {
  const sorted = [...evidence].toSorted(compareEvidence);
  return { groupId, declarationIds: [...declarationIds], eligible: sorted.length === 0, evidence: sorted };
}

function compareEvidence(left: TypeOnlyExtractionEvidence, right: TypeOnlyExtractionEvidence): number {
  return (
    (left.start ?? -1) - (right.start ?? -1) ||
    (left.end ?? -1) - (right.end ?? -1) ||
    byCodeUnit(left.code, right.code) ||
    byCodeUnit(left.message, right.message)
  );
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function spanKey(start: number, end: number): string {
  return `${start}:${end}`;
}

interface TopLevelDeclaration {
  readonly node: ts.Declaration;
  readonly names: readonly string[];
}
