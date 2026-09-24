import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { byCodeUnit, stableStringify } from "../util/hash.ts";
import type { DeclarationBatchResult } from "./batch.ts";
import {
  EvidenceError,
  publishEvidence,
  type EvidenceArtifactRecord,
  type EvidenceManifestBase,
  type PublishEvidenceOptions,
  type PublishEvidenceResult,
} from "./evidence.ts";
import type { AssessmentQualification } from "./qualification.ts";
import { canonicalizeScanReport } from "./report-paths.ts";
import { deriveAssessmentReports, type AssessmentReports } from "./reports.ts";
import type { AssessmentBaselineIdentity, AssessmentSnapshot } from "./snapshot.ts";

export interface AssessmentAnalyticalArguments {
  readonly application: string;
  readonly limit: number;
  readonly fullPortfolio: boolean;
  readonly splitSelection:
    | { readonly mode: "none" }
    | { readonly mode: "files"; readonly paths: readonly string[] }
    | { readonly mode: "hotspots"; readonly count: number };
}

type PublicationTestPhaseHook = NonNullable<PublishEvidenceOptions<EvidenceManifestBase>["testPhaseHook"]>;

export interface AssessmentManifest extends EvidenceManifestBase {
  readonly kind: "architecture-assessment";
  readonly analyticalArguments: AssessmentAnalyticalArguments;
  readonly baseline: AssessmentBaselineIdentity;
  readonly qualification: AssessmentQualification;
  /** Reversible, collision-free mapping from configured application names to raw report paths. */
  readonly rawReports: Readonly<Record<string, string>>;
  readonly provenance: { readonly capture: "live"; readonly invocation: "live" | "replay" };
  readonly overrides: readonly string[];
  readonly omissions: readonly { readonly kind: string; readonly reason: string; readonly command: string }[];
}

export interface DeclarationBatchManifest extends EvidenceManifestBase {
  readonly kind: "declaration-analysis-batch";
  readonly analyticalArguments: AssessmentAnalyticalArguments;
  readonly baseline: AssessmentBaselineIdentity;
  readonly qualification: AssessmentQualification;
  /** Reversible, collision-free mapping from configured application names to raw report paths. */
  readonly rawReports: Readonly<Record<string, string>>;
  readonly provenance: { readonly capture: "live"; readonly invocation: "live" | "replay" };
  readonly sourceHashes: Readonly<Record<string, string>>;
  readonly overrides: readonly string[];
  readonly omissions: readonly { readonly kind: string; readonly reason: string; readonly command: string }[];
}

/** Assessment artifact paths every published bundle must carry, required. */
export const CORE_ASSESSMENT_ARTIFACTS = [
  "summary.json",
  "layers.json",
  "hotspots.json",
  "portfolio.json",
  "backlog.json",
  "findings.md",
  "input-inventory.json",
] as const;
export const FULL_PORTFOLIO_PATH = "portfolio-full.json";

export function assessmentArtifacts(snapshot: AssessmentSnapshot, reports: AssessmentReports, batch?: DeclarationBatchResult): Record<string, string> {
  const artifacts: Record<string, string> = {
    "summary.json": json(reports.summary),
    "layers.json": json({ schemaVersion: 1, baseline: snapshot.baseline, report: reports.layers }),
    "hotspots.json": json({ schemaVersion: 1, baseline: snapshot.baseline, result: reports.hotspots }),
    "portfolio.json": json({ schemaVersion: 1, baseline: snapshot.baseline, result: reports.portfolio }),
    "backlog.json": json({ schemaVersion: 1, baseline: snapshot.baseline, result: reports.backlog }),
    "findings.md": assessmentFindings(reports.findings, batch),
    "input-inventory.json": json(snapshot.inputInventory),
  };
  if (reports.fullPortfolio !== undefined)
    artifacts["portfolio-full.json"] = json({ schemaVersion: 1, baseline: snapshot.baseline, result: reports.fullPortfolio });
  const rawReports = rawReportPaths(Object.keys(snapshot.reports));
  for (const [application, report] of Object.entries(snapshot.reports).sort(([left], [right]) => byCodeUnit(left, right)))
    artifacts[rawReports[application]!] = json(canonicalizeScanReport(snapshot.rootDir, report));
  if (batch !== undefined) appendAssessmentBatchArtifacts(artifacts, snapshot.baseline, batch);
  return artifacts;
}

function assessmentFindings(findings: string, batch: DeclarationBatchResult | undefined): string {
  if (batch === undefined || findings.includes("## Declaration splits")) return findings;
  const overview =
    batch.aggregate.entries.length === 0
      ? "No analyzable split targets were selected."
      : batch.aggregate.entries
          .map((entry) => `- ${entry.sourcePath}: ${entry.declarationCount} declarations, ${entry.splitCandidateCount} candidates`)
          .join("\n");
  return `${findings.trimEnd()}\n\n## Declaration split overview\n\n${overview}\n`;
}

function appendAssessmentBatchArtifacts(artifacts: Record<string, string>, baseline: AssessmentBaselineIdentity, batch: DeclarationBatchResult): void {
  artifacts["split-aggregate.json"] = json(batch.aggregate);
  for (const [path, report] of Object.entries(batch.reports).sort(([left], [right]) => byCodeUnit(left, right))) {
    artifacts[path] = json({ schemaVersion: 1, baseline, report });
  }
}

export function publishAssessment(input: {
  readonly snapshot: AssessmentSnapshot;
  readonly reports: AssessmentReports;
  readonly destination: string;
  readonly analyticalRoots: readonly string[];
  readonly arguments: AssessmentAnalyticalArguments;
  readonly replaceGenerated?: boolean;
  readonly maxBytes?: number;
  readonly batch?: DeclarationBatchResult;
  /** Test seam for proving snapshot revalidation at publication boundaries. */
  readonly testPhaseHook?: PublicationTestPhaseHook;
}): PublishEvidenceResult<AssessmentManifest> {
  input.snapshot.verify();
  assertAssessmentPublicationContract(input);
  const artifacts = assessmentArtifacts(input.snapshot, input.reports, input.batch);
  // The publication transaction performs the final input check immediately
  // before its rename, after artifact rendering and staging are complete.
  const omissions = input.arguments.fullPortfolio ? [] : [fullPortfolioOmission(input.arguments.application)];
  const result = publishEvidence<AssessmentManifest>({
    rootDir: input.snapshot.rootDir,
    destination: input.destination,
    analyticalRoots: input.analyticalRoots,
    artifacts,
    requiredArtifacts: new Set(Object.keys(artifacts).filter((path) => path !== FULL_PORTFOLIO_PATH)),
    manifest: (_records: readonly EvidenceArtifactRecord[]) => ({
      kind: "architecture-assessment",
      analyticalArguments: input.arguments,
      baseline: input.snapshot.baseline,
      qualification: input.snapshot.qualification,
      provenance: { capture: "live", invocation: input.snapshot.mode },
      rawReports: rawReportPaths(Object.keys(input.snapshot.reports)),
      overrides: input.snapshot.qualification.overrides,
      omissions,
    }),
    verifyBeforeRename: (paths) => input.snapshot.verify([paths.stage, paths.backup, paths.recovery, paths.lock]),
    ...(input.testPhaseHook === undefined ? {} : { testPhaseHook: input.testPhaseHook }),
    ...(input.replaceGenerated ? { replaceGenerated: true } : {}),
    ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
  });
  return result;
}

export function publishDeclarationBatch(input: {
  readonly snapshot: AssessmentSnapshot;
  readonly batch: DeclarationBatchResult;
  readonly destination: string;
  readonly analyticalRoots: readonly string[];
  readonly arguments: AssessmentAnalyticalArguments;
  readonly replaceGenerated?: boolean;
  readonly maxBytes?: number;
  /** Test seam for proving snapshot revalidation at publication boundaries. */
  readonly testPhaseHook?: PublicationTestPhaseHook;
}): PublishEvidenceResult<DeclarationBatchManifest> {
  input.snapshot.verify();
  assertBatchPublicationContract(input);
  const artifacts: Record<string, string> = {
    "batch-aggregate.json": json(input.batch.aggregate),
    "input-inventory.json": json(input.snapshot.inputInventory),
  };
  const rawReports = rawReportPaths(Object.keys(input.snapshot.reports));
  for (const [application, report] of Object.entries(input.snapshot.reports).sort(([left], [right]) => byCodeUnit(left, right)))
    artifacts[rawReports[application]!] = json(canonicalizeScanReport(input.snapshot.rootDir, report));
  for (const [path, report] of Object.entries(input.batch.reports).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
    artifacts[path] = json({ schemaVersion: 1, baseline: input.snapshot.baseline, report });
  }
  const sourceHashes = Object.fromEntries(
    input.batch.aggregate.entries
      .map((entry): [string, string] => [entry.sourcePath, entry.sourceHash])
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
  return publishEvidence<DeclarationBatchManifest>({
    rootDir: input.snapshot.rootDir,
    destination: input.destination,
    analyticalRoots: input.analyticalRoots,
    artifacts,
    requiredArtifacts: new Set(Object.keys(artifacts)),
    manifest: () => ({
      kind: "declaration-analysis-batch",
      analyticalArguments: input.arguments,
      baseline: input.snapshot.baseline,
      qualification: input.snapshot.qualification,
      provenance: { capture: "live", invocation: input.snapshot.mode },
      rawReports,
      sourceHashes,
      overrides: input.snapshot.qualification.overrides,
      omissions: [],
    }),
    verifyBeforeRename: (paths) => input.snapshot.verify([paths.stage, paths.backup, paths.recovery, paths.lock]),
    ...(input.testPhaseHook === undefined ? {} : { testPhaseHook: input.testPhaseHook }),
    ...(input.replaceGenerated ? { replaceGenerated: true } : {}),
    ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
  });
}

export function deriveAndPublishAssessment(input: Parameters<typeof publishAssessment>[0]): PublishEvidenceResult<AssessmentManifest> {
  return publishAssessment(input);
}

export function defaultAssessmentArguments(application: string, input: { limit?: number; fullPortfolio?: boolean } = {}): AssessmentAnalyticalArguments {
  return { application, limit: input.limit ?? 20, fullPortfolio: input.fullPortfolio === true, splitSelection: { mode: "none" } };
}

export function reportsForSnapshot(snapshot: AssessmentSnapshot, args: AssessmentAnalyticalArguments, batch?: DeclarationBatchResult): AssessmentReports {
  return deriveAssessmentReports(snapshot, {
    limit: args.limit,
    ...(args.fullPortfolio ? { fullPortfolio: true } : {}),
    ...(batch === undefined ? {} : { batch }),
  });
}

function assertAssessmentPublicationContract(input: Parameters<typeof publishAssessment>[0]): void {
  const fullPortfolio = input.reports.fullPortfolio !== undefined;
  const hasBatch = input.batch !== undefined;
  if (!isAnalyticalArguments(input.arguments)) throw bundleContractError("analytical arguments are not canonical");
  if (input.arguments.application !== input.snapshot.application) throw bundleContractError("analytical application does not match the snapshot");
  if (input.arguments.fullPortfolio !== fullPortfolio) throw bundleContractError("full-portfolio arguments and generated report disagree");
  if ((input.arguments.splitSelection.mode !== "none") !== hasBatch) throw bundleContractError("split-selection arguments and generated reports disagree");
}

function assertBatchPublicationContract(input: Parameters<typeof publishDeclarationBatch>[0]): void {
  if (!isAnalyticalArguments(input.arguments)) throw bundleContractError("batch analytical arguments are not canonical");
  if (input.arguments.application !== input.snapshot.application || input.batch.aggregate.application !== input.snapshot.application)
    throw bundleContractError("batch application does not match the snapshot");
  if (input.arguments.fullPortfolio || input.arguments.splitSelection.mode === "none")
    throw bundleContractError("standalone batch arguments must select splits and cannot request portfolio evidence");
  if (input.arguments.splitSelection.mode !== input.batch.aggregate.selection.mode)
    throw bundleContractError("batch selection provenance disagrees with analytical arguments");
  if (input.batch.aggregate.failed.length > 0) throw bundleContractError("an incomplete declaration batch cannot be published");
  if (stableStringify(input.batch.aggregate.baseline) !== stableStringify(input.snapshot.baseline))
    throw bundleContractError("batch baseline does not match the assessment snapshot");
  assertBatchArtifactBindings(input);
  assertBatchSelectionBindings(input);
}

function assertBatchArtifactBindings(input: Parameters<typeof publishDeclarationBatch>[0]): void {
  const reportPaths = Object.keys(input.batch.reports).sort(byCodeUnit);
  const entryPaths = input.batch.aggregate.entries.map((entry) => entry.reportPath).sort(byCodeUnit);
  if (stableStringify(reportPaths) !== stableStringify(entryPaths)) throw bundleContractError("batch aggregate does not bind exactly its detail reports");
  const completed = input.batch.aggregate.entries.map((entry) => entry.sourcePath);
  if (stableStringify(completed) !== stableStringify(input.batch.aggregate.completed))
    throw bundleContractError("batch completion provenance does not bind exactly its entries");
  if (input.batch.aggregate.entries.some((entry) => !/^[a-f0-9]{64}$/u.test(entry.sourceHash))) throw bundleContractError("batch source hashes are malformed");
}

function assertBatchSelectionBindings(input: Parameters<typeof publishDeclarationBatch>[0]): void {
  const completed = input.batch.aggregate.entries.map((entry) => entry.sourcePath);
  if (input.arguments.splitSelection.mode === "files" && stableStringify(input.arguments.splitSelection.paths) !== stableStringify(completed))
    throw bundleContractError("batch file selection does not bind exactly its completed paths");
  if (input.arguments.splitSelection.mode === "hotspots" && input.arguments.splitSelection.count !== input.batch.aggregate.selection.requested)
    throw bundleContractError("batch hotspot selection does not bind its requested count");
}

export function isAnalyticalArguments(value: unknown): value is AssessmentAnalyticalArguments {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<AssessmentAnalyticalArguments>;
  if (
    typeof entry.application !== "string" ||
    entry.application.length === 0 ||
    !Number.isSafeInteger(entry.limit) ||
    (entry.limit ?? 0) <= 0 ||
    typeof entry.fullPortfolio !== "boolean"
  )
    return false;
  return isSplitSelection(entry.splitSelection);
}

function isSplitSelection(selection: AssessmentAnalyticalArguments["splitSelection"] | undefined): boolean {
  if (typeof selection !== "object" || selection === null) return false;
  if (selection.mode === "none") return true;
  if (selection.mode === "hotspots") return Number.isSafeInteger(selection.count) && selection.count > 0;
  return selection.mode === "files" && isCanonicalFileSelection(selection.paths);
}

function isCanonicalFileSelection(paths: readonly string[]): boolean {
  return (
    Array.isArray(paths) && paths.every((path) => typeof path === "string") && stableStringify(paths) === stableStringify([...new Set(paths)].sort(byCodeUnit))
  );
}

export function fullPortfolioOmission(application: string): AssessmentManifest["omissions"][number] {
  return { kind: "full-portfolio", reason: "default output is bounded", command: `assess --app ${application} --evidence-dir <path> --full-portfolio` };
}

function bundleContractError(message: string): EvidenceError {
  return new EvidenceError("EVIDENCE_REPLACEMENT_REFUSED", `invalid evidence bundle contract: ${message}`);
}

export function parseJson<T>(root: string, path: string): T {
  return JSON.parse(readFileSync(resolve(root, path), "utf8")) as T;
}
function json(value: unknown): string {
  return `${stableStringify(value, 2)}\n`;
}
export function rawReportPaths(applications: readonly string[]): Record<string, string> {
  const names = [...new Set(applications)].sort(byCodeUnit);
  if (names.some((name) => name.length === 0)) throw new Error("application names must be non-empty");
  return Object.fromEntries(names.map((name, index) => [name, `raw/application-${index}.json`])) as Record<string, string>;
}
