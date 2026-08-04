import type { CampaignWave, PlanConflict, Subject } from "./conflict-types.ts";

export function buildWaves(subjects: readonly Subject[], conflicts: readonly PlanConflict[]): CampaignWave[] {
  const adjacent = new Map<string, Set<string>>();
  for (const subject of subjects) adjacent.set(subject.candidateId, new Set());
  for (const conflict of conflicts) {
    adjacent.get(conflict.candidates[0])!.add(conflict.candidates[1]);
    adjacent.get(conflict.candidates[1])!.add(conflict.candidates[0]);
  }
  const waves: string[][] = [];
  for (const subject of subjects) {
    const neighbours = adjacent.get(subject.candidateId)!;
    let index = waves.findIndex((wave) => wave.every((candidateId) => !neighbours.has(candidateId)));
    if (index < 0) {
      index = waves.length;
      waves.push([]);
    }
    waves[index]!.push(subject.candidateId);
  }
  return waves.map((candidateIds, index) => ({
    index,
    candidateIds,
    requiresReplanAfterPreviousWave: index > 0,
    execution: "replan-between-every-child",
  }));
}
