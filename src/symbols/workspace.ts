import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import ts from "typescript";

import { byCodeUnit, hashJson } from "../util/hash.ts";
import { relativeWorkspacePath, workspacePath } from "../util/paths.ts";
import { analyzeProgramSource, referenceSpace, SymbolAnalysisError } from "./analyze.ts";
import type {
  AnalyzeWorkspaceSymbolsInput,
  ExternalSymbolConsumer,
  SymbolGraph,
  SymbolSpace,
  SymbolSplitCandidate,
  WorkspaceSymbolAnalysis,
} from "./types.ts";

interface MutableConsumer {
  readonly groupId: string;
  readonly groupName: string;
  readonly consumerPath: string;
  readonly affinity: string;
  readonly spaces: Set<"type" | "value">;
  referenceCount: number;
}

/** Analyze cross-file consumers using the application's own TypeScript program. */
export function analyzeWorkspaceSymbols(input: AnalyzeWorkspaceSymbolsInput): WorkspaceSymbolAnalysis {
  const sourcePath = relativeWorkspacePath(input.rootDir, input.sourcePath);
  const targetAbsolute = workspacePath(input.rootDir, sourcePath);
  const sourceText = readFileSync(targetAbsolute, "utf8");
  const program = workspaceProgram(input.rootDir, input.tsconfigPath);
  const target = program.getSourceFile(targetAbsolute) ?? program.getSourceFiles().find(
    (file) => normalize(file.fileName) === normalize(targetAbsolute),
  );
  if (!target) throw new SymbolAnalysisError(`${sourcePath} is not included by ${input.tsconfigPath}`, []);

  const checker = program.getTypeChecker();
  const source = analyzeProgramSource({
    sourcePath,
    sourceText,
    sourceFile: target,
    checker,
    syntacticDiagnostics: program.getSyntacticDiagnostics(target),
    semanticDiagnostics: program.getSemanticDiagnostics(target),
  });
  const groupByName = new Map(source.groups.map((group) => [group.name, group]));
  const consumers = new Map<string, MutableConsumer>();
  for (const file of program.getSourceFiles()) {
    const absolute = normalize(file.fileName);
    if (file.isDeclarationFile || absolute === normalize(targetAbsolute) || !inside(input.rootDir, absolute)) continue;
    const consumerPath = relativeWorkspacePath(input.rootDir, absolute);
    const affinity = input.affinityForPath(consumerPath);
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && !isImportBinding(node)) {
        let symbol = checker.getSymbolAtLocation(node);
        if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol);
        const declaration = symbol?.declarations?.find(
          (entry) => normalize(entry.getSourceFile().fileName) === normalize(targetAbsolute),
        );
        const name = declaration && declarationName(declaration);
        const group = name ? groupByName.get(name) : undefined;
        if (group) {
          const key = `${group.id}\0${consumerPath}\0${affinity}`;
          const current = consumers.get(key) ?? {
            groupId: group.id,
            groupName: group.name,
            consumerPath,
            affinity,
            spaces: new Set<"type" | "value">(),
            referenceCount: 0,
          };
          current.spaces.add(referenceSpace(node));
          current.referenceCount += 1;
          consumers.set(key, current);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }

  const records: ExternalSymbolConsumer[] = [...consumers.values()].map((entry) => ({
    groupId: entry.groupId,
    groupName: entry.groupName,
    consumerPath: entry.consumerPath,
    affinity: entry.affinity,
    space: mergeSpaces([...entry.spaces]),
    referenceCount: entry.referenceCount,
  })).sort((left, right) =>
    byCodeUnit(left.groupName, right.groupName) ||
    byCodeUnit(left.affinity, right.affinity) ||
    byCodeUnit(left.consumerPath, right.consumerPath) ||
    byCodeUnit(left.groupId, right.groupId),
  );

  return {
    schemaVersion: 1,
    source,
    consumers: records,
    splitCandidates: splitCandidates(source, records),
  };
}

function workspaceProgram(rootDir: string, tsconfigPath: string): ts.Program {
  const configPath = workspacePath(rootDir, relativeWorkspacePath(rootDir, tsconfigPath));
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) throw new SymbolAnalysisError(`cannot read TypeScript config ${tsconfigPath}`, [diagnostic(read.error)]);
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(configPath), undefined, configPath);
  const fatal = parsed.errors.filter((entry) => entry.category === ts.DiagnosticCategory.Error);
  if (fatal.length > 0) {
    throw new SymbolAnalysisError(`cannot build TypeScript program from ${tsconfigPath}`, fatal.map(diagnostic));
  }
  return ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
}

function splitCandidates(graph: SymbolGraph, consumers: readonly ExternalSymbolConsumer[]): SymbolSplitCandidate[] {
  const groupById = new Map(graph.groups.map((group) => [group.id, group]));
  return graph.components.map((component): SymbolSplitCandidate => {
    const groups = component.groupIds.map((id) => groupById.get(id)!).filter(Boolean);
    const groupSet = new Set(component.groupIds);
    const relevant = consumers.filter((consumer) => groupSet.has(consumer.groupId));
    const affinityCounts: Record<string, number> = {};
    for (const consumer of relevant) affinityCounts[consumer.affinity] = (affinityCounts[consumer.affinity] ?? 0) + consumer.referenceCount;
    const sortedAffinities = Object.entries(affinityCounts).sort(
      ([leftName, left], [rightName, right]) => right - left || byCodeUnit(leftName, rightName),
    );
    const total = sortedAffinities.reduce((sum, [, count]) => sum + count, 0);
    const dominantAffinity = sortedAffinities[0]?.[0];
    const concentration = total === 0 ? 0 : (sortedAffinities[0]?.[1] ?? 0) / total;
    const incoming = graph.edges.filter((edge) => !groupSet.has(edge.source) && groupSet.has(edge.target)).length;
    const outgoing = graph.edges.filter((edge) => groupSet.has(edge.source) && !groupSet.has(edge.target)).length;
    const names = groups.map((group) => group.name).sort(byCodeUnit);
    return {
      id: hashJson({ sourceHash: graph.sourceHash, component: component.id, consumers: relevant }),
      groupIds: [...component.groupIds],
      names,
      space: mergeSpaces(groups.map((group) => group.space)),
      exported: groups.some((group) => group.exported),
      consumers: relevant,
      affinities: Object.fromEntries(sortedAffinities.sort(([left], [right]) => byCodeUnit(left, right))),
      ...(dominantAffinity === undefined ? {} : { dominantAffinity }),
      affinityConcentration: concentration,
      incomingBoundaryEdges: incoming,
      outgoingBoundaryEdges: outgoing,
      score: Math.round(concentration * 1000) + relevant.length * 10 - (incoming + outgoing),
    };
  }).sort((left, right) => right.score - left.score || byCodeUnit(left.id, right.id));
}

function declarationName(node: ts.Declaration): string | undefined {
  const named = node as ts.Declaration & { readonly name?: ts.DeclarationName };
  return named.name && ts.isIdentifier(named.name) ? named.name.text : undefined;
}

function isImportBinding(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  return ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent) || ts.isImportEqualsDeclaration(parent);
}

function mergeSpaces(spaces: readonly SymbolSpace[]): SymbolSpace {
  const type = spaces.some((space) => space === "type" || space === "both");
  const value = spaces.some((space) => space === "value" || space === "both");
  return type && value ? "both" : type ? "type" : "value";
}

function normalize(path: string): string {
  return resolve(path).replaceAll("\\", "/");
}

function inside(rootDir: string, path: string): boolean {
  const root = `${normalize(rootDir).replace(/\/$/, "")}/`;
  return normalize(path).startsWith(root);
}

function diagnostic(entry: ts.Diagnostic): { phase: "semantic"; code: number; category: "error" | "warning" | "suggestion" | "message"; message: string; start?: number; length?: number } {
  const categories = ["warning", "error", "suggestion", "message"] as const;
  return {
    phase: "semantic",
    code: entry.code,
    category: categories[entry.category] ?? "message",
    message: ts.flattenDiagnosticMessageText(entry.messageText, "\n"),
    ...(entry.start === undefined ? {} : { start: entry.start }),
    ...(entry.length === undefined ? {} : { length: entry.length }),
  };
}
