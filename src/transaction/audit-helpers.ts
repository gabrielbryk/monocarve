import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";

import { fileState, sourceFiles } from "../util/files.ts";
import { MISSING, hashBytes } from "../util/hash.ts";
import { relativePosix } from "../util/paths.ts";
import { LEGACY_PLAN_SCHEMA_VERSION, PREVIOUS_PLAN_SCHEMA_VERSION, PLAN_SCHEMA_VERSION, type ExtractionManifest } from "../plan/manifest.ts";
import type { MonocarveConfig } from "../config.ts";
import { showBaseline } from "../util/git.ts";
import type { AuditReport, ProofResult } from "./audit-types.ts";
import { evacuationId } from "../evacuation/candidate.ts";
import { isCompositionRoot } from "../graph/layers.ts";

export function stateAt(root: string, path: string): string {
  return fileState(resolve(root, path));
}

export function textAt(root: string, path: string): string {
  const absolute = resolve(root, path);
  return existsSync(absolute) ? readFileSync(absolute, "utf8") : "";
}

export function firstExportTarget(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(firstExportTarget).find((target) => target !== undefined);
  if (!value || typeof value !== "object") return undefined;
  return ["types", "import", "default", "require"]
    .map((key) => firstExportTarget((value as Record<string, unknown>)[key]))
    .find((target) => target !== undefined);
}

export function repositorySources(config: MonocarveConfig, root: string): string[] {
  return [
    ...config.applications.flatMap((app) => [app.sourceRoot, ...app.consumerRoots]),
    ...config.packageRoots,
    ...config.firstPartyRoots,
    ...config.firstPartyPackages.map((pkg) => pkg.root),
  ]
    .flatMap((directory) => sourceFiles(resolve(root, directory), undefined, [...config.sourceExtensions, ...config.assetExtensions]))
    .map((file) => relativePosix(root, file)).sort();
}

export function relativeCandidates(config: MonocarveConfig, importer: string, specifier: string): string[] {
  const suffixes = ["", ".d.ts", ...config.sourceExtensions, ...config.assetExtensions];
  const base = resolve(dirname(importer), specifier.replace(/[?#].*$/, ""));
  const stripped = /\.[cm]?jsx?$/.test(base) ? base.slice(0, base.length - extname(base).length) : base;
  return [...new Set([base, stripped].flatMap((candidate) => [
    ...suffixes.map((suffix) => candidate + suffix),
      ...config.sourceExtensions.map((suffix) => `${candidate}/index${suffix}`),
  ]))];
}

export function showBaselineHash(rootDir: string, commit: string, path: string): string {
  const text = showBaseline(rootDir, commit, path);
  return text === null ? MISSING : hashBytes(Buffer.from(text, "utf8"));
}

export function unauditableManifest(config: MonocarveConfig, manifest: ExtractionManifest): string[] {
  const value = manifest as unknown as Record<string, unknown>;
  if (value["schemaVersion"] !== LEGACY_PLAN_SCHEMA_VERSION && value["schemaVersion"] !== PREVIOUS_PLAN_SCHEMA_VERSION && value["schemaVersion"] !== PLAN_SCHEMA_VERSION) return [`[schema-version] manifest schemaVersion must be ${LEGACY_PLAN_SCHEMA_VERSION}, ${PREVIOUS_PLAN_SCHEMA_VERSION}, or ${PLAN_SCHEMA_VERSION}`];
  const failures: string[] = [];
  const require = (key: string, ok: boolean, kind: string): void => { if (!ok) failures.push(`[manifest-shape] ${key} must be ${kind}`); };
  const isArray = (key: string): boolean => Array.isArray(value[key]);
  const isRecord = (key: string): boolean => typeof value[key] === "object" && value[key] !== null && !Array.isArray(value[key]);
  if (value["schemaVersion"] === PLAN_SCHEMA_VERSION) require("provenance", isRecord("provenance"), "an object");
  require("baselineCommit", typeof value["baselineCommit"] === "string", "a string");
  require("sourceBlobs", isRecord("sourceBlobs"), "an object"); require("operations", isArray("operations"), "an array");
  require("consumers", isArray("consumers"), "an array"); require("generatedFiles", isArray("generatedFiles"), "an array");
  require("evaluationEffects", isArray("evaluationEffects"), "an array"); require("source", isRecord("source"), "an object");
  if (isRecord("source")) require("source.files", Array.isArray((value["source"] as Record<string, unknown>)["files"]), "an array");
  require("target", isRecord("target"), "an object");
  if (isRecord("target")) {
    const target = value["target"] as Record<string, unknown>;
    require("target.packageRoot", typeof target["packageRoot"] === "string", "a string"); require("target.entrypoint", typeof target["entrypoint"] === "string", "a string");
    require("target.packageName", typeof target["packageName"] === "string", "a string"); require("target.requiredExports", Array.isArray(target["requiredExports"]), "an array");
  }
  require("expectedDynamicImportDelta", isRecord("expectedDynamicImportDelta"), "an object");
  if (isRecord("expectedDynamicImportDelta")) { const delta = value["expectedDynamicImportDelta"] as Record<string, unknown>; require("expectedDynamicImportDelta.added", Array.isArray(delta["added"]), "an array"); require("expectedDynamicImportDelta.removed", Array.isArray(delta["removed"]), "an array"); }
  if (!config.applications.some((app) => app.name === value["application"])) failures.push(`[application] manifest application ${JSON.stringify(value["application"] ?? null)} is not configured`);
  const evacuation = manifest.provenance?.evacuation;
  if (evacuation !== undefined) {
    const sourceFiles = isRecord("source") && Array.isArray((value["source"] as Record<string, unknown>)["files"])
      ? (value["source"] as { files: string[] }).files
      : [];
    const included = evacuation.includedCompositionRoots ?? [];
    const application = config.applications.find((entry) => entry.name === manifest.application);
    const canonical = (paths: readonly string[]): boolean => new Set(paths).size === paths.length
      && paths.every((path, index) => index === 0 || path > paths[index - 1]!);
    if (!canonical(included)) failures.push("[composition-inclusion] included composition roots must be sorted and unique");
    for (const root of included) {
      if (!isCompositionRoot(config, root)) failures.push(`[composition-inclusion] included path is not an exact configured composition root: ${root}`);
      if (application !== undefined && root !== application.sourceRoot && !root.startsWith(`${application.sourceRoot}/`)) failures.push(`[composition-inclusion] included composition root crosses application ${JSON.stringify(manifest.application)}: ${root}`);
      if (!evacuation.requested.includes(root)) failures.push(`[composition-inclusion] included composition root is outside the selected evacuation: ${root}`);
      if (!sourceFiles.includes(root)) failures.push(`[composition-inclusion] included composition root is absent from moved source: ${root}`);
    }
    const expected = evacuationId(
      manifest.application,
      evacuation.requested,
      sourceFiles,
      evacuation.retainedComposition.length === 0 ? [] : [{ id: "provenance", members: evacuation.retainedComposition }],
      evacuation.authorizedProtectedRoots,
      included,
    );
    if (evacuation.id !== expected || (manifest.planId !== expected && !manifest.planId.startsWith(`${expected}--`))) failures.push("[evacuation-identity] plan identity does not match canonical evacuation provenance");
  }
  return failures;
}

export function unauditableReport(manifest: ExtractionManifest, rootDir: string, failures: readonly string[]): AuditReport {
  const notRun: ProofResult = { passed: false, checked: 0, failures: [] };
  const value = manifest as unknown as Record<string, unknown>; const text = (key: string): string => typeof value[key] === "string" ? value[key] as string : "";
  return { planId: text("planId"), baselineCommit: text("baselineCommit"), auditedRoot: rootDir, passed: false, byteFidelity: notRun, consumerCompleteness: notRun, boundaryRules: notRun, externalConsumerCompile: notRun, codemodReplay: notRun, entrypointClosure: notRun, lockfileIntegrity: notRun, generatedArtifacts: notRun, sourceConservation: { ...notRun, plannedFiles: 0, plannedTests: 0, plannedAssets: 0, landedFiles: 0, landedTests: 0, landedAssets: 0 }, graphEvidence: { dynamicImportDelta: { added: [], removed: [] }, movedPathEdges: [], passed: false }, failures: [...failures], unauditable: [...failures] };
}
