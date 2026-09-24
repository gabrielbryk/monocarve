import type { PreparationAuditReport } from "../prepare/audit.ts";
import type { AuditReport } from "../transaction/audit.ts";
import type { Sha256 } from "../util/hash.ts";

/** The stable on-disk shape for a sequential decomposition campaign. */
export const CAMPAIGN_LEDGER_SCHEMA_VERSION = 1 as const;

export type CampaignStatus = "active" | "completed" | "stopped";
type CampaignChildKind = "preparation" | "extraction";

/** A graph snapshot is deliberately generic: every metric is a non-negative count. */
export interface GraphMetricSnapshot {
  /** `hashJson(metrics)`: a snapshot cannot claim graph metrics from another scan. */
  readonly digest: Sha256;
  readonly metrics: Readonly<Record<string, number>>;
}

export type CampaignStopCondition =
  | { readonly kind: "all-children-applied" }
  | { readonly kind: "max-children"; readonly maximum: number }
  | { readonly kind: "metric-threshold"; readonly metric: string; readonly comparison: "at-most" | "at-least"; readonly value: number };

interface CampaignAuditEvidenceBase {
  /** The immediate, unmodified audit result for this exact child application. */
  /** Stable digest of `report`, preventing a ledger from relabelling an audit. */
  readonly digest: Sha256;
}

interface ExtractionCampaignAuditEvidence extends CampaignAuditEvidenceBase {
  readonly kind: "extraction";
  readonly report: AuditReport;
}

interface PreparationCampaignAuditEvidence extends CampaignAuditEvidenceBase {
  readonly kind: "preparation";
  readonly report: PreparationAuditReport;
}

/** The evidence format must match the child it records; reports are never coerced. */
export type CampaignAuditEvidence = ExtractionCampaignAuditEvidence | PreparationCampaignAuditEvidence;

interface CampaignGraphTransition {
  readonly before: GraphMetricSnapshot;
  readonly after: GraphMetricSnapshot;
}

export interface CampaignChildPlan {
  /** Stable child identity; never reuse it within one campaign. */
  readonly id: string;
  /** Shared by exactly one preparation/extraction pair. */
  readonly pairId: string;
  readonly kind: CampaignChildKind;
  readonly planId: string;
  /** The exact HEAD against which the child plan was compiled. */
  readonly baselineCommit: string;
  /** Exact scanner graph from which this child was compiled. */
  readonly graphDigest?: Sha256;
}

interface PlannedCampaignChild extends CampaignChildPlan {
  readonly graphDigest: Sha256;
  readonly status: "planned";
}

export interface AppliedCampaignChild extends CampaignChildPlan {
  readonly graphDigest: Sha256;
  readonly status: "applied";
  readonly application: {
    /** Commit produced by applying this child, before any next child is planned. */
    readonly resultingCommit: string;
    readonly audit: CampaignAuditEvidence;
    readonly graph: CampaignGraphTransition;
  };
}

export type CampaignChildRecord = PlannedCampaignChild | AppliedCampaignChild;

/** Input accepted when starting a campaign. No clock is recorded: it stays reproducible. */
export interface CampaignLedgerInput {
  readonly campaignId: string;
  readonly objective: string;
  readonly stopConditions: readonly CampaignStopCondition[];
  readonly baselineCommit: string;
  readonly initialGraph: GraphMetricSnapshot;
}

/**
 * A sequential ledger, not a batch queue. At most its tail may be planned;
 * each subsequent child must be recompiled from the previous resulting commit.
 */
export interface CampaignLedger extends CampaignLedgerInput {
  readonly schemaVersion: typeof CAMPAIGN_LEDGER_SCHEMA_VERSION;
  readonly currentCommit: string;
  readonly currentGraph: GraphMetricSnapshot;
  readonly children: readonly CampaignChildRecord[];
  readonly status: CampaignStatus;
}

/** A pure evaluation lets CLI/orchestration persist the exact terminal state. */
export interface CampaignStopEvaluation {
  readonly outcome: "active" | "completed" | "stopped";
  readonly ledger: CampaignLedger;
  readonly condition?: CampaignStopCondition;
}

export interface CampaignChildApplication {
  readonly childId: string;
  readonly resultingCommit: string;
  readonly audit: CampaignAuditEvidence;
  readonly graph: CampaignGraphTransition;
}
