import type { MonocarveConfig } from "../config.ts";
import { analyzeLayers, type LayerReport } from "../graph/layers.ts";
import type { DependencyGraph } from "../graph/model.ts";
import {
  analyzeCouplingHotspots,
  blockedCandidates,
  buildPortfolio,
  type CouplingHotspot,
  type Portfolio,
  type PortfolioCandidate,
} from "../portfolio/index.ts";
import { byCodeUnit } from "../util/hash.ts";
import type { DeclarationBatchResult } from "./batch.ts";
import { available, unavailable, type Availability } from "./qualification.ts";
import type { AssessmentBaselineIdentity, AssessmentSnapshot } from "./snapshot.ts";

export interface NormalizedGraphFacts {
  readonly firstPartyModules: number;
  readonly applicationModules: number;
  readonly productionLines: number;
  readonly edges: number;
  readonly sccs: number;
  readonly cyclicSccs: number;
  readonly maximumLayer: number;
  readonly dynamicImports: number;
  readonly unresolvedImports: number;
}

export function normalizedGraphFacts(
  config: MonocarveConfig,
  graph: DependencyGraph,
  application?: string,
): { readonly facts: NormalizedGraphFacts; readonly layers: LayerReport } {
  const layers = analyzeLayers(config, graph, application);
  const selected = application === undefined ? undefined : new Set(graph.paths.filter((path) => graph.nodes.get(path)?.application === application));
  const scopedEdges = selected === undefined ? graph.edges : graph.edges.filter((edge) => selected.has(edge.from));
  const scopedUnresolved = selected === undefined ? graph.unresolved : graph.unresolved.filter((entry) => selected.has(entry.source));
  return {
    layers,
    facts: {
      firstPartyModules: selected?.size ?? layers.summary.firstPartyFiles,
      applicationModules: layers.summary.applicationFiles,
      productionLines: layers.components.reduce((sum, component) => sum + component.lines, 0),
      edges: scopedEdges.length,
      sccs: layers.summary.applicationSccs,
      cyclicSccs: layers.summary.cyclicSccs,
      maximumLayer: layers.summary.maximumLayer,
      dynamicImports: scopedEdges.filter((edge) => edge.dynamic).length,
      unresolvedImports: scopedUnresolved.length,
    },
  };
}

export interface BoundedReport<T> {
  readonly total: number;
  readonly limit: number;
  readonly truncated: boolean;
  readonly omitted: number;
  readonly records: readonly T[];
  readonly deeperCommand: string;
}

export interface ArchitectureSummary {
  readonly schemaVersion: 1;
  readonly baseline: AssessmentBaselineIdentity;
  readonly qualification: AssessmentSnapshot["qualification"];
  readonly graph: {
    readonly productionModules: number;
    readonly productionLines: number;
    readonly edges: number;
    readonly sccs: number;
    readonly cyclicSccs: number;
    readonly maximumLayer: number;
    readonly dynamicImports: number;
    readonly unresolvedImports: number;
  };
  readonly candidates: Availability<{
    readonly total: number;
    readonly eligible: number;
    readonly blocked: number;
    readonly recommended: number;
    readonly reviewRequired: number;
    readonly discouraged: number;
  }>;
}

export interface AssessmentReports {
  readonly summary: ArchitectureSummary;
  readonly layers: LayerReport;
  readonly hotspots: Availability<BoundedReport<CouplingHotspot>>;
  readonly portfolio: Availability<BoundedReport<PortfolioCandidate>>;
  readonly fullPortfolio?: Availability<readonly PortfolioCandidate[]>;
  readonly backlog: Availability<BoundedReport<PortfolioCandidate>>;
  readonly findings: string;
}

export function deriveAssessmentReports(
  snapshot: AssessmentSnapshot,
  input: { readonly limit?: number; readonly fullPortfolio?: boolean; readonly batch?: DeclarationBatchResult } = {},
): AssessmentReports {
  snapshot.verify();
  const limit = positiveLimit(input.limit ?? 20);
  const normalized = normalizedGraphFacts(snapshot.config, snapshot.graph, snapshot.application);
  const layers = normalized.layers;
  snapshot.verify();
  const resolutionUnavailable = snapshot.qualification.status === "degraded";
  let portfolio: Portfolio | undefined;
  if (!resolutionUnavailable) {
    portfolio = buildPortfolio({ config: snapshot.config, graph: snapshot.graph, context: snapshot.context, application: snapshot.application });
    snapshot.verify();
  }
  // A degraded snapshot may retain independent graph facts, but every
  // resolution/package-dependent field must carry the complete qualification
  // reason. Filtering to one currently-known code would let a future degraded
  // condition silently look like an empty, valid portfolio.
  const candidateDiagnostics = snapshot.qualification.diagnostics;
  const candidateTotals = portfolio === undefined ? unavailable(candidateDiagnostics) : available(portfolioTotals(portfolio));
  const summary: ArchitectureSummary = {
    schemaVersion: 1,
    baseline: snapshot.baseline,
    qualification: snapshot.qualification,
    graph: {
      productionModules: normalized.facts.applicationModules,
      productionLines: normalized.facts.productionLines,
      edges: normalized.facts.edges,
      sccs: normalized.facts.sccs,
      cyclicSccs: normalized.facts.cyclicSccs,
      maximumLayer: normalized.facts.maximumLayer,
      dynamicImports: normalized.facts.dynamicImports,
      unresolvedImports: normalized.facts.unresolvedImports,
    },
    candidates: candidateTotals,
  };
  const portfolioRecords =
    portfolio === undefined ? [] : [...portfolio.candidates].toSorted((left, right) => right.score - left.score || byCodeUnit(left.id, right.id));
  const backlogRecords =
    portfolio === undefined
      ? []
      : blockedCandidates(portfolio)
          .slice()
          .toSorted((left, right) => right.lineCount - left.lineCount || byCodeUnit(left.id, right.id));
  const portfolioReport =
    portfolio === undefined
      ? unavailable<BoundedReport<PortfolioCandidate>>(candidateDiagnostics)
      : available(bound(portfolioRecords, limit, `assess --app ${snapshot.application} --evidence-dir <path> --full-portfolio`));
  const fullPortfolio =
    input.fullPortfolio !== true
      ? undefined
      : portfolio === undefined
        ? unavailable<readonly PortfolioCandidate[]>(candidateDiagnostics)
        : available(portfolioRecords);
  const hotspotReport =
    portfolio === undefined
      ? unavailable<BoundedReport<CouplingHotspot>>(candidateDiagnostics)
      : available(
          bound(
            analyzeCouplingHotspots(snapshot.graph, portfolio, snapshot.application),
            limit,
            `assess --app ${snapshot.application} --evidence-dir <path> --limit ${limit * 2}`,
          ),
        );
  const backlogReport =
    portfolio === undefined
      ? unavailable<BoundedReport<PortfolioCandidate>>(candidateDiagnostics)
      : available(bound(backlogRecords, limit, `assess --app ${snapshot.application} --evidence-dir <path> --limit ${limit * 2}`));
  return {
    summary,
    layers,
    hotspots: hotspotReport,
    portfolio: portfolioReport,
    ...(fullPortfolio === undefined ? {} : { fullPortfolio }),
    backlog: backlogReport,
    findings: renderFindings(summary, layers, hotspotReport, portfolioReport, backlogReport, input.fullPortfolio === true, snapshot.application, input.batch),
  };
}

function portfolioTotals(portfolio: Portfolio) {
  const eligible = portfolio.candidates.filter((candidate) => candidate.eligible);
  return {
    total: portfolio.candidates.length,
    eligible: eligible.length,
    blocked: portfolio.candidates.length - eligible.length,
    recommended: eligible.filter((candidate) => candidate.recommendation?.status === "recommended").length,
    reviewRequired: eligible.filter((candidate) => candidate.recommendation?.status === "review-required").length,
    discouraged: eligible.filter((candidate) => candidate.recommendation?.status === "discouraged").length,
  };
}

function bound<T>(records: readonly T[], limit: number, deeperCommand: string): BoundedReport<T> {
  const bounded = records.slice(0, limit);
  return {
    total: records.length,
    limit,
    truncated: records.length > limit,
    omitted: Math.max(0, records.length - bounded.length),
    records: bounded,
    deeperCommand,
  };
}

function positiveLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("assessment report limit must be a positive integer");
  return value;
}

function renderFindings(
  summary: ArchitectureSummary,
  layers: LayerReport,
  hotspots: AssessmentReports["hotspots"],
  portfolio: AssessmentReports["portfolio"],
  backlog: AssessmentReports["backlog"],
  fullPortfolio: boolean,
  application: string,
  batch?: DeclarationBatchResult,
): string {
  const baseline = summary.baseline;
  const lines = [
    "# Architecture Assessment",
    "",
    "## Evidence boundary",
    "",
    `Qualification: **${summary.qualification.status}**. All facts below share source commit \`${baseline.sourceCommit}\`, input digest \`${baseline.inputDigest}\`, config digest \`${baseline.configDigest}\`, and graph digest \`${baseline.graphDigest}\`.`,
    `Executable: ${baseline.executable.semanticVersion} (${baseline.executable.packagingMode}), compiler \`${baseline.executable.compiler.artifactIntegrity}\`; runtime Bun ${baseline.runtime.bun}, Node ${baseline.runtime.node}.`,
    "",
    "This report is read-only evidence for human review. It did not mutate source, does not approve architecture, and does not authorize package extraction.",
    "",
    "### Qualification limitations",
    "",
    ...qualificationLines(summary),
    "",
    "## Graph",
    "",
    `- ${summary.graph.productionModules} production modules and ${summary.graph.productionLines} physical lines`,
    `- ${summary.graph.edges} edges across ${summary.graph.sccs} SCCs; ${summary.graph.cyclicSccs} cyclic`,
    `- Maximum dependency layer ${summary.graph.maximumLayer}; ${summary.graph.dynamicImports} dynamic and ${summary.graph.unresolvedImports} unresolved imports`,
    "",
    "## Domains and cycles",
    "",
    ...layers.domains
      .slice()
      .toSorted((left, right) => byCodeUnit(left.domain, right.domain))
      .map((domain) => `- ${domain.domain}: ${domain.files} files, ${domain.lines} lines, ${domain.crossDomainEdges.length} outgoing cross-domain edges`),
    ...domainFallback(layers),
    ...cycleLines(layers),
    "",
    "## Hotspots",
    "",
    ...availabilityLines(hotspots, (report) =>
      report.records.map((entry) => `- ${entry.path}: pressure ${entry.pressureScore}, suggested ${entry.suggestedAction}`),
    ),
    "",
    "## Candidate classifications",
    "",
    ...availabilityLines(portfolio, (report) =>
      report.records.map(
        (entry) =>
          `- ${entry.id}: mechanically ${entry.eligible ? "eligible" : "blocked"}; classification ${entry.classification ?? "unclassified"}; recommendation ${entry.recommendation?.status ?? "unclassified"}${entry.recommendation?.cohesion === "low" ? "; low cohesion requires architectural review" : ""}`,
      ),
    ),
    "",
    "## Preparation backlog",
    "",
    ...availabilityLines(backlog, (report) =>
      report.records.map(
        (entry) =>
          `- ${entry.id}: ${entry.rejectionReasons
            .map((reason) => reason.code)
            .toSorted(byCodeUnit)
            .join(", ")}`,
      ),
    ),
    "",
    "## Declaration splits",
    "",
    ...splitLines(batch),
    "",
    "## Evidence retained and omitted",
    "",
    ...evidenceLines(portfolio, hotspots, backlog, fullPortfolio, application),
    "",
    "## Reproduce",
    "",
    `Run \`assess --app ${application} --evidence-dir <path>\` against matching authoritative inputs.`,
    `For a verified bundle, run \`assess --app ${application} --evidence-dir <path> --replay <bundle-directory>\`; replay performs no live scan.`,
    "",
  ];
  return `${lines.join("\n")}\n`;
}

function qualificationLines(summary: ArchitectureSummary): string[] {
  return summary.qualification.diagnostics.length === 0
    ? ["- No qualification limitations were recorded."]
    : summary.qualification.diagnostics.map((entry) => `- ${entry.code}: ${entry.impact}`);
}

function domainFallback(layers: LayerReport): string[] {
  return layers.domains.length === 0 ? ["- No domains were observed."] : [];
}

function cycleLines(layers: LayerReport): string[] {
  const cycles = layers.components
    .filter((component) => component.cyclic)
    .slice()
    .toSorted((left, right) => byCodeUnit(left.nodes.join("\0"), right.nodes.join("\0")));
  return cycles.length === 0
    ? ["- No cycles were observed in the selected application."]
    : cycles.map((component) => `- SCC ${component.id}: ${component.nodes.join(", ")} (${component.lines} lines)`);
}

function splitLines(batch: DeclarationBatchResult | undefined): string[] {
  if (batch === undefined) return ["No declaration split analysis was requested."];
  return [
    `Selection: ${batch.aggregate.selection.mode}, ${batch.aggregate.selection.selected} target(s) selected (${batch.aggregate.selection.deduplicated} duplicate(s) removed).`,
    ...batch.aggregate.entries.map(
      (entry) =>
        `- ${entry.sourcePath}: ${entry.declarationCount} declarations, ${entry.splitCandidateCount} candidates, ${entry.cycleCount} cycle(s), affinities ${entry.dominantAffinities.length === 0 ? "none" : entry.dominantAffinities.join(", ")}; detail ${entry.reportPath}`,
    ),
    ...(batch.aggregate.diagnostics.length === 0 ? [] : batch.aggregate.diagnostics.map((entry) => `- ${entry.category} ${entry.code}: ${entry.message}`)),
  ];
}

function evidenceLines(
  portfolio: AssessmentReports["portfolio"],
  hotspots: AssessmentReports["hotspots"],
  backlog: AssessmentReports["backlog"],
  fullPortfolio: boolean,
  application: string,
): string[] {
  return [
    "Raw scanner reports and the input inventory are mandatory replay authority and are retained.",
    ...(portfolio.status === "available" && portfolio.value.truncated
      ? [`- ${portfolio.value.omitted} portfolio record(s) omitted; use \`${portfolio.value.deeperCommand}\`.`]
      : []),
    ...(!fullPortfolio ? [`- Full portfolio details omitted by default; use \`assess --app ${application} --evidence-dir <path> --full-portfolio\`.`] : []),
    ...(hotspots.status === "available" && hotspots.value.truncated
      ? [`- ${hotspots.value.omitted} hotspot record(s) omitted; use \`${hotspots.value.deeperCommand}\`.`]
      : []),
    ...(backlog.status === "available" && backlog.value.truncated
      ? [`- ${backlog.value.omitted} backlog record(s) omitted; use \`${backlog.value.deeperCommand}\`.`]
      : []),
  ];
}

function availabilityLines<T>(value: Availability<T>, render: (value: T) => readonly string[]): string[] {
  if (value.status === "unavailable") return [`- Unavailable: ${value.diagnostics.map((entry) => `${entry.code}: ${entry.impact}`).join("; ")}`];
  const rendered = render(value.value);
  return rendered.length === 0 ? ["- None."] : [...rendered];
}
