/** Turn verified application evidence into the one durable campaign transition. */

import { MonocarveError } from "../errors.ts";
import {
  assertCampaignLedgerValid,
  recordCampaignChildApplication,
  type CampaignAuditEvidence,
  type CampaignChildPlan,
  type CampaignLedger,
  type GraphMetricSnapshot,
} from "./ledger.ts";

export class CampaignRecordError extends MonocarveError {
  override readonly name = "CampaignRecordError";
}

/** All evidence must describe the same just-applied child, at one stable HEAD. */
export interface RecordCampaignApplicationInput {
  readonly campaign: CampaignLedger;
  /** Identity read from the reviewed plan, not reconstructed from its filename. */
  readonly plan: CampaignChildPlan;
  /** HEAD after the child application and before the immediate audit. */
  readonly resultingHead: string;
  /** HEAD observed immediately after the audit completed. */
  readonly auditedHead: string;
  /** HEAD observed immediately after the uncached post-application scan. */
  readonly scannedHead: string;
  readonly audit: CampaignAuditEvidence;
  readonly postScan: GraphMetricSnapshot;
}

/**
 * Record exactly one verified child application without running I/O.
 *
 * A failure means the caller tried to label a plan, audit, HEAD, or scan from
 * a different event as this child. The existing ledger validator then proves
 * the resulting transition is canonical before it is returned for persistence.
 */
export function recordCampaignApplication(input: RecordCampaignApplicationInput): CampaignLedger {
  const { campaign, plan, resultingHead, auditedHead, scannedHead, audit, postScan } = input;
  assertCampaignLedgerValid(campaign);
  const tail = campaign.children.at(-1);
  if (tail === undefined || tail.status !== "planned") {
    throw new CampaignRecordError("campaign has no planned child to record");
  }
  assertPlanIdentity(tail, plan);
  if (resultingHead.length === 0 || auditedHead.length === 0 || scannedHead.length === 0) {
    throw new CampaignRecordError("resulting, audited, and scanned HEAD values must be non-empty");
  }
  if (resultingHead === campaign.currentCommit) {
    throw new CampaignRecordError("resulting HEAD must differ from the planned child baseline");
  }
  if (resultingHead !== auditedHead || resultingHead !== scannedHead) {
    throw new CampaignRecordError("audit and post-scan must observe the exact resulting HEAD");
  }
  if (postScan === undefined || postScan === null) throw new CampaignRecordError("fresh post-scan evidence is required");
  if (audit.kind !== plan.kind) throw new CampaignRecordError(`audit kind ${audit.kind} does not match ${plan.kind} plan ${plan.planId}`);
  if (!audit.report.passed) throw new CampaignRecordError(`immediate audit failed for ${plan.planId}`);
  if (audit.report.planId !== plan.planId || audit.report.baselineCommit !== plan.baselineCommit) {
    throw new CampaignRecordError(`immediate audit does not prove reviewed plan ${plan.planId}`);
  }
  return recordCampaignChildApplication(campaign, {
    childId: tail.id,
    resultingCommit: resultingHead,
    audit,
    graph: { before: campaign.currentGraph, after: postScan },
  });
}

function assertPlanIdentity(tail: CampaignChildPlan, plan: CampaignChildPlan): void {
  if (
    tail.id !== plan.id ||
    tail.pairId !== plan.pairId ||
    tail.kind !== plan.kind ||
    tail.planId !== plan.planId ||
    tail.baselineCommit !== plan.baselineCommit
  ) {
    throw new CampaignRecordError(`reviewed plan ${plan.planId} does not match planned campaign child ${tail.planId}`);
  }
}
