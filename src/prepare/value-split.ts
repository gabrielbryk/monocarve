import ts from "typescript";

import { GENERATOR } from "../branding.ts";
import type { MonocarveConfig } from "../config.ts";
import type { DependencyGraph } from "../graph/model.ts";
import { PlanningError } from "../plan/context.ts";
import { analyzeTypeScriptSource } from "../symbols/analyze.ts";
import { resolveCommit, showBaseline } from "../util/git.ts";
import { byCodeUnit, hashJson, hashText, MISSING, type Sha256 } from "../util/hash.ts";
import { baselineFileMode, type PreparationManifestRendering } from "./build.ts";
import { assertPreparationManifestValid, createPreparationManifest, preparationOperationPaths } from "./manifest.ts";
import type { PreparationManifest, PreparationReplayOperation, PreparationWriteFileOperation } from "./manifest-types.ts";
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

/** Compile one configured, dependency-closed exported value split. */
export function compileValueSplit(input: CompileValueSplitInput): PreparationManifest {
  const split = input.config.valueSplits.find((item) => item.id === input.splitId);
  if (!split) throw new PlanningError(`unknown value split ${JSON.stringify(input.splitId)}`);
  const baseline = resolveCommit(input.rootDir, input.baselineCommit);
  if (input.graph.commit !== baseline.commit) throw new PlanningError("value split requires a fresh graph at the exact baseline");
  const sourceText = showBaseline(input.rootDir, baseline.commit, split.source);
  if (sourceText === null) throw new PlanningError(`value split source does not exist at baseline: ${split.source}`);
  if (showBaseline(input.rootDir, baseline.commit, split.target) !== null) throw new PlanningError(`value split target already exists at baseline: ${split.target}`);

  const analysis = analyzeTypeScriptSource({ sourcePath: split.source, sourceText });
  const group = analysis.groups.find((item) => item.name === split.symbol);
  if (!group) throw new PlanningError(`value split symbol is not a top-level declaration: ${split.symbol}`);
  if (!group.exported || (group.space !== "value" && group.space !== "both")) throw new PlanningError(`value split symbol must be exported in value space: ${split.symbol}`);
  const component = analysis.components.find((item) => item.groupIds.includes(group.id));
  if (!component || component.groupIds.length !== 1) throw new PlanningError(`value split symbol belongs to a multi-group declaration cycle: ${split.symbol}`);
  const outgoing = analysis.edges.filter((edge) => edge.source === group.id && edge.target !== group.id);
  if (outgoing.length > 0) {
    const names = outgoing.map((edge) => analysis.groups.find((item) => item.id === edge.target)?.name ?? edge.target).sort(byCodeUnit);
    throw new PlanningError(`value split symbol depends on retained declaration(s): ${names.join(", ")}`);
  }

  const declarations = group.declarationIds.map((id) => analysis.declarations.find((item) => item.id === id)).filter((item) => item !== undefined)
    .sort((left, right) => left.span.start - right.span.start);
  if (declarations.length !== group.declarationIds.length) throw new PlanningError(`value split declaration group is incomplete: ${split.symbol}`);
  const sourceFile = ts.createSourceFile(split.source, sourceText, ts.ScriptTarget.Latest, true, split.source.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const regions = declarations.map((declaration) => {
    const statement = sourceFile.statements.find((item) => item.getStart(sourceFile) === declaration.span.start && item.end === declaration.span.end);
    if (!statement) throw new PlanningError(`value split declaration span is not one complete statement: ${split.symbol}`);
    return { start: statement.getFullStart(), end: statement.end };
  });
  const importedBindings = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const clause = statement.importClause;
    if (clause?.name) importedBindings.add(clause.name.text);
    if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) importedBindings.add(clause.namedBindings.name.text);
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) for (const element of clause.namedBindings.elements) importedBindings.add(element.name.text);
  }
  const usedImportedBindings = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && importedBindings.has(node.text)) usedImportedBindings.add(node.text);
    ts.forEachChild(node, visit);
  };
  for (const statement of sourceFile.statements) if (regions.some((region) => statement.getFullStart() === region.start && statement.end === region.end)) visit(statement);
  if (usedImportedBindings.size > 0) throw new PlanningError(`value split symbol depends on imported binding(s): ${[...usedImportedBindings].sort(byCodeUnit).join(", ")}`);
  const targetContents = regions.map((region) => sourceText.slice(region.start, region.end)).join("").replace(/^\s*/, "") + "\n";
  let donorContents = sourceText;
  for (const region of [...regions].sort((left, right) => right.start - left.start)) donorContents = donorContents.slice(0, region.start) + donorContents.slice(region.end);
  donorContents = `${donorContents.replace(/\s*$/, "\n\n")}export { ${split.symbol} } from ${JSON.stringify(split.targetModuleSpecifier)};\n`;
  const sourceMode = baselineFileMode(input.rootDir, baseline.commit, split.source);
  const operations: PreparationReplayOperation[] = [
    write(split.source, hashText(sourceText), sourceMode, donorContents),
    write(split.target, MISSING, "missing", targetContents),
  ].sort((left, right) => byCodeUnit(preparationOperationPaths(left)[0]!, preparationOperationPaths(right)[0]!));
  const policyAnchor = { sourcePath: split.source, targetPath: split.target, targetModuleSpecifier: split.targetModuleSpecifier };
  const changedSourcePaths = operations.flatMap(preparationOperationPaths);
  const postJournalPreparers = preparationPostJournalRecords(input.config, changedSourcePaths);
  const manifest = createPreparationManifest({
    schemaVersion: 1,
    createdAt: baseline.committedAt,
    generator: { ...GENERATOR },
    baseline: { commit: baseline.commit, committerDate: baseline.committedAt, configDigest: hashJson(input.config) },
    graphDigest: input.graphDigest,
    policyAnchor,
    declarations: [],
    operations,
    postJournalPreparers,
    compatibilityReexports: [],
    changedFiles: [...changedSourcePaths, ...postJournalPreparers.flatMap((item) => item.outputs)].sort(byCodeUnit),
    commits: { prepare: input.rendering.commit },
    gates: {
      package: [...input.rendering.gates.package].sort(byCodeUnit),
      project: [...input.rendering.gates.project].sort(byCodeUnit),
      workspace: [...input.rendering.gates.workspace].sort(byCodeUnit),
    },
  });
  assertPreparationManifestValid(manifest);
  return manifest;
}

function write(path: string, preconditionHash: Sha256 | typeof MISSING, preconditionMode: number | "missing", contents: string): PreparationWriteFileOperation {
  return { kind: "write-file", purpose: "value-split", contents, file: { path, preconditionHash, preconditionMode, resultHash: hashText(contents), resultMode: preconditionMode === "missing" ? 0o644 : preconditionMode } };
}
