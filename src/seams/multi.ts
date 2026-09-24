import { dirname, isAbsolute } from "node:path";

import ts from "typescript";

import { analyzeWorkspaceSymbols, referenceSpace } from "../symbols/index.ts";
import type { DeclarationGroup, ExternalSymbolConsumer, WorkspaceSymbolAnalysis } from "../symbols/types.ts";
import { byCodeUnit, hashJson, type Sha256 } from "../util/hash.ts";
import { relativeWorkspacePath, workspacePath } from "../util/paths.ts";
import { normalizePath } from "../util/paths.ts";
import { SeamPlanningError } from "./plan.ts";
import type { MultiFileMergedSymbol, MultiFileSeamCandidate, MultiFileSeamPlan, MultiFileSymbolEdge, PlanMultiFileSeamsInput, SeamBlocker } from "./types.ts";

interface SelectedGroup {
  readonly group: DeclarationGroup;
  readonly analysis: WorkspaceSymbolAnalysis;
}

/** Build a deterministic, read-only SCC view spanning explicitly selected files. */
export function planMultiFileSeams(input: PlanMultiFileSeamsInput): MultiFileSeamPlan {
  const paths = canonicalPaths(input.rootDir, input.sourcePaths);
  if (paths.length < 2) throw new SeamPlanningError("multi-file seam planning requires at least two distinct source files");
  const analyses = paths.map((sourcePath) =>
    analyzeWorkspaceSymbols({ rootDir: input.rootDir, tsconfigPath: input.tsconfigPath, sourcePath, affinityForPath: input.affinityForPath }),
  );
  const sourceHashes = Object.fromEntries(analyses.map((analysis) => [analysis.source.sourcePath, analysis.source.sourceHash]));
  const stale = staleBlockers(sourceHashes, input.expectedSourceHashes);
  if (stale.length > 0) return planResult(sourceHashes, [], [], [], stale);
  const program = createProgram(input.rootDir, input.tsconfigPath);
  const edges = crossFileEdges(input.rootDir, program, analyses);
  const mergedSymbols = mergedSymbolGroups(input.rootDir, program, analyses);
  const candidates = components(analyses, edges, mergedSymbols).map((ids) => candidateFor(ids, analyses, edges, input.affinityForPath, input.targetPaths));
  return planResult(sourceHashes, edges, mergedSymbols, candidates, []);
}

function planResult(
  sourceHashes: Readonly<Record<string, Sha256>>,
  edges: readonly MultiFileSymbolEdge[],
  mergedSymbols: readonly MultiFileMergedSymbol[],
  candidates: readonly MultiFileSeamCandidate[],
  blockers: readonly SeamBlocker[],
): MultiFileSeamPlan {
  const identity = { schemaVersion: 1 as const, sourceHashes, edges, mergedSymbols, candidates, blockers };
  return { ...identity, id: hashJson(identity) };
}

function canonicalPaths(root: string, paths: readonly string[]): string[] {
  try {
    return [...new Set(paths.map((path) => relativeWorkspacePath(root, path)))].toSorted(byCodeUnit);
  } catch {
    throw new SeamPlanningError("multi-file seam sources must be safe repository-relative paths");
  }
}

function staleBlockers(actual: Readonly<Record<string, Sha256>>, expected?: Readonly<Record<string, Sha256>>): SeamBlocker[] {
  if (!expected) return [];
  const blockers: SeamBlocker[] = [];
  for (const path of Object.keys(actual).toSorted(byCodeUnit)) {
    if (expected[path] !== actual[path])
      blockers.push({ code: "stale-source", message: `${path} changed since its source hash was observed`, confidence: "exact" });
  }
  return blockers;
}

function crossFileEdges(root: string, program: ts.Program, analyses: readonly WorkspaceSymbolAnalysis[]): MultiFileSymbolEdge[] {
  const checker = program.getTypeChecker();
  const selected = new Map<string, WorkspaceSymbolAnalysis>(analyses.map((item) => [item.source.sourcePath, item]));
  const absoluteToPath = new Map([...selected.keys()].map((path) => [normalize(workspacePath(root, path)), path]));
  const aggregates = new Map<string, { edge: Omit<MultiFileSymbolEdge, "referenceCount">; count: number }>();
  for (const file of program.getSourceFiles()) {
    const sourcePath = absoluteToPath.get(normalize(file.fileName));
    const analysis = sourcePath && selected.get(sourcePath);
    if (!sourcePath || !analysis) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && !isDeclarationName(node)) addReference(node, file, sourcePath, analysis, absoluteToPath, selected, checker, aggregates);
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return [...aggregates.values()].map(({ edge, count }) => ({ ...edge, referenceCount: count })).toSorted(compareEdges);
}

function addReference(
  node: ts.Identifier,
  file: ts.SourceFile,
  sourcePath: string,
  analysis: WorkspaceSymbolAnalysis,
  absoluteToPath: ReadonlyMap<string, string>,
  selected: ReadonlyMap<string, WorkspaceSymbolAnalysis>,
  checker: ts.TypeChecker,
  output: Map<string, { edge: Omit<MultiFileSymbolEdge, "referenceCount">; count: number }>,
): void {
  const ownerName = containingDeclarationName(node, file);
  const sourceGroup = ownerName ? analysis.source.groups.find((group) => group.name === ownerName) : undefined;
  let symbol = checker.getSymbolAtLocation(node);
  if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol);
  const targetDeclaration = symbol?.declarations?.find((entry) => absoluteToPath.has(normalize(entry.getSourceFile().fileName)));
  const targetPath = targetDeclaration && absoluteToPath.get(normalize(targetDeclaration.getSourceFile().fileName));
  const targetName = targetDeclaration && declarationName(targetDeclaration);
  const targetGroup = targetPath && targetName ? selected.get(targetPath)?.source.groups.find((group) => group.name === targetName) : undefined;
  if (!sourceGroup || !targetGroup || targetPath === undefined || targetPath === sourcePath) return;
  const space = referenceSpace(node);
  const edge = {
    sourcePath,
    sourceGroupId: sourceGroup.id,
    sourceName: sourceGroup.name,
    targetPath,
    targetGroupId: targetGroup.id,
    targetName: targetGroup.name,
    space,
    confidence: "exact" as const,
  };
  const key = [edge.sourceGroupId, edge.targetGroupId, edge.space].join("\0");
  const prior = output.get(key);
  output.set(key, { edge, count: (prior?.count ?? 0) + 1 });
}

function components(analyses: readonly WorkspaceSymbolAnalysis[], cross: readonly MultiFileSymbolEdge[], merged: readonly MultiFileMergedSymbol[]): Sha256[][] {
  const ids = analyses.flatMap((item) => item.source.groups.map((group) => group.id)).toSorted(byCodeUnit);
  const adjacency = new Map(ids.map((id) => [id, new Set<Sha256>()]));
  for (const analysis of analyses) for (const edge of analysis.source.edges) adjacency.get(edge.source)?.add(edge.target);
  for (const edge of cross) adjacency.get(edge.sourceGroupId)?.add(edge.targetGroupId);
  for (const symbol of merged) for (const source of symbol.groupIds) for (const target of symbol.groupIds) adjacency.get(source)?.add(target);
  return tarjan(ids, adjacency).sort((a, b) => byCodeUnit(a[0] ?? "", b[0] ?? ""));
}

function tarjan(ids: readonly Sha256[], adjacency: ReadonlyMap<Sha256, ReadonlySet<Sha256>>): Sha256[][] {
  let next = 0;
  const stack: Sha256[] = [];
  const onStack = new Set<Sha256>();
  const index = new Map<Sha256, number>();
  const low = new Map<Sha256, number>();
  const result: Sha256[][] = [];
  const visit = (id: Sha256): void => {
    index.set(id, next);
    low.set(id, next);
    next += 1;
    stack.push(id);
    onStack.add(id);
    for (const target of [...(adjacency.get(id) ?? [])].toSorted(byCodeUnit)) {
      if (!index.has(target)) {
        visit(target);
        low.set(id, Math.min(low.get(id)!, low.get(target)!));
      } else if (onStack.has(target)) low.set(id, Math.min(low.get(id)!, index.get(target)!));
    }
    if (low.get(id) !== index.get(id)) return;
    const component: Sha256[] = [];
    let current: Sha256;
    do {
      current = stack.pop()!;
      onStack.delete(current);
      component.push(current);
    } while (current !== id);
    result.push(component.sort(byCodeUnit));
  };
  for (const id of ids) if (!index.has(id)) visit(id);
  return result;
}

function candidateFor(
  ids: readonly Sha256[],
  analyses: readonly WorkspaceSymbolAnalysis[],
  edges: readonly MultiFileSymbolEdge[],
  affinityForPath: (path: string) => string,
  targets?: Readonly<Record<string, string>>,
): MultiFileSeamCandidate {
  const selected = new Set(ids);
  const records = groupRecords(analyses).filter((entry) => selected.has(entry.group.id));
  const groups = records.map((entry) => entry.group).toSorted((a, b) => byCodeUnit(a.id, b.id));
  const sourcePaths = [...new Set(groups.map((group) => group.sourcePath))].toSorted(byCodeUnit);
  const outsideFiles = records.flatMap(({ group, analysis }) =>
    analysis.consumers.filter((item) => item.groupId === group.id && !sourcePaths.includes(item.consumerPath)),
  );
  const insideFilesOutsideComponent = edges
    .filter((edge) => selected.has(edge.targetGroupId) && !selected.has(edge.sourceGroupId))
    .map((edge): ExternalSymbolConsumer => ({
      groupId: edge.targetGroupId,
      groupName: edge.targetName,
      consumerPath: edge.sourcePath,
      affinity: affinityForPath(edge.sourcePath),
      space: edge.space,
      referenceCount: edge.referenceCount,
    }));
  const affectedConsumers = deduplicateConsumers([...outsideFiles, ...insideFilesOutsideComponent]).sort(compareConsumers);
  const selectedTargets = [
    ...new Set(
      ids
        .map((id) => targets?.[id])
        .filter((path): path is string => path !== undefined)
        .map((path) => normalizedTarget(path)),
    ),
  ].toSorted(byCodeUnit);
  const blockers: SeamBlocker[] = [];
  if (selectedTargets.length > 1)
    blockers.push({ code: "target-collision", message: "groups in one atomic component have conflicting target paths", confidence: "exact" });
  const selfLoop = edges.some((edge) => edge.sourceGroupId === edge.targetGroupId && selected.has(edge.sourceGroupId));
  const cyclic = ids.length > 1 || selfLoop;
  return {
    id: hashJson({ ids, sourcePaths }),
    groupIds: [...ids],
    groups,
    sourcePaths,
    cyclic,
    placement:
      selectedTargets[0] === undefined
        ? { confidence: "heuristic" }
        : { confidence: selectedTargets.length === 1 ? "exact" : "heuristic", targetPath: selectedTargets[0] },
    affectedConsumers,
    blockers,
  };
}

function groupRecords(analyses: readonly WorkspaceSymbolAnalysis[]): SelectedGroup[] {
  return analyses.flatMap((analysis) => analysis.source.groups.map((group) => ({ group, analysis })));
}
function deduplicateConsumers(consumers: readonly ExternalSymbolConsumer[]): ExternalSymbolConsumer[] {
  const records = new Map<string, ExternalSymbolConsumer>();
  for (const consumer of consumers) {
    const key = [consumer.groupId, consumer.consumerPath, consumer.affinity, consumer.space].join("\0");
    const prior = records.get(key);
    records.set(key, { ...consumer, referenceCount: Math.max(prior?.referenceCount ?? 0, consumer.referenceCount) });
  }
  return [...records.values()];
}

function mergedSymbolGroups(root: string, program: ts.Program, analyses: readonly WorkspaceSymbolAnalysis[]): MultiFileMergedSymbol[] {
  const checker = program.getTypeChecker();
  const groupByLocation = new Map<string, DeclarationGroup>();
  for (const analysis of analyses)
    for (const declaration of analysis.source.declarations) {
      const group = analysis.source.groups.find((entry) => entry.declarationIds.includes(declaration.id));
      if (group) groupByLocation.set(`${declaration.sourcePath}\0${declaration.span.start}`, group);
    }
  const seen = new Set<ts.Symbol>();
  const result: MultiFileMergedSymbol[] = [];
  for (const file of program.getSourceFiles())
    for (const statement of file.statements) {
      const name = (statement as ts.DeclarationStatement).name;
      if (!name || !ts.isIdentifier(name)) continue;
      const symbol = checker.getSymbolAtLocation(name);
      if (!symbol || seen.has(symbol)) continue;
      seen.add(symbol);
      const groups =
        symbol.declarations
          ?.map((declaration) => {
            let path: string;
            try {
              path = relativeWorkspacePath(root, declaration.getSourceFile().fileName);
            } catch {
              return undefined;
            }
            return groupByLocation.get(`${path}\0${declaration.getStart(declaration.getSourceFile())}`);
          })
          .filter((group): group is DeclarationGroup => group !== undefined) ?? [];
      const ids = [...new Set(groups.map((group) => group.id))].toSorted(byCodeUnit);
      if (ids.length > 1)
        result.push({
          groupIds: ids,
          sourcePaths: [...new Set(groups.map((group) => group.sourcePath))].toSorted(byCodeUnit),
          name: name.text,
          confidence: "exact",
        });
    }
  return result.sort((a, b) => byCodeUnit(a.name, b.name) || byCodeUnit(a.groupIds[0] ?? "", b.groupIds[0] ?? ""));
}
function normalizedTarget(path: string): string {
  const result = normalizePath(path);
  if (!result || result === "." || isAbsolute(result) || result.split("/").includes("..")) throw new SeamPlanningError(`invalid target path ${path}`);
  return result;
}
function createProgram(root: string, config: string): ts.Program {
  const path = workspacePath(root, relativeWorkspacePath(root, config));
  const read = ts.readConfigFile(path, ts.sys.readFile);
  if (read.error) throw new SeamPlanningError(`cannot read TypeScript config ${config}`);
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(path), undefined, path);
  if (parsed.errors.length) throw new SeamPlanningError(`cannot build TypeScript program from ${config}`);
  return ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
}
function containingDeclarationName(node: ts.Node, file: ts.SourceFile): string | undefined {
  let current: ts.Node | undefined = node;
  while (current?.parent && current.parent !== file) current = current.parent;
  return current && declarationName(current as ts.Declaration);
}
function declarationName(node: ts.Declaration): string | undefined {
  const name = (node as ts.Declaration & { name?: ts.DeclarationName }).name;
  return name && ts.isIdentifier(name) ? name.text : undefined;
}
function isDeclarationName(node: ts.Identifier): boolean {
  return (node.parent as ts.Declaration & { name?: ts.Node }).name === node;
}
function normalize(path: string): string {
  return path.replaceAll("\\", "/");
}
function compareEdges(a: MultiFileSymbolEdge, b: MultiFileSymbolEdge): number {
  return (
    byCodeUnit(a.sourcePath, b.sourcePath) ||
    byCodeUnit(a.sourceGroupId, b.sourceGroupId) ||
    byCodeUnit(a.targetPath, b.targetPath) ||
    byCodeUnit(a.targetGroupId, b.targetGroupId) ||
    byCodeUnit(a.space, b.space)
  );
}
function compareConsumers(a: ExternalSymbolConsumer, b: ExternalSymbolConsumer): number {
  return byCodeUnit(a.consumerPath, b.consumerPath) || byCodeUnit(a.groupId, b.groupId) || byCodeUnit(a.affinity, b.affinity);
}
