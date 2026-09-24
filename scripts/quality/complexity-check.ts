import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";

import { headCommit, showBaseline } from "../../src/util/git.ts";

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
    .sort(compareViolations);
}

/** Enforce absolute limits for new files and prohibit worsening legacy debt. */
export function findComplexityRegressions(
  records: readonly ComplexityRecord[],
  baselineRecords: readonly ComplexityRecord[],
  limits: ComplexityLimits = DEFAULT_COMPLEXITY_LIMITS,
): ComplexityViolation[] {
  const baseline = new Map(baselineRecords.map((record) => [record.path, record]));
  const metrics = Object.keys(limits) as (keyof ComplexityLimits)[];
  return records.flatMap((record) => metrics.flatMap((metric) => {
    const allowed = Math.max(limits[metric], baseline.get(record.path)?.[metric] ?? limits[metric]);
    return record[metric] > allowed ? [{ path: record.path, metric, actual: record[metric], limit: allowed, lever: record.lever, reason: record.leverReason }] : [];
  })).sort(compareViolations);
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
    const records = normalizePaths(JSON.parse(result.stdout) as ComplexityRecord[], process.cwd());
    const baselineRecords = analyzeBaseline(analyzer, records);
    const violations = findComplexityRegressions(records, baselineRecords);
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

function analyzeBaseline(analyzer: string, records: readonly ComplexityRecord[]): ComplexityRecord[] {
  const root = process.cwd();
  const cacheRoot = resolve(process.env.XDG_CACHE_HOME ?? resolve(process.env.HOME ?? tmpdir(), ".cache"), "tmp");
  mkdirSync(cacheRoot, { recursive: true });
  const scratch = mkdtempSync(resolve(cacheRoot, "complexity-baseline-"));
  try {
    const commit = headCommit(root);
    let copied = false;
    for (const record of records) {
      const text = showBaseline(root, commit, record.path);
      if (text === null) continue;
      copied = true;
      const destination = resolve(scratch, record.path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, text);
    }
    if (!copied) return [];
    const result = spawnSync(process.execPath, [analyzer, scratch, "--json"], {
      cwd: scratch, encoding: "utf8", env: { ...process.env, PLAT: scratch },
    });
    if (result.status !== 0) throw new Error(result.stderr || "baseline complexity analyzer failed");
    return normalizePaths(JSON.parse(result.stdout) as ComplexityRecord[], scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function normalizePaths(records: readonly ComplexityRecord[], root: string): ComplexityRecord[] {
  return records.map((record) => ({ ...record, path: relative(root, record.path).replaceAll("\\", "/") }));
}

function compareViolations(left: ComplexityViolation, right: ComplexityViolation): number {
  return compareCodeUnits(left.path, right.path) || compareCodeUnits(left.metric, right.metric);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
