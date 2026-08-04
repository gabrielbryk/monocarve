import type { MonocarveConfig } from "../../config.ts";
import type { PlanOperationKind } from "../manifest.ts";

export type ValidationSeverity = "error" | "warning";

export interface ValidationIssue {
  readonly severity: ValidationSeverity;
  /** Machine-readable rule id, e.g. `"scc-partition"`, `"move-not-byte-identical"`. */
  readonly rule: string;
  readonly message: string;
  /** Operation index, when the issue is attributable to one. */
  readonly operationIndex?: number;
  readonly operationKind?: PlanOperationKind;
  readonly path?: string;
}

export interface ValidationResult {
  readonly ok: boolean;
  readonly issues: readonly ValidationIssue[];
}

export interface ValidatePlanOptions {
  readonly config: MonocarveConfig;
  readonly rootDir: string;
  /** Skip checks that read the working tree (existence, current hashes). */
  readonly offline?: boolean;
}

/** Ordered accumulator: validation issue order is part of the review contract. */
export class Issues {
  readonly items: ValidationIssue[] = [];

  add(rule: string, message: string, extra: Partial<ValidationIssue> = {}): void {
    this.items.push({ severity: "error", rule, message, ...extra });
  }

  warn(rule: string, message: string, extra: Partial<ValidationIssue> = {}): void {
    this.items.push({ severity: "warning", rule, message, ...extra });
  }
}

export function validationResult(issues: Issues): ValidationResult {
  return { ok: !issues.items.some((issue) => issue.severity === "error"), issues: issues.items };
}
