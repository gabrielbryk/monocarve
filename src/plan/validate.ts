/**
 * Plan validation entrypoint.
 *
 * The ordered calls below are intentional: review tools rely on stable issue
 * ordering, while individual rule families live in `validation/` so each can
 * stay small enough to audit independently.
 */

import { resolve } from "node:path";

import { isFirstPartyPackageOwner, isPackageOwner, packageNameMatcher, testKindOf } from "../config.ts";
import { PlanValidationError } from "../errors.ts";
import { isSourceModulePath } from "../util/files.ts";
import { isSha256, stableStringify } from "../util/hash.ts";
import { relativeWorkspacePath } from "../util/paths.ts";
import { readManifest } from "../graph/workspace.ts";
import { PLAN_SCHEMA_VERSION, operationPaths, type ExtractionManifest } from "./manifest.ts";
import { projectedArtifactEvidence } from "./projected-workspace.ts";
import { validateIntegrationTestSuite } from "./validation/integration.ts";
import { validateDonorSurface, validateOperations } from "./validation/operations.ts";
import { Issues, validationResult, type ValidatePlanOptions, type ValidationResult } from "./validation/shared.ts";
import { validatePublicModules, validateTargetProfile } from "./validation/target.ts";

export type { ValidatePlanOptions, ValidationIssue, ValidationResult, ValidationSeverity } from "./validation/shared.ts";

const COMMIT_SUBJECT = /^(?:refactor|fix|feat|chore|test|docs|ci|build|perf|style)(?:\([^)\n]+\))?!?: [^\n]+$/;
const COMMIT_HASH = /^[0-9a-f]{7,64}$/;

export function validatePlan(manifest: ExtractionManifest, options: ValidatePlanOptions): ValidationResult {
  const issues = new Issues();
  const { rootDir } = options;

  if (manifest.schemaVersion !== PLAN_SCHEMA_VERSION) {
    issues.add("schema-version", `manifest schemaVersion must be ${PLAN_SCHEMA_VERSION}`);
    return validationResult(issues);
  }
  validateHeader(manifest, options, issues);

  const containedPath = (path: string, rule: string): boolean => {
    try {
      relativeWorkspacePath(rootDir, path);
      return true;
    } catch (error) {
      issues.add(rule, (error as Error).message, { path });
      return false;
    }
  };
  const source = validateSource(manifest, options, issues, containedPath);
  const target = validateTarget(manifest, options, issues, [...source.files, ...source.assets], containedPath);
  validateDependencies(manifest, options, issues);
  const consumers = validateConsumers(manifest, issues, target.packageName, target.publicModules, containedPath);
  validateMetadata(manifest, issues, containedPath);
  validateOperations(manifest, options, issues, {
    ...source,
    consumers,
    packageName: target.packageName,
    rewriteTargets: new Set([target.packageName, ...target.publicModules.map((module) => module.specifier)]),
    publicSpecifierByDonor: new Map(target.publicModules.map((module) => [module.source, module.specifier])),
    packageRoot: target.packageRoot,
    entrypoint: `${target.packageRoot}/${target.entrypoint}`,
  });
  return validationResult(issues);
}

function validateHeader(manifest: ExtractionManifest, options: ValidatePlanOptions, issues: Issues): void {
  if (!manifest.planId) issues.add("plan-id", "planId must be a non-empty string");
  if (!COMMIT_HASH.test(manifest.baselineCommit ?? "")) issues.add("baseline-commit", "baselineCommit must be a git commit hash");
  if (Number.isNaN(Date.parse(manifest.createdAt ?? ""))) issues.add("created-at", "createdAt must be an ISO date");
  if (!isSha256(manifest.graphDigest ?? "")) issues.add("graph-digest", "graphDigest must be a SHA-256 hash");
  if (!options.config.applications.some((app) => app.name === manifest.application)) {
    issues.add("application", `manifest application ${JSON.stringify(manifest.application)} is not configured`);
  }
}

function validateSource(
  manifest: ExtractionManifest,
  options: ValidatePlanOptions,
  issues: Issues,
  containedPath: (path: string, rule: string) => boolean,
): { readonly files: readonly string[]; readonly tests: readonly string[]; readonly assets: readonly string[]; readonly blobs: Readonly<Record<string, string>> } {
  const files = manifest.source?.files ?? [];
  const tests = manifest.source?.tests ?? [];
  const assets = manifest.source?.assets ?? [];
  const declared = [...files, ...tests, ...assets];
  if (assets.some((asset) => isSourceModulePath(asset, options.config.sourceExtensions))) issues.add("asset-kind", "source.assets must not contain configured source modules");
  if (new Set(declared).size !== declared.length) issues.add("source-uniqueness", "source files, tests, and assets must be unique");
  for (const path of declared) containedPath(path, "source-path");
  if (!options.offline) {
    for (const test of tests) {
      const kind = testKindOf(options.config, test);
      const allowed = manifest.integrationTestSuite ? kind === "integration" || kind === undefined : kind === "unit";
      if (!allowed) issues.add("test-kind", `moved test has an invalid relocation kind: ${test}`, { path: test });
    }
  }
  const sccMembers = Object.values(manifest.source?.sccs ?? {}).flat();
  if (new Set(sccMembers).size !== files.length || sccMembers.some((member) => !files.includes(member))) {
    issues.add("scc-partition", "sccs must partition production source files and exclude tests and assets");
  }
  const blobs = manifest.sourceBlobs ?? {};
  if (Object.keys(blobs).length !== declared.length || declared.some((path) => !(path in blobs))) {
    issues.add("source-blobs", "sourceBlobs must cover every source, test, and asset exactly");
  }
  for (const [path, hash] of Object.entries(blobs)) {
    if (!isSha256(hash)) issues.add("source-blobs", `sourceBlobs.${path} must be a SHA-256 hash`, { path });
  }
  return { files, tests, assets, blobs };
}

function validateTarget(
  manifest: ExtractionManifest,
  options: ValidatePlanOptions,
  issues: Issues,
  files: readonly string[],
  containedPath: (path: string, rule: string) => boolean,
): { readonly packageName: string; readonly packageRoot: string; readonly entrypoint: string; readonly publicModules: NonNullable<ExtractionManifest["target"]["publicModules"]> } {
  const target = manifest.target;
  const packageName = target?.packageName ?? "";
  const packageRoot = target?.packageRoot ?? "";
  const entrypoint = target?.entrypoint ?? "";
  if (!packageNameMatcher(options.config).test(packageName)) {
    issues.add("target-name", `target package ${JSON.stringify(packageName)} does not match the configured pattern`);
  }
  if (!packageRoot || !isPackageOwner(options.config, packageRoot) || packageRoot.includes("..")) {
    issues.add("target-root", "target.packageRoot must be a directory under a configured package root");
  } else {
    containedPath(packageRoot, "target-root");
  }
  if (!entrypoint) issues.add("target-entrypoint", "target.entrypoint must be a non-empty string");
  validateTargetProfile(manifest, options, issues);
  validateIntegrationTestSuite(manifest, options, issues);
  for (const entry of target?.requiredExports ?? []) {
    if (!entry.name || typeof entry.typeOnly !== "boolean") issues.add("target-exports", "each required export needs a name and a boolean typeOnly");
  }
  const publicModules = target?.publicModules ?? [];
  validatePublicModuleShape(publicModules, files, packageName, issues);
  if (!options.offline) validatePublicModules(manifest, options, issues);
  return { packageName, packageRoot, entrypoint, publicModules };
}

function validatePublicModuleShape(
  publicModules: NonNullable<ExtractionManifest["target"]["publicModules"]>,
  files: readonly string[],
  packageName: string,
  issues: Issues,
): void {
  const publicKeys = new Set<string>();
  const publicSources = new Set<string>();
  for (const module of publicModules) {
    if (!files.includes(module.source) || !module.target || !module.specifier.startsWith(`${packageName}/`)) {
      issues.add("target-subpaths", `invalid public module mapping for ${module.source}`, { path: module.source });
    }
    if (!module.exportKey.startsWith("./") || !module.exportTarget.startsWith("./")) {
      issues.add("target-subpaths", `public module paths must be package-relative: ${module.exportKey}`, { path: module.source });
    }
    if (publicKeys.has(module.exportKey) || publicSources.has(module.source)) {
      issues.add("target-subpaths", `duplicate public module mapping: ${module.exportKey}`, { path: module.source });
    }
    if (!Array.isArray(module.requiredExports)) {
      issues.add("target-subpaths", `public module ${module.source} must declare required exports`, { path: module.source });
    } else if (module.requiredExports.some((entry) => !entry.name || typeof entry.typeOnly !== "boolean")) {
      issues.add("target-subpaths", `public module ${module.source} has an invalid required export`, { path: module.source });
    }
    publicKeys.add(module.exportKey);
    publicSources.add(module.source);
  }
}

function validateDependencies(manifest: ExtractionManifest, options: ValidatePlanOptions, issues: Issues): void {
  for (const section of ["runtime", "dev"] as const) {
    for (const [name, version] of Object.entries(manifest.dependencies?.[section] ?? {})) {
      if (!/^[a-zA-Z0-9_.@/-]+$/.test(name) || typeof version !== "string" || version === "") issues.add("dependency", `invalid dependency ${name}`);
      if (isPackageOwner(options.config, name)) issues.add("dependency", `dependency must use a package name, not a directory: ${name}`);
    }
  }
  const references = manifest.dependencies?.packageReferences ?? [];
  if (new Set(references).size !== references.length) issues.add("package-references", "packageReferences must be unique");
  for (const reference of references) {
    if (!isPackageOwner(options.config, reference) && !isFirstPartyPackageOwner(options.config, reference)) {
      issues.add("package-references", `package reference must be a workspace package directory: ${reference}`);
      continue;
    }
    if (!options.offline && !readManifest(resolve(options.rootDir, reference, "package.json"))) {
      issues.add("package-references", `package reference does not exist: ${reference}`);
    }
  }
}

function validateConsumers(
  manifest: ExtractionManifest,
  issues: Issues,
  packageName: string,
  publicModules: NonNullable<ExtractionManifest["target"]["publicModules"]>,
  containedPath: (path: string, rule: string) => boolean,
): ReadonlySet<string> {
  const consumerFiles = new Set<string>();
  const rewriteTargets = new Set([packageName, ...publicModules.map((module) => module.specifier)]);
  const publicSpecifierByDonor = new Map(publicModules.map((module) => [module.source, module.specifier]));
  for (const consumer of manifest.consumers ?? []) {
    if (!consumer.file) {
      issues.add("consumer", "consumer file must be a non-empty string");
      continue;
    }
    containedPath(consumer.file, "consumer");
    if (consumerFiles.has(consumer.file)) issues.add("consumer", `duplicate consumer ${consumer.file}`);
    consumerFiles.add(consumer.file);
    if (!consumer.expectedImporter) issues.add("consumer", `consumer ${consumer.file} declares no expected importer`);
    if (consumer.dependencySection !== "runtime" && consumer.dependencySection !== "dev") issues.add("consumer", `consumer ${consumer.file} has an invalid dependency section`);
    if (consumer.specifiers.length === 0) issues.add("consumer", `consumer ${consumer.file} declares no rewrite`);
    for (const rewrite of consumer.specifiers) {
      if (!rewriteTargets.has(rewrite.to)) issues.add("consumer", `consumer rewrite must target a declared ${packageName} surface`);
      if (rewrite.from === rewrite.to) issues.add("consumer", `consumer rewrite for ${consumer.file} is a no-op`);
      validateDonorSurface(rewrite, packageName, publicSpecifierByDonor, issues, "consumer", { path: consumer.file });
    }
  }
  return consumerFiles;
}

function validateMetadata(manifest: ExtractionManifest, issues: Issues, containedPath: (path: string, rule: string) => boolean): void {
  const projected = manifest.projectedArtifacts;
  if (projected !== undefined && stableStringify(projected) !== stableStringify(projectedArtifactEvidence(manifest.operations ?? []))) {
    issues.add("projected-artifacts", "projectedArtifacts must exactly describe the final structured operation outputs");
  }
  const decisionKeys = new Set<string>();
  for (const decision of manifest.dependencyDecisions ?? []) {
    const key = `${decision.name}:${decision.decision}`;
    if (decisionKeys.has(key)) issues.add("dependency-evidence", `duplicate dependency decision ${key}`);
    decisionKeys.add(key);
    if (decision.reasons.length === 0) issues.add("dependency-evidence", `dependency decision ${key} has no reason`);
    for (const source of decision.sources) containedPath(source, "dependency-evidence");
    if (decision.decision === "target-runtime" && manifest.dependencies.runtime[decision.name] === undefined) issues.add("dependency-evidence", `${key} is absent from runtime dependencies`);
    if (decision.decision === "target-dev" && manifest.dependencies.dev[decision.name] === undefined) issues.add("dependency-evidence", `${key} is absent from dev dependencies`);
  }
  if (manifest.dependencyDecisions !== undefined) {
    const expected = [
      ...Object.keys(manifest.dependencies.runtime).map((name) => `${name}:target-runtime`),
      ...Object.keys(manifest.dependencies.dev).map((name) => `${name}:target-dev`),
      ...(manifest.donorDependencyPruning?.candidates ?? []).map(({ name }) =>
        `${name}:${manifest.donorDependencyPruning?.mode === "apply" ? "donor-remove" : "donor-review"}`),
    ];
    for (const key of expected) if (!decisionKeys.has(key)) issues.add("dependency-evidence", `missing dependency decision ${key}`);
    if (decisionKeys.size !== expected.length) issues.add("dependency-evidence", "dependency decisions contain an undeclared addition or removal");
  }
  for (const generated of manifest.generatedFiles ?? []) {
    containedPath(generated.path, "generated-file");
    containedPath(generated.source, "generated-file");
    if (!generated.regenerate) issues.add("generated-file", `generated file ${generated.path} declares no regenerate command`);
    if (generated.expectedHash !== undefined && !isSha256(generated.expectedHash)) issues.add("generated-file", `generated file ${generated.path} has an invalid expectedHash`);
    if (generated.expectedHash === undefined && generated.exemptReason === undefined) issues.add("generated-file", `generated file ${generated.path} needs expectedHash or exemptReason`);
  }
  for (const [name, commit] of Object.entries(manifest.commits ?? {})) {
    if (commit && !COMMIT_SUBJECT.test(commit.subject)) issues.add("commit-subject", `invalid Conventional Commit subject for the ${name} commit`);
  }
  for (const tier of ["package", "project", "workspace"] as const) {
    for (const command of manifest.gates?.[tier] ?? []) {
      if (typeof command !== "string" || command.length === 0) issues.add("gates", `gate command in the ${tier} tier must be a non-empty string`);
    }
  }
  const delta = manifest.expectedDynamicImportDelta;
  if (!delta || !Array.isArray(delta.added) || !Array.isArray(delta.removed)) {
    issues.add("dynamic-import-delta", "expectedDynamicImportDelta must declare added and removed arrays");
  }
}

/** Throwing wrapper used by the CLI and by `apply` preflight. */
export function assertPlanValid(manifest: ExtractionManifest, options: ValidatePlanOptions): void {
  const validation = validatePlan(manifest, options);
  if (validation.ok) return;
  const errors = validation.issues.filter((issue) => issue.severity === "error");
  throw new PlanValidationError(
    `plan ${manifest.planId} failed validation with ${errors.length} error(s):\n${errors.map((issue) => `  [${issue.rule}] ${issue.message}`).join("\n")}`,
    errors.map((issue) => issue.message),
  );
}

/** Every path an operation touches — re-exported for callers of the validator. */
export { operationPaths };
