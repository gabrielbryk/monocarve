/**
 * Same-baseline plan conflict analysis.
 *
 * This module never merges manifests. A shared structured edit can be
 * *mergeable* in the resulting graph, but the byte hashes in the two original
 * journals still describe two different transitions from the same baseline.
 * Campaign execution must recompile after either transition; weakening a
 * precondition would turn useful planning information into an unsafe apply.
 */

import { MonocarveError } from "../errors.ts";
import { byCodeUnit } from "../util/hash.ts";
import { accessesFor } from "./conflict-accesses.ts";
import { compareConflicts, conflictsBetween } from "./conflict-resolution.ts";
import type { CampaignPlan, PlanConflict, PlanConflictAnalysis, Subject } from "./conflict-types.ts";
import { buildWaves } from "./conflict-waves.ts";

export type {
  CampaignPlan,
  CampaignWave,
  ConflictCategory,
  ConflictDisposition,
  OperationPathAccess,
  PathAccessMode,
  PathAccessRole,
  PlanConflict,
  PlanConflictAnalysis,
} from "./conflict-types.ts";

export class CampaignConflictAnalysisError extends MonocarveError {
  override readonly name = "CampaignConflictAnalysisError";
}

/** Analyze plans from one baseline and partition them into deterministic waves. */
export function analyzePlanConflicts(plans: readonly CampaignPlan[]): PlanConflictAnalysis {
  if (plans.length === 0) return { baselineCommit: "", graphDigest: "", conflicts: [], waves: [] };
  assertUnique(plans, (plan) => plan.candidateId, "candidate id");
  assertUnique(plans, (plan) => plan.manifest.planId, "plan id");
  assertCompatiblePlans(plans);
  const subjects = plans.map(toSubject).sort(compareSubjects);
  const conflicts = collectConflicts(subjects);
  return { baselineCommit: plans[0]!.manifest.baselineCommit, graphDigest: plans[0]!.manifest.graphDigest, conflicts, waves: buildWaves(subjects, conflicts) };
}

function assertCompatiblePlans(plans: readonly CampaignPlan[]): void {
  const baselineCommit = plans[0]!.manifest.baselineCommit;
  const graphDigest = plans[0]!.manifest.graphDigest;
  for (const plan of plans) {
    if (plan.priority !== undefined && !Number.isFinite(plan.priority)) {
      throw new CampaignConflictAnalysisError(`candidate priority must be finite: ${plan.candidateId}`);
    }
    if (plan.manifest.baselineCommit !== baselineCommit) {
      throw new CampaignConflictAnalysisError(
        `plans do not share a baseline commit: ${plan.candidateId} has ${plan.manifest.baselineCommit}, expected ${baselineCommit}`,
      );
    }
    if (plan.manifest.graphDigest !== graphDigest) {
      throw new CampaignConflictAnalysisError(
        `plans do not share a graph digest: ${plan.candidateId} has ${plan.manifest.graphDigest}, expected ${graphDigest}`,
      );
    }
  }
}

function assertUnique(plans: readonly CampaignPlan[], value: (plan: CampaignPlan) => string, label: string): void {
  const seen = new Set<string>();
  for (const plan of plans) {
    const current = value(plan);
    if (seen.has(current)) throw new CampaignConflictAnalysisError(`duplicate ${label}: ${current}`);
    seen.add(current);
  }
}

function toSubject(plan: CampaignPlan): Subject {
  return { candidateId: plan.candidateId, priority: plan.priority ?? 0, manifest: plan.manifest, accesses: accessesFor(plan) };
}

function compareSubjects(left: Subject, right: Subject): number {
  return right.priority - left.priority || byCodeUnit(left.candidateId, right.candidateId);
}

function collectConflicts(subjects: readonly Subject[]): PlanConflict[] {
  const conflicts: PlanConflict[] = [];
  for (let leftIndex = 0; leftIndex < subjects.length; leftIndex += 1) {
    const left = subjects[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < subjects.length; rightIndex += 1) {
      conflicts.push(...conflictsBetween(left, subjects[rightIndex]!));
    }
  }
  return conflicts.sort(compareConflicts);
}
