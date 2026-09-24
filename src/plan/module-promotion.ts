import { buildApplicationGraph, stronglyConnectedComponents, toSccs } from "../graph/components.ts";
import type { Scc } from "../graph/model.ts";
import type { PortfolioCandidate } from "../portfolio/types.ts";
import { hashJson } from "../util/hash.ts";
import { buildPlanSync, type BuildPlanOptions } from "./build.ts";
import { partitionTests } from "./consumers.ts";
import { PlanningError, WorkspaceContext } from "./context.ts";
import type { ExtractionManifest } from "./manifest.ts";

export interface CompileModulePromotionInput extends Omit<BuildPlanOptions, "candidate" | "modulePromotion" | "packageName"> {
  readonly promotionId: string;
}

export function modulePromotionImporterEvidence(input: {
  readonly graph: CompileModulePromotionInput["graph"];
  readonly context: WorkspaceContext;
  readonly source: string;
}): string[] {
  const graphImporters = [...(input.graph.incoming.get(input.source) ?? []), ...(input.graph.testImporters.get(input.source) ?? [])];
  const compilerImporters = input.context.consumerIndex().get(input.context.absolute(input.source)) ?? [];
  return [...new Set([...graphImporters, ...compilerImporters])].toSorted();
}

type ModulePromotion = CompileModulePromotionInput["config"]["modulePromotions"][number];
type GraphNode = NonNullable<ReturnType<CompileModulePromotionInput["graph"]["nodes"]["get"]>>;
type PromotedNode = GraphNode & { readonly application: string };
type ApplicationGraph = ReturnType<typeof buildApplicationGraph>;
interface EdgePair {
  readonly from: string;
  readonly to: string;
}

interface PromotionCut {
  readonly component: readonly string[];
  readonly after: string[][];
  readonly removedEdges: EdgePair[];
  readonly cutsScc: boolean;
  readonly architecturalEdges: readonly EdgePair[];
  readonly containmentRemoved: EdgePair[];
  readonly introducedApplicationDependencies: string[];
}

/** Compile a reviewed singleton selection through the ordinary extraction engine. */
export function compileModulePromotion(input: CompileModulePromotionInput): ExtractionManifest {
  const { promotion, node } = resolvePromotionSource(input);
  const appGraph = buildApplicationGraph(input.graph, node.application);
  const cut = promotionCut(input, promotion, appGraph);
  assertPromotionCuts(promotion, cut);
  const context = input.context ?? new WorkspaceContext(input.config, input.rootDir);
  const importers = modulePromotionImporterEvidence({ graph: input.graph, context, source: promotion.source });
  const candidate = promotionCandidate(input, context, promotion, node, appGraph, importers);
  const proof = promotionProof(promotion, importers, cut);
  const manifest = buildPlanSync({ ...input, context, candidate, packageName: promotion.targetPackage, modulePromotion: proof });
  const compiledImporters = [...new Set([...manifest.consumers.map((item) => item.file), ...manifest.source.tests])].toSorted();
  if (hashJson(compiledImporters) !== hashJson(importers)) {
    throw new PlanningError(`module promotion importer proof differs from the compiler-derived consumer set`);
  }
  return manifest;
}

function resolvePromotionSource(input: CompileModulePromotionInput): { promotion: ModulePromotion; node: PromotedNode } {
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
  return { promotion, node: { ...node, application: node.application } };
}

function sortedEdgePairs(edges: readonly EdgePair[]): EdgePair[] {
  return edges.map(({ from, to }) => ({ from, to })).toSorted((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to));
}

function promotionCut(input: CompileModulePromotionInput, promotion: ModulePromotion, appGraph: ApplicationGraph): PromotionCut {
  const component = appGraph.condensed.components[appGraph.condensed.componentByNode.get(promotion.source) ?? -1];
  if (!component) throw new PlanningError(`module promotion source is absent from the application SCC graph: ${promotion.source}`);
  const remaining = component.filter((path) => path !== promotion.source);
  const remainingSet = new Set(remaining);
  const remainingOutgoing = new Map(remaining.map((path) => [path, (input.graph.outgoing.get(path) ?? []).filter((target) => remainingSet.has(target))]));
  const after = stronglyConnectedComponents(remaining, remainingOutgoing).sort((left, right) => left[0]!.localeCompare(right[0]!));
  const touchesSource = (edge: EdgePair): boolean => edge.from === promotion.source || edge.to === promotion.source;
  const removedEdges = sortedEdgePairs(input.graph.edges.filter(touchesSource).filter((edge) => component.includes(edge.from) && component.includes(edge.to)));
  const cutsScc = component.length >= 2 && removedEdges.length > 0 && Math.max(0, ...after.map((part) => part.length)) < component.length;
  const architecturalEdges = input.graph.edges.filter((edge) => isArchitecturalContainmentEdge(input.graph, edge.from, edge.to));
  const containmentRemoved = sortedEdgePairs(architecturalEdges.filter(touchesSource));
  const introducedApplicationDependencies = [
    ...new Set((input.graph.outgoing.get(promotion.source) ?? []).filter((path) => input.graph.nodes.get(path)?.zone === "application")),
  ].toSorted();
  return { component, after, removedEdges, cutsScc, architecturalEdges, containmentRemoved, introducedApplicationDependencies };
}

function assertPromotionCuts(promotion: ModulePromotion, cut: PromotionCut): void {
  if (!cut.cutsScc && cut.containmentRemoved.length === 0)
    throw new PlanningError(`module promotion ${promotion.id} cuts neither a multi-module SCC nor an architectural containment edge at the baseline`);
  if (!cut.cutsScc && cut.introducedApplicationDependencies.length > 0)
    throw new PlanningError(
      `module promotion ${promotion.id} would introduce a package dependency on application modules: ${cut.introducedApplicationDependencies.join(", ")}`,
    );
}

function promotionCandidate(
  input: CompileModulePromotionInput,
  context: WorkspaceContext,
  promotion: ModulePromotion,
  node: PromotedNode,
  appGraph: ApplicationGraph,
  importers: readonly string[],
): PortfolioCandidate {
  const directTests = importers.filter((path) => context.isTest(path));
  const testPartition = partitionTests(context, [promotion.source], directTests, []);
  const promotedSpecifier =
    promotion.targetModule === "index" ? promotion.targetPackage : `${promotion.targetPackage}/${promotion.targetModule.replace(/^\.\//, "")}`;
  const travellingTestRewrites = testPartition.travelling.flatMap((test) =>
    context
      .moduleReferences(test)
      .filter((reference) => reference.specifier !== null && reference.resolved === context.absolute(promotion.source))
      .map((reference) => ({ file: test, specifier: reference.specifier!, package: promotedSpecifier })),
  );
  const scc: Scc = toSccs(appGraph.condensed).find((item) => item.members.includes(promotion.source))!;
  return {
    id: `promotion-${hashJson({ id: promotion.id, source: promotion.source, commit: input.graph.commit })}`,
    application: node.application,
    suggestedPackageName: promotion.targetPackage,
    files: [promotion.source],
    tests: directTests,
    assets: [],
    sccs: [scc],
    seed: scc,
    lineCount: node.lineCount,
    owners: [node.owner],
    domains: [node.domain],
    dependencies: [],
    consumers: [],
    consumerChurn: importers.length,
    coverage: testPartition.travelling.length > 0 ? 1 : 0,
    score: 0,
    eligible: true,
    rejectionReasons: [],
    warnings: [],
    rewriteEscapes: travellingTestRewrites,
    classification: "extraction",
  };
}

function promotionProof(promotion: ModulePromotion, importers: string[], cut: PromotionCut): NonNullable<ExtractionManifest["modulePromotion"]> {
  return {
    id: promotion.id,
    source: promotion.source,
    targetModule: promotion.targetModule,
    retireSource: promotion.retireSource,
    importerProof: importers,
    ...(cut.cutsScc
      ? { cycleCut: { before: [...cut.component], after: cut.after, removedEdges: cut.removedEdges } }
      : {
          containmentCut: {
            architecturalEdgesBefore: cut.architecturalEdges.length,
            architecturalEdgesAfter: cut.architecturalEdges.length - cut.containmentRemoved.length,
            removedEdges: cut.containmentRemoved,
            introducedApplicationDependencies: cut.introducedApplicationDependencies,
          },
        }),
  };
}

function isArchitecturalContainmentEdge(graph: CompileModulePromotionInput["graph"], from: string, to: string): boolean {
  const left = graph.nodes.get(from);
  const right = graph.nodes.get(to);
  if (left === undefined || right === undefined || (left.zone !== "application" && right.zone !== "application")) return false;
  return left.application !== right.application || left.domain !== right.domain;
}
