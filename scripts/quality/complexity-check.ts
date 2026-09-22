import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { baselinePath, judge, readBaseline, report, reportBaselineUpdate, summarizeBaselineUpdate, writeBaseline, type BaselinedFinding } from "./baseline.ts";

export interface ComplexityRecord {
  readonly path: string;
  readonly structuralScore: number;
  readonly maxCognitive: number;
  readonly maxNest: number;
  readonly maxCyclo: number;
  readonly maxMethodLoc: number;
  readonly lever: string;
  readonly leverReason: string;
}

export interface ComplexityLimits {
  readonly structuralScore: number;
  readonly maxCognitive: number;
  readonly maxNest: number;
  readonly maxCyclo: number;
  readonly maxMethodLoc: number;
}

export interface ComplexityViolation {
  readonly path: string;
  readonly metric: keyof ComplexityLimits;
  readonly actual: number;
  readonly limit: number;
  readonly lever: string;
  readonly reason: string;
}

export const DEFAULT_COMPLEXITY_LIMITS: ComplexityLimits = { structuralScore: 100, maxCognitive: 25, maxNest: 8, maxCyclo: 15, maxMethodLoc: 80 };

export function findComplexityViolations(records: readonly ComplexityRecord[], limits: ComplexityLimits = DEFAULT_COMPLEXITY_LIMITS): ComplexityViolation[] {
  const metrics = Object.keys(limits) as (keyof ComplexityLimits)[];
  return records
    .flatMap((record) =>
      metrics
        .filter((metric) => record[metric] > limits[metric])
        .map((metric) => ({ path: record.path, metric, actual: record[metric], limit: limits[metric], lever: record.lever, reason: record.leverReason })),
    )
    .sort((left, right) => left.path.localeCompare(right.path) || left.metric.localeCompare(right.metric));
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const updating = argv.includes("--update-baseline");
  const targets = argv.filter((arg) => !arg.startsWith("--"));
  const analyzer = resolve(import.meta.dir, "complexity.ts");
  const result = spawnSync(process.execPath, [analyzer, ...(targets.length > 0 ? targets : ["src"]), "--json"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, PLAT: process.cwd() },
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || "complexity analyzer failed\n");
    process.exitCode = result.status ?? 1;
  } else {
    const records = JSON.parse(result.stdout) as ComplexityRecord[];
    const findings: BaselinedFinding[] = findComplexityViolations(records).map((entry) => ({
      path: entry.path.replace(`${process.cwd()}/`, ""),
      metric: entry.metric,
      actual: entry.actual,
      detail: `${entry.metric} ${entry.actual} > ${entry.limit} (${entry.lever}: ${entry.reason})`,
    }));
    const file = baselinePath(process.cwd(), "complexity");
    if (updating) {
      const summary = summarizeBaselineUpdate(findings, readBaseline(file));
      reportBaselineUpdate("complexity", summary, (text) => process.stderr.write(text));
      writeBaseline(file, findings);
      process.stderr.write(`complexity: baseline rewritten with ${findings.length} measurement(s)\n`);
    } else {
      process.exitCode = report("complexity", judge(findings, readBaseline(file)), (text) => process.stderr.write(text));
    }
  }
}
