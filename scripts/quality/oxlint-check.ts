/**
 * Ratchets oxlint's `--type-aware` findings, in the spirit of `max-file-lines.ts`
 * and `complexity-check.ts`.
 *
 * Adopting oxlint on this repository surfaced ~2,450 findings on day one —
 * real, mostly legitimate (non-null assertions, mutating `Array#sort()`,
 * `any`-typed access, etc.) but far too many to fix in one pass without a
 * mass mechanical cleanup. Rather than leave the gate permanently red (which
 * stops it being read at all) or turn every noisy-but-real rule off, this
 * baselines today's count per `<file, rule>` pair:
 *
 *  - a rule with zero baseline entries left is fully enforced repo-wide;
 *  - a `<file, rule>` pair absent from the baseline fails — new debt of an
 *    already-adopted rule, in a file that didn't have it, is blocked;
 *  - a pair whose count got worse fails — existing debt cannot grow;
 *  - a pair whose count improved passes, and points at tightening the
 *    baseline;
 *  - a pair with no matching finding at all is reported stale.
 *
 * The metric is a `<rule>` id; `actual` is the number of findings for that
 * rule in that file, so fixing three of five `no-array-sort` findings in one
 * file is visible progress even before the file reaches zero.
 */

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { baselinePath, judge, readBaseline, report, reportBaselineUpdate, summarizeBaselineUpdate, writeBaseline, type BaselinedFinding } from "./baseline.ts";

export interface OxlintDiagnostic {
  readonly code: string;
  readonly filename: string;
}

export interface OxlintReport {
  readonly diagnostics: readonly OxlintDiagnostic[];
}

export function findOxlintViolations(diagnostics: readonly OxlintDiagnostic[]): BaselinedFinding[] {
  const counts = new Map<string, number>();
  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.filename}\u0000${diagnostic.code}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, actual]) => {
      const [path, metric] = key.split("\u0000") as [string, string];
      return { path, metric, actual, detail: `${actual} violation(s) of ${metric}` };
    })
    .sort((left, right) => left.path.localeCompare(right.path) || left.metric.localeCompare(right.metric));
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const updating = argv.includes("--update-baseline");
  const targets = argv.filter((arg) => !arg.startsWith("--"));
  const oxlintBin = resolve(import.meta.dir, "../../node_modules/.bin/oxlint");
  const result = spawnSync(oxlintBin, ["--type-aware", "--format=json", ...targets], {
    cwd: process.cwd(),
    encoding: "utf8",
    // The default 1 MiB ceiling truncates the JSON report well before a
    // repo-wide `--type-aware` run finishes writing it, which then reads
    // as a tool failure. A cold run on this repo already produces >1 MiB.
    maxBuffer: 1024 * 1024 * 64,
  });
  let oxlintReport: OxlintReport;
  try {
    oxlintReport = JSON.parse(result.stdout) as OxlintReport;
  } catch {
    // oxlint prints JSON on every run that actually lints, even one that
    // finds nothing or exits 1 on findings. Unparseable stdout means oxlint
    // itself failed (bad config, crash) rather than "found violations" —
    // that is a tool failure, not ratchet data, so fail loudly instead of
    // silently treating it as zero findings.
    process.stderr.write(result.stdout || "");
    process.stderr.write(result.stderr || "oxlint failed to run\n");
    process.exitCode = result.status ?? 1;
    oxlintReport = undefined as unknown as OxlintReport;
  }
  if (oxlintReport !== undefined) {
    const findings = findOxlintViolations(oxlintReport.diagnostics);
    const file = baselinePath(process.cwd(), "oxlint");
    if (updating) {
      const summary = summarizeBaselineUpdate(findings, readBaseline(file));
      reportBaselineUpdate("oxlint", summary, (text) => process.stderr.write(text));
      writeBaseline(file, findings);
      process.stderr.write(`oxlint: baseline rewritten with ${findings.length} measurement(s)\n`);
    } else {
      process.exitCode = report("oxlint", judge(findings, readBaseline(file)), (text) => process.stderr.write(text));
    }
  }
}
