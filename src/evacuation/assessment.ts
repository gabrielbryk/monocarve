import { domainFor, type MonocarveConfig } from "../config.ts";
import { buildApplicationGraph } from "../graph/components.ts";
import { componentReports, type ComponentReport } from "../graph/layers.ts";
import type { DependencyGraph } from "../graph/model.ts";
import { partitionTests } from "../plan/consumers.ts";
import { WorkspaceContext } from "../plan/context.ts";
import { buildPathReferenceIndex, type PathReferenceIndex } from "../plan/path-references.ts";
import { estimateCandidateEffort } from "../portfolio/effort.ts";
import { recommendCandidate } from "../portfolio/recommendation.ts";
import { preparationRecipe } from "../portfolio/recipe.ts";
import { assessCandidate, dedupeReasons, planabilityRejections, protectedPathRejections } from "../portfolio/rank-assessment.ts";
import { scoreCandidate, suggestedPackageName } from "../portfolio/rank.ts";
import { detectCompatibilityShims } from "../portfolio/shims.ts";
import type { PortfolioCandidate } from "../portfolio/types.ts";
import { byCodeUnit } from "../util/hash.ts";
import type { EvacuationCandidate } from "./candidate.ts";
import { evacuationBoundaryCuts, type EvacuationBoundaryCut } from "./cuts.ts";
import { EvacuationSelectorError } from "./selectors.ts";

export interface AssessedEvacuation {
  readonly evacuation: EvacuationCandidate;
  readonly candidate: PortfolioCandidate;
  readonly boundaryCuts: readonly EvacuationBoundaryCut[];
}

export interface AssessEvacuationOptions {
  readonly config: MonocarveConfig;
  readonly graph: DependencyGraph;
  readonly evacuation: EvacuationCandidate;
  readonly context?: WorkspaceContext;
  readonly pathReferences?: PathReferenceIndex;
  readonly packageName?: string;
}

/** Apply ordinary portfolio safety and planning checks to an explicit bounded evacuation. */
export function assessEvacuationCandidate(options: AssessEvacuationOptions): AssessedEvacuation {
  const { config, graph, evacuation } = options;
  if (evacuation.files.length === 0) throw new EvacuationSelectorError("evacuation contains no movable production files");
  const context = options.context ?? new WorkspaceContext(config, graph.rootDir);
  const pathReferences = options.pathReferences ?? buildPathReferenceIndex(context);
  const reports = componentReports(config, graph, buildApplicationGraph(graph, evacuation.application));
  const moved = new Set(evacuation.files);
  const closureReports = reports.filter((report) => report.nodes.some((path) => moved.has(path)));
  const domains = [...new Set(evacuation.files.map((path) => domainFor(config, path)))].sort(byCodeUnit);
  const owners = [...new Set(evacuation.files.map((path) => graph.nodes.get(path)?.owner ?? "unknown"))].sort(byCodeUnit);
  const directTests = [...new Set(evacuation.files.flatMap((path) => [...(graph.testImporters.get(path) ?? [])]))].sort(byCodeUnit);
  const aggregate = aggregateReport(graph, evacuation, closureReports, domains, directTests);
  const firstAssessment = assessCandidate(config, context, pathReferences, graph, aggregate, evacuation.files, closureReports, owners, domains, []);

  let tests = directTests;
  let partitionFailure: unknown;
  try {
    tests = partitionTests(context, evacuation.files, directTests, firstAssessment.assets).travelling.slice();
  } catch (error) {
    partitionFailure = error;
  }
  const assessment = partitionFailure === undefined
    ? assessCandidate(config, context, pathReferences, graph, aggregate, evacuation.files, closureReports, owners, domains, tests)
    : firstAssessment;
  const rejections = [...assessment.rejections];
  if (partitionFailure !== undefined) {
    rejections.push({ code: "unplannable", detail: `test relocation: ${partitionFailure instanceof Error ? partitionFailure.message : String(partitionFailure)}`, edges: [] });
    tests = directTests;
  }
  rejections.push(...protectedPathRejections(config, [...evacuation.files, ...tests, ...assessment.assets]));
  rejections.push(...planabilityRejections(config, context, graph, evacuation.files, tests, evacuation.id));

  const rejectionReasons = dedupeReasons(rejections);
  const compatibilityShims = detectCompatibilityShims(context, graph).filter((shim) => moved.has(shim.path));
  const base = {
    id: evacuation.id,
    application: evacuation.application,
    suggestedPackageName: options.packageName ?? suggestedPackageName(config, evacuation.application, domains, evacuation.id),
    files: evacuation.files,
    tests,
    assets: assessment.assets,
    sccs: evacuation.sccs,
    seed: evacuation.seedSccs.find((scc) => scc.members.some((path) => moved.has(path))) ?? evacuation.sccs[0]!,
    lineCount: evacuation.lineCount,
    owners,
    domains,
    dependencies: evacuation.dependencies,
    consumers: evacuation.consumers,
    consumerChurn: evacuation.consumers.length,
    coverage: tests.length === 0 ? 0 : Math.min(1, tests.length / evacuation.files.length),
    eligible: rejectionReasons.length === 0,
    rejectionReasons,
    warnings: [...new Set(assessment.warnings)].sort(byCodeUnit),
    rewriteEscapes: assessment.rewriteEscapes,
    compatibilityShims,
    classification: assessment.classification,
    retainedBlockers: assessment.retainedBlockers,
    recipe: preparationRecipe(config, assessment.retainedBlockers),
  };
  const recommendation = recommendCandidate(config, context, graph, base, compatibilityShims);
  const withRecommendation = { ...base, recommendation };
  const effort = estimateCandidateEffort(withRecommendation);
  const candidate: PortfolioCandidate = { ...withRecommendation, effort, score: scoreCandidate(config, { ...withRecommendation, effort }) };
  return { evacuation, candidate, boundaryCuts: evacuationBoundaryCuts(config, context, graph, evacuation) };
}

function aggregateReport(
  graph: DependencyGraph,
  evacuation: EvacuationCandidate,
  reports: readonly ComponentReport[],
  domains: readonly string[],
  tests: readonly string[],
): ComponentReport {
  const moved = new Set(evacuation.files);
  const inboundNodes = graph.edges.filter((edge) => !moved.has(edge.from) && moved.has(edge.to)).map((edge) => edge.from);
  const directEdges = graph.edges.filter((edge) => moved.has(edge.from));
  return {
    id: -1,
    application: evacuation.application,
    layer: Math.max(0, ...reports.map((report) => report.layer)),
    cyclic: reports.some((report) => report.cyclic),
    nodes: evacuation.files,
    lines: evacuation.lineCount,
    dependencies: [],
    dependents: [],
    inboundNodes: [...new Set(inboundNodes)].sort(byCodeUnit),
    testImporterFiles: tests,
    transitiveClosure: evacuation.absorbedSccPeers,
    transitiveClosureLines: evacuation.lineCount,
    domains,
    closedWithinDomain: domains.length === 1,
    libraryDependencies: evacuation.dependencies,
    externalPackages: [...new Set(evacuation.files.flatMap((path) => [...(graph.externalBySource.get(path) ?? [])]))].sort(byCodeUnit),
    frameworkDependencies: [...new Set(reports.flatMap((report) => report.frameworkDependencies))].sort(byCodeUnit),
    archetype: "module-candidate",
    generated: reports.flatMap((report) => report.generated).sort((left, right) => byCodeUnit(left.node, right.node)),
    dynamicImports: directEdges.filter((edge) => edge.dynamic).map((edge) => edge.specifier).sort(byCodeUnit),
    typeOnlyEdges: directEdges.filter((edge) => edge.typeOnly).length,
    flags: [...new Set(reports.flatMap((report) => report.flags).filter((flag) => flag !== "composition-root" && flag !== "composition-or-route"))].sort(byCodeUnit),
  };
}
