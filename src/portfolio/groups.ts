import { hashText } from "../util/hash.ts";
import type { CandidateEquivalenceGroup, PortfolioCandidate } from "./types.ts";

export function groupEquivalentCandidates(candidates: readonly PortfolioCandidate[], threshold: number): CandidateEquivalenceGroup[] {
  const remaining = [...candidates].sort((left, right) => left.id.localeCompare(right.id));
  const groups: CandidateEquivalenceGroup[] = [];
  while (remaining.length > 0) {
    const seed = remaining.shift()!;
    const members = [seed];
    for (let index = remaining.length - 1; index >= 0; index -= 1) {
      const candidate = remaining[index]!;
      if (sameKind(seed, candidate) && similarity(seed.files, candidate.files) >= threshold) {
        members.push(candidate);
        remaining.splice(index, 1);
      }
    }
    members.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
    const ids = members.map((candidate) => candidate.id).sort();
    const shared = members.reduce<Set<string>>((set, candidate) => new Set([...set].filter((path) => candidate.files.includes(path))), new Set(seed.files));
    groups.push({
      id: `eg-${hashText(ids.join("\n")).slice(0, 12)}`,
      representativeId: members[0]!.id,
      candidateIds: ids,
      sharedFileCount: shared.size,
      similarity: Math.min(...members.map((candidate) => similarity(seed.files, candidate.files))),
    });
  }
  return groups.sort((left, right) => left.id.localeCompare(right.id));
}

function sameKind(left: PortfolioCandidate, right: PortfolioCandidate): boolean {
  return (
    left.application === right.application &&
    left.eligible === right.eligible &&
    left.classification === right.classification &&
    left.recommendation?.status === right.recommendation?.status
  );
}

function similarity(left: readonly string[], right: readonly string[]): number {
  const a = new Set(left);
  const intersection = right.filter((path) => a.has(path)).length;
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 1 : intersection / union;
}
