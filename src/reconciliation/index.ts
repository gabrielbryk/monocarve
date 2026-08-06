import { stableStringify } from "../util/hash.ts";
import type { AppliedPlanReceipt, ReconciliationRecord } from "./types.ts";

export * from "./types.ts";
export * from "./compile.ts";
export * from "./validate.ts";
export * from "./receipt.ts";
export * from "./evidence.ts";
export * from "./approval.ts";
export * from "./overlay.ts";

export function serializeReconciliationRecord(record: ReconciliationRecord): string {
  return `${stableStringify(record, 2)}\n`;
}

export function serializeAppliedPlanReceipt(receipt: AppliedPlanReceipt): string {
  return `${stableStringify(receipt, 2)}\n`;
}
