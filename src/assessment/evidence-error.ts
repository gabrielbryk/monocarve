import { MonocarveError } from "../errors.ts";

export class EvidenceError extends MonocarveError {
  override readonly name = "EvidenceError";
  constructor(
    readonly code:
      | "EVIDENCE_DESTINATION_BUSY"
      | "EVIDENCE_RECOVERY_REQUIRED"
      | "EVIDENCE_DESTINATION_UNSAFE"
      | "EVIDENCE_REPLACEMENT_REFUSED"
      | "EVIDENCE_BUDGET_EXCEEDED",
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}
