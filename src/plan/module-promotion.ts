import { buildApplicationGraph, stronglyConnectedComponents, toSccs } from "../graph/components.ts";
import type { Scc } from "../graph/model.ts";
import type { PortfolioCandidate } from "../portfolio/types.ts";
import { PlanningError, WorkspaceContext } from "./context.ts";
import { partitionTests } from "./consumers.ts";
import { buildPlanSync, type BuildPlanOptions } from "./build.ts";
import type { ExtractionManifest } from "./manifest.ts";
import { hashJson } from "../util/hash.ts";

export interface CompileModulePromotionInput extends Omit<BuildPlanOptions, "candidate" | "modulePromotion" | "packageName"> {
  readonly promotionId: string;
}

/** Compile a reviewed singleton selection through the ordinary extraction engine. */
export function compileModulePromotion(input: CompileModulePromotionInput): ExtractionManifest {
  const promotion = input.config.modulePromotions.find((item) => item.id === input.promotionId);
  if (!promotion) throw new PlanningError(`unknown module promotion ${JSON.stringify(input.promotionId)}`);
  const node = input.graph.nodes.get(promotion.source);
  if (!node || node.zone !== "application" || node.application === undefined) {
    throw new PlanningError(`module promotion source is not a configured application module: ${promotion.source}`);
  }
  if (!node.hasExports || node.isTest || node.isAsset || node.isDeclaration) {
    throw new PlanningError(`module promotion source must be one exported production implementation module: ${promotion.source}`);
  }
  if (input.graph.commit !== input.baselineCommit) throw new PlanningError("module promotion requires a fresh graph at the exact baseline");
  const appGraph = buildApplicationGraph(input.graph, node.application);
  const component = appGraph.condensed.components[appGraph.condensed.componentByNode.get(promotion.source) ?? -1];
  if (!component) throw new PlanningError(`module promotion source is absent from the application SCC graph: ${promotion.source}`);
  const remaining = component.filter((path) => path !== promotion.source);
  const remainingSet = new Set(remaining);
  const remainingOutgoing = new Map(remaining.map((path) => [path, (input.graph.outgoing.get(path) ?? []).filter((target) => remainingSet.has(target))]));
  const after = stronglyConnectedComponents(remaining, remainingOutgoing).sort((left, right) => left[0]!.localeCompare(right[0]!));
  const removedEdges = input.graph.edges
    .filter((edge) => edge.from === promotion.source || edge.to === promotion.source)
    .filter((edge) => component.includes(edge.from) && component.includes(edge.to))
    .map(({ from, to }) => ({ from, to }))
    .sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to));
  const cutsScc = component.length >= 2 && removedEdges.length > 0 && Math.max(0, ...after.map((part) => part.length)) < component.length;
  const architecturalEdges = input.graph.edges.filter((edge) => isArchitecturalContainmentEdge(input.graph, edge.from, edge.to));
  const containmentRemoved = architecturalEdges
    .filter((edge) => edge.from === promotion.source || edge.to === promotion.source)
    .map(({ from, to }) => ({ from, to }))
    .sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to));
  const introducedApplicationDependencies = [...new Set((input.graph.outgoing.get(promotion.source) ?? [])
    .filter((path) => input.graph.nodes.get(path)?.zone === "application"))].sort();
  if (!cutsScc && containmentRemoved.length === 0) throw new PlanningError(`module promotion ${promotion.id} cuts neither a multi-module SCC nor an architectural containment edge at the baseline`);
  if (!cutsScc && introducedApplicationDependencies.length > 0) throw new PlanningError(`module promotion ${promotion.id} would introduce a package dependency on application modules: ${introducedApplicationDependencies.join(", ")}`);
  const context = input.context ?? new WorkspaceContext(input.config, input.rootDir);
  const directTests = [...(input.graph.testImporters.get(promotion.source) ?? [])].sort();
  const testPartition = partitionTests(context, [promotion.source], directTests, []);
  const importers = [...new Set([...(input.graph.incoming.get(promotion.source) ?? []), ...directTests])].sort();
  const scc: Scc = toSccs(appGraph.condensed).find((item) => item.members.includes(promotion.source))!;
  const candidate: PortfolioCandidate = {
    id: `promotion-${hashJson({ id: promotion.id, source: promotion.source, commit: input.graph.commit })}`,
    application: node.application,
    suggestedPackageName: promotion.targetPackage,
    files: [promotion.source], tests: directTests, assets: [], sccs: [scc], seed: scc,
    lineCount: node.lineCount, owners: [node.owner], domains: [node.domain], dependencies: [],
    consumers: [], consumerChurn: importers.length, coverage: testPartition.travelling.length > 0 ? 1 : 0,
    score: 0, eligible: true, rejectionReasons: [], warnings: [], rewriteEscapes: [], classification: "extraction",
  };
  const proof: NonNullable<ExtractionManifest["modulePromotion"]> = {
    id: promotion.id, source: promotion.source, targetModule: promotion.targetModule,
    retireSource: promotion.retireSource, importerProof: importers,
    ...(cutsScc
      ? { cycleCut: { before: [...component], after, removedEdges } }
      : { containmentCut: { architecturalEdgesBefore: architecturalEdges.length, architecturalEdgesAfter: architecturalEdges.length - containmentRemoved.length, removedEdges: containmentRemoved, introducedApplicationDependencies } }),
  };
  const manifest = buildPlanSync({ ...input, context, candidate, packageName: promotion.targetPackage, modulePromotion: proof });
  const compiledImporters = [...new Set([...manifest.consumers.map((item) => item.file), ...manifest.source.tests])].sort();
  if (hashJson(compiledImporters) !== hashJson(importers)) {
    throw new PlanningError(`module promotion importer proof differs from the compiler-derived consumer set`);
  }
  return manifest;
}

function isArchitecturalContainmentEdge(graph: CompileModulePromotionInput["graph"], from: string, to: string): boolean {
  const left = graph.nodes.get(from);
  const right = graph.nodes.get(to);
  if (left === undefined || right === undefined || (left.zone !== "application" && right.zone !== "application")) return false;
  return left.application !== right.application || left.domain !== right.domain;
}
