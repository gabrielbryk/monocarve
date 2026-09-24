import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import ts from "typescript";

import { sourceFiles } from "../util/files.ts";
import { byCodeUnit, hashJson } from "../util/hash.ts";
import { relativeWorkspacePath, workspacePath } from "../util/paths.ts";
import { analyzeProgramSource, referenceSpace, SymbolAnalysisError } from "./analyze.ts";
import type { AnalyzeWorkspaceSymbolsInput, ExternalSymbolConsumer, SymbolGraph, SymbolSpace, SymbolSplitCandidate, WorkspaceSymbolAnalysis } from "./types.ts";

interface MutableConsumer {
  readonly groupId: string;
  readonly groupName: string;
  readonly consumerPath: string;
  readonly affinity: string;
  readonly spaces: Set<"type" | "value">;
  referenceCount: number;
}

export interface ProgramCompletenessDiagnostic {
  readonly phase: "configuration" | "options" | "global" | "syntactic" | "semantic";
  readonly code: number;
  readonly category: "error" | "warning" | "suggestion" | "message";
  readonly message: string;
  readonly path?: string;
  readonly start?: number;
  readonly length?: number;
}

export interface WorkspaceSymbolProgram {
  readonly rootDir: string;
  readonly tsconfigPath: string;
  readonly program: ts.Program;
  readonly diagnostics: readonly ProgramCompletenessDiagnostic[];
}

/** Program/configuration construction failed before a usable TypeScript program existed. */
export class WorkspaceProgramError extends SymbolAnalysisError {
  readonly completenessDiagnostics: readonly ProgramCompletenessDiagnostic[];

  constructor(message: string, diagnostics: readonly ProgramCompletenessDiagnostic[]) {
    super(
      message,
      diagnostics.map((entry) => ({
        phase: entry.phase === "syntactic" ? ("syntactic" as const) : ("semantic" as const),
        code: entry.code,
        category: entry.category,
        message: entry.message,
        ...(entry.start === undefined ? {} : { start: entry.start }),
        ...(entry.length === undefined ? {} : { length: entry.length }),
      })),
    );
    this.completenessDiagnostics = diagnostics;
  }
}

/** Analyze cross-file consumers using the application's own TypeScript program. */
export function analyzeWorkspaceSymbols(input: AnalyzeWorkspaceSymbolsInput): WorkspaceSymbolAnalysis {
  return analyzeWorkspaceSymbolsWithProgram(createWorkspaceSymbolProgram(input.rootDir, input.tsconfigPath), input);
}

/** Analyze one file using a caller-owned program shared across a batch. */
export function analyzeWorkspaceSymbolsWithProgram(
  workspace: WorkspaceSymbolProgram,
  input: Omit<AnalyzeWorkspaceSymbolsInput, "rootDir" | "tsconfigPath">,
): WorkspaceSymbolAnalysis {
  const rootDir = workspace.rootDir;
  const sourcePath = relativeWorkspacePath(rootDir, input.sourcePath);
  const targetAbsolute = workspacePath(rootDir, sourcePath);
  const sourceText = workspace.program.getSourceFile(targetAbsolute)?.text ?? readFileSync(targetAbsolute, "utf8");
  const program = workspace.program;
  const target = program.getSourceFile(targetAbsolute) ?? program.getSourceFiles().find((file) => normalize(file.fileName) === normalize(targetAbsolute));
  if (!target) throw new SymbolAnalysisError(`${sourcePath} is not included by ${workspace.tsconfigPath}`, []);

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
  const consumers = collectConsumers(program, checker, targetAbsolute, rootDir, groupByName, input.affinityForPath);
  const records: ExternalSymbolConsumer[] = [...consumers.values()]
    .map((entry) => ({
      groupId: entry.groupId,
      groupName: entry.groupName,
      consumerPath: entry.consumerPath,
      affinity: entry.affinity,
      space: mergeSpaces([...entry.spaces]),
      referenceCount: entry.referenceCount,
    }))
    .toSorted(
      (left, right) =>
        byCodeUnit(left.groupName, right.groupName) ||
        byCodeUnit(left.affinity, right.affinity) ||
        byCodeUnit(left.consumerPath, right.consumerPath) ||
        byCodeUnit(left.groupId, right.groupId),
    );

  return { schemaVersion: 1, source, consumers: records, splitCandidates: splitCandidates(source, records) };
}

function collectConsumers(
  program: ts.Program,
  checker: ts.TypeChecker,
  targetAbsolute: string,
  rootDir: string,
  groupByName: ReadonlyMap<string, SymbolGraph["groups"][number]>,
  affinityForPath: (path: string) => string,
): Map<string, MutableConsumer> {
  const consumers = new Map<string, MutableConsumer>();
  for (const file of program.getSourceFiles()) {
    const absolute = normalize(file.fileName);
    if (file.isDeclarationFile || absolute === normalize(targetAbsolute) || !inside(rootDir, absolute)) continue;
    const consumerPath = relativeWorkspacePath(rootDir, absolute);
    const affinity = affinityForPath(consumerPath);
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && !isImportBinding(node)) {
        recordConsumer(node, checker, targetAbsolute, consumerPath, affinity, groupByName, consumers);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return consumers;
}

function recordConsumer(
  node: ts.Identifier,
  checker: ts.TypeChecker,
  targetAbsolute: string,
  consumerPath: string,
  affinity: string,
  groupByName: ReadonlyMap<string, SymbolGraph["groups"][number]>,
  consumers: Map<string, MutableConsumer>,
): void {
  let symbol = checker.getSymbolAtLocation(node);
  if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol);
  const declaration = symbol?.declarations?.find((entry) => normalize(entry.getSourceFile().fileName) === normalize(targetAbsolute));
  const name = declaration && declarationName(declaration);
  const group = name ? groupByName.get(name) : undefined;
  if (!group) return;
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

/** Build the real application program for higher-level workspace analyses. */
export function workspaceProgram(rootDir: string, tsconfigPath: string): ts.Program {
  return createWorkspaceSymbolProgram(rootDir, tsconfigPath).program;
}

export function createWorkspaceSymbolProgram(
  rootDir: string,
  tsconfigPath: string,
  additionalRoots: readonly string[] = [],
  readInput: (path: string) => string | undefined = (path) => ts.sys.readFile(path),
): WorkspaceSymbolProgram {
  const configPath = workspacePath(rootDir, relativeWorkspacePath(rootDir, tsconfigPath));
  const system = { ...ts.sys, readFile: readInput };
  const read = ts.readConfigFile(configPath, readInput);
  if (!read.error && typeof read.config === "object" && read.config !== null) {
    // `extends` files are loaded by parseJsonConfigFileContent through the supplied system.
  }
  if (read.error)
    throw new WorkspaceProgramError(`cannot read TypeScript config ${tsconfigPath}`, [completenessDiagnostic(rootDir, read.error, "configuration")]);
  const parsed = ts.parseJsonConfigFileContent(read.config, system, dirname(configPath), undefined, configPath);
  const configDiagnostics = parsed.errors.map((entry) => completenessDiagnostic(rootDir, entry, "configuration"));
  const fatal = parsed.errors.filter((entry) => entry.category === ts.DiagnosticCategory.Error);
  if (fatal.length > 0) {
    throw new WorkspaceProgramError(`cannot build TypeScript program from ${tsconfigPath}`, configDiagnostics);
  }
  const additionalFiles = additionalRoots.flatMap((root) => sourceFiles(resolve(rootDir, root)));
  const rootNames = [...new Set([...parsed.fileNames, ...additionalFiles])].toSorted(byCodeUnit);
  const host = ts.createCompilerHost(parsed.options);
  host.readFile = readInput;
  host.getSourceFile = (fileName, languageVersion, onError) => {
    const text = readInput(fileName);
    if (text === undefined) {
      onError?.(`File not found: ${fileName}`);
      return undefined;
    }
    return ts.createSourceFile(fileName, text, languageVersion);
  };
  const program = ts.createProgram({
    rootNames,
    options: parsed.options,
    host,
    ...(parsed.projectReferences === undefined ? {} : { projectReferences: parsed.projectReferences }),
  });
  const diagnostics: ProgramCompletenessDiagnostic[] = [
    ...configDiagnostics,
    ...program.getConfigFileParsingDiagnostics().map((entry) => completenessDiagnostic(rootDir, entry, "configuration")),
    ...program.getOptionsDiagnostics().map((entry) => completenessDiagnostic(rootDir, entry, "options")),
    ...program.getGlobalDiagnostics().map((entry) => completenessDiagnostic(rootDir, entry, "global")),
    ...program.getSyntacticDiagnostics().map((entry) => completenessDiagnostic(rootDir, entry, "syntactic")),
    ...program.getSemanticDiagnostics().map((entry) => completenessDiagnostic(rootDir, entry, "semantic")),
  ].toSorted((left, right) => byCodeUnit(left.path ?? "", right.path ?? "") || (left.start ?? -1) - (right.start ?? -1) || left.code - right.code);
  return { rootDir, tsconfigPath, program, diagnostics };
}

function completenessDiagnostic(rootDir: string, entry: ts.Diagnostic, phase: ProgramCompletenessDiagnostic["phase"]): ProgramCompletenessDiagnostic {
  const categories = ["warning", "error", "suggestion", "message"] as const;
  const fileName = entry.file?.fileName;
  return {
    phase,
    code: entry.code,
    category: categories[entry.category] ?? "message",
    message: ts.flattenDiagnosticMessageText(entry.messageText, "\n"),
    ...(fileName === undefined ? {} : { path: inside(rootDir, fileName) ? relativeWorkspacePath(rootDir, fileName) : normalize(fileName) }),
    ...(entry.start === undefined ? {} : { start: entry.start }),
    ...(entry.length === undefined ? {} : { length: entry.length }),
  };
}

function splitCandidates(graph: SymbolGraph, consumers: readonly ExternalSymbolConsumer[]): SymbolSplitCandidate[] {
  const groupById = new Map(graph.groups.map((group) => [group.id, group]));
  return graph.components
    .map((component): SymbolSplitCandidate => {
      const groups = component.groupIds.map((id) => groupById.get(id)!).filter(Boolean);
      const groupSet = new Set(component.groupIds);
      const relevant = consumers.filter((consumer) => groupSet.has(consumer.groupId));
      const affinityCounts: Record<string, number> = {};
      for (const consumer of relevant) affinityCounts[consumer.affinity] = (affinityCounts[consumer.affinity] ?? 0) + consumer.referenceCount;
      const sortedAffinities = Object.entries(affinityCounts).toSorted(([leftName, left], [rightName, right]) => right - left || byCodeUnit(leftName, rightName));
      const total = sortedAffinities.reduce((sum, [, count]) => sum + count, 0);
      const dominantAffinity = sortedAffinities[0]?.[0];
      const concentration = total === 0 ? 0 : (sortedAffinities[0]?.[1] ?? 0) / total;
      const incoming = graph.edges.filter((edge) => !groupSet.has(edge.source) && groupSet.has(edge.target)).length;
      const outgoing = graph.edges.filter((edge) => groupSet.has(edge.source) && !groupSet.has(edge.target)).length;
      const names = groups.map((group) => group.name).toSorted(byCodeUnit);
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
    })
    .toSorted((left, right) => right.score - left.score || byCodeUnit(left.id, right.id));
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
