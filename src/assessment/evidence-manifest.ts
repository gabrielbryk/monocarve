import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { TOOL_NAME } from "../branding.ts";
import { byCodeUnit, hashBytes } from "../util/hash.ts";
import { listBundleEntries } from "./evidence-cleanup.ts";
import { EvidenceError } from "./evidence-error.ts";
import { entryExists, writeDurable } from "./evidence-fs.ts";
import { systemReason } from "./evidence-paths.ts";
import type { EvidenceArtifactRecord, EvidenceManifestBase } from "./evidence-types.ts";

export function readEvidenceManifest(path: string): EvidenceManifestBase {
  let value: unknown;
  const manifestPath = resolve(path, "manifest.json");
  try {
    const stat = lstatSync(manifestPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("manifest is not a regular file");
    value = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
  } catch (error) {
    throw new EvidenceError("EVIDENCE_REPLACEMENT_REFUSED", `could not read prior manifest: ${systemReason(error)}`);
  }
  if (!isManifest(value)) throw new EvidenceError("EVIDENCE_REPLACEMENT_REFUSED", "prior manifest has an unsupported shape or tool identity");
  return value;
}

export function validateBundle(path: string, manifest: EvidenceManifestBase = readEvidenceManifest(path)): void {
  if (!isManifest(manifest)) throw new EvidenceError("EVIDENCE_REPLACEMENT_REFUSED", "manifest has an unsupported shape or tool identity");
  const rootStat = lstatSync(path, { throwIfNoEntry: false });
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) throw new EvidenceError("EVIDENCE_REPLACEMENT_REFUSED", "bundle is not a regular directory");
  validateArtifactRecords(manifest.artifacts);
  const names = new Set<string>();
  for (const artifact of manifest.artifacts) {
    names.add(artifact.path);
    const absolute = resolve(path, artifact.path);
    const stat = lstatSync(absolute, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.isSymbolicLink())
      throw new EvidenceError("EVIDENCE_REPLACEMENT_REFUSED", `prior artifact is missing or not a regular file: ${artifact.path}`);
    const bytes = readFileSync(absolute);
    if (bytes.byteLength !== artifact.bytes || hashBytes(bytes) !== artifact.sha256)
      throw new EvidenceError("EVIDENCE_REPLACEMENT_REFUSED", `prior artifact does not match its manifest: ${artifact.path}`);
  }
  const disk = listBundleEntries(path, (message) => new EvidenceError("EVIDENCE_REPLACEMENT_REFUSED", message)).filter((entry) => entry !== "manifest.json");
  const expectedDirectories = new Set(
    [...names].flatMap((name) => {
      const parents: string[] = [];
      for (let parent = dirname(name); parent !== "."; parent = dirname(parent)) parents.push(parent.replaceAll("\\", "/"));
      return parents;
    }),
  );
  const unrelated = disk.filter((entry) => !names.has(entry) && !expectedDirectories.has(entry));
  if (unrelated.length > 0) throw new EvidenceError("EVIDENCE_REPLACEMENT_REFUSED", `evidence directory contains unrelated paths: ${unrelated.join(", ")}`);
}

export function writeArtifacts(
  stage: string,
  artifacts: Readonly<Record<string, string | Uint8Array>>,
  required: ReadonlySet<string>,
): EvidenceArtifactRecord[] {
  const paths = Object.keys(artifacts).toSorted(byCodeUnit);
  validateArtifactNames(paths, required);
  return paths.map((path) => {
    const value = artifacts[path]!;
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
    const absolute = resolve(stage, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeDurable(absolute, bytes);
    return { path, bytes: bytes.byteLength, sha256: hashBytes(bytes), required: required.has(path) };
  });
}

export function validateArtifactNames(paths: readonly string[], required: ReadonlySet<string>): void {
  const seen = new Set<string>();
  for (const path of paths) {
    assertArtifactPath(path);
    if (path === "manifest.json") throw new EvidenceError("EVIDENCE_REPLACEMENT_REFUSED", "manifest may not list or hash itself");
    const parent = path
      .split("/")
      .slice(0, -1)
      .reduce((prefix, part) => (prefix === "" ? part : `${prefix}/${part}`), "");
    if (parent !== "" && [...seen].some((entry) => parent === entry || parent.startsWith(`${entry}/`))) {
      throw new EvidenceError("EVIDENCE_REPLACEMENT_REFUSED", `artifact paths collide as file and directory: ${path}`);
    }
    seen.add(path);
  }
  const available = new Set(paths);
  const missing = [...required].filter((path) => !available.has(path)).toSorted(byCodeUnit);
  if (missing.length > 0) throw new EvidenceError("EVIDENCE_REPLACEMENT_REFUSED", `required artifacts were not generated: ${missing.join(", ")}`);
}

function validateArtifactRecords(records: readonly EvidenceArtifactRecord[]): void {
  const paths = records.map((record) => record.path);
  validateArtifactNames(paths, new Set());
  const sorted = [...paths].toSorted(byCodeUnit);
  if (new Set(paths).size !== paths.length) throw new EvidenceError("EVIDENCE_REPLACEMENT_REFUSED", "prior manifest lists duplicate artifact paths");
  if (paths.some((path, index) => path !== sorted[index]))
    throw new EvidenceError("EVIDENCE_REPLACEMENT_REFUSED", "prior manifest artifact inventory is not in canonical order");
  for (const record of records) {
    if (!Number.isSafeInteger(record.bytes) || record.bytes < 0 || !/^[a-f0-9]{64}$/u.test(record.sha256) || typeof record.required !== "boolean") {
      throw new EvidenceError("EVIDENCE_REPLACEMENT_REFUSED", `prior manifest has an invalid artifact record: ${record.path}`);
    }
  }
}

export function validateMaxBytes(max: number | undefined): void {
  if (max !== undefined && (!Number.isSafeInteger(max) || max <= 0)) {
    throw new EvidenceError("EVIDENCE_BUDGET_EXCEEDED", "--max-bytes must be a positive integer");
  }
}

export function enforceBudget(max: number | undefined, total: number, records: readonly EvidenceArtifactRecord[], manifestBytes: number): void {
  if (max === undefined || total <= max) return;
  const largest = [...records.map(({ path, bytes, required }) => ({ path, bytes, required })), { path: "manifest.json", bytes: manifestBytes, required: true }]
    .toSorted((left, right) => right.bytes - left.bytes || byCodeUnit(left.path, right.path))
    .slice(0, 5);
  const required = records.filter((entry) => entry.required).reduce((sum, entry) => sum + entry.bytes, manifestBytes);
  const optional = records
    .filter((entry) => !entry.required)
    .map((entry) => entry.path)
    .toSorted(byCodeUnit);
  const advice =
    required > max || optional.length === 0
      ? "required evidence alone exceeds the budget; no optional omission can satisfy it"
      : `omit only requested optional evidence (${optional.join(", ")}) or increase --max-bytes`;
  throw new EvidenceError(
    "EVIDENCE_BUDGET_EXCEEDED",
    `bundle needs ${total} bytes but budget is ${max}; largest: ${largest.map((entry) => `${entry.path}=${entry.bytes}`).join(", ")}; ${advice}`,
  );
}

export function assertRelativePath(path: string, label: string, code: "EVIDENCE_DESTINATION_UNSAFE" | "EVIDENCE_REPLACEMENT_REFUSED"): void {
  if (
    path.length === 0 ||
    isAbsolute(path) ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new EvidenceError(code, `${label} is not a confined relative path: ${path}`);
  }
}

function assertArtifactPath(path: string): void {
  assertRelativePath(path, "artifact path", "EVIDENCE_REPLACEMENT_REFUSED");
}

function isManifest(value: unknown): value is EvidenceManifestBase {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entry = value as Partial<EvidenceManifestBase>;
  return (
    entry.schemaVersion === 1 &&
    entry.tool === TOOL_NAME &&
    (entry.kind === "architecture-assessment" || entry.kind === "declaration-analysis-batch") &&
    Array.isArray(entry.artifacts) &&
    entry.artifacts.every(
      (artifact) =>
        typeof artifact === "object" &&
        artifact !== null &&
        typeof (artifact as EvidenceArtifactRecord).path === "string" &&
        typeof (artifact as EvidenceArtifactRecord).bytes === "number" &&
        typeof (artifact as EvidenceArtifactRecord).sha256 === "string" &&
        typeof (artifact as EvidenceArtifactRecord).required === "boolean",
    )
  );
}

export function validateIfPresent(path: string, manifest: EvidenceManifestBase): void {
  if (entryExists(resolve(path, "manifest.json"))) validateBundle(path, manifest);
}
