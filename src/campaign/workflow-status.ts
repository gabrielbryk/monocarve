import type { CampaignLedger, CampaignStatus } from "./ledger-types.ts";
import { assertCampaignLedgerValid } from "./ledger-validation.ts";

type CampaignPhase =
  | "needs-preparation-review"
  | "needs-preparation-application"
  | "needs-paired-extraction-review"
  | "needs-paired-extraction-application"
  | "stale-head"
  | "completed"
  | "stopped";

export interface CampaignWorkflowStatus {
  readonly campaignId: string;
  readonly status: CampaignStatus;
  readonly phase: CampaignPhase;
  readonly expectedCommit: string;
  readonly observedCommit: string;
  readonly staleHead: boolean;
  readonly canProceed: boolean;
  readonly pendingChildId?: string;
  readonly pairId?: string;
}

/** Derive the one legal next operator action without mutating or rescanning. */
export function describeCampaignStatus(ledger: CampaignLedger, observedCommit: string): CampaignWorkflowStatus {
  assertCampaignLedgerValid(ledger);
  const staleHead = observedCommit !== ledger.currentCommit;
  const tail = ledger.children.at(-1);
  let phase: CampaignPhase;
  if (staleHead) phase = "stale-head";
  else if (ledger.status !== "active") phase = ledger.status;
  else if (tail?.status === "planned") {
    phase = tail.kind === "preparation" ? "needs-preparation-application" : "needs-paired-extraction-application";
  } else if (tail?.kind === "preparation") phase = "needs-paired-extraction-review";
  else phase = "needs-preparation-review";
  return {
    campaignId: ledger.campaignId,
    status: ledger.status,
    phase,
    expectedCommit: ledger.currentCommit,
    observedCommit,
    staleHead,
    canProceed: !staleHead && ledger.status === "active",
    ...(tail === undefined ? {} : { pairId: tail.pairId }),
    ...(tail?.status === "planned" ? { pendingChildId: tail.id } : {}),
  };
}
