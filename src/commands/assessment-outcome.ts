/**
 * Shared outcome handling for the read-only assessment commands (`assess` and
 * `batch split-candidates`).
 *
 * This is the only place a command sets exit code 2: `setQualificationExitCode`
 * copies `AssessmentQualification.exitCode` (0 qualified/allowed-empty,
 * 2 degraded, 1 fatal) into `process.exitCode`, which `main()` in src/cli.ts
 * returns. Expected assessment failures are printed as a fatal outcome document
 * (exit 1) instead of propagating, so `--json` callers always get a document.
 */

import { BatchAnalysisError } from "../assessment/batch.ts";
import { EvidenceError } from "../assessment/evidence.ts";
import type { AssessmentQualification } from "../assessment/qualification.ts";
import { AssessmentQualificationError } from "../assessment/snapshot.ts";
import { flagBool, type ParsedArgs } from "../cli/args.ts";
import type { LoadedConfig } from "../config.ts";
import { ConfigError, IoError, toError, UsageError } from "../errors.ts";
import { print } from "./shared.ts";

/** Flags that only make sense for mutating commands; assessment refuses them outright. */
export const MUTATION_ONLY_FLAGS = [
  "plan",
  "apply",
  "approve",
  "simulate",
  "prepare",
  "journal",
  "allow-dirty",
  "write",
  "commit",
  "commit-approval",
  "resume",
  "recover",
  "skip-gates",
  "force",
  "replace",
  "delete",
  "execute",
  "target",
  "package-name",
  "package-root",
  "retire-donors",
] as const;

/** Wording that differs between the two assessment commands' failure output. */
export interface AssessmentOutcomeWording {
  /** `impact` line on fatal diagnostics, e.g. "No new authoritative assessment bundle was published." */
  readonly impact: string;
  /** First line of the human-readable incomplete-batch report. */
  readonly batchFailureHeadline: string;
}

/** Every root the analysis reads; evidence may never be written inside one. */
export function analyticalRootsFor(loaded: LoadedConfig): string[] {
  return [
    ...loaded.config.applications.flatMap((entry) => [entry.sourceRoot, ...entry.consumerRoots]),
    ...loaded.config.packageRoots,
    ...loaded.config.firstPartyRoots,
    ...loaded.config.firstPartyPackages.map((entry) => entry.root),
  ];
}

/** Exit 0, 1, or 2 (degraded) as the qualification decided. The sole source of exit code 2. */
export function setQualificationExitCode(qualification: Pick<AssessmentQualification, "exitCode">): void {
  process.exitCode = qualification.exitCode;
}

/** Parse a positive integer flag value, or fail the invocation (exit 64). */
export function positiveInteger(value: number | string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new UsageError(`${name} must be a positive integer`);
  return parsed;
}

/**
 * Print an expected assessment failure as a fatal outcome document and exit 1.
 * Anything else — usage errors, not-yet-ported seams, defects — propagates to `main()`.
 */
export function handleAssessmentFailure(args: ParsedArgs, error: unknown, wording: AssessmentOutcomeWording): void {
  if (error instanceof BatchAnalysisError) {
    const failure = {
      schemaVersion: 1,
      status: "fatal" as const,
      exitCode: 1 as const,
      published: false,
      code: "SPLIT_ANALYSIS_INCOMPLETE" as const,
      ...error.aggregate,
    };
    print(flagBool(args, "json") ? failure : humanBatchFailure(failure, wording.batchFailureHeadline), args);
    process.exitCode = 1;
    return;
  }
  if (error instanceof AssessmentQualificationError) return printFatal(args, error.qualification.diagnostics, error.qualification.overrides);
  if (error instanceof EvidenceError) return printFatal(args, [{ code: error.code, severity: "error", message: error.message, impact: wording.impact }]);
  if (error instanceof ConfigError || error instanceof IoError) {
    const hint = error.hint === undefined ? {} : { hint: error.hint };
    return printFatal(args, [{ code: "ASSESSMENT_INPUT_UNREADABLE", severity: "error", message: error.message, impact: wording.impact, ...hint }]);
  }
  throw toError(error);
}

function printFatal(args: ParsedArgs, diagnostics: readonly unknown[], overrides: readonly string[] = []): void {
  print({ schemaVersion: 1, status: "fatal", exitCode: 1, published: false, overrides, diagnostics }, args);
  process.exitCode = 1;
}

function humanBatchFailure(aggregate: { readonly completed: readonly string[]; readonly failed: readonly string[] }, headline: string): string {
  return [
    headline,
    `Completed (${aggregate.completed.length}): ${aggregate.completed.length === 0 ? "none" : aggregate.completed.join(", ")}`,
    `Failed (${aggregate.failed.length}): ${aggregate.failed.length === 0 ? "none" : aggregate.failed.join(", ")}`,
  ].join("\n");
}
