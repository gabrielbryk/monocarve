import { isAbsolute, relative, resolve } from "node:path";
import { realpathSync } from "node:fs";

import type { ScanReport } from "../graph/build.ts";
import { hashBytes } from "../util/hash.ts";
import { canonicalInputPath } from "./input-inventory.ts";

/**
 * Scanner adapters are allowed to use absolute paths internally, but raw
 * reports are durable public evidence.  Normalize every absolute string in a
 * report at that boundary so a checkout's parent directory can never become
 * part of an artifact hash.  This intentionally walks the complete scanner
 * shape: dependency-cruiser adds path-bearing fields beyond the small
 * internal ScanReport interface (for example cycle names and dependents).
 */
export function canonicalizeScanReport(rootDir: string, report: ScanReport): ScanReport {
  const root = realpathSync(rootDir);
  return canonicalizeValue(root, report) as ScanReport;
}

/** A replay bundle must contain only checkout-independent raw report paths. */
export function containsAbsoluteReportPath(value: unknown): boolean {
  if (typeof value === "string") return isAbsoluteReportPath(value);
  if (Array.isArray(value)) return value.some((entry) => containsAbsoluteReportPath(entry));
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value).some((entry) => containsAbsoluteReportPath(entry));
}

function canonicalizeValue(rootDir: string, value: unknown): unknown {
  if (typeof value === "string") return isAbsoluteReportPath(value) ? canonicalReportPath(rootDir, value) : value;
  if (Array.isArray(value)) return value.map((entry) => canonicalizeValue(rootDir, entry));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, canonicalizeValue(rootDir, entry)]));
}

function isAbsoluteReportPath(value: string): boolean {
  return isAbsolute(value) || /^[A-Za-z]:[\\/]/u.test(value);
}

function canonicalReportPath(rootDir: string, path: string): string {
  // Windows paths cannot be resolved meaningfully on a POSIX host.  They are
  // still rejected as machine-specific rather than copied into evidence.
  if (/^[A-Za-z]:[\\/]/u.test(path)) return `external:windows/${hashBytes(new TextEncoder().encode(path.replaceAll("\\", "/")))}`;
  const absolute = resolve(path);
  const relativePath = relative(rootDir, absolute).replaceAll("\\", "/");
  if (relativePath === "" || (relativePath !== ".." && !relativePath.startsWith("../"))) return relativePath || ".";
  // Keep the same stable dependency-relative namespace used by the input
  // inventory for reads outside the workspace.  No host prefix is retained.
  const named = canonicalInputPath(rootDir, absolute);
  return named.startsWith("external:") ? named : `external:${named}`;
}
