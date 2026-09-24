import ts from "typescript";

import { byCodeUnit } from "../util/hash.ts";
import { relativeWorkspacePath, workspacePath } from "../util/paths.ts";
import { SymbolAnalysisError } from "./analyze.ts";
import { workspaceProgram } from "./workspace.ts";

interface CapabilityPartition {
  readonly affinities: readonly string[];
  readonly properties: readonly string[];
  readonly declarations: readonly string[];
}

export interface CapabilityPartitionReport {
  readonly schema: "capability-partitions";
  readonly sourcePath: string;
  readonly interfaceName: string;
  readonly properties: readonly string[];
  readonly unusedProperties: readonly string[];
  readonly partitions: readonly CapabilityPartition[];
}

interface CapabilityPartitionInput {
  readonly rootDir: string;
  readonly tsconfigPath: string;
  readonly sourcePath: string;
  readonly interfaceName: string;
  readonly affinityForPath: (path: string) => string;
}

interface PropertyUse {
  readonly declarations: Set<string>;
  readonly affinities: Set<string>;
}

/** Suggest narrow context interfaces from property use and consumer affinity. */
export function analyzeCapabilityPartitions(input: CapabilityPartitionInput): CapabilityPartitionReport {
  const sourcePath = relativeWorkspacePath(input.rootDir, input.sourcePath);
  const absolute = workspacePath(input.rootDir, sourcePath);
  const program = workspaceProgram(input.rootDir, input.tsconfigPath);
  const declaration = findInterface(program, absolute, sourcePath, input);
  const checker = program.getTypeChecker();
  const properties = declaration.members.flatMap((member) => (member.name && ts.isIdentifier(member.name) ? [member.name.text] : [])).toSorted(byCodeUnit);
  const uses = new Map<string, PropertyUse>();
  for (const property of properties) uses.set(property, { declarations: new Set(), affinities: new Set() });
  const propertyDeclarations = new Set<ts.Node>(declaration.members);
  for (const candidate of program.getSourceFiles()) {
    if (!candidate.isDeclarationFile) recordPropertyUses(candidate, checker, propertyDeclarations, uses, input);
  }
  return {
    schema: "capability-partitions",
    sourcePath,
    interfaceName: input.interfaceName,
    properties,
    unusedProperties: properties.filter((property) => uses.get(property)!.affinities.size === 0),
    partitions: partitionsByAffinity(uses),
  };
}

function findInterface(program: ts.Program, absolute: string, sourcePath: string, input: CapabilityPartitionInput): ts.InterfaceDeclaration {
  const file =
    program.getSourceFile(absolute) ?? program.getSourceFiles().find((entry) => entry.fileName.replaceAll("\\", "/") === absolute.replaceAll("\\", "/"));
  if (!file) throw new SymbolAnalysisError(`${sourcePath} is not included by ${input.tsconfigPath}`, []);
  const declaration = file.statements.find(
    (statement): statement is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(statement) && statement.name.text === input.interfaceName,
  );
  if (!declaration) throw new SymbolAnalysisError(`interface ${input.interfaceName} was not found in ${sourcePath}`, []);
  return declaration;
}

/** Record every access in `candidate` that the checker resolves to one of the interface's members. */
function recordPropertyUses(
  candidate: ts.SourceFile,
  checker: ts.TypeChecker,
  propertyDeclarations: ReadonlySet<ts.Node>,
  uses: ReadonlyMap<string, PropertyUse>,
  input: CapabilityPartitionInput,
): void {
  const visit = (node: ts.Node): void => {
    const nameNode = accessedName(node);
    if (nameNode && resolvesToMember(checker, nameNode, propertyDeclarations)) {
      const record = uses.get(nameNode.text)!;
      record.affinities.add(input.affinityForPath(relativeWorkspacePath(input.rootDir, candidate.fileName)));
      const owner = topLevelName(node);
      if (owner) record.declarations.add(owner);
    }
    ts.forEachChild(node, visit);
  };
  visit(candidate);
}

/** The identifier or string literal naming the member in `a.b` or `a["b"]`, if any. */
function accessedName(node: ts.Node): ts.Identifier | ts.StringLiteral | undefined {
  if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return undefined;
  const nameNode = ts.isPropertyAccessExpression(node) ? node.name : node.argumentExpression;
  return nameNode && (ts.isIdentifier(nameNode) || ts.isStringLiteral(nameNode)) ? nameNode : undefined;
}

function resolvesToMember(checker: ts.TypeChecker, nameNode: ts.Node, propertyDeclarations: ReadonlySet<ts.Node>): boolean {
  let symbol = checker.getSymbolAtLocation(nameNode);
  if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol);
  return symbol?.declarations?.some((entry) => propertyDeclarations.has(entry)) === true;
}

/** Group used properties by their exact consumer-affinity set. */
function partitionsByAffinity(uses: ReadonlyMap<string, PropertyUse>): CapabilityPartition[] {
  const grouped = new Map<string, { affinities: string[]; properties: string[]; declarations: Set<string> }>();
  for (const [property, use] of uses) {
    if (use.affinities.size === 0) continue;
    const affinities = [...use.affinities].toSorted(byCodeUnit);
    const key = affinities.join("\0");
    const group = grouped.get(key) ?? { affinities, properties: [], declarations: new Set() };
    group.properties.push(property);
    use.declarations.forEach((name) => group.declarations.add(name));
    grouped.set(key, group);
  }
  return [...grouped.values()]
    .map((group) => ({
      affinities: group.affinities,
      properties: group.properties.sort(byCodeUnit),
      declarations: [...group.declarations].toSorted(byCodeUnit),
    }))
    .toSorted(
      (left, right) => byCodeUnit(left.affinities.join("/"), right.affinities.join("/")) || byCodeUnit(left.properties.join("/"), right.properties.join("/")),
    );
}

function topLevelName(node: ts.Node): string | undefined {
  let current: ts.Node = node;
  while (current.parent && !ts.isSourceFile(current.parent)) current = current.parent;
  if (ts.isFunctionDeclaration(current) || ts.isClassDeclaration(current) || ts.isInterfaceDeclaration(current) || ts.isTypeAliasDeclaration(current))
    return current.name?.text;
  if (ts.isVariableStatement(current))
    return current.declarationList.declarations.flatMap((entry) => (ts.isIdentifier(entry.name) ? [entry.name.text] : []))[0];
  return undefined;
}
