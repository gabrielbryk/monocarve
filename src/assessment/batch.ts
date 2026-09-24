import ts from "typescript";
import { domainFor, getApplication } from "../config.ts";
import { MonocarveError, UsageError } from "../errors.ts";
import { analyzeCouplingHotspots, buildPortfolio } from "../portfolio/index.ts";
import {
  analyzeWorkspaceSymbolsWithProgram,
  createWorkspaceSymbolProgram,
  SymbolAnalysisError,
  WorkspaceProgramError,
  type ProgramCompletenessDiagnostic,
  type WorkspaceSymbolAnalysis,
  type WorkspaceSymbolProgram,
} from "../symbols/index.ts";
import { byCodeUnit, hashText } from "../util/hash.ts";
import { relativeWorkspacePath } from "../util/paths.ts";
import type { AssessmentSnapshot } from "./snapshot.ts";

interface DeclarationBatchEntry {
  readonly sourcePath: string;
  readonly reportPath: string;
  readonly sourceHash: string;
  readonly declarationCount: number;
  readonly splitCandidateCount: number;
  readonly dominantAffinities: readonly string[];
  readonly unclassifiedCount: number;
  readonly cycleCount: number;
  readonly status: "complete";
}

export interface DeclarationBatchAggregate {
  readonly schemaVersion: 1;
  readonly baseline: AssessmentSnapshot["baseline"];
  readonly application: string;
  readonly selection: {
    readonly mode: "files" | "hotspots";
    readonly requested: number;
    readonly selected: number;
    readonly deduplicated: number;
    readonly reason?: string;
  };
  readonly diagnostics: readonly ProgramCompletenessDiagnostic[];
  readonly completed: readonly string[];
  readonly failed: readonly string[];
  readonly entries: readonly DeclarationBatchEntry[];
}

export interface DeclarationBatchResult {
  readonly aggregate: DeclarationBatchAggregate;
  readonly reports: Readonly<Record<string, WorkspaceSymbolAnalysis>>;
}

export class BatchAnalysisError extends MonocarveError {
  override readonly name = "BatchAnalysisError";
  constructor(
    readonly aggregate: Omit<DeclarationBatchAggregate, "schemaVersion" | "baseline">,
    message: string,
  ) {
    super(`SPLIT_ANALYSIS_INCOMPLETE: ${message}`);
  }
}

function selectHotspotTargets(snapshot: AssessmentSnapshot, count: number): string[] {
  if (!Number.isSafeInteger(count) || count <= 0) throw new UsageError("--split-hotspots must be a positive integer");
  snapshot.verify();
  if (snapshot.qualification.status === "degraded") return [];
  const portfolio = buildPortfolio({ config: snapshot.config, graph: snapshot.graph, context: snapshot.context, application: snapshot.application });
  return analyzeCouplingHotspots(snapshot.graph, portfolio, snapshot.application)
    .map((entry) => entry.path)
    .filter((path) => {
      const node = snapshot.graph.nodes.get(path);
      return node?.application === snapshot.application && !node.isDeclaration && !node.isAsset && !node.isTest;
    })
    .slice(0, count);
}

export function analyzeDeclarationBatch(
  snapshot: AssessmentSnapshot,
  selection: { readonly mode: "files"; readonly paths: readonly string[] } | { readonly mode: "hotspots"; readonly count: number },
): DeclarationBatchResult {
  snapshot.verify();
  const { paths, record: selectionRecord } = resolveSelection(snapshot, selection);
  validateTargets(snapshot, paths, selectionRecord);
  if (paths.length === 0)
    return {
      aggregate: {
        schemaVersion: 1,
        baseline: snapshot.baseline,
        application: snapshot.application,
        selection: selectionRecord,
        diagnostics: [],
        completed: [],
        failed: [],
        entries: [],
      },
      reports: {},
    };
  const workspace = createBatchProgram(snapshot, paths, selectionRecord);
  const diagnostics = [...workspace.diagnostics, ...unsupportedProgramRelationships(workspace)].toSorted(
    (left, right) =>
      byCodeUnit(left.path ?? "", right.path ?? "") ||
      (left.start ?? -1) - (right.start ?? -1) ||
      left.code - right.code ||
      byCodeUnit(left.message, right.message),
  );
  const errors = diagnostics.filter((entry) => entry.category === "error");
  if (errors.length > 0)
    throw new BatchAnalysisError(
      { application: snapshot.application, selection: selectionRecord, diagnostics, completed: [], failed: paths, entries: [] },
      `the selected application program has ${errors.length} error diagnostic(s)`,
    );
  const reports: Record<string, WorkspaceSymbolAnalysis> = {};
  const entries: DeclarationBatchEntry[] = [];
  for (const path of paths) {
    snapshot.verify();
    try {
      const analyzed = analyzeTarget(snapshot, workspace, path);
      reports[analyzed.entry.reportPath] = analyzed.report;
      entries.push(analyzed.entry);
    } catch (error) {
      const failed = paths.slice(entries.length);
      const detail = error instanceof SymbolAnalysisError ? error.message : String(error);
      throw new BatchAnalysisError(
        { application: snapshot.application, selection: selectionRecord, diagnostics, completed: entries.map((entry) => entry.sourcePath), failed, entries },
        detail,
      );
    }
  }
  snapshot.verify();
  return {
    aggregate: {
      schemaVersion: 1,
      baseline: snapshot.baseline,
      application: snapshot.application,
      selection: selectionRecord,
      diagnostics,
      completed: entries.map((entry) => entry.sourcePath),
      failed: [],
      entries,
    },
    reports,
  };
}

type BatchSelectionRecord = DeclarationBatchAggregate["selection"];

function resolveSelection(
  snapshot: AssessmentSnapshot,
  selection: { readonly mode: "files"; readonly paths: readonly string[] } | { readonly mode: "hotspots"; readonly count: number },
): { readonly paths: string[]; readonly record: BatchSelectionRecord } {
  const raw =
    selection.mode === "files" ? selection.paths.map((path) => relativeWorkspacePath(snapshot.rootDir, path)) : selectHotspotTargets(snapshot, selection.count);
  const paths = [...new Set(raw)].toSorted(byCodeUnit);
  return {
    paths,
    record: {
      mode: selection.mode,
      requested: selection.mode === "files" ? raw.length : selection.count,
      selected: paths.length,
      deduplicated: raw.length - paths.length,
      ...(selection.mode === "hotspots" && paths.length === 0 ? { reason: "captured ranking selected no analyzable production sources" } : {}),
    },
  };
}

function validateTargets(snapshot: AssessmentSnapshot, paths: readonly string[], selection: BatchSelectionRecord): void {
  for (const path of paths) {
    const node = snapshot.graph.nodes.get(path);
    if (!node || node.zone !== "application" || node.application !== snapshot.application || node.isDeclaration || node.isAsset || node.isTest) {
      throw new BatchAnalysisError(
        { application: snapshot.application, selection, diagnostics: [], completed: [], failed: [path], entries: [] },
        `${path} is not an analyzable production source in ${snapshot.application}`,
      );
    }
  }
}

function createBatchProgram(snapshot: AssessmentSnapshot, paths: readonly string[], selection: BatchSelectionRecord): WorkspaceSymbolProgram {
  try {
    const application = getApplication(snapshot.config, snapshot.application);
    const workspace = createWorkspaceSymbolProgram(
      snapshot.rootDir,
      application.tsconfig,
      [...application.consumerRoots, ...snapshot.config.firstPartyRoots, ...snapshot.config.firstPartyPackages.map((pkg) => pkg.root)],
      snapshot.readTypeScriptInput,
    );
    snapshot.verify();
    return workspace;
  } catch (error) {
    const diagnostics =
      error instanceof WorkspaceProgramError
        ? [...error.completenessDiagnostics]
        : error instanceof SymbolAnalysisError
          ? error.diagnostics.map((entry) => ({ phase: "semantic" as const, code: entry.code, category: entry.category, message: entry.message }))
          : [{ phase: "configuration" as const, code: 0, category: "error" as const, message: error instanceof Error ? error.message : String(error) }];
    throw new BatchAnalysisError(
      { application: snapshot.application, selection, diagnostics, completed: [], failed: paths, entries: [] },
      error instanceof Error ? error.message : String(error),
    );
  }
}

function analyzeTarget(
  snapshot: AssessmentSnapshot,
  workspace: WorkspaceSymbolProgram,
  path: string,
): { readonly report: WorkspaceSymbolAnalysis; readonly entry: DeclarationBatchEntry } {
  const report = analyzeWorkspaceSymbolsWithProgram(workspace, {
    sourcePath: path,
    affinityForPath: (candidate) => snapshot.graph.nodes.get(candidate)?.domain ?? domainFor(snapshot.config, candidate),
  });
  const reportPath = reportPathFor(path);
  return {
    report,
    entry: {
      sourcePath: path,
      reportPath,
      sourceHash: report.source.sourceHash,
      declarationCount: report.source.declarations.length,
      splitCandidateCount: report.splitCandidates.length,
      dominantAffinities: [...new Set(report.splitCandidates.flatMap((entry) => entry.dominantAffinity ?? []))].toSorted(byCodeUnit),
      unclassifiedCount: report.splitCandidates.filter((entry) => entry.dominantAffinity === undefined).length,
      cycleCount: report.source.components.filter((entry) => entry.cyclic).length,
      status: "complete",
    },
  };
}

/**
 * TypeScript can successfully construct a program for a computed module
 * reference while the declaration analyzer has no relationship it can prove.
 * Treat that as an explicit completeness failure in batches.  The legacy
 * single-file surface deliberately keeps its historical report behavior.
 */
function unsupportedProgramRelationships(workspace: {
  readonly rootDir: string;
  readonly program: import("typescript").Program;
}): ProgramCompletenessDiagnostic[] {
  const diagnostics: ProgramCompletenessDiagnostic[] = [];
  for (const file of workspace.program.getSourceFiles()) {
    const absolute = file.fileName.replaceAll("\\", "/");
    if (file.isDeclarationFile || !absolute.startsWith(`${workspace.rootDir.replaceAll("\\", "/").replace(/\/$/u, "")}/`)) continue;
    const sourcePath = relativeWorkspacePath(workspace.rootDir, file.fileName);
    const visit = (node: ts.Node): void => {
      if (!ts.isCallExpression(node) || node.arguments.length === 0) {
        ts.forEachChild(node, visit);
        return;
      }
      const dynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const requireCall = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if ((dynamicImport || requireCall) && !ts.isStringLiteralLike(node.arguments[0]!)) {
        diagnostics.push({
          phase: "semantic",
          code: 0,
          category: "error",
          message: `unsupported computed module relationship (${dynamicImport ? "dynamic-import" : "require"})`,
          path: sourcePath,
          start: node.getStart(file),
          length: node.end - node.getStart(file),
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return diagnostics;
}

function reportPathFor(sourcePath: string): string {
  const slug = sourcePath.replace(/[^A-Za-z0-9._-]/gu, "_");
  return `splits/${slug}-${hashText(sourcePath).slice(0, 12)}.json`;
}
