import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { LoadedConfig } from "../config.ts";
import type { ScanReport } from "../graph/build.ts";
import { executableBuildIdentity } from "../build-identity.ts";
import { byCodeUnit, hashJson, stableStringify } from "../util/hash.ts";
import { EvidenceError, publishEvidence, readEvidenceManifest, validateBundle, type EvidenceArtifactRecord, type EvidenceManifestBase, type PublishEvidenceOptions, type PublishEvidenceResult } from "./evidence.ts";
import { inventoryBodyDigest, type AssessmentInputInventory } from "./input-inventory.ts";
import { canonicalizeScanReport, containsAbsoluteReportPath } from "./report-paths.ts";
import { qualifyAssessment, type AssessmentQualification } from "./qualification.ts";
import { deriveAssessmentReports, type AssessmentReports } from "./reports.ts";
import { AssessmentQualificationError, replayAssessmentSnapshot, runtimeIdentity, type AssessmentBaselineIdentity, type AssessmentSnapshot } from "./snapshot.ts";
import type { DeclarationBatchResult } from "./batch.ts";

export interface AssessmentAnalyticalArguments {
  readonly application: string;
  readonly limit: number;
  readonly fullPortfolio: boolean;
  readonly splitSelection: { readonly mode: "none" } | { readonly mode: "files"; readonly paths: readonly string[] } | { readonly mode: "hotspots"; readonly count: number };
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

const CORE_ASSESSMENT_ARTIFACTS = ["summary.json", "layers.json", "hotspots.json", "portfolio.json", "backlog.json", "findings.md", "input-inventory.json"] as const;
const FULL_PORTFOLIO_PATH = "portfolio-full.json";

export function assessmentArtifacts(snapshot: AssessmentSnapshot, reports: AssessmentReports, batch?: DeclarationBatchResult): Record<string, string> {
  const artifacts: Record<string, string> = {
    "summary.json": json(reports.summary), "layers.json": json({ schemaVersion: 1, baseline: snapshot.baseline, report: reports.layers }),
    "hotspots.json": json({ schemaVersion: 1, baseline: snapshot.baseline, result: reports.hotspots }),
    "portfolio.json": json({ schemaVersion: 1, baseline: snapshot.baseline, result: reports.portfolio }),
    "backlog.json": json({ schemaVersion: 1, baseline: snapshot.baseline, result: reports.backlog }),
    "findings.md": assessmentFindings(reports.findings, batch),
    "input-inventory.json": json(snapshot.inputInventory),
  };
  if (reports.fullPortfolio !== undefined) artifacts["portfolio-full.json"] = json({ schemaVersion: 1, baseline: snapshot.baseline, result: reports.fullPortfolio });
  const rawReports = rawReportPaths(Object.keys(snapshot.reports));
  for (const [application, report] of Object.entries(snapshot.reports).sort(([left], [right]) => byCodeUnit(left, right))) artifacts[rawReports[application]!] = json(canonicalizeScanReport(snapshot.rootDir, report));
  if (batch !== undefined) appendAssessmentBatchArtifacts(artifacts, snapshot.baseline, batch);
  return artifacts;
}

function assessmentFindings(findings: string, batch: DeclarationBatchResult | undefined): string {
  if (batch === undefined || findings.includes("## Declaration splits")) return findings;
  const overview = batch.aggregate.entries.length === 0 ? "No analyzable split targets were selected."
    : batch.aggregate.entries.map((entry) => `- ${entry.sourcePath}: ${entry.declarationCount} declarations, ${entry.splitCandidateCount} candidates`).join("\n");
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
    rootDir: input.snapshot.rootDir, destination: input.destination, analyticalRoots: input.analyticalRoots,
    artifacts, requiredArtifacts: new Set(Object.keys(artifacts).filter((path) => path !== FULL_PORTFOLIO_PATH)),
    manifest: (_records: readonly EvidenceArtifactRecord[]) => ({
      kind: "architecture-assessment", analyticalArguments: input.arguments, baseline: input.snapshot.baseline,
      qualification: input.snapshot.qualification, provenance: { capture: "live", invocation: input.snapshot.mode },
      rawReports: rawReportPaths(Object.keys(input.snapshot.reports)),
      overrides: input.snapshot.qualification.overrides, omissions,
    }),
    verifyBeforeRename: (paths) => input.snapshot.verify([paths.stage, paths.backup, paths.recovery, paths.lock]),
    ...(input.testPhaseHook === undefined ? {} : { testPhaseHook: input.testPhaseHook }),
    ...(input.replaceGenerated ? { replaceGenerated: true } : {}), ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
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
    "batch-aggregate.json": json(input.batch.aggregate), "input-inventory.json": json(input.snapshot.inputInventory),
  };
  const rawReports = rawReportPaths(Object.keys(input.snapshot.reports));
  for (const [application, report] of Object.entries(input.snapshot.reports).sort(([left], [right]) => byCodeUnit(left, right))) artifacts[rawReports[application]!] = json(canonicalizeScanReport(input.snapshot.rootDir, report));
  for (const [path, report] of Object.entries(input.batch.reports).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    artifacts[path] = json({ schemaVersion: 1, baseline: input.snapshot.baseline, report });
  }
  const sourceHashes = Object.fromEntries(input.batch.aggregate.entries
    .map((entry): [string, string] => [entry.sourcePath, entry.sourceHash])
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
  return publishEvidence<DeclarationBatchManifest>({
    rootDir: input.snapshot.rootDir, destination: input.destination, analyticalRoots: input.analyticalRoots,
    artifacts, requiredArtifacts: new Set(Object.keys(artifacts)),
    manifest: () => ({
      kind: "declaration-analysis-batch", analyticalArguments: input.arguments, baseline: input.snapshot.baseline,
      qualification: input.snapshot.qualification, provenance: { capture: "live", invocation: input.snapshot.mode },
      rawReports,
      sourceHashes, overrides: input.snapshot.qualification.overrides, omissions: [],
    }),
    verifyBeforeRename: (paths) => input.snapshot.verify([paths.stage, paths.backup, paths.recovery, paths.lock]),
    ...(input.testPhaseHook === undefined ? {} : { testPhaseHook: input.testPhaseHook }),
    ...(input.replaceGenerated ? { replaceGenerated: true } : {}), ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
  });
}

export async function loadReplaySnapshot(input: LoadedConfig & { readonly application: string; readonly bundleDirectory: string; readonly excludedRoots?: readonly string[] }): Promise<AssessmentSnapshot> {
  const bundle = resolve(input.rootDir, input.bundleDirectory);
  const manifest = verifiedReplayManifest(bundle);
  const manifestIssue = assessmentManifestIssue(manifest);
  if (manifestIssue !== undefined) throw replayFatal("ASSESSMENT_REPLAY_PROVENANCE_REQUIRED", `replay assessment manifest is not authoritative: ${manifestIssue}`);
  if (!isAssessmentManifest(manifest) || !isBaseline(manifest.baseline)) throw replayFatal("ASSESSMENT_REPLAY_PROVENANCE_REQUIRED", "replay requires an architecture assessment bundle with a complete baseline");
  const identityIssue = replayIdentityIssue(manifest.baseline);
  if (identityIssue !== undefined) throw replayFatal("ASSESSMENT_REPLAY_INPUT_MISMATCH", identityIssue);
  const artifactIssue = assessmentArtifactContractIssue(bundle, manifest);
  if (artifactIssue !== undefined) throw replayFatal("ASSESSMENT_REPLAY_PROVENANCE_REQUIRED", `replay analytical artifacts are inconsistent: ${artifactIssue}`);
  if (manifest.analyticalArguments.application !== input.application) throw replayFatal("ASSESSMENT_REPLAY_INPUT_MISMATCH", `bundle application is ${manifest.analyticalArguments.application}, not ${input.application}`);
  const configuredApplication = input.config.applications.some((application) => application.name === input.application);
  if (!configuredApplication) throw replayFatal("ASSESSMENT_REPLAY_INPUT_MISMATCH", `replay application ${input.application} is not configured`);
  const rawApplications = Object.keys(manifest.rawReports);
  if (rawApplications.length !== 1 || rawApplications[0] !== input.application) {
    throw replayFatal("ASSESSMENT_REPLAY_INPUT_MISMATCH", "replay raw report mapping does not identify exactly the requested configured application");
  }
  const inventory = replayInventory(bundle);
  if (!isInputInventory(inventory) || inventoryBodyDigest(inventory) !== inventory.digest) throw replayFatal("ASSESSMENT_REPLAY_INPUT_MISMATCH", "replay input inventory digest does not match its serialized body");
  if (inventory.digest !== manifest.baseline.inputDigest || inventory.configDigest !== manifest.baseline.configDigest) throw replayFatal("ASSESSMENT_REPLAY_INPUT_MISMATCH", "replay manifest baseline is not bound to its input inventory");
  const reports = replayReports(bundle, manifest);
  if (reports[input.application] === undefined) throw replayFatal("ASSESSMENT_REPLAY_PROVENANCE_REQUIRED", `bundle has no raw report for ${input.application}`);
  return await replayAssessmentSnapshot({ ...input, inputInventory: inventory, reports, qualification: manifest.qualification, baseline: manifest.baseline, excludedRoots: input.excludedRoots ?? [input.bundleDirectory] });
}

function verifiedReplayManifest(bundle: string): EvidenceManifestBase {
  try {
    const manifest = readEvidenceManifest(bundle);
    validateBundle(bundle, manifest);
    return manifest;
  } catch (error) {
    throw replayFatal("ASSESSMENT_REPLAY_PROVENANCE_REQUIRED", `replay bundle is not a complete verified assessment bundle: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function replayInventory(bundle: string): AssessmentInputInventory {
  try { return parseJson<AssessmentInputInventory>(bundle, "input-inventory.json"); }
  catch (error) { throw replayFatal("ASSESSMENT_REPLAY_PROVENANCE_REQUIRED", `replay input inventory is unreadable: ${error instanceof Error ? error.message : String(error)}`); }
}

function replayReports(bundle: string, manifest: AssessmentManifest): Record<string, ScanReport> {
  const reports: Record<string, ScanReport> = Object.create(null) as Record<string, ScanReport>;
  try {
    for (const [name, path] of Object.entries(manifest.rawReports).sort(([left], [right]) => byCodeUnit(left, right))) {
      const report = parseJson<ScanReport>(bundle, path);
      if (containsAbsoluteReportPath(report)) throw new Error(`${path} contains an absolute path`);
      reports[name] = report;
    }
  } catch (error) {
    throw replayFatal("ASSESSMENT_REPLAY_PROVENANCE_REQUIRED", `replay raw scanner evidence is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  return reports;
}

function replayFatal(code: "ASSESSMENT_REPLAY_PROVENANCE_REQUIRED" | "ASSESSMENT_REPLAY_INPUT_MISMATCH", message: string): AssessmentQualificationError {
  return new AssessmentQualificationError({ schemaVersion: 1, status: "fatal", exitCode: 1, mayPublish: false, overrides: [], diagnostics: [{ code, severity: "error", message, impact: "Replay evidence is not authoritative for the current workspace." }] });
}

function replayIdentityIssue(baseline: AssessmentBaselineIdentity): string | undefined {
  const executable = executableBuildIdentity();
  const runtime = runtimeIdentity();
  if (hashJson(executable) !== hashJson(baseline.executable)) return "replay authority does not match current executable identity";
  if (hashJson(runtime) !== hashJson(baseline.runtime)) return "replay authority does not match current runtime identity";
  return undefined;
}

function isBaseline(value: unknown): value is AssessmentBaselineIdentity {
  if (typeof value !== "object" || value === null) return false;
  const baseline = value as Partial<AssessmentBaselineIdentity>;
  return typeof baseline.sourceCommit === "string" && typeof baseline.inputDigest === "string" && typeof baseline.configDigest === "string" && typeof baseline.graphDigest === "string"
    && typeof baseline.executable === "object" && baseline.executable !== null && typeof baseline.runtime === "object" && baseline.runtime !== null;
}

function isInputInventory(value: unknown): value is AssessmentInputInventory {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const inventory = value as Partial<AssessmentInputInventory>;
  return inventory.schemaVersion === 1 && typeof inventory.sourceCommit === "string" && typeof inventory.configDigest === "string"
    && typeof inventory.digest === "string" && Array.isArray(inventory.entries) && Array.isArray(inventory.directories) && Array.isArray(inventory.dirtyPaths);
}

export function deriveAndPublishAssessment(input: Parameters<typeof publishAssessment>[0]): PublishEvidenceResult<AssessmentManifest> {
  return publishAssessment(input);
}

export function defaultAssessmentArguments(application: string, input: { limit?: number; fullPortfolio?: boolean } = {}): AssessmentAnalyticalArguments {
  return { application, limit: input.limit ?? 20, fullPortfolio: input.fullPortfolio === true, splitSelection: { mode: "none" } };
}

export function reportsForSnapshot(snapshot: AssessmentSnapshot, args: AssessmentAnalyticalArguments, batch?: DeclarationBatchResult): AssessmentReports {
  return deriveAssessmentReports(snapshot, { limit: args.limit, ...(args.fullPortfolio ? { fullPortfolio: true } : {}), ...(batch === undefined ? {} : { batch }) });
}

function isAssessmentManifest(value: EvidenceManifestBase): value is AssessmentManifest {
  const entry = value as Partial<AssessmentManifest>;
  return value.kind === "architecture-assessment" && typeof entry.baseline === "object" && entry.baseline !== null
    && typeof entry.qualification === "object" && entry.qualification !== null && typeof entry.analyticalArguments === "object" && entry.analyticalArguments !== null;
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
  if (input.arguments.application !== input.snapshot.application || input.batch.aggregate.application !== input.snapshot.application) throw bundleContractError("batch application does not match the snapshot");
  if (input.arguments.fullPortfolio || input.arguments.splitSelection.mode === "none") throw bundleContractError("standalone batch arguments must select splits and cannot request portfolio evidence");
  if (input.arguments.splitSelection.mode !== input.batch.aggregate.selection.mode) throw bundleContractError("batch selection provenance disagrees with analytical arguments");
  if (input.batch.aggregate.failed.length > 0) throw bundleContractError("an incomplete declaration batch cannot be published");
  if (stableStringify(input.batch.aggregate.baseline) !== stableStringify(input.snapshot.baseline)) throw bundleContractError("batch baseline does not match the assessment snapshot");
  assertBatchArtifactBindings(input);
  assertBatchSelectionBindings(input);
}

function assertBatchArtifactBindings(input: Parameters<typeof publishDeclarationBatch>[0]): void {
  const reportPaths = Object.keys(input.batch.reports).sort(byCodeUnit);
  const entryPaths = input.batch.aggregate.entries.map((entry) => entry.reportPath).sort(byCodeUnit);
  if (stableStringify(reportPaths) !== stableStringify(entryPaths)) throw bundleContractError("batch aggregate does not bind exactly its detail reports");
  const completed = input.batch.aggregate.entries.map((entry) => entry.sourcePath);
  if (stableStringify(completed) !== stableStringify(input.batch.aggregate.completed)) throw bundleContractError("batch completion provenance does not bind exactly its entries");
  if (input.batch.aggregate.entries.some((entry) => !/^[a-f0-9]{64}$/u.test(entry.sourceHash))) throw bundleContractError("batch source hashes are malformed");
}

function assertBatchSelectionBindings(input: Parameters<typeof publishDeclarationBatch>[0]): void {
  const completed = input.batch.aggregate.entries.map((entry) => entry.sourcePath);
  if (input.arguments.splitSelection.mode === "files" && stableStringify(input.arguments.splitSelection.paths) !== stableStringify(completed)) throw bundleContractError("batch file selection does not bind exactly its completed paths");
  if (input.arguments.splitSelection.mode === "hotspots" && input.arguments.splitSelection.count !== input.batch.aggregate.selection.requested) throw bundleContractError("batch hotspot selection does not bind its requested count");
}

function assessmentManifestIssue(value: EvidenceManifestBase): string | undefined {
  if (!isAssessmentManifest(value)) return "required assessment fields are missing";
  const metadataIssue = assessmentManifestMetadataIssue(value);
  if (metadataIssue !== undefined) return metadataIssue;
  const evidenceIssue = requiredAssessmentEvidenceIssue(value);
  if (evidenceIssue !== undefined) return evidenceIssue;
  return assessmentInventoryPolicyIssue(value);
}

function assessmentManifestMetadataIssue(value: AssessmentManifest): string | undefined {
  if (!isAnalyticalArguments(value.analyticalArguments)) return "analytical arguments are not canonical";
  const rawReportsIssue = rawReportMappingIssue(value);
  if (rawReportsIssue !== undefined) return rawReportsIssue;
  if (!Array.isArray(value.omissions) || !Array.isArray(value.overrides) || value.overrides.some((entry) => typeof entry !== "string")) return "omissions or overrides are malformed";
  if (value.provenance?.capture !== "live" || (value.provenance.invocation !== "live" && value.provenance.invocation !== "replay")) return "capture/replay provenance is malformed";
  const qualificationIssue = manifestQualificationIssue(value);
  if (qualificationIssue !== undefined) return qualificationIssue;
  return undefined;
}

function manifestQualificationIssue(value: AssessmentManifest): string | undefined {
  const qualification = value.qualification as Partial<AssessmentQualification>;
  if (qualification.schemaVersion !== 1 || !Array.isArray(qualification.diagnostics) || !Array.isArray(qualification.overrides)) return "qualification is malformed";
  if (qualification.diagnostics.some((entry) => typeof entry !== "object" || entry === null || typeof entry.code !== "string" || typeof entry.severity !== "string" || typeof entry.message !== "string" || typeof entry.impact !== "string")) return "qualification diagnostics are malformed";
  if (qualification.overrides.some((entry) => entry !== "allow-empty")) return "qualification has an unsupported override";
  const expected = qualifyAssessment({ diagnostics: qualification.diagnostics, ...(qualification.overrides.includes("allow-empty") ? { allowedEmpty: true } : {}) });
  if (stableStringify(qualification) !== stableStringify(expected) || stableStringify(value.overrides) !== stableStringify(expected.overrides)) return "qualification status, diagnostics, or overrides are inconsistent";
  if (!expected.mayPublish) return "a fatal qualification cannot authorize a bundle";
  return undefined;
}

function assessmentArtifactContractIssue(bundle: string, manifest: AssessmentManifest): string | undefined {
  try {
    const summary = parseJson<{ schemaVersion?: number; baseline?: unknown; qualification?: unknown }>(bundle, "summary.json");
    if (summary.schemaVersion !== 1 || stableStringify(summary.baseline) !== stableStringify(manifest.baseline)) return "summary baseline does not match the manifest";
    if (stableStringify(summary.qualification) !== stableStringify(manifest.qualification)) return "summary qualification does not match the manifest";
    for (const path of ["layers.json", "hotspots.json", "portfolio.json", "backlog.json", ...(manifest.analyticalArguments.fullPortfolio ? [FULL_PORTFOLIO_PATH] : [])]) {
      const envelope = parseJson<{ baseline?: unknown }>(bundle, path);
      if (stableStringify(envelope.baseline) !== stableStringify(manifest.baseline)) return `${path} baseline does not match the manifest`;
    }
    for (const path of ["hotspots.json", "portfolio.json", "backlog.json"]) {
      const issue = boundedArtifactIssue(parseJson<{ result?: unknown }>(bundle, path).result, manifest.analyticalArguments.limit);
      if (issue !== undefined) return `${path} ${issue}`;
    }
    if (manifest.analyticalArguments.fullPortfolio) return fullPortfolioArtifactIssue(bundle, manifest.analyticalArguments.limit);
    return undefined;
  } catch (error) {
    return `could not validate analytical artifact envelopes: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function boundedArtifactIssue(result: unknown, expectedLimit: number): string | undefined {
  if (typeof result !== "object" || result === null) return "has no availability result";
  const availability = result as { status?: unknown; value?: unknown };
  if (availability.status === "unavailable") return undefined;
  if (availability.status !== "available" || typeof availability.value !== "object" || availability.value === null) return "has malformed bounded evidence";
  const value = availability.value as { total?: unknown; limit?: unknown; truncated?: unknown; omitted?: unknown; records?: unknown };
  if (!Number.isSafeInteger(value.total) || value.limit !== expectedLimit || !Array.isArray(value.records)) return "limit or record inventory disagrees with analytical arguments";
  const omitted = Number(value.total) - value.records.length;
  if (value.omitted !== omitted || value.truncated !== (omitted > 0) || omitted < 0 || value.records.length > expectedLimit) return "bounded totals and truncation fields are inconsistent";
  return undefined;
}

function fullPortfolioArtifactIssue(bundle: string, limit: number): string | undefined {
  const bounded = parseJson<{ result?: { status?: string; value?: { records?: unknown[] } } }>(bundle, "portfolio.json").result;
  const full = parseJson<{ result?: { status?: string; value?: unknown[] } }>(bundle, FULL_PORTFOLIO_PATH).result;
  if (bounded?.status === "unavailable" || full?.status === "unavailable") return bounded?.status === full?.status ? undefined : "full and bounded portfolio availability disagree";
  if (!Array.isArray(bounded?.value?.records) || !Array.isArray(full?.value)) return "full portfolio evidence is malformed";
  if (stableStringify(bounded.value.records) !== stableStringify(full.value.slice(0, limit))) return "full portfolio does not extend the bounded portfolio deterministically";
  return undefined;
}

function requiredAssessmentEvidenceIssue(value: AssessmentManifest): string | undefined {
  const records = new Map(value.artifacts.map((entry) => [entry.path, entry]));
  for (const path of CORE_ASSESSMENT_ARTIFACTS) if (records.get(path)?.required !== true) return `${path} must be present and required`;
  const raw = value.artifacts.filter((entry) => entry.path.startsWith("raw/") && entry.path.endsWith(".json"));
  if (raw.length === 0 || raw.some((entry) => !entry.required)) return "raw scanner reports must be present and required";
  const splitRequested = value.analyticalArguments.splitSelection.mode !== "none";
  if (splitRequested !== records.has("split-aggregate.json")) return "split aggregate presence disagrees with analytical arguments";
  if (!splitRequested && value.artifacts.some((entry) => entry.path.startsWith("splits/"))) return "split detail presence disagrees with analytical arguments";
  return undefined;
}

function rawReportMappingIssue(value: AssessmentManifest): string | undefined {
  if (typeof value.rawReports !== "object" || value.rawReports === null || Array.isArray(value.rawReports)) return "raw report mapping is missing or malformed";
  const names = Object.keys(value.rawReports).sort(byCodeUnit);
  if (names.some((name) => name.length === 0)) return "raw report mapping contains an empty application name";
  const expected = rawReportPaths(names);
  if (stableStringify(value.rawReports) !== stableStringify(expected)) return "raw report mapping is not canonical or collision-free";
  const rawPaths = value.artifacts.filter((entry) => entry.path.startsWith("raw/") && entry.path.endsWith(".json")).map((entry) => entry.path).sort(byCodeUnit);
  if (stableStringify(rawPaths) !== stableStringify(Object.values(expected).sort(byCodeUnit))) return "raw report mapping does not bind exactly its artifacts";
  return undefined;
}

function assessmentInventoryPolicyIssue(value: AssessmentManifest): string | undefined {
  const records = new Map(value.artifacts.map((entry) => [entry.path, entry]));
  if (!value.artifacts.every((entry) => isAllowedAssessmentArtifact(entry.path))) return "artifact inventory contains an unknown assessment artifact";
  if (value.artifacts.some((entry) => entry.path !== FULL_PORTFOLIO_PATH && !entry.required)) return "only full portfolio evidence may be optional";
  const full = records.get(FULL_PORTFOLIO_PATH);
  if (value.analyticalArguments.fullPortfolio !== (full !== undefined) || full?.required === true) return "full portfolio presence or optionality disagrees with analytical arguments";
  const expectedOmissions = value.analyticalArguments.fullPortfolio ? [] : [fullPortfolioOmission(value.analyticalArguments.application)];
  if (stableStringify(value.omissions) !== stableStringify(expectedOmissions)) return "full portfolio omission recipe is missing or non-canonical";
  return undefined;
}

function isAllowedAssessmentArtifact(path: string): boolean {
  return CORE_ASSESSMENT_ARTIFACTS.includes(path as typeof CORE_ASSESSMENT_ARTIFACTS[number])
    || path === FULL_PORTFOLIO_PATH || path === "split-aggregate.json" || /^raw\/[A-Za-z0-9._-]+\.json$/u.test(path) || /^splits\/[A-Za-z0-9._-]+\.json$/u.test(path);
}

function isAnalyticalArguments(value: unknown): value is AssessmentAnalyticalArguments {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<AssessmentAnalyticalArguments>;
  if (typeof entry.application !== "string" || entry.application.length === 0 || !Number.isSafeInteger(entry.limit) || (entry.limit ?? 0) <= 0 || typeof entry.fullPortfolio !== "boolean") return false;
  return isSplitSelection(entry.splitSelection);
}

function isSplitSelection(selection: AssessmentAnalyticalArguments["splitSelection"] | undefined): boolean {
  if (typeof selection !== "object" || selection === null) return false;
  if (selection.mode === "none") return true;
  if (selection.mode === "hotspots") return Number.isSafeInteger(selection.count) && selection.count > 0;
  return selection.mode === "files" && isCanonicalFileSelection(selection.paths);
}

function isCanonicalFileSelection(paths: readonly string[]): boolean {
  return Array.isArray(paths) && paths.every((path) => typeof path === "string")
    && stableStringify(paths) === stableStringify([...new Set(paths)].sort(byCodeUnit));
}

function fullPortfolioOmission(application: string): AssessmentManifest["omissions"][number] {
  return { kind: "full-portfolio", reason: "default output is bounded", command: `assess --app ${application} --evidence-dir <path> --full-portfolio` };
}

function bundleContractError(message: string): EvidenceError {
  return new EvidenceError("EVIDENCE_REPLACEMENT_REFUSED", `invalid evidence bundle contract: ${message}`);
}

function parseJson<T>(root: string, path: string): T { return JSON.parse(readFileSync(resolve(root, path), "utf8")) as T; }
function json(value: unknown): string { return `${stableStringify(value, 2)}\n`; }
export function rawReportPaths(applications: readonly string[]): Record<string, string> {
  const names = [...new Set(applications)].sort(byCodeUnit);
  if (names.some((name) => name.length === 0)) throw new Error("application names must be non-empty");
  return Object.fromEntries(names.map((name, index) => [name, `raw/application-${index}.json`])) as Record<string, string>;
}
