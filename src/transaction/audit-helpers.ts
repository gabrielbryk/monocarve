import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";

import type { MonocarveConfig } from "../config.ts";
import { evacuationId } from "../evacuation/candidate.ts";
import { isCompositionRoot } from "../graph/layers.ts";
import { boundaryBaselineDefects } from "../plan/boundary-baseline.ts";
import { LEGACY_PLAN_SCHEMA_VERSION, PREVIOUS_PLAN_SCHEMA_VERSION, PLAN_SCHEMA_VERSION, type ExtractionManifest } from "../plan/manifest.ts";
import { fileState, sourceFiles } from "../util/files.ts";
import { showBaseline } from "../util/git.ts";
import { MISSING, hashBytes } from "../util/hash.ts";
import { relativePosix } from "../util/paths.ts";
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
    .map((file) => relativePosix(root, file))
    .toSorted();
}

export function relativeCandidates(config: MonocarveConfig, importer: string, specifier: string): string[] {
  const suffixes = ["", ".d.ts", ...config.sourceExtensions, ...config.assetExtensions];
  const base = resolve(dirname(importer), specifier.replace(/[?#].*$/, ""));
  const stripped = /\.[cm]?jsx?$/.test(base) ? base.slice(0, base.length - extname(base).length) : base;
  return [
    ...new Set(
      [base, stripped].flatMap((candidate) => [
        ...suffixes.map((suffix) => candidate + suffix),
        ...config.sourceExtensions.map((suffix) => `${candidate}/index${suffix}`),
      ]),
    ),
  ];
}

export function showBaselineHash(rootDir: string, commit: string, path: string): string {
  const text = showBaseline(rootDir, commit, path);
  return text === null ? MISSING : hashBytes(Buffer.from(text, "utf8"));
}

type ManifestRecord = Record<string, unknown>;
type EvacuationProvenance = NonNullable<NonNullable<ExtractionManifest["provenance"]>["evacuation"]>;

/** One structural requirement; `children` are checked only when the field is itself an object. */
interface FieldRule {
  readonly key: string;
  readonly check: (value: unknown) => boolean;
  readonly kind: string;
  readonly children?: readonly FieldRule[];
}

const isRecordValue = (value: unknown): value is ManifestRecord => typeof value === "object" && value !== null && !Array.isArray(value);
const isArrayValue = (value: unknown): boolean => Array.isArray(value);
const isStringValue = (value: unknown): boolean => typeof value === "string";

const objectField = (key: string, children?: readonly FieldRule[]): FieldRule => ({
  key,
  check: isRecordValue,
  kind: "an object",
  ...(children ? { children } : {}),
});
const arrayField = (key: string): FieldRule => ({ key, check: isArrayValue, kind: "an array" });
const stringField = (key: string): FieldRule => ({ key, check: isStringValue, kind: "a string" });

/** Checked in this order, so failures read in manifest order. */
const MANIFEST_SHAPE: readonly FieldRule[] = [
  stringField("baselineCommit"),
  objectField("sourceBlobs"),
  arrayField("operations"),
  arrayField("consumers"),
  arrayField("generatedFiles"),
  arrayField("evaluationEffects"),
  objectField("source", [arrayField("files")]),
  objectField("target", [stringField("packageRoot"), stringField("entrypoint"), stringField("packageName"), arrayField("requiredExports")]),
  objectField("expectedDynamicImportDelta", [arrayField("added"), arrayField("removed")]),
];

function checkFields(record: ManifestRecord, prefix: string, rules: readonly FieldRule[], failures: string[]): void {
  for (const rule of rules) {
    const field = record[rule.key];
    if (!rule.check(field)) failures.push(`[manifest-shape] ${prefix}${rule.key} must be ${rule.kind}`);
    if (rule.children !== undefined && isRecordValue(field)) checkFields(field, `${prefix}${rule.key}.`, rule.children, failures);
  }
}

function isSupportedSchema(value: ManifestRecord): boolean {
  const version = value["schemaVersion"];
  return version === LEGACY_PLAN_SCHEMA_VERSION || version === PREVIOUS_PLAN_SCHEMA_VERSION || version === PLAN_SCHEMA_VERSION;
}

function manifestShapeFailures(value: ManifestRecord): string[] {
  const failures: string[] = [];
  if (value["schemaVersion"] === PLAN_SCHEMA_VERSION) checkFields(value, "", [objectField("provenance")], failures);
  checkFields(value, "", MANIFEST_SHAPE, failures);
  return failures;
}

function isMalformedBoundaryEdge(edge: unknown): boolean {
  return (
    typeof edge !== "object" ||
    edge === null ||
    typeof (edge as { file?: unknown }).file !== "string" ||
    typeof (edge as { target?: unknown }).target !== "string"
  );
}

// A recorded baseline is the one manifest field that makes the audit accept
// something, so an unreadable one must stop the audit rather than be treated
// as an empty set — which would silently turn a widened baseline into a
// strict run whose failures nobody expected, or an empty one into no proof.
function boundaryBaselineFailures(value: ManifestRecord, manifest: ExtractionManifest): string[] {
  if (!("boundaryBaseline" in value)) return [];
  const record = value["boundaryBaseline"];
  if (!isRecordValue(record) || !Array.isArray(record["edges"]) || typeof record["digest"] !== "string")
    return ["[boundary-baseline] boundaryBaseline must be an object with a digest and an edges array"];
  if (record["edges"].some(isMalformedBoundaryEdge)) return ["[boundary-baseline] every recorded boundary edge must carry a file and a target string"];
  return boundaryBaselineDefects(manifest.boundaryBaseline).map((defect) => `[boundary-baseline] ${defect}`);
}

function movedSourceFiles(value: ManifestRecord): string[] {
  const source = value["source"];
  return isRecordValue(source) && Array.isArray(source["files"]) ? (source as { files: string[] }).files : [];
}

function isCanonicalPathList(paths: readonly string[]): boolean {
  return new Set(paths).size === paths.length && paths.every((path, index) => index === 0 || path > paths[index - 1]!);
}

function compositionRootFailures(
  config: MonocarveConfig,
  manifest: ExtractionManifest,
  evacuation: EvacuationProvenance,
  movedFiles: readonly string[],
  root: string,
): string[] {
  const failures: string[] = [];
  const application = config.applications.find((entry) => entry.name === manifest.application);
  if (!isCompositionRoot(config, root)) failures.push(`[composition-inclusion] included path is not an exact configured composition root: ${root}`);
  if (application !== undefined && root !== application.sourceRoot && !root.startsWith(`${application.sourceRoot}/`))
    failures.push(`[composition-inclusion] included composition root crosses application ${JSON.stringify(manifest.application)}: ${root}`);
  if (!evacuation.requested.includes(root)) failures.push(`[composition-inclusion] included composition root is outside the selected evacuation: ${root}`);
  if (!movedFiles.includes(root)) failures.push(`[composition-inclusion] included composition root is absent from moved source: ${root}`);
  return failures;
}

function evacuationIdentityMatches(
  manifest: ExtractionManifest,
  evacuation: EvacuationProvenance,
  movedFiles: readonly string[],
  included: readonly string[],
): boolean {
  const expected = evacuationId(
    manifest.application,
    evacuation.requested,
    movedFiles,
    evacuation.retainedComposition.length === 0 ? [] : [{ id: "provenance", members: evacuation.retainedComposition }],
    evacuation.authorizedProtectedRoots,
    included,
  );
  return evacuation.id === expected && (manifest.planId === expected || manifest.planId.startsWith(`${expected}--`));
}

function evacuationFailures(config: MonocarveConfig, manifest: ExtractionManifest, value: ManifestRecord): string[] {
  const evacuation = manifest.provenance?.evacuation;
  if (evacuation === undefined) return [];
  const movedFiles = movedSourceFiles(value);
  const included = evacuation.includedCompositionRoots ?? [];
  const failures: string[] = [];
  if (!isCanonicalPathList(included)) failures.push("[composition-inclusion] included composition roots must be sorted and unique");
  for (const root of included) failures.push(...compositionRootFailures(config, manifest, evacuation, movedFiles, root));
  if (!evacuationIdentityMatches(manifest, evacuation, movedFiles, included))
    failures.push("[evacuation-identity] plan identity does not match canonical evacuation provenance");
  return failures;
}

export function unauditableManifest(config: MonocarveConfig, manifest: ExtractionManifest): string[] {
  const value = manifest as unknown as ManifestRecord;
  if (!isSupportedSchema(value))
    return [`[schema-version] manifest schemaVersion must be ${LEGACY_PLAN_SCHEMA_VERSION}, ${PREVIOUS_PLAN_SCHEMA_VERSION}, or ${PLAN_SCHEMA_VERSION}`];
  const failures = manifestShapeFailures(value);
  if (!config.applications.some((app) => app.name === value["application"]))
    failures.push(`[application] manifest application ${JSON.stringify(value["application"] ?? null)} is not configured`);
  failures.push(...boundaryBaselineFailures(value, manifest), ...evacuationFailures(config, manifest, value));
  return failures;
}

export function unauditableReport(manifest: ExtractionManifest, rootDir: string, failures: readonly string[]): AuditReport {
  const notRun: ProofResult = { passed: false, checked: 0, failures: [] };
  const value = manifest as unknown as Record<string, unknown>;
  const text = (key: string): string => (typeof value[key] === "string" ? (value[key] as string) : "");
  return {
    planId: text("planId"),
    baselineCommit: text("baselineCommit"),
    auditedRoot: rootDir,
    passed: false,
    byteFidelity: notRun,
    consumerCompleteness: notRun,
    boundaryRules: notRun,
    externalConsumerCompile: notRun,
    codemodReplay: notRun,
    entrypointClosure: notRun,
    lockfileIntegrity: notRun,
    generatedArtifacts: notRun,
    sourceConservation: { ...notRun, plannedFiles: 0, plannedTests: 0, plannedAssets: 0, landedFiles: 0, landedTests: 0, landedAssets: 0 },
    boundaryBaseline: { recorded: Array.isArray(manifest.boundaryBaseline?.edges) ? manifest.boundaryBaseline.edges.length : 0, observed: [], cleared: [] },
    graphEvidence: { dynamicImportDelta: { added: [], removed: [] }, movedPathEdges: [], passed: false },
    failures: [...failures],
    unauditable: [...failures],
  };
}
