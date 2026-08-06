import { buildApplicationGraph, stronglyConnectedComponents, toSccs } from "../graph/components.ts";
import type { Scc } from "../graph/model.ts";
import type { PortfolioCandidate } from "../portfolio/types.ts";
import { PlanningError } from "./context.ts";
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
  if (component.length < 2 || removedEdges.length === 0 || Math.max(0, ...after.map((part) => part.length)) >= component.length) {
    throw new PlanningError(`module promotion ${promotion.id} does not cut a multi-module SCC at the baseline`);
  }
  const directTests = [...(input.graph.testImporters.get(promotion.source) ?? [])].sort();
  const importers = [...new Set([...(input.graph.incoming.get(promotion.source) ?? []), ...directTests])].sort();
  const scc: Scc = toSccs(appGraph.condensed).find((item) => item.members.includes(promotion.source))!;
  const candidate: PortfolioCandidate = {
    id: `promotion-${hashJson({ id: promotion.id, source: promotion.source, commit: input.graph.commit })}`,
    application: node.application,
    suggestedPackageName: promotion.targetPackage,
    files: [promotion.source], tests: directTests, assets: [], sccs: [scc], seed: scc,
    lineCount: node.lineCount, owners: [node.owner], domains: [node.domain], dependencies: [],
    consumers: [], consumerChurn: importers.length, coverage: directTests.length > 0 ? 1 : 0,
    score: 0, eligible: true, rejectionReasons: [], warnings: [], rewriteEscapes: [], classification: "extraction",
  };
  const proof: NonNullable<ExtractionManifest["modulePromotion"]> = {
    id: promotion.id, source: promotion.source, targetModule: promotion.targetModule,
    retireSource: promotion.retireSource, importerProof: importers,
    cycleCut: { before: [...component], after, removedEdges },
  };
  const manifest = buildPlanSync({ ...input, candidate, packageName: promotion.targetPackage, modulePromotion: proof });
  const compiledImporters = manifest.consumers.map((item) => item.file).sort();
  if (hashJson(compiledImporters) !== hashJson(importers)) {
    throw new PlanningError(`module promotion importer proof differs from the compiler-derived consumer set`);
  }
  return manifest;
}
