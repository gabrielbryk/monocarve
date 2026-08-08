import { packageNameMatcher, type MonocarveConfig } from "../config.ts";
import type { DependencyGraph } from "../graph/model.ts";
import { PlanningError, type WorkspaceContext } from "../plan/context.ts";
import type { CandidateRecommendation, RejectionReason } from "../portfolio/types.ts";
import { assessEvacuationCandidate } from "./assessment.ts";
import type { AssessedEvacuation } from "./assessment.ts";
import { buildEvacuationCandidate } from "./candidate.ts";
import type { EvacuationBoundaryCut } from "./cuts.ts";
import { resolveEvacuationSelectors } from "./selectors.ts";
import { authorizeProtectedRoots } from "./protected-authorization.ts";

export interface EvacuationAnalysisOptions {
  readonly config: MonocarveConfig;
  readonly graph: DependencyGraph;
  readonly context?: WorkspaceContext;
  readonly application: string;
  readonly sources: readonly string[];
  readonly packageName: string;
  readonly authorizedProtectedRoots?: readonly string[];
}

export interface EvacuationReport {
  readonly schema: "evacuation";
  readonly id: string;
  readonly application: string;
  readonly target: { readonly packageName: string };
  readonly authorizedProtectedRoots: readonly string[];
  readonly requested: readonly string[];
  readonly moved: { readonly files: readonly string[]; readonly lineCount: number };
  readonly retainedComposition: readonly { readonly id: string; readonly members: readonly string[] }[];
  readonly absorbedSccPeers: readonly string[];
  readonly unselectedDependencies: readonly string[];
  readonly boundaryCuts: readonly EvacuationBoundaryCut[];
  readonly candidate: {
    readonly eligible: boolean;
    readonly classification: "extraction" | "preparation" | null;
    readonly rejectionReasons: readonly RejectionReason[];
    readonly warnings: readonly string[];
    readonly recommendation: CandidateRecommendation | null;
  };
}

/** Run the complete read-only bounded evacuation analysis. */
export function analyzeEvacuation(options: EvacuationAnalysisOptions): EvacuationReport {
  return evacuationReport(prepareEvacuation(options), options.packageName);
}

/** Resolve, union, and assess once for report or immutable plan compilation. */
export function prepareEvacuation(options: EvacuationAnalysisOptions): AssessedEvacuation {
  if (!packageNameMatcher(options.config).test(options.packageName)) {
    throw new PlanningError(`package name ${JSON.stringify(options.packageName)} does not match the configured pattern`);
  }
  const selected = resolveEvacuationSelectors(options.graph, options.application, options.sources);
  const authorizedProtectedRoots = authorizeProtectedRoots(options.config, options.graph, options.application, selected, options.authorizedProtectedRoots ?? []);
  const evacuation = buildEvacuationCandidate({
    config: options.config,
    graph: options.graph,
    application: options.application,
    selected,
    authorizedProtectedRoots,
  });
  return assessEvacuationCandidate({
    config: options.config,
    graph: options.graph,
    evacuation,
    packageName: options.packageName,
    authorizedProtectedRoots,
    ...(options.context ? { context: options.context } : {}),
  });
}

export function evacuationReport(assessed: AssessedEvacuation, packageName: string): EvacuationReport {
  const evacuation = assessed.evacuation;
  return {
    schema: "evacuation",
    id: evacuation.id,
    application: evacuation.application,
    target: { packageName },
    authorizedProtectedRoots: assessed.authorizedProtectedRoots,
    requested: evacuation.requested,
    moved: { files: evacuation.files, lineCount: evacuation.lineCount },
    retainedComposition: evacuation.retainedComposition,
    absorbedSccPeers: evacuation.absorbedSccPeers,
    unselectedDependencies: evacuation.unselectedDependencies,
    boundaryCuts: assessed.boundaryCuts,
    candidate: {
      eligible: assessed.candidate.eligible,
      classification: assessed.candidate.classification ?? null,
      rejectionReasons: assessed.candidate.rejectionReasons,
      warnings: assessed.candidate.warnings,
      recommendation: assessed.candidate.recommendation ?? null,
    },
  };
}

export function formatEvacuationReport(report: EvacuationReport): string {
  const cuts = report.boundaryCuts.length === 0
    ? "none"
    : report.boundaryCuts.map((cut) => `  ${cut.kind} ${cut.from} -> ${cut.target} (${cut.reason}, ${cut.remedy.kind})`).join("\n");
  const blockers = report.candidate.rejectionReasons.length === 0
    ? "none"
    : report.candidate.rejectionReasons.map((reason) => `  ${reason.code}: ${reason.detail}`).join("\n");
  return [
    `Evacuation ${report.id}`,
    `Application: ${report.application}`,
    `Target: ${report.target.packageName}`,
    `Requested: ${report.requested.length}`,
    `Moved: ${report.moved.files.length} files / ${report.moved.lineCount} LOC`,
    `Retained composition: ${report.retainedComposition.flatMap((scc) => scc.members).length}`,
    `Absorbed SCC peers: ${report.absorbedSccPeers.length}`,
    `Unselected dependencies: ${report.unselectedDependencies.length}`,
    `Eligible: ${report.candidate.eligible ? "yes" : "no"}`,
    "Boundary cuts:", cuts,
    "Blockers:", blockers,
  ].join("\n");
}
