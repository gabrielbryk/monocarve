import { hashJson, stableStringify, type Sha256 } from "../util/hash.ts";
import {
  CAMPAIGN_LEDGER_SCHEMA_VERSION,
  type CampaignChildApplication,
  type CampaignChildPlan,
  type CampaignLedger,
  type CampaignLedgerInput,
  type CampaignStopEvaluation,
  type GraphMetricSnapshot,
} from "./ledger-types.ts";
import { assertAppendableChild, assertCampaignLedgerInputValid, assertCampaignLedgerValid, CampaignLedgerValidationError } from "./ledger-validation.ts";

export * from "./ledger-types.ts";
export { assertCampaignLedgerValid } from "./ledger-validation.ts";

export function createCampaignLedger(input: CampaignLedgerInput): CampaignLedger {
  assertCampaignLedgerInputValid(input);
  return {
    ...input,
    schemaVersion: CAMPAIGN_LEDGER_SCHEMA_VERSION,
    currentCommit: input.baselineCommit,
    currentGraph: input.initialGraph,
    children: [],
    status: "active",
  };
}

/** Add exactly one recompiled child; another cannot be queued before this one audits. */
export function appendCampaignChild(ledger: CampaignLedger, child: CampaignChildPlan): CampaignLedger {
  const evaluated = evaluateCampaignStopConditions(ledger);
  if (evaluated.outcome !== "active") throw new CampaignLedgerValidationError(`cannot plan a child: campaign is ${evaluated.outcome}`);
  assertAppendableChild(evaluated.ledger, child);
  const next = {
    ...evaluated.ledger,
    children: [...evaluated.ledger.children, { ...child, graphDigest: child.graphDigest ?? evaluated.ledger.currentGraph.digest, status: "planned" as const }],
  };
  assertCampaignLedgerValid(next);
  return next;
}

/**
 * Make the tail child durable only after its immediate successful audit.
 * A failure here means the ledger retains the planned child and cannot advance.
 */
export function recordCampaignChildApplication(ledger: CampaignLedger, application: CampaignChildApplication): CampaignLedger {
  assertCampaignLedgerValid(ledger);
  if (ledger.status !== "active") throw new CampaignLedgerValidationError(`cannot apply a child for ${ledger.status} campaign`);
  const tail = ledger.children.at(-1);
  if (tail === undefined || tail.status !== "planned") throw new CampaignLedgerValidationError("no planned child awaits application");
  if (tail.id !== application.childId) throw new CampaignLedgerValidationError(`cannot skip planned child ${tail.id}`);
  const applied = { ...tail, status: "applied" as const, application };
  const next: CampaignLedger = {
    ...ledger,
    currentCommit: application.resultingCommit,
    currentGraph: application.graph.after,
    children: [...ledger.children.slice(0, -1), applied],
  };
  assertCampaignLedgerValid(next);
  return evaluateCampaignStopConditions(next).ledger;
}

export function completeCampaign(ledger: CampaignLedger): CampaignLedger {
  assertCampaignLedgerValid(ledger);
  if (ledger.status !== "active") throw new CampaignLedgerValidationError(`cannot complete a ${ledger.status} campaign`);
  if (ledger.children.some((child) => child.status === "planned")) {
    throw new CampaignLedgerValidationError("cannot complete a campaign with an un-applied child");
  }
  return { ...ledger, status: "completed" };
}

export function stopCampaign(ledger: CampaignLedger): CampaignLedger {
  assertCampaignLedgerValid(ledger);
  if (ledger.status !== "active") throw new CampaignLedgerValidationError(`cannot stop a ${ledger.status} campaign`);
  return { ...ledger, status: "stopped" };
}

/** Stable bytes for review, persistence, and digesting; array order remains execution order. */
export function serializeCampaignLedger(ledger: CampaignLedger): string {
  assertCampaignLedgerValid(ledger);
  return `${stableStringify(ledger, 2)}\n`;
}

export function parseCampaignLedger(text: string, source = "<inline>"): CampaignLedger {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new CampaignLedgerValidationError(`could not parse campaign ledger ${source}: ${(error as Error).message}`, { cause: error });
  }
  if (parsed === null || typeof parsed !== "object") throw new CampaignLedgerValidationError(`campaign ledger ${source} must be an object`);
  const ledger = parsed as CampaignLedger;
  assertCampaignLedgerValid(ledger);
  return ledger;
}

/** Build a self-authenticating graph snapshot from scanner metric evidence. */
export function graphMetricSnapshot(metrics: Readonly<Record<string, number>>): GraphMetricSnapshot {
  return { metrics, digest: hashJson(metrics) as Sha256 };
}

/**
 * Evaluate the configured terminal conditions in declaration order. Metric
 * thresholds and all-applied are successful completion; max-children is a
 * protective stop. A terminal ledger is returned, never mutated in place.
 */
export function evaluateCampaignStopConditions(ledger: CampaignLedger): CampaignStopEvaluation {
  assertCampaignLedgerValid(ledger);
  if (ledger.status !== "active") return { outcome: ledger.status, ledger };
  const tail = ledger.children.at(-1);
  // A preparation is only the first half of a pair. Its graph can legitimately
  // meet a target while the dependent extraction still has to be compiled and
  // audited, so terminal conditions are meaningful only after that extraction.
  if (tail?.status !== "applied" || tail.kind !== "extraction") return { outcome: "active", ledger };
  for (const condition of ledger.stopConditions) {
    if (condition.kind === "max-children" && ledger.children.length >= condition.maximum) {
      return terminal(ledger, "stopped", condition);
    }
    if (condition.kind === "all-children-applied" && ledger.children.length > 0) {
      return terminal(ledger, "completed", condition);
    }
    if (condition.kind === "metric-threshold") {
      const actual = ledger.currentGraph.metrics[condition.metric];
      if (actual === undefined) throw new CampaignLedgerValidationError(`metric stop condition is unavailable: ${condition.metric}`);
      const reached = condition.comparison === "at-most" ? actual <= condition.value : actual >= condition.value;
      if (reached) return terminal(ledger, "completed", condition);
    }
  }
  return { outcome: "active", ledger };
}

function terminal(ledger: CampaignLedger, outcome: "completed" | "stopped", condition: CampaignStopEvaluation["condition"]): CampaignStopEvaluation {
  const terminalLedger = { ...ledger, status: outcome };
  return condition === undefined ? { outcome, ledger: terminalLedger } : { outcome, condition, ledger: terminalLedger };
}
