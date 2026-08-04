import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

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

export const DEFAULT_COMPLEXITY_LIMITS: ComplexityLimits = {
  structuralScore: 100,
  maxCognitive: 25,
  maxNest: 8,
  maxCyclo: 15,
  maxMethodLoc: 80,
};

export function findComplexityViolations(
  records: readonly ComplexityRecord[],
  limits: ComplexityLimits = DEFAULT_COMPLEXITY_LIMITS,
): ComplexityViolation[] {
  const metrics = Object.keys(limits) as (keyof ComplexityLimits)[];
  return records.flatMap((record) => metrics
    .filter((metric) => record[metric] > limits[metric])
    .map((metric) => ({
      path: record.path,
      metric,
      actual: record[metric],
      limit: limits[metric],
      lever: record.lever,
      reason: record.leverReason,
    })))
    .sort((left, right) => left.path.localeCompare(right.path) || left.metric.localeCompare(right.metric));
}

if (import.meta.main) {
  const analyzer = resolve(import.meta.dir, "complexity.ts");
  const targets = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["src"];
  const result = spawnSync(process.execPath, [analyzer, ...targets, "--json"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, PLAT: process.cwd() },
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || "complexity analyzer failed\n");
    process.exitCode = result.status ?? 1;
  } else {
    const records = JSON.parse(result.stdout) as ComplexityRecord[];
    const violations = findComplexityViolations(records);
    for (const entry of violations) {
      const path = entry.path.replace(`${process.cwd()}/`, "");
      process.stderr.write(`${path}: ${entry.metric} ${entry.actual} > ${entry.limit} (${entry.lever}: ${entry.reason})\n`);
    }
    if (violations.length > 0) {
      process.stderr.write(`complexity: ${violations.length} metric violation(s) across ${new Set(violations.map((entry) => entry.path)).size} file(s)\n`);
      process.exitCode = 1;
    }
  }
}
