/** Candidate enumeration and ranking. */

import { domainFor, packageNameMatcher, scopedPackageName, type MonocarveConfig } from "../config.ts";
import { buildApplicationGraph, sccId, transitive, type ApplicationGraph } from "../graph/components.ts";
import { componentReports, type ComponentReport } from "../graph/layers.ts";
import type { DependencyGraph, Scc } from "../graph/model.ts";
import { partitionTests } from "../plan/consumers.ts";
import { WorkspaceContext } from "../plan/context.ts";
import { buildPathReferenceIndex, type PathReferenceIndex } from "../plan/path-references.ts";
import { byCodeUnit, hashText } from "../util/hash.ts";
import { estimateCandidateEffort } from "./effort.ts";
import { groupEquivalentCandidates } from "./groups.ts";
import { assessCandidate, dedupeReasons, planabilityRejections, protectedPathRejections, sizeRejections } from "./rank-assessment.ts";
import { preparationRecipe } from "./recipe.ts";
import { recommendCandidate } from "./recommendation.ts";
import { detectCompatibilityShims } from "./shims.ts";
import type { ConsumerRef, Portfolio, PortfolioCandidate } from "./types.ts";

export interface PortfolioOptions {
  readonly config: MonocarveConfig;
  readonly graph: DependencyGraph;
  /** Shared planning caches; created per call when omitted. */
  readonly context?: WorkspaceContext;
  /** Repo-wide index of paths written as strings, shared by all candidates. */
  readonly pathReferences?: PathReferenceIndex;
  /** Restrict to one application. */
  readonly application?: string;
  /** Include candidates listed in `portfolio.extracted`. */
  readonly includeExtracted?: boolean;
}

export function buildPortfolio(options: PortfolioOptions): Portfolio {
  const { config, graph } = options;
  const context = options.context ?? new WorkspaceContext(config, graph.rootDir);
  const pathReferences = options.pathReferences ?? buildPathReferenceIndex(context);
  const applicationGraph = buildApplicationGraph(graph, options.application);
  const reports = componentReports(config, graph, applicationGraph);
  const skip = new Set(options.includeExtracted ? [] : config.portfolio.extracted);
  const compatibilityShims = detectCompatibilityShims(context, graph);
  const candidates = reports
    .map((report) => candidateFor(config, context, pathReferences, graph, applicationGraph, reports, report, compatibilityShims))
    .filter((candidate): candidate is PortfolioCandidate => candidate !== null)
    .filter((candidate) => !skip.has(candidate.id));
  return {
    rootDir: graph.rootDir,
    ...(graph.commit === undefined ? {} : { commit: graph.commit }),
    candidates,
    selected: selectNonOverlapping(candidates),
    equivalenceGroups: groupEquivalentCandidates(candidates, config.portfolio.equivalenceThreshold),
  };
}

/** Select compatible candidates against one unchanged baseline. */
function selectNonOverlapping(candidates: readonly PortfolioCandidate[]): string[] {
  const ranked = [...candidates].toSorted((left, right) => right.score - left.score || byCodeUnit(left.id, right.id));
  const occupied = new Set<string>();
  const selected: string[] = [];
  for (const candidate of ranked) {
    if (!candidate.eligible) continue;
    const claimed = [...candidate.files, ...candidate.tests, ...candidate.assets];
    if (claimed.some((path) => occupied.has(path))) continue;
    selected.push(candidate.id);
    for (const path of claimed) occupied.add(path);
  }
  return selected;
}

function candidateFor(
  config: MonocarveConfig,
  context: WorkspaceContext,
  pathReferences: PathReferenceIndex,
  graph: DependencyGraph,
  applicationGraph: ApplicationGraph,
  reports: readonly ComponentReport[],
  report: ComponentReport,
  allCompatibilityShims: readonly import("./types.ts").CompatibilityShim[],
): PortfolioCandidate | null {
  if (report.application === null) return null;
  const components = applicationGraph.condensed.components;
  const ids = new Set<number>([report.id, ...transitive(report.id, applicationGraph.condensed.outgoing)]);
  const closure = [...ids].flatMap((id) => components[id] ?? []).toSorted();
  if (closure.length === 0) return null;

  const closureReports = [...ids].map((id) => reports[id]).filter((item): item is ComponentReport => item !== undefined);
  const owners = [...new Set(closure.map((path) => graph.nodes.get(path)?.owner ?? "unknown"))].toSorted();
  const domains = [...new Set(closure.map((path) => domainFor(config, path)))].toSorted();
  const directTests = [...new Set(closure.flatMap((path) => [...(graph.testImporters.get(path) ?? [])]))].toSorted();
  const id = `c-${hashText(closure.join("\n")).slice(0, 12)}`;
  const assessment = assessCandidate(config, context, pathReferences, graph, report, closure, closureReports, owners, domains, []);

  let tests = directTests;
  let partitionFailure: unknown;
  try {
    tests = partitionTests(context, closure, directTests, assessment.assets).travelling.slice();
  } catch (error) {
    partitionFailure = error;
  }
  const assessed =
    partitionFailure === undefined
      ? assessCandidate(config, context, pathReferences, graph, report, closure, closureReports, owners, domains, tests)
      : assessment;
  const rejections = [...assessed.rejections];
  if (partitionFailure !== undefined) {
    rejections.push({
      code: "unplannable",
      detail: `test relocation: ${partitionFailure instanceof Error ? partitionFailure.message : String(partitionFailure)}`,
      edges: [],
    });
    tests = directTests;
  }
  rejections.push(...protectedPathRejections(config, [...closure, ...tests, ...assessed.assets]));
  rejections.push(...sizeRejections(config, closure));
  rejections.push(...planabilityRejections(config, context, graph, closure, tests, id));

  const lineCount = closure.reduce((total, path) => total + (graph.nodes.get(path)?.lineCount ?? 0), 0);
  const consumerChurn = report.inboundNodes.length + report.testImporterFiles.length;
  const coverage = tests.length === 0 ? 0 : Math.min(1, tests.length / Math.max(1, closure.length));
  const rejectionReasons = dedupeReasons(rejections);
  const compatibilityShims = allCompatibilityShims.filter((shim) => closure.includes(shim.path));
  const base = {
    id,
    application: report.application,
    suggestedPackageName: suggestedPackageName(config, report.application, domains, id),
    files: closure,
    tests,
    assets: assessed.assets,
    sccs: candidateSccs(ids, components),
    seed: { id: sccId(report.nodes), members: [...report.nodes].toSorted() },
    lineCount,
    owners,
    domains,
    dependencies: packageDependencies(graph, report),
    consumers: consumerRefs(graph, report, closure),
    consumerChurn,
    coverage,
    eligible: rejectionReasons.length === 0,
    rejectionReasons,
    warnings: [...new Set(assessed.warnings)],
    rewriteEscapes: assessed.rewriteEscapes,
    compatibilityShims,
    classification: assessed.classification,
    retainedBlockers: assessed.retainedBlockers,
    recipe: preparationRecipe(config, assessed.retainedBlockers),
  };
  const recommendation = recommendCandidate(config, context, graph, base, compatibilityShims);
  const withRecommendation = { ...base, recommendation };
  const effort = estimateCandidateEffort(withRecommendation);
  return { ...withRecommendation, effort, score: scoreCandidate(config, { ...withRecommendation, effort }) };
}

function candidateSccs(ids: ReadonlySet<number>, components: readonly (readonly string[])[]): Scc[] {
  return [...ids]
    .map((componentId) => components[componentId] ?? [])
    .filter((component) => component.length > 0)
    .map((component): Scc => ({ id: sccId(component), members: [...component].toSorted() }))
    .toSorted((left, right) => left.id.localeCompare(right.id));
}

function consumerRefs(graph: DependencyGraph, report: ComponentReport, closure: readonly string[]): ConsumerRef[] {
  const closureSet = new Set(closure);
  const application = graph.nodes.get(closure[0]!)?.application;
  const byFile = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    if (closureSet.has(edge.from) || !closureSet.has(edge.to)) continue;
    const specifiers = byFile.get(edge.from) ?? new Set<string>();
    specifiers.add(edge.specifier);
    byFile.set(edge.from, specifiers);
  }
  for (const file of report.testImporterFiles) if (!byFile.has(file)) byFile.set(file, new Set());
  return [...byFile.entries()]
    .map(([file, specifiers]) => ({
      file,
      owner: graph.nodes.get(file)?.owner ?? "unknown",
      specifiers: [...specifiers].toSorted(),
      external: graph.nodes.get(file)?.application !== application,
    }))
    .toSorted((left, right) => left.file.localeCompare(right.file));
}

function packageDependencies(graph: DependencyGraph, report: ComponentReport): string[] {
  const ownerToPackage = new Map([...graph.workspace.packageNames.entries()].map(([name, owner]) => [owner, name]));
  return [...new Set(report.libraryDependencies.map((owner) => ownerToPackage.get(owner) ?? owner))].toSorted();
}

export function suggestedPackageName(config: MonocarveConfig, application: string, domains: readonly string[], candidateId: string): string {
  const slug = (domains[0] ?? application)
    .split(":")
    .at(-1)!
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  const name = scopedPackageName(config, slug === "" ? candidateId : slug);
  return packageNameMatcher(config).test(name) ? name : scopedPackageName(config, candidateId);
}

export function scoreCandidate(config: MonocarveConfig, candidate: Omit<PortfolioCandidate, "score">): number {
  const weights = config.portfolio.weights;
  const advisoryLineCount = candidate.lineCount - (candidate.compatibilityShims ?? []).reduce((sum, shim) => sum + shim.lineCount, 0);
  return (
    advisoryLineCount * weights.lineCount +
    candidate.files.length * weights.fileCount +
    candidate.consumerChurn * weights.consumerCount +
    candidate.coverage * weights.testCoverage +
    candidate.dependencies.length * weights.prerequisite +
    candidate.rejectionReasons.length * weights.rejection +
    candidate.rewriteEscapes.length * weights.rewriteEscape +
    (candidate.domains.length > 1 ? weights.domainCrossing : 0) +
    (candidate.domains.length > 1 ? weights.runtimeCrossing : 0) +
    (candidate.retainedBlockers?.length ?? 0) * weights.retainedEdge
  );
}

export function pickNext(portfolio: Portfolio, alreadyExtracted: readonly string[] = []): PortfolioCandidate | null {
  const skip = new Set(alreadyExtracted);
  return (
    portfolio.candidates
      .filter((candidate) => candidate.eligible && candidate.recommendation?.status === "recommended" && !skip.has(candidate.id))
      .toSorted((left, right) => right.score - left.score || left.id.localeCompare(right.id))[0] ?? null
  );
}

export function candidateById(portfolio: Portfolio, id: string): PortfolioCandidate {
  const candidate = portfolio.candidates.find((entry) => entry.id === id);
  if (!candidate) throw new Error(`candidate ${id} was not produced by the portfolio`);
  return candidate;
}
