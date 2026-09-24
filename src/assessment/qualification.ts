import { byCodeUnit } from "../util/hash.ts";

export type AssessmentDiagnosticSeverity = "info" | "warning" | "error";

export type AssessmentDiagnosticCode =
  | "WORKSPACE_PATTERN_UNMATCHED"
  | "WORKSPACE_GLOB_UNSUPPORTED"
  | "WORKSPACE_PATH_UNSAFE"
  | "WORKSPACE_PACKAGE_DUPLICATE"
  | "WORKSPACE_DISCOVERY_FAILED"
  | "SOURCE_ROOT_MISSING"
  | "SOURCE_ROOT_EMPTY"
  | "SCAN_UNEXPECTED_EMPTY_GRAPH"
  | "SCAN_TSCONFIG_EXCLUDES_PRODUCTION"
  | "SCAN_CONFIGURATION_EXCLUDES_PRODUCTION"
  | "SCAN_REPORT_MALFORMED"
  | "ASSESSMENT_INPUT_UNBOUND"
  | "ASSESSMENT_INPUT_UNREADABLE"
  | "ASSESSMENT_INPUT_MISSING"
  | "ASSESSMENT_INPUT_DRIFT"
  | "ASSESSMENT_REPLAY_PROVENANCE_REQUIRED"
  | "ASSESSMENT_REPLAY_INPUT_MISMATCH"
  | "SPLIT_ANALYSIS_INCOMPLETE"
  | "EVIDENCE_DESTINATION_BUSY"
  | "EVIDENCE_RECOVERY_REQUIRED"
  | "EVIDENCE_DESTINATION_UNSAFE"
  | "EVIDENCE_REPLACEMENT_REFUSED"
  | "EVIDENCE_BUDGET_EXCEEDED";

export interface AssessmentDiagnostic {
  readonly code: AssessmentDiagnosticCode;
  readonly severity: AssessmentDiagnosticSeverity;
  readonly message: string;
  readonly impact: string;
  readonly paths?: readonly string[];
  readonly patterns?: readonly string[];
}

export type QualificationStatus = "qualified" | "allowed-empty" | "degraded" | "fatal";

export interface AssessmentQualification {
  readonly schemaVersion: 1;
  readonly status: QualificationStatus;
  readonly exitCode: 0 | 1 | 2;
  readonly mayPublish: boolean;
  readonly diagnostics: readonly AssessmentDiagnostic[];
  readonly overrides: readonly "allow-empty"[];
}

const FATAL_CODES = new Set<AssessmentDiagnosticCode>([
  "WORKSPACE_GLOB_UNSUPPORTED", "WORKSPACE_PATH_UNSAFE", "WORKSPACE_PACKAGE_DUPLICATE",
  "WORKSPACE_DISCOVERY_FAILED", "SOURCE_ROOT_MISSING", "SOURCE_ROOT_EMPTY",
  "SCAN_UNEXPECTED_EMPTY_GRAPH", "SCAN_TSCONFIG_EXCLUDES_PRODUCTION",
  "SCAN_CONFIGURATION_EXCLUDES_PRODUCTION", "SCAN_REPORT_MALFORMED",
  "ASSESSMENT_INPUT_UNBOUND", "ASSESSMENT_INPUT_UNREADABLE", "ASSESSMENT_INPUT_MISSING",
  "ASSESSMENT_INPUT_DRIFT", "ASSESSMENT_REPLAY_PROVENANCE_REQUIRED",
  "ASSESSMENT_REPLAY_INPUT_MISMATCH", "SPLIT_ANALYSIS_INCOMPLETE",
  "EVIDENCE_DESTINATION_BUSY", "EVIDENCE_RECOVERY_REQUIRED", "EVIDENCE_DESTINATION_UNSAFE",
  "EVIDENCE_REPLACEMENT_REFUSED", "EVIDENCE_BUDGET_EXCEEDED",
]);

export function qualifyAssessment(input: {
  readonly diagnostics?: readonly AssessmentDiagnostic[];
  readonly allowedEmpty?: boolean;
}): AssessmentQualification {
  const diagnostics = [...(input.diagnostics ?? [])].sort(compareDiagnostics);
  const fatal = diagnostics.some((entry) => entry.severity === "error" || FATAL_CODES.has(entry.code));
  const degraded = diagnostics.some((entry) => entry.code === "WORKSPACE_PATTERN_UNMATCHED");
  const overrides: readonly "allow-empty"[] = input.allowedEmpty ? ["allow-empty"] : [];
  if (fatal) return { schemaVersion: 1, status: "fatal", exitCode: 1, mayPublish: false, diagnostics, overrides };
  if (degraded) return { schemaVersion: 1, status: "degraded", exitCode: 2, mayPublish: true, diagnostics, overrides };
  if (input.allowedEmpty) return { schemaVersion: 1, status: "allowed-empty", exitCode: 0, mayPublish: true, diagnostics, overrides };
  return { schemaVersion: 1, status: "qualified", exitCode: 0, mayPublish: true, diagnostics, overrides };
}

export function unavailable<T = never>(diagnostics: readonly AssessmentDiagnostic[]): Availability<T> {
  return { status: "unavailable", diagnostics: [...diagnostics].sort(compareDiagnostics) };
}

export type Availability<T> = { readonly status: "available"; readonly value: T }
  | { readonly status: "unavailable"; readonly diagnostics: readonly AssessmentDiagnostic[] };

export function available<T>(value: T): Availability<T> { return { status: "available", value }; }

function compareDiagnostics(left: AssessmentDiagnostic, right: AssessmentDiagnostic): number {
  return byCodeUnit(left.code, right.code)
    || byCodeUnit(left.message, right.message)
    || byCodeUnit((left.paths ?? []).join("\0"), (right.paths ?? []).join("\0"))
    || byCodeUnit((left.patterns ?? []).join("\0"), (right.patterns ?? []).join("\0"));
}
