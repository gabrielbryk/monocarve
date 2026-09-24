import { resolve } from "node:path";

import { executableBuildIdentity } from "../build-identity.ts";
import type { LoadedConfig } from "../config.ts";
import type { ScanReport } from "../graph/build.ts";
import { byCodeUnit, hashJson, stableStringify } from "../util/hash.ts";
import {
  CORE_ASSESSMENT_ARTIFACTS,
  FULL_PORTFOLIO_PATH,
  fullPortfolioOmission,
  isAnalyticalArguments,
  parseJson,
  rawReportPaths,
  type AssessmentManifest,
} from "./bundle.ts";
import { readEvidenceManifest, validateBundle, type EvidenceManifestBase } from "./evidence.ts";
import { inventoryBodyDigest, type AssessmentInputInventory } from "./input-inventory.ts";
import { qualifyAssessment, type AssessmentQualification } from "./qualification.ts";
import { containsAbsoluteReportPath } from "./report-paths.ts";
import {
  AssessmentQualificationError,
  replayAssessmentSnapshot,
  runtimeIdentity,
  type AssessmentBaselineIdentity,
  type AssessmentSnapshot,
} from "./snapshot.ts";

export async function loadReplaySnapshot(
  input: LoadedConfig & { readonly application: string; readonly bundleDirectory: string; readonly excludedRoots?: readonly string[] },
): Promise<AssessmentSnapshot> {
  const bundle = resolve(input.rootDir, input.bundleDirectory);
  const manifest = verifiedReplayManifest(bundle);
  const manifestIssue = assessmentManifestIssue(manifest);
  if (manifestIssue !== undefined)
    throw replayFatal("ASSESSMENT_REPLAY_PROVENANCE_REQUIRED", `replay assessment manifest is not authoritative: ${manifestIssue}`);
  if (!isAssessmentManifest(manifest) || !isBaseline(manifest.baseline))
    throw replayFatal("ASSESSMENT_REPLAY_PROVENANCE_REQUIRED", "replay requires an architecture assessment bundle with a complete baseline");
  const identityIssue = replayIdentityIssue(manifest.baseline);
  if (identityIssue !== undefined) throw replayFatal("ASSESSMENT_REPLAY_INPUT_MISMATCH", identityIssue);
  const artifactIssue = assessmentArtifactContractIssue(bundle, manifest);
  if (artifactIssue !== undefined) throw replayFatal("ASSESSMENT_REPLAY_PROVENANCE_REQUIRED", `replay analytical artifacts are inconsistent: ${artifactIssue}`);
  if (manifest.analyticalArguments.application !== input.application)
    throw replayFatal("ASSESSMENT_REPLAY_INPUT_MISMATCH", `bundle application is ${manifest.analyticalArguments.application}, not ${input.application}`);
  const configuredApplication = input.config.applications.some((application) => application.name === input.application);
  if (!configuredApplication) throw replayFatal("ASSESSMENT_REPLAY_INPUT_MISMATCH", `replay application ${input.application} is not configured`);
  const rawApplications = Object.keys(manifest.rawReports);
  if (rawApplications.length !== 1 || rawApplications[0] !== input.application) {
    throw replayFatal("ASSESSMENT_REPLAY_INPUT_MISMATCH", "replay raw report mapping does not identify exactly the requested configured application");
  }
  const inventory = replayInventory(bundle);
  if (!isInputInventory(inventory) || inventoryBodyDigest(inventory) !== inventory.digest)
    throw replayFatal("ASSESSMENT_REPLAY_INPUT_MISMATCH", "replay input inventory digest does not match its serialized body");
  if (inventory.digest !== manifest.baseline.inputDigest || inventory.configDigest !== manifest.baseline.configDigest)
    throw replayFatal("ASSESSMENT_REPLAY_INPUT_MISMATCH", "replay manifest baseline is not bound to its input inventory");
  const reports = replayReports(bundle, manifest);
  if (reports[input.application] === undefined) throw replayFatal("ASSESSMENT_REPLAY_PROVENANCE_REQUIRED", `bundle has no raw report for ${input.application}`);
  return await replayAssessmentSnapshot({
    ...input,
    inputInventory: inventory,
    reports,
    qualification: manifest.qualification,
    baseline: manifest.baseline,
    excludedRoots: input.excludedRoots ?? [input.bundleDirectory],
  });
}

function verifiedReplayManifest(bundle: string): EvidenceManifestBase {
  try {
    const manifest = readEvidenceManifest(bundle);
    validateBundle(bundle, manifest);
    return manifest;
  } catch (error) {
    throw replayFatal(
      "ASSESSMENT_REPLAY_PROVENANCE_REQUIRED",
      `replay bundle is not a complete verified assessment bundle: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function replayInventory(bundle: string): AssessmentInputInventory {
  try {
    return parseJson<AssessmentInputInventory>(bundle, "input-inventory.json");
  } catch (error) {
    throw replayFatal(
      "ASSESSMENT_REPLAY_PROVENANCE_REQUIRED",
      `replay input inventory is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function replayReports(bundle: string, manifest: AssessmentManifest): Record<string, ScanReport> {
  const reports: Record<string, ScanReport> = Object.create(null) as Record<string, ScanReport>;
  try {
    for (const [name, path] of Object.entries(manifest.rawReports).toSorted(([left], [right]) => byCodeUnit(left, right))) {
      const report = parseJson<ScanReport>(bundle, path);
      if (containsAbsoluteReportPath(report)) throw new Error(`${path} contains an absolute path`);
      reports[name] = report;
    }
  } catch (error) {
    throw replayFatal(
      "ASSESSMENT_REPLAY_PROVENANCE_REQUIRED",
      `replay raw scanner evidence is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return reports;
}

function replayFatal(code: "ASSESSMENT_REPLAY_PROVENANCE_REQUIRED" | "ASSESSMENT_REPLAY_INPUT_MISMATCH", message: string): AssessmentQualificationError {
  return new AssessmentQualificationError({
    schemaVersion: 1,
    status: "fatal",
    exitCode: 1,
    mayPublish: false,
    overrides: [],
    diagnostics: [{ code, severity: "error", message, impact: "Replay evidence is not authoritative for the current workspace." }],
  });
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
  return (
    typeof baseline.sourceCommit === "string" &&
    typeof baseline.inputDigest === "string" &&
    typeof baseline.configDigest === "string" &&
    typeof baseline.graphDigest === "string" &&
    typeof baseline.executable === "object" &&
    baseline.executable !== null &&
    typeof baseline.runtime === "object" &&
    baseline.runtime !== null
  );
}

function isInputInventory(value: unknown): value is AssessmentInputInventory {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const inventory = value as Partial<AssessmentInputInventory>;
  return (
    inventory.schemaVersion === 1 &&
    typeof inventory.sourceCommit === "string" &&
    typeof inventory.configDigest === "string" &&
    typeof inventory.digest === "string" &&
    Array.isArray(inventory.entries) &&
    Array.isArray(inventory.directories) &&
    Array.isArray(inventory.dirtyPaths)
  );
}

function isAssessmentManifest(value: EvidenceManifestBase): value is AssessmentManifest {
  const entry = value as Partial<AssessmentManifest>;
  return (
    value.kind === "architecture-assessment" &&
    typeof entry.baseline === "object" &&
    entry.baseline !== null &&
    typeof entry.qualification === "object" &&
    entry.qualification !== null &&
    typeof entry.analyticalArguments === "object" &&
    entry.analyticalArguments !== null
  );
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
  if (!Array.isArray(value.omissions) || !Array.isArray(value.overrides) || value.overrides.some((entry) => typeof entry !== "string"))
    return "omissions or overrides are malformed";
  if (value.provenance?.capture !== "live" || (value.provenance.invocation !== "live" && value.provenance.invocation !== "replay"))
    return "capture/replay provenance is malformed";
  const qualificationIssue = manifestQualificationIssue(value);
  if (qualificationIssue !== undefined) return qualificationIssue;
  return undefined;
}

function manifestQualificationIssue(value: AssessmentManifest): string | undefined {
  const qualification = value.qualification as Partial<AssessmentQualification>;
  if (qualification.schemaVersion !== 1 || !Array.isArray(qualification.diagnostics) || !Array.isArray(qualification.overrides))
    return "qualification is malformed";
  if (
    qualification.diagnostics.some(
      (entry) =>
        typeof entry !== "object" ||
        entry === null ||
        typeof entry.code !== "string" ||
        typeof entry.severity !== "string" ||
        typeof entry.message !== "string" ||
        typeof entry.impact !== "string",
    )
  )
    return "qualification diagnostics are malformed";
  if (qualification.overrides.some((entry) => entry !== "allow-empty")) return "qualification has an unsupported override";
  const expected = qualifyAssessment({
    diagnostics: qualification.diagnostics,
    ...(qualification.overrides.includes("allow-empty") ? { allowedEmpty: true } : {}),
  });
  if (stableStringify(qualification) !== stableStringify(expected) || stableStringify(value.overrides) !== stableStringify(expected.overrides))
    return "qualification status, diagnostics, or overrides are inconsistent";
  if (!expected.mayPublish) return "a fatal qualification cannot authorize a bundle";
  return undefined;
}

function assessmentArtifactContractIssue(bundle: string, manifest: AssessmentManifest): string | undefined {
  try {
    const summary = parseJson<{ schemaVersion?: number; baseline?: unknown; qualification?: unknown }>(bundle, "summary.json");
    if (summary.schemaVersion !== 1 || stableStringify(summary.baseline) !== stableStringify(manifest.baseline))
      return "summary baseline does not match the manifest";
    if (stableStringify(summary.qualification) !== stableStringify(manifest.qualification)) return "summary qualification does not match the manifest";
    for (const path of [
      "layers.json",
      "hotspots.json",
      "portfolio.json",
      "backlog.json",
      ...(manifest.analyticalArguments.fullPortfolio ? [FULL_PORTFOLIO_PATH] : []),
    ]) {
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
  if (!Number.isSafeInteger(value.total) || value.limit !== expectedLimit || !Array.isArray(value.records))
    return "limit or record inventory disagrees with analytical arguments";
  const omitted = Number(value.total) - value.records.length;
  if (value.omitted !== omitted || value.truncated !== omitted > 0 || omitted < 0 || value.records.length > expectedLimit)
    return "bounded totals and truncation fields are inconsistent";
  return undefined;
}

function fullPortfolioArtifactIssue(bundle: string, limit: number): string | undefined {
  const bounded = parseJson<{ result?: { status?: string; value?: { records?: unknown[] } } }>(bundle, "portfolio.json").result;
  const full = parseJson<{ result?: { status?: string; value?: unknown[] } }>(bundle, FULL_PORTFOLIO_PATH).result;
  if (bounded?.status === "unavailable" || full?.status === "unavailable")
    return bounded?.status === full?.status ? undefined : "full and bounded portfolio availability disagree";
  if (!Array.isArray(bounded?.value?.records) || !Array.isArray(full?.value)) return "full portfolio evidence is malformed";
  if (stableStringify(bounded.value.records) !== stableStringify(full.value.slice(0, limit)))
    return "full portfolio does not extend the bounded portfolio deterministically";
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
  const names = Object.keys(value.rawReports).toSorted(byCodeUnit);
  if (names.some((name) => name.length === 0)) return "raw report mapping contains an empty application name";
  const expected = rawReportPaths(names);
  if (stableStringify(value.rawReports) !== stableStringify(expected)) return "raw report mapping is not canonical or collision-free";
  const rawPaths = value.artifacts
    .filter((entry) => entry.path.startsWith("raw/") && entry.path.endsWith(".json"))
    .map((entry) => entry.path)
    .toSorted(byCodeUnit);
  if (stableStringify(rawPaths) !== stableStringify(Object.values(expected).toSorted(byCodeUnit))) return "raw report mapping does not bind exactly its artifacts";
  return undefined;
}

function assessmentInventoryPolicyIssue(value: AssessmentManifest): string | undefined {
  const records = new Map(value.artifacts.map((entry) => [entry.path, entry]));
  if (!value.artifacts.every((entry) => isAllowedAssessmentArtifact(entry.path))) return "artifact inventory contains an unknown assessment artifact";
  if (value.artifacts.some((entry) => entry.path !== FULL_PORTFOLIO_PATH && !entry.required)) return "only full portfolio evidence may be optional";
  const full = records.get(FULL_PORTFOLIO_PATH);
  if (value.analyticalArguments.fullPortfolio !== (full !== undefined) || full?.required === true)
    return "full portfolio presence or optionality disagrees with analytical arguments";
  const expectedOmissions = value.analyticalArguments.fullPortfolio ? [] : [fullPortfolioOmission(value.analyticalArguments.application)];
  if (stableStringify(value.omissions) !== stableStringify(expectedOmissions)) return "full portfolio omission recipe is missing or non-canonical";
  return undefined;
}

function isAllowedAssessmentArtifact(path: string): boolean {
  return (
    CORE_ASSESSMENT_ARTIFACTS.includes(path as (typeof CORE_ASSESSMENT_ARTIFACTS)[number]) ||
    path === FULL_PORTFOLIO_PATH ||
    path === "split-aggregate.json" ||
    /^raw\/[A-Za-z0-9._-]+\.json$/u.test(path) ||
    /^splits\/[A-Za-z0-9._-]+\.json$/u.test(path)
  );
}
