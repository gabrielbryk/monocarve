/** Pure lifecycle classification from independently collected evidence. */
import { TOOL_NAME } from "../branding.ts";
import type { CommitChainEvidence } from "./commit-evidence.ts";

export type LifecycleState =
  | "baseline"
  | "uncommitted-plan"
  | "approved"
  | "post-move"
  | "applied"
  | "applied-with-later-commits"
  | "applied-and-audited"
  | "drifted"
  | "unknown";
export interface LifecycleRecordEvidence {
  readonly valid: boolean;
  readonly failures?: readonly string[];
}
export interface LifecycleAuditEvidence {
  readonly passed: boolean;
  readonly reconcilable: boolean;
  readonly failures: readonly string[];
}
export interface LifecycleEvidence {
  readonly manifestPath?: string;
  readonly planId?: string;
  readonly atBaseline: boolean;
  readonly planWritten: boolean;
  readonly chain?: CommitChainEvidence;
  readonly currentTreeValid?: boolean;
  readonly audit?: LifecycleAuditEvidence;
  readonly receipt?: LifecycleRecordEvidence;
  readonly reconciliation?: LifecycleRecordEvidence;
}
export interface LifecycleStatus {
  readonly schema: "lifecycle-status-v1";
  readonly state: LifecycleState;
  readonly failures: readonly string[];
  readonly next: readonly string[];
  readonly planId?: string;
  readonly manifestPath?: string;
  readonly headCommit?: string;
  readonly evidence?: LifecycleEvidence;
}

export function classifyLifecycle(evidence: LifecycleEvidence): LifecycleStatus {
  const path = evidence.manifestPath;
  const chain = evidence.chain;
  const recordFailures = [...(evidence.receipt?.failures ?? []), ...(evidence.reconciliation?.failures ?? [])];
  if (evidence.receipt?.valid === false || evidence.reconciliation?.valid === false) return status("unknown", recordFailures, verify(path));
  if (chain !== undefined && !chain.valid) return status("drifted", chain.failures, verify(path));
  if (chain?.phase === "applied" && (evidence.audit?.passed === false || evidence.currentTreeValid === false)) {
    const failures = evidence.audit?.failures ?? ["current tree no longer matches the applied plan"];
    return status("drifted", failures, evidence.audit?.reconcilable ? reconcile(path) : audit(path));
  }
  if (chain?.phase === "applied") {
    const state = evidence.receipt?.valid ? "applied-and-audited" : chain.laterCommitCount > 0 ? "applied-with-later-commits" : "applied";
    return status(state, [], audit(path));
  }
  if (chain?.phase === "post-move") return status("post-move", [], [TOOL_NAME, "apply", "--plan", required(path), "--commit", "--resume"]);
  if (chain?.phase === "approved") return status("approved", [], [TOOL_NAME, "apply", "--plan", required(path), "--commit"]);
  if (evidence.atBaseline && evidence.planWritten) return status("uncommitted-plan", [], [TOOL_NAME, "approve", "--plan", required(path), "--commit"]);
  if (evidence.atBaseline && !evidence.planWritten) return status("baseline", [], [TOOL_NAME, "portfolio"]);
  return status("unknown", chain?.failures ?? ["no coherent lifecycle boundary found"], path === undefined ? [TOOL_NAME, "portfolio"] : verify(path));
}

function status(state: LifecycleState, failures: readonly string[], next: readonly string[]): LifecycleStatus {
  return { schema: "lifecycle-status-v1", state, failures, next };
}
function required(path: string | undefined): string {
  return path ?? "<plan>";
}
function audit(path: string | undefined): readonly string[] {
  return [TOOL_NAME, "audit", "--plan", required(path)];
}
function verify(path: string | undefined): readonly string[] {
  return [TOOL_NAME, "verify", "--plan", required(path)];
}
function reconcile(path: string | undefined): readonly string[] {
  return [TOOL_NAME, "reconcile", "--plan", required(path)];
}
