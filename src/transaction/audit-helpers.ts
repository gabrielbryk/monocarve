import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";

import { fileState, sourceFiles } from "../util/files.ts";
import { MISSING, hashBytes } from "../util/hash.ts";
import { relativePosix } from "../util/paths.ts";
import { PLAN_SCHEMA_VERSION, type ExtractionManifest } from "../plan/manifest.ts";
import type { MonocarveConfig } from "../config.ts";
import { showBaseline } from "../util/git.ts";
import type { AuditReport, ProofResult } from "./audit-types.ts";

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
  if (value["schemaVersion"] !== PLAN_SCHEMA_VERSION) return [`[schema-version] manifest schemaVersion must be ${PLAN_SCHEMA_VERSION}`];
  const failures: string[] = [];
  const require = (key: string, ok: boolean, kind: string): void => { if (!ok) failures.push(`[manifest-shape] ${key} must be ${kind}`); };
  const isArray = (key: string): boolean => Array.isArray(value[key]);
  const isRecord = (key: string): boolean => typeof value[key] === "object" && value[key] !== null && !Array.isArray(value[key]);
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
  return failures;
}

export function unauditableReport(manifest: ExtractionManifest, rootDir: string, failures: readonly string[]): AuditReport {
  const notRun: ProofResult = { passed: false, checked: 0, failures: [] };
  const value = manifest as unknown as Record<string, unknown>; const text = (key: string): string => typeof value[key] === "string" ? value[key] as string : "";
  return { planId: text("planId"), baselineCommit: text("baselineCommit"), auditedRoot: rootDir, passed: false, byteFidelity: notRun, consumerCompleteness: notRun, boundaryRules: notRun, externalConsumerCompile: notRun, codemodReplay: notRun, entrypointClosure: notRun, lockfileIntegrity: notRun, generatedArtifacts: notRun, sourceConservation: { ...notRun, plannedFiles: 0, plannedTests: 0, plannedAssets: 0, landedFiles: 0, landedTests: 0, landedAssets: 0 }, graphEvidence: { dynamicImportDelta: { added: [], removed: [] }, movedPathEdges: [], passed: false }, failures: [...failures], unauditable: [...failures] };
}
