import ts from "typescript";

import { byCodeUnit } from "../util/hash.ts";
import { relativeWorkspacePath, workspacePath } from "../util/paths.ts";
import { SymbolAnalysisError } from "./analyze.ts";
import { workspaceProgram } from "./workspace.ts";

export interface CapabilityPartition {
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

/** Suggest narrow context interfaces from property use and consumer affinity. */
export function analyzeCapabilityPartitions(input: {
  readonly rootDir: string;
  readonly tsconfigPath: string;
  readonly sourcePath: string;
  readonly interfaceName: string;
  readonly affinityForPath: (path: string) => string;
}): CapabilityPartitionReport {
  const sourcePath = relativeWorkspacePath(input.rootDir, input.sourcePath);
  const absolute = workspacePath(input.rootDir, sourcePath);
  const program = workspaceProgram(input.rootDir, input.tsconfigPath);
  const file =
    program.getSourceFile(absolute) ?? program.getSourceFiles().find((entry) => entry.fileName.replaceAll("\\", "/") === absolute.replaceAll("\\", "/"));
  if (!file) throw new SymbolAnalysisError(`${sourcePath} is not included by ${input.tsconfigPath}`, []);
  const declaration = file.statements.find(
    (statement): statement is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(statement) && statement.name.text === input.interfaceName,
  );
  if (!declaration) throw new SymbolAnalysisError(`interface ${input.interfaceName} was not found in ${sourcePath}`, []);
  const checker = program.getTypeChecker();
  const properties = declaration.members.flatMap((member) => (member.name && ts.isIdentifier(member.name) ? [member.name.text] : [])).sort(byCodeUnit);
  const propertyDeclarations = new Set<ts.Node>(declaration.members);
  const uses = new Map<string, { declarations: Set<string>; affinities: Set<string> }>();
  for (const property of properties) uses.set(property, { declarations: new Set(), affinities: new Set() });
  for (const candidate of program.getSourceFiles()) {
    if (candidate.isDeclarationFile) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const nameNode = ts.isPropertyAccessExpression(node) ? node.name : node.argumentExpression;
        if (nameNode && (ts.isIdentifier(nameNode) || ts.isStringLiteral(nameNode))) {
          let symbol = checker.getSymbolAtLocation(nameNode);
          if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol);
          if (symbol?.declarations?.some((entry) => propertyDeclarations.has(entry))) {
            const record = uses.get(nameNode.text)!;
            record.affinities.add(input.affinityForPath(relativeWorkspacePath(input.rootDir, candidate.fileName)));
            const owner = topLevelName(node);
            if (owner) record.declarations.add(owner);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(candidate);
  }
  const grouped = new Map<string, { affinities: string[]; properties: string[]; declarations: Set<string> }>();
  for (const [property, use] of uses) {
    if (use.affinities.size === 0) continue;
    const affinities = [...use.affinities].sort(byCodeUnit);
    const key = affinities.join("\0");
    const group = grouped.get(key) ?? { affinities, properties: [], declarations: new Set() };
    group.properties.push(property);
    use.declarations.forEach((name) => group.declarations.add(name));
    grouped.set(key, group);
  }
  const partitions = [...grouped.values()]
    .map((group) => ({ affinities: group.affinities, properties: group.properties.sort(byCodeUnit), declarations: [...group.declarations].sort(byCodeUnit) }))
    .sort(
      (left, right) => byCodeUnit(left.affinities.join("/"), right.affinities.join("/")) || byCodeUnit(left.properties.join("/"), right.properties.join("/")),
    );
  return {
    schema: "capability-partitions",
    sourcePath,
    interfaceName: input.interfaceName,
    properties,
    unusedProperties: properties.filter((property) => uses.get(property)!.affinities.size === 0),
    partitions,
  };
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
