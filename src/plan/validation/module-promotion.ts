import type { ExtractionManifest } from "../manifest.ts";
import { Issues } from "./shared.ts";

export function validateModulePromotion(manifest: ExtractionManifest, consumers: ReadonlySet<string>, issues: Issues): void {
  const promotion = manifest.modulePromotion;
  if (promotion === undefined) return;
  if (manifest.source.files.length !== 1 || manifest.source.files[0] !== promotion.source)
    issues.add("module-promotion", "module promotion must select exactly its configured source module");
  const importerProof = [...promotion.importerProof];
  if (new Set(importerProof).size !== importerProof.length || importerProof.some((path, index) => index > 0 && path <= importerProof[index - 1]!))
    issues.add("module-promotion-importers", "module promotion importer proof must be sorted and unique");
  const coveredImporters = new Set([...consumers, ...manifest.source.tests]);
  if (importerProof.length !== coveredImporters.size || importerProof.some((path) => !coveredImporters.has(path)))
    issues.add("module-promotion-importers", "module promotion importer proof must exactly equal rewritten consumers and relocated owned tests");
  if ((promotion.cycleCut === undefined) === (promotion.containmentCut === undefined))
    issues.add("module-promotion-boundary-cut", "module promotion must carry exactly one SCC or containment-cut proof");
  if (promotion.cycleCut !== undefined) validatePromotionCycleCut(promotion.source, promotion.cycleCut, issues);
  if (promotion.containmentCut !== undefined) validatePromotionContainmentCut(promotion.source, promotion.containmentCut, issues);
}

function validatePromotionCycleCut(source: string, cut: NonNullable<NonNullable<ExtractionManifest["modulePromotion"]>["cycleCut"]>, issues: Issues): void {
  const before = cut.before;
  const after = cut.after;
  if (before.length < 2 || !before.includes(source))
    issues.add("module-promotion-cycle-cut", "cycle-cut baseline must be a multi-module SCC containing the source");
  const afterMembers = after.flat();
  if (afterMembers.includes(source) || afterMembers.length !== before.length - 1 || afterMembers.some((path) => !before.includes(path)))
    issues.add("module-promotion-cycle-cut", "cycle-cut result must partition every baseline SCC member except the promoted source");
  if (Math.max(0, ...after.map((component) => component.length)) >= before.length)
    issues.add("module-promotion-cycle-cut", "cycle-cut proof does not reduce the largest SCC");
  if (cut.removedEdges.length === 0 || cut.removedEdges.some((edge) => edge.from !== source && edge.to !== source))
    issues.add("module-promotion-cycle-cut", "removed SCC edges must be non-empty and incident to the promoted source");
}

function validatePromotionContainmentCut(
  source: string,
  cut: NonNullable<NonNullable<ExtractionManifest["modulePromotion"]>["containmentCut"]>,
  issues: Issues,
): void {
  if (cut.removedEdges.length === 0 || cut.removedEdges.some((edge) => edge.from !== source && edge.to !== source))
    issues.add("module-promotion-containment-cut", "removed containment edges must be non-empty and incident to the promoted source");
  if (cut.introducedApplicationDependencies.length > 0)
    issues.add("module-promotion-containment-cut", "promoted package must not introduce dependencies on application modules");
  if (
    cut.architecturalEdgesBefore < cut.removedEdges.length ||
    cut.architecturalEdgesAfter !== cut.architecturalEdgesBefore - cut.removedEdges.length ||
    cut.architecturalEdgesAfter >= cut.architecturalEdgesBefore
  )
    issues.add("module-promotion-containment-cut", "architectural containment-edge metric must improve by the exact recorded cut");
}
