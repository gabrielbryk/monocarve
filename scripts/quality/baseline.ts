/**
 * The reviewed baseline of quality-gate debt that already existed.
 *
 * Both gates in this directory measure the whole repository, which is the right
 * scope and also what made them unusable: they have never passed. The limits
 * were set as a target, the codebase has never met them, and a gate that fails
 * on every run stops being read — `bun run check` has been red since the
 * initial commit, so nothing it says about a *new* regression can be seen.
 *
 * The answer is not to raise the limits until they are met, which discards the
 * target, nor to list violations as permanently forgiven, which lets the debt
 * grow inside the allowance. It is a ratchet, in the spirit of the reviewed
 * boundary baseline in `src/plan/boundary-baseline.ts`:
 *
 *  - every violation that exists today is recorded here with its measured
 *    value, checked in, and reviewable as a diff;
 *  - a violation absent from the baseline fails the gate — new debt is blocked;
 *  - a recorded violation whose value got *worse* fails the gate — existing
 *    debt cannot grow;
 *  - a recorded violation whose value improved passes, and the gate says so, so
 *    the baseline can be tightened;
 *  - a recorded violation that no longer exists at all is reported as stale, so
 *    the entry gets removed rather than quietly protecting nothing.
 *
 * The limits stay where they are. They describe where the code should be; the
 * baseline describes where it is, and only ever narrows.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/** One accepted measurement: `<path>` -> `<metric>` -> highest tolerated value. */
export type QualityBaseline = Record<string, Record<string, number>>;

export interface BaselinedFinding {
  readonly path: string;
  readonly metric: string;
  readonly actual: number;
  /** Rendered for the operator, e.g. "maxCyclo 16 > 15". */
  readonly detail: string;
}

export interface BaselineVerdict {
  /** Not in the baseline at all, or worse than recorded. These fail the gate. */
  readonly failures: { readonly finding: BaselinedFinding; readonly reason: string }[];
  /** Recorded and unchanged. Informational. */
  readonly accepted: BaselinedFinding[];
  /** Recorded, and now better than recorded. The baseline can be tightened. */
  readonly improved: { readonly finding: BaselinedFinding; readonly recorded: number }[];
  /** Recorded but no longer measured at all. The entry is stale. */
  readonly stale: { readonly path: string; readonly metric: string; readonly recorded: number }[];
}

export function baselinePath(rootDir: string, name: string): string {
  return resolve(rootDir, "scripts/quality", `${name}-baseline.json`);
}

export function readBaseline(file: string): QualityBaseline {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    // An absent baseline is an empty one: every violation is new, which is the
    // correct behaviour for a repository that has not adopted one.
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Unparseable is treated the same as absent — fails closed, not open.
    return {};
  }
  // A baseline that parses but is malformed is not "no baseline" — it is a
  // corrupt one, and trusting it (as empty, or as-is) would let `judge` fall
  // through to `accepted` on a comparison against a non-number, silently
  // voiding the ratchet's whole guarantee. Fail loudly instead.
  return validateBaseline(parsed, file);
}

export function validateBaseline(value: unknown, file: string): QualityBaseline {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`corrupt baseline ${file}: expected a top-level object, got ${describeValue(value)}`);
  }
  for (const [path, metrics] of Object.entries(value as Record<string, unknown>)) {
    if (typeof metrics !== "object" || metrics === null || Array.isArray(metrics)) {
      throw new Error(`corrupt baseline ${file}: ${path} must be an object of metrics, got ${describeValue(metrics)}`);
    }
    for (const [metric, recorded] of Object.entries(metrics as Record<string, unknown>)) {
      if (typeof recorded !== "number" || !Number.isFinite(recorded)) {
        throw new Error(`corrupt baseline ${file}: ${path}.${metric} must be a finite number, got ${describeValue(recorded)}`);
      }
    }
  }
  return value as QualityBaseline;
}

function describeValue(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

export function writeBaseline(file: string, findings: readonly BaselinedFinding[]): void {
  const baseline: QualityBaseline = {};
  for (const finding of [...findings].sort((a, b) => a.path.localeCompare(b.path) || a.metric.localeCompare(b.metric))) {
    (baseline[finding.path] ??= {})[finding.metric] = finding.actual;
  }
  writeFileSync(file, `${JSON.stringify(baseline, null, 2)}\n`);
}

export function judge(findings: readonly BaselinedFinding[], baseline: QualityBaseline): BaselineVerdict {
  const verdict: BaselineVerdict = { failures: [], accepted: [], improved: [], stale: [] };
  const seen = new Set<string>();
  for (const finding of findings) {
    seen.add(`${finding.path}\u0000${finding.metric}`);
    const recorded = baseline[finding.path]?.[finding.metric];
    if (recorded === undefined) {
      verdict.failures.push({ finding, reason: "not in the reviewed baseline" });
    } else if (finding.actual > recorded) {
      verdict.failures.push({ finding, reason: `worse than the reviewed baseline (${recorded})` });
    } else if (finding.actual < recorded) {
      verdict.improved.push({ finding, recorded });
    } else {
      verdict.accepted.push(finding);
    }
  }
  for (const [path, metrics] of Object.entries(baseline)) {
    for (const [metric, recorded] of Object.entries(metrics)) {
      if (!seen.has(`${path}\u0000${metric}`)) verdict.stale.push({ path, metric, recorded });
    }
  }
  return verdict;
}

/**
 * What `--update-baseline` is about to accept, broken into the buckets a
 * reviewer actually needs to look at (new, worsened) versus the ones a count
 * is enough for (improved, stale). Built on `judge` rather than duplicating
 * its comparison — a worsened entry is just a `judge` failure that already
 * had a recorded value, so the old value comes straight from the baseline
 * that was judged against, not from re-parsing `reason`.
 */
export interface BaselineUpdateSummary {
  /** Violations with no prior baseline entry — the dangerous ones. */
  readonly newEntries: readonly BaselinedFinding[];
  /** Recorded measurements about to be blessed at a worse value. */
  readonly worsened: readonly { readonly finding: BaselinedFinding; readonly recorded: number }[];
  readonly improvedCount: number;
  readonly staleCount: number;
}

export function summarizeBaselineUpdate(findings: readonly BaselinedFinding[], baseline: QualityBaseline): BaselineUpdateSummary {
  const verdict = judge(findings, baseline);
  const newEntries: BaselinedFinding[] = [];
  const worsened: { finding: BaselinedFinding; recorded: number }[] = [];
  for (const { finding } of verdict.failures) {
    const recorded = baseline[finding.path]?.[finding.metric];
    if (recorded === undefined) newEntries.push(finding);
    else worsened.push({ finding, recorded });
  }
  return { newEntries, worsened, improvedCount: verdict.improved.length, staleCount: verdict.stale.length };
}

/** Prints a `summarizeBaselineUpdate` result in `report`'s voice, before the file is written. */
export function reportBaselineUpdate(label: string, summary: BaselineUpdateSummary, write: (text: string) => void): void {
  if (summary.newEntries.length > 0) {
    write(`${label}: ${summary.newEntries.length} new violation(s) being accepted\n`);
    for (const finding of summary.newEntries) write(`  ${finding.path}: ${finding.detail}\n`);
  }
  if (summary.worsened.length > 0) {
    write(`${label}: ${summary.worsened.length} baselined measurement(s) getting worse\n`);
    for (const { finding, recorded } of summary.worsened) {
      write(`  ${finding.path} ${finding.metric}: ${recorded} -> ${finding.actual}\n`);
    }
  }
  if (summary.improvedCount > 0) {
    write(`${label}: ${summary.improvedCount} baselined measurement(s) improving\n`);
  }
  if (summary.staleCount > 0) {
    write(`${label}: ${summary.staleCount} stale baseline entr(y/ies) being dropped\n`);
  }
}

/** Shared reporting, so both gates speak with one voice. Returns the exit code. */
export function report(label: string, verdict: BaselineVerdict, write: (text: string) => void): number {
  for (const { finding, reason } of verdict.failures) write(`${finding.path}: ${finding.detail} — ${reason}\n`);
  if (verdict.failures.length > 0) {
    const files = new Set(verdict.failures.map((entry) => entry.finding.path)).size;
    write(`${label}: ${verdict.failures.length} unbaselined violation(s) across ${files} file(s)\n`);
  }
  if (verdict.improved.length > 0) {
    write(`${label}: ${verdict.improved.length} baselined measurement(s) improved — run with --update-baseline to tighten\n`);
  }
  if (verdict.stale.length > 0) {
    write(`${label}: ${verdict.stale.length} baseline entr(y/ies) no longer apply — run with --update-baseline to drop\n`);
  }
  if (verdict.failures.length === 0 && verdict.accepted.length > 0) {
    write(`${label}: ${verdict.accepted.length} known violation(s) within the reviewed baseline\n`);
  }
  return verdict.failures.length > 0 ? 1 : 0;
}
