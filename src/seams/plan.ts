import { isAbsolute } from "node:path";

import type { DeclarationGroup, SymbolEdge, SymbolSplitCandidate, WorkspaceSymbolAnalysis } from "../symbols/types.ts";
import { byCodeUnit, hashJson, type Sha256 } from "../util/hash.ts";
import { normalizePath } from "../util/paths.ts";
import { classifyTypeOnlyExtraction, type TypeOnlyExtractionSafety } from "./safety.ts";
import type { AffectedSeamConsumer, PlanSeamInput, RequiredSeamImport, RetainedSeamCycle, SeamBlocker, SeamPlan } from "./types.ts";

/** The requested candidate is not an atomic component of this source analysis. */
export class SeamPlanningError extends Error {
  override readonly name = "SeamPlanningError";
}

/**
 * Compile one SCC suggestion into a deterministic, read-only seam proposal.
 *
 * Exact conclusions come only from the TypeScript symbol graph supplied by the
 * caller. Affinity remains a placement heuristic, so this function never
 * manufactures a target path or pretends that a cyclic component was broken.
 */
export function planSeam(input: PlanSeamInput): SeamPlan {
  const candidate = candidateFor(input.analysis, input.candidateId);
  const targetPath = input.targetPath === undefined ? undefined : normalizedTargetPath(input.targetPath);
  const groupById = new Map(input.analysis.source.groups.map((group) => [group.id, group]));
  const movedIds = [...candidate.groupIds].sort(byCodeUnit);
  const movedSet = new Set(movedIds);
  const movedGroups = groupsFor(movedIds, groupById);
  const retainedGroups = [...input.analysis.source.groups].filter((group) => !movedSet.has(group.id)).sort(compareGroups);
  const cyclesRetained = cyclicComponents(input.analysis, movedSet);
  const requiredImports = boundaryImports(input.analysis, movedSet, groupById);
  const affectedConsumers = consumersFor(candidate, input.analysis);
  const typeOnlyPreparationSafety = movedGroups
    .map((group) =>
      classifyTypeOnlyExtraction({
        sourceText: input.sourceText,
        graph: input.analysis.source,
        groupId: group.id,
        selectedDeclarationIds: group.declarationIds,
      }),
    )
    .sort((left, right) => byCodeUnit(left.groupId, right.groupId));
  const eligibleForTypeOnlyPreparation =
    typeOnlyPreparationSafety.every((result) => result.eligible) && requiredImports.every((requirement) => requirement.space === "type");
  const remainingBlockers = blockersFor(input.analysis, targetPath, candidate, cyclesRetained, requiredImports, typeOnlyPreparationSafety);
  const identity = {
    schemaVersion: 1 as const,
    sourcePath: input.analysis.source.sourcePath,
    sourceHash: input.analysis.source.sourceHash,
    candidateId: candidate.id,
    ...(targetPath === undefined ? {} : { targetPath }),
    movedGroupIds: movedGroups.map((group) => group.id),
    retainedGroupIds: retainedGroups.map((group) => group.id),
    requiredImports,
    affectedConsumers,
    cyclesRetained,
    typeOnlyPreparationSafety,
    eligibleForTypeOnlyPreparation,
    remainingBlockers,
  };

  return {
    schemaVersion: 1,
    id: hashJson(identity),
    sourcePath: input.analysis.source.sourcePath,
    sourceHash: input.analysis.source.sourceHash,
    candidateId: candidate.id,
    ...(targetPath === undefined ? {} : { targetPath }),
    movedGroups,
    retainedGroups,
    requiredImports,
    affectedConsumers,
    cyclesBroken: [],
    cyclesRetained,
    typeOnlyPreparationSafety,
    eligibleForTypeOnlyPreparation,
    remainingBlockers,
    confidence: { partition: "exact", imports: "exact", consumers: "exact", placement: "heuristic" },
  };
}

function candidateFor(analysis: WorkspaceSymbolAnalysis, id: Sha256): SymbolSplitCandidate {
  const candidate = analysis.splitCandidates.find((entry) => entry.id === id);
  if (!candidate) throw new SeamPlanningError(`unknown split candidate ${id}`);
  const component = analysis.source.components.find((entry) => sameIds(entry.groupIds, candidate.groupIds));
  if (!component) throw new SeamPlanningError(`candidate ${id} does not describe one declaration component`);
  return candidate;
}

function groupsFor(ids: readonly Sha256[], groupById: ReadonlyMap<Sha256, DeclarationGroup>): DeclarationGroup[] {
  return ids.map((id) => {
    const group = groupById.get(id);
    if (!group) throw new SeamPlanningError(`candidate references missing declaration group ${id}`);
    return group;
  });
}

function boundaryImports(
  analysis: WorkspaceSymbolAnalysis,
  moved: ReadonlySet<Sha256>,
  groupById: ReadonlyMap<Sha256, DeclarationGroup>,
): RequiredSeamImport[] {
  return analysis.source.edges
    .filter((edge) => moved.has(edge.source) !== moved.has(edge.target))
    .map((edge) => importFor(edge, moved, groupById))
    .sort(
      (left, right) =>
        byCodeUnit(left.importer, right.importer) ||
        byCodeUnit(left.importerGroupId, right.importerGroupId) ||
        byCodeUnit(left.importedGroupId, right.importedGroupId),
    );
}

function importFor(edge: SymbolEdge, moved: ReadonlySet<Sha256>, groupById: ReadonlyMap<Sha256, DeclarationGroup>): RequiredSeamImport {
  const importer = groupById.get(edge.source);
  const imported = groupById.get(edge.target);
  if (!importer || !imported) throw new SeamPlanningError("symbol graph edge references a missing declaration group");
  const importerMoved = moved.has(importer.id);
  return {
    importer: importerMoved ? "moved" : "retained",
    exporter: importerMoved ? "retained" : "moved",
    importerGroupId: importer.id,
    importerName: importer.name,
    importedGroupId: imported.id,
    importedName: imported.name,
    space: edge.space,
    referenceCount: edge.references.length,
    confidence: "exact",
  };
}

function consumersFor(candidate: SymbolSplitCandidate, analysis: WorkspaceSymbolAnalysis): AffectedSeamConsumer[] {
  const moved = new Set(candidate.groupIds);
  return analysis.consumers
    .filter((consumer) => moved.has(consumer.groupId))
    .map((consumer) => ({ ...consumer, partition: "moved" as const, confidence: "exact" as const }))
    .sort(
      (left, right) =>
        byCodeUnit(left.groupName, right.groupName) ||
        byCodeUnit(left.affinity, right.affinity) ||
        byCodeUnit(left.consumerPath, right.consumerPath) ||
        byCodeUnit(left.groupId, right.groupId),
    );
}

function cyclicComponents(analysis: WorkspaceSymbolAnalysis, moved: ReadonlySet<Sha256>): RetainedSeamCycle[] {
  return analysis.source.components
    .filter((component) => component.cyclic && component.groupIds.every((id) => moved.has(id)))
    .map((component) => ({ componentId: component.id, groupIds: [...component.groupIds].sort(byCodeUnit), confidence: "exact" as const }))
    .sort((left, right) => byCodeUnit(left.componentId, right.componentId));
}

function blockersFor(
  analysis: WorkspaceSymbolAnalysis,
  targetPath: string | undefined,
  candidate: SymbolSplitCandidate,
  cycles: readonly RetainedSeamCycle[],
  requiredImports: readonly RequiredSeamImport[],
  safety: readonly TypeOnlyExtractionSafety[],
): SeamBlocker[] {
  const sourcePath = analysis.source.sourcePath;
  const blockers: SeamBlocker[] = [];
  if (targetPath === undefined) {
    blockers.push({
      code: "target-path-not-provided",
      message: "no destination path was supplied; affinity is not a module-path proof",
      confidence: "heuristic",
    });
  } else if (targetPath === sourcePath) {
    blockers.push({ code: "target-path-is-source", message: "target path is the source path, so no seam can be formed", confidence: "exact" });
  }
  if (cycles.length > 0) {
    blockers.push({ code: "cyclic-component", message: "the selected declaration component is cyclic and must remain intact", confidence: "exact" });
  }
  if (candidate.dominantAffinity === undefined) {
    blockers.push({ code: "no-dominant-affinity", message: "no external consumer affinity identifies likely ownership", confidence: "heuristic" });
  } else if (candidate.affinityConcentration < 1) {
    blockers.push({ code: "split-affinity", message: "external consumers span multiple affinities, so ownership remains heuristic", confidence: "heuristic" });
  }
  if (requiredImports.some((requirement) => requirement.space !== "type")) {
    blockers.push({
      code: "value-boundary-dependency",
      message: "the selected declarations have a value-space dependency across the proposed seam",
      confidence: "exact",
    });
  }
  for (const result of safety) {
    for (const evidence of result.evidence) {
      blockers.push({
        code: evidence.code,
        message: evidence.message,
        confidence: "exact",
        groupId: result.groupId,
        ...(evidence.declarationId === undefined ? {} : { declarationId: evidence.declarationId }),
        ...(evidence.start === undefined ? {} : { start: evidence.start }),
        ...(evidence.end === undefined ? {} : { end: evidence.end }),
      });
    }
  }
  return blockers.sort(compareBlockers);
}

function compareBlockers(left: SeamBlocker, right: SeamBlocker): number {
  return (
    byCodeUnit(left.code, right.code) ||
    byCodeUnit(left.groupId ?? "", right.groupId ?? "") ||
    (left.start ?? -1) - (right.start ?? -1) ||
    (left.end ?? -1) - (right.end ?? -1) ||
    byCodeUnit(left.declarationId ?? "", right.declarationId ?? "") ||
    byCodeUnit(left.message, right.message)
  );
}

function sameIds(left: readonly Sha256[], right: readonly Sha256[]): boolean {
  const a = [...left].sort(byCodeUnit);
  const b = [...right].sort(byCodeUnit);
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

function compareGroups(left: DeclarationGroup, right: DeclarationGroup): number {
  return byCodeUnit(left.id, right.id);
}

function normalizedTargetPath(path: string): string {
  const normalized = normalizePath(path);
  if (!normalized || normalized === "." || isAbsolute(normalized) || normalized.split("/").includes("..")) {
    throw new SeamPlanningError(`target path must be repository-relative: ${path}`);
  }
  return normalized;
}
