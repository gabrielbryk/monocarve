import type { AppliedPlanReceipt, ReconciliationRecord } from "./types.ts";
import { assertAppliedPlanReceiptValid, assertReconciliationRecordValid, ReconciliationValidationError } from "./validate.ts";

function object(value: unknown): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ReconciliationValidationError("evidence must be a JSON object");
}

export const parseRecord = {
  reconciliation(value: unknown): ReconciliationRecord {
    object(value);
    const record = value as unknown as ReconciliationRecord;
    try {
      assertReconciliationRecordValid(record);
    } catch (error) {
      if (error instanceof ReconciliationValidationError) throw error;
      throw new ReconciliationValidationError(`invalid reconciliation structure: ${error instanceof Error ? error.message : String(error)}`);
    }
    return record;
  },
  receipt(value: unknown): AppliedPlanReceipt {
    object(value);
    const receipt = value as unknown as AppliedPlanReceipt;
    try {
      assertAppliedPlanReceiptValid(receipt);
    } catch (error) {
      if (error instanceof ReconciliationValidationError) throw error;
      throw new ReconciliationValidationError(`invalid receipt structure: ${error instanceof Error ? error.message : String(error)}`);
    }
    return receipt;
  },
};
