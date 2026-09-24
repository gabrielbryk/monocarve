/**
 * Compile the next campaign child without applying it.
 *
 * A campaign is intentionally a one-item queue. The caller records an apply
 * and its successful audit in the ledger, then this module re-scans that exact
 * resulting HEAD before compiling one replacement child. This keeps a child
 * compiled against an earlier baseline from being mistaken for a safe batch.
 */

import { MonocarveError } from "../errors.ts";
import {
  appendCampaignChild,
  assertCampaignLedgerValid,
  completeCampaign,
  evaluateCampaignStopConditions,
  type CampaignChildPlan,
  type CampaignLedger,
  type GraphMetricSnapshot,
} from "./ledger.ts";

class CampaignAdvanceError extends MonocarveError {
  override readonly name = "CampaignAdvanceError";
}

export interface CampaignRescanInput {
  readonly campaign: CampaignLedger;
  readonly headCommit: string;
}

export interface CampaignCompileNextInput extends CampaignRescanInput {
  /** Fresh evidence, collected after the previous child was applied and audited. */
  readonly graph: GraphMetricSnapshot;
}

export interface AdvanceCampaignOptions {
  readonly campaign: CampaignLedger;
  /** Injected so orchestration has no git or filesystem dependency. */
  readonly headCommit: () => Promise<string> | string;
  /** Must inspect the exact current HEAD; a cached graph is not a replan. */
  readonly rescan: (input: CampaignRescanInput) => Promise<GraphMetricSnapshot> | GraphMetricSnapshot;
  /** A singular return type makes a batch impossible to queue accidentally. */
  readonly compileNext: (input: CampaignCompileNextInput) => Promise<CampaignChildPlan | undefined> | CampaignChildPlan | undefined;
  /** Review is required unless a caller deliberately opts into a ready result. */
  readonly stopForReview?: boolean;
}

interface CampaignAdvanceStopped {
  readonly outcome: "stopped";
  readonly reason: "no-next-child" | "stop-condition";
  readonly campaign: CampaignLedger;
  readonly graph: GraphMetricSnapshot;
}

interface CampaignAdvancePlanned {
  readonly outcome: "review-required" | "ready-to-apply";
  readonly campaign: CampaignLedger;
  readonly child: CampaignChildPlan;
  readonly graph: GraphMetricSnapshot;
}

export type CampaignAdvanceResult = CampaignAdvanceStopped | CampaignAdvancePlanned;

/**
 * Replan a campaign after exactly one audited child.
 *
 * Failure means either a stale checkout, an unaudited/unfinished previous
 * child, an invalid preparation-to-extraction order, or an attempted batch.
 * In all cases no child is appended and no repository state is changed.
 */
export async function advanceCampaign(options: AdvanceCampaignOptions): Promise<CampaignAdvanceResult> {
  const evaluation = evaluateCampaignStopConditions(options.campaign);
  if (evaluation.outcome !== "active") {
    return { outcome: "stopped", reason: "stop-condition", campaign: evaluation.ledger, graph: evaluation.ledger.currentGraph };
  }
  assertReadyToAdvance(evaluation.ledger);
  const headCommit = await options.headCommit();
  if (headCommit !== evaluation.ledger.currentCommit) {
    throw new CampaignAdvanceError(
      `campaign HEAD is stale: checkout is ${headCommit}, ledger requires ${evaluation.ledger.currentCommit}; rescan and replan from the current checkout`,
    );
  }

  const input = { campaign: evaluation.ledger, headCommit };
  const graph = await options.rescan(input);
  const child = await options.compileNext({ ...input, graph });
  if (child === undefined) {
    assertPairMayComplete(evaluation.ledger);
    return { outcome: "stopped", reason: "no-next-child", campaign: completeCampaign(evaluation.ledger), graph };
  }

  assertChildSequence(evaluation.ledger, child);
  const campaign = appendCampaignChild(evaluation.ledger, child);
  return { outcome: options.stopForReview === false ? "ready-to-apply" : "review-required", campaign, child, graph };
}

/** No replacement can close only the second, audited half of a pair. */
function assertPairMayComplete(campaign: CampaignLedger): void {
  const tail = campaign.children.at(-1);
  if (tail?.kind === "extraction" && tail.status === "applied") return;
  throw new CampaignAdvanceError("no next child cannot complete a campaign before an applied extraction closes the current pair");
}

function assertReadyToAdvance(campaign: CampaignLedger): void {
  assertCampaignLedgerValid(campaign);
  if (campaign.status !== "active") {
    throw new CampaignAdvanceError(`cannot advance a ${campaign.status} campaign`);
  }
  const tail = campaign.children.at(-1);
  if (tail?.status === "planned") {
    throw new CampaignAdvanceError(`cannot advance while child ${tail.id} awaits application and audit`);
  }
}

/**
 * A pair is one preparation and its dependent extraction, in that exact order.
 * This local refusal is intentionally duplicated by ledger validation: callers
 * get a precise orchestration error before a malformed child reaches storage.
 */
function assertChildSequence(campaign: CampaignLedger, child: CampaignChildPlan): void {
  const previous = campaign.children.at(-1);
  if (previous === undefined) {
    if (child.kind === "preparation") return;
    throw new CampaignAdvanceError(`first child ${child.id} must be a preparation; compile preparation first`);
  }
  if (previous.status !== "applied") throw new CampaignAdvanceError(`cannot advance while child ${previous.id} awaits application and audit`);
  if (previous.kind === "preparation") {
    if (child.kind !== "extraction") {
      throw new CampaignAdvanceError(`child ${child.id} must extract after preparation ${previous.id}`);
    }
    if (child.pairId !== previous.pairId) {
      throw new CampaignAdvanceError(`extraction child ${child.id} must share pair id ${previous.pairId}`);
    }
    return;
  }
  if (child.kind !== "preparation") {
    throw new CampaignAdvanceError(`child ${child.id} must prepare after extraction ${previous.id}`);
  }
}
