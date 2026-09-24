import { dirname, relative, resolve } from "node:path";

import ts from "typescript";

import { GENERATOR } from "../branding.ts";
import { evaluationEffects } from "../codemod/side-effects.ts";
import type { MonocarveConfig } from "../config.ts";
import { configDigest } from "../config.ts";
import type { DependencyGraph } from "../graph/model.ts";
import { PlanningError } from "../plan/context.ts";
import { analyzeTypeScriptSource } from "../symbols/analyze.ts";
import { resolveCommit, showBaseline } from "../util/git.ts";
import { byCodeUnit, hashText, MISSING, type Sha256 } from "../util/hash.ts";
import { baselineFileMode, sortedGates, type PreparationManifestRendering } from "./build-shared.ts";
import { preparationCompilerOptions } from "./compiler-policy.ts";
import type { PreparationManifest, PreparationReplayOperation, PreparationWriteFileOperation } from "./manifest-types.ts";
import { assertPreparationManifestValid, createPreparationManifest, preparationOperationPaths } from "./manifest.ts";
import { preparationPostJournalRecords } from "./post-journal.ts";

export interface CompileValueSplitInput {
  readonly rootDir: string;
  readonly config: MonocarveConfig;
  readonly graph: DependencyGraph;
  readonly baselineCommit: string;
  readonly graphDigest: Sha256;
  readonly splitId: string;
  readonly rendering: PreparationManifestRendering;
}

type ValueSplit = MonocarveConfig["valueSplits"][number];
type SourceAnalysis = ReturnType<typeof analyzeTypeScriptSource>;
interface SourceRegion {
  readonly start: number;
  readonly end: number;
}

/** Compile one configured, dependency-closed exported value split. */
export function compileValueSplit(input: CompileValueSplitInput): PreparationManifest {
  const split = input.config.valueSplits.find((item) => item.id === input.splitId);
  if (!split) throw new PlanningError(`unknown value split ${JSON.stringify(input.splitId)}`);
  const baseline = resolveCommit(input.rootDir, input.baselineCommit);
  if (input.graph.commit !== baseline.commit) throw new PlanningError("value split requires a fresh graph at the exact baseline");
  const sourceText = readValueSplitSource(input.rootDir, baseline.commit, split);
  const declarations = movedDeclarations(split, sourceText);
  const sourceFile = ts.createSourceFile(
    split.source,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    split.source.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const regions = statementRegions(split, sourceFile, declarations);
  const targetContents = renderValueSplitTarget(input, split, sourceFile, regions);
  const donorContents = renderValueSplitDonor(split, sourceText, regions);
  const sourceMode = baselineFileMode(input.rootDir, baseline.commit, split.source);
  const operations: PreparationReplayOperation[] = [
    write(split.source, hashText(sourceText), sourceMode, donorContents),
    write(split.target, MISSING, "missing", targetContents),
  ].toSorted((left, right) => byCodeUnit(preparationOperationPaths(left)[0]!, preparationOperationPaths(right)[0]!));
  const policyAnchor = { sourcePath: split.source, targetPath: split.target, targetModuleSpecifier: split.targetModuleSpecifier };
  const changedSourcePaths = operations.flatMap(preparationOperationPaths);
  const postJournalPreparers = preparationPostJournalRecords(input.config, changedSourcePaths);
  const manifest = createPreparationManifest({
    schemaVersion: 1,
    createdAt: baseline.committedAt,
    generator: { ...GENERATOR },
    baseline: { commit: baseline.commit, committerDate: baseline.committedAt, configDigest: configDigest(input.config) },
    graphDigest: input.graphDigest,
    policyAnchor,
    declarations: [],
    operations,
    postJournalPreparers,
    compatibilityReexports: [],
    changedFiles: [...changedSourcePaths, ...postJournalPreparers.flatMap((item) => item.outputs)].toSorted(byCodeUnit),
    commits: { prepare: input.rendering.commit },
    gates: sortedGates(input.rendering),
  });
  assertPreparationManifestValid(manifest);
  return manifest;
}

function readValueSplitSource(rootDir: string, commit: string, split: ValueSplit): string {
  const sourceText = showBaseline(rootDir, commit, split.source);
  if (sourceText === null) throw new PlanningError(`value split source does not exist at baseline: ${split.source}`);
  if (showBaseline(rootDir, commit, split.target) !== null) throw new PlanningError(`value split target already exists at baseline: ${split.target}`);
  return sourceText;
}

/** The exported value symbol plus its complete local dependency closure, in source order. */
function movedDeclarations(split: ValueSplit, sourceText: string): SourceAnalysis["declarations"][number][] {
  const analysis = analyzeTypeScriptSource({ sourcePath: split.source, sourceText });
  const group = analysis.groups.find((item) => item.name === split.symbol);
  if (!group) throw new PlanningError(`value split symbol is not a top-level declaration: ${split.symbol}`);
  if (!group.exported || (group.space !== "value" && group.space !== "both"))
    throw new PlanningError(`value split symbol must be exported in value space: ${split.symbol}`);
  const movedGroupIds = dependencyClosedGroups(analysis, group.id);
  assertNoRetainedIncoming(analysis, movedGroupIds);
  const declarationIds = analysis.groups.filter((item) => movedGroupIds.has(item.id)).flatMap((item) => item.declarationIds);
  const declarations = declarationIds
    .map((id) => analysis.declarations.find((item) => item.id === id))
    .filter((item) => item !== undefined)
    .toSorted((left, right) => left.span.start - right.span.start);
  if (declarations.length !== declarationIds.length) throw new PlanningError(`value split declaration closure is incomplete: ${split.symbol}`);
  return declarations;
}

function assertNoRetainedIncoming(analysis: SourceAnalysis, movedGroupIds: ReadonlySet<string>): void {
  const retainedIncoming = analysis.edges.filter((edge) => !movedGroupIds.has(edge.source) && movedGroupIds.has(edge.target));
  if (retainedIncoming.length === 0) return;
  const names = retainedIncoming.map((edge) => analysis.groups.find((item) => item.id === edge.target)?.name ?? edge.target).toSorted(byCodeUnit);
  throw new PlanningError(`value split dependency is still used by retained declaration(s): ${names.join(", ")}`);
}

/** Map each moved declaration to the one whole top-level statement (with leading trivia) that carries it. */
function statementRegions(split: ValueSplit, sourceFile: ts.SourceFile, declarations: readonly SourceAnalysis["declarations"][number][]): SourceRegion[] {
  const regionByStart = new Map<number, SourceRegion>();
  for (const declaration of declarations) {
    const statement = enclosingStatement(split, sourceFile, declaration.span);
    regionByStart.set(statement.getFullStart(), { start: statement.getFullStart(), end: statement.end });
  }
  return [...regionByStart.values()].toSorted((left, right) => left.start - right.start);
}

function enclosingStatement(split: ValueSplit, sourceFile: ts.SourceFile, span: SourceRegion): ts.Statement {
  const statement = sourceFile.statements.find((item) => item.getStart(sourceFile) <= span.start && item.end >= span.end);
  if (!statement) throw new PlanningError(`value split declaration span is not one complete statement: ${split.symbol}`);
  if (ts.isVariableStatement(statement) && statement.declarationList.declarations.length !== 1) {
    throw new PlanningError(`value split refuses a multi-declarator variable statement: ${split.symbol}`);
  }
  return statement;
}

function renderValueSplitTarget(input: CompileValueSplitInput, split: ValueSplit, sourceFile: ts.SourceFile, regions: readonly SourceRegion[]): string {
  const importText = [...usedImportDeclarations(sourceFile, regions)]
    .toSorted((left, right) => left.getStart(sourceFile) - right.getStart(sourceFile))
    .map((statement) => renderTargetImport(input, split.source, split.target, statement, sourceFile))
    .join("\n");
  const declarationsText = regions
    .map((region) => sourceFile.text.slice(region.start, region.end))
    .join("")
    .replace(/^\s*/, "");
  const targetContents = `${importText}${importText ? "\n\n" : ""}${declarationsText}\n`;
  if (evaluationEffects(targetContents, split.target).length > 0) {
    throw new PlanningError(`value split declaration closure has top-level evaluation effects: ${split.symbol}`);
  }
  return targetContents;
}

function importedBindingStatements(sourceFile: ts.SourceFile): Map<string, ts.ImportDeclaration> {
  const importedBindings = new Map<string, ts.ImportDeclaration>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    for (const name of importClauseNames(statement.importClause)) importedBindings.set(name, statement);
  }
  return importedBindings;
}

function importClauseNames(clause: ts.ImportClause | undefined): string[] {
  const names: string[] = [];
  if (clause?.name) names.push(clause.name.text);
  const bindings = clause?.namedBindings;
  if (bindings && ts.isNamespaceImport(bindings)) names.push(bindings.name.text);
  if (bindings && ts.isNamedImports(bindings)) names.push(...bindings.elements.map((element) => element.name.text));
  return names;
}

/** Import declarations whose bindings are named anywhere inside a moved region. */
function usedImportDeclarations(sourceFile: ts.SourceFile, regions: readonly SourceRegion[]): Set<ts.ImportDeclaration> {
  const importedBindings = importedBindingStatements(sourceFile);
  const usedImports = new Set<ts.ImportDeclaration>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const statement = importedBindings.get(node.text);
      if (statement) usedImports.add(statement);
    }
    ts.forEachChild(node, visit);
  };
  for (const statement of sourceFile.statements)
    if (regions.some((region) => statement.getFullStart() === region.start && statement.end === region.end)) visit(statement);
  return usedImports;
}

function renderValueSplitDonor(split: ValueSplit, sourceText: string, regions: readonly SourceRegion[]): string {
  let donorContents = sourceText;
  for (const region of [...regions].toSorted((left, right) => right.start - left.start))
    donorContents = donorContents.slice(0, region.start) + donorContents.slice(region.end);
  return `${donorContents.replace(/\s*$/, "\n\n")}export { ${split.symbol} } from ${JSON.stringify(split.targetModuleSpecifier)};\n`;
}

function dependencyClosedGroups(analysis: SourceAnalysis, seed: string): Set<string> {
  const moved = new Set([seed]);
  const pending = [seed];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const targets = new Set(analysis.edges.filter((edge) => edge.source === current && !moved.has(edge.target)).map((edge) => edge.target));
    for (const target of targets) moved.add(target);
    pending.push(...targets);
  }
  return moved;
}

function renderTargetImport(
  input: CompileValueSplitInput,
  sourcePath: string,
  targetPath: string,
  statement: ts.ImportDeclaration,
  sourceFile: ts.SourceFile,
): string {
  if (!ts.isStringLiteral(statement.moduleSpecifier)) throw new PlanningError("value split import has a non-literal module specifier");
  const original = statement.moduleSpecifier.text;
  const replacement = original.startsWith(".") ? retargetRelativeSpecifier(input, sourcePath, targetPath, original) : original;
  const text = statement.getText(sourceFile);
  const start = statement.moduleSpecifier.getStart(sourceFile) - statement.getStart(sourceFile);
  const end = statement.moduleSpecifier.end - statement.getStart(sourceFile);
  return `${text.slice(0, start)}${JSON.stringify(replacement)}${text.slice(end)}`;
}

function retargetRelativeSpecifier(input: CompileValueSplitInput, sourcePath: string, targetPath: string, original: string): string {
  const options = preparationCompilerOptions(input.rootDir, input.config, sourcePath);
  const resolved = ts.resolveModuleName(original, resolve(input.rootDir, sourcePath), options, ts.sys).resolvedModule?.resolvedFileName;
  if (!resolved) throw new PlanningError(`value split could not resolve relative import ${original}`);
  let path = relative(dirname(resolve(input.rootDir, targetPath)), resolved).replaceAll("\\", "/");
  if (!path.startsWith(".")) path = `./${path}`;
  return path.replace(/\.(?:tsx?|jsx?)$/u, original.match(/\.(?:tsx?|jsx?)$/u)?.[0] ?? "");
}

function write(path: string, preconditionHash: Sha256 | typeof MISSING, preconditionMode: number | "missing", contents: string): PreparationWriteFileOperation {
  return {
    kind: "write-file",
    purpose: "value-split",
    contents,
    file: { path, preconditionHash, preconditionMode, resultHash: hashText(contents), resultMode: preconditionMode === "missing" ? 0o644 : preconditionMode },
  };
}
