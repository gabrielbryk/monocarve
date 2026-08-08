/**
 * Plan validation entrypoint.
 *
 * The ordered calls below are intentional: review tools rely on stable issue
 * ordering, while individual rule families live in `validation/` so each can
 * stay small enough to audit independently.
 */

import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";

import { createPackageManagerAdapter, createTaskRunnerAdapter } from "../adapters/registry.ts";
import { getApplication, isFirstPartyPackageOwner, isPackageOwner, packageNameMatcher, resolveExtractionProfile, testKindOf } from "../config.ts";
import { PlanValidationError } from "../errors.ts";
import { isSourceModulePath } from "../util/files.ts";
import { isSha256, stableStringify } from "../util/hash.ts";
import { relativeWorkspacePath } from "../util/paths.ts";
import { readManifest } from "../graph/workspace.ts";
import { LEGACY_PLAN_SCHEMA_VERSION, PREVIOUS_PLAN_SCHEMA_VERSION, PLAN_SCHEMA_VERSION, isSupportedExtractionManifestVersion, operationPaths, type ExtractionManifest } from "./manifest.ts";
import { projectedArtifactEvidence } from "./projected-workspace.ts";
import { buildPlanProvenance } from "./provenance.ts";
import { evacuationId } from "../evacuation/candidate.ts";
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

  if (!isSupportedExtractionManifestVersion(manifest.schemaVersion)) {
    issues.add("schema-version", `manifest schemaVersion must be ${LEGACY_PLAN_SCHEMA_VERSION}, ${PREVIOUS_PLAN_SCHEMA_VERSION}, or ${PLAN_SCHEMA_VERSION}`);
    return validationResult(issues);
  }
  validateHeader(manifest, options, issues);
  validateAssessment(manifest, issues);

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
  validateModulePromotion(manifest, consumers, issues);
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

function validateAssessment(manifest: ExtractionManifest, issues: Issues): void {
  const assessment = manifest.assessment;
  if (assessment === undefined) return;
  if (!["recommended", "review-required", "discouraged"].includes(assessment.status)) issues.add("assessment", "assessment status is invalid");
  if (!["high", "medium", "low"].includes(assessment.cohesion)) issues.add("assessment", "assessment cohesion is invalid");
  const sortedUnique = (values: readonly string[]): boolean =>
    new Set(values).size === values.length && values.every((value, index) => index === 0 || value > values[index - 1]!);
  for (const reason of assessment.reasons) {
    if (!reason.code || !reason.detail || !sortedUnique(reason.paths)) issues.add("assessment", "assessment reasons require non-empty identity and sorted unique paths");
  }
  const shimPaths = assessment.compatibilityShims.map(({ path }) => path);
  if (!sortedUnique(shimPaths)) issues.add("assessment", "compatibility shims must be sorted and unique by path");
  const targetNames = assessment.targetOptions.map(({ packageName }) => packageName);
  if (!sortedUnique(targetNames)) issues.add("assessment", "assessment target options must be sorted and unique by package name");
  if (assessment.selectedTarget.packageName !== manifest.target.packageName || assessment.selectedTarget.packageRoot !== manifest.target.packageRoot) {
    issues.add("assessment", "assessment selected target must match the executable plan target");
  }
}

function validateModulePromotion(manifest: ExtractionManifest, consumers: ReadonlySet<string>, issues: Issues): void {
  const promotion = manifest.modulePromotion;
  if (promotion === undefined) return;
  if (manifest.source.files.length !== 1 || manifest.source.files[0] !== promotion.source) issues.add("module-promotion", "module promotion must select exactly its configured source module");
  const importerProof = [...promotion.importerProof];
  if (new Set(importerProof).size !== importerProof.length || importerProof.some((path, index) => index > 0 && path <= importerProof[index - 1]!)) issues.add("module-promotion-importers", "module promotion importer proof must be sorted and unique");
  const coveredImporters = new Set([...consumers, ...manifest.source.tests]);
  if (importerProof.length !== coveredImporters.size || importerProof.some((path) => !coveredImporters.has(path))) issues.add("module-promotion-importers", "module promotion importer proof must exactly equal rewritten consumers and relocated owned tests");
  if ((promotion.cycleCut === undefined) === (promotion.containmentCut === undefined)) issues.add("module-promotion-boundary-cut", "module promotion must carry exactly one SCC or containment-cut proof");
  if (promotion.cycleCut !== undefined) validatePromotionCycleCut(promotion.source, promotion.cycleCut, issues);
  if (promotion.containmentCut !== undefined) validatePromotionContainmentCut(promotion.source, promotion.containmentCut, issues);
}

function validatePromotionCycleCut(source: string, cut: NonNullable<NonNullable<ExtractionManifest["modulePromotion"]>["cycleCut"]>, issues: Issues): void {
  const before = cut.before;
  const after = cut.after;
  if (before.length < 2 || !before.includes(source)) issues.add("module-promotion-cycle-cut", "cycle-cut baseline must be a multi-module SCC containing the source");
  const afterMembers = after.flat();
  if (afterMembers.includes(source) || afterMembers.length !== before.length - 1 || afterMembers.some((path) => !before.includes(path))) issues.add("module-promotion-cycle-cut", "cycle-cut result must partition every baseline SCC member except the promoted source");
  if (Math.max(0, ...after.map((component) => component.length)) >= before.length) issues.add("module-promotion-cycle-cut", "cycle-cut proof does not reduce the largest SCC");
  if (cut.removedEdges.length === 0 || cut.removedEdges.some((edge) => edge.from !== source && edge.to !== source)) issues.add("module-promotion-cycle-cut", "removed SCC edges must be non-empty and incident to the promoted source");
}

function validatePromotionContainmentCut(source: string, cut: NonNullable<NonNullable<ExtractionManifest["modulePromotion"]>["containmentCut"]>, issues: Issues): void {
  if (cut.removedEdges.length === 0 || cut.removedEdges.some((edge) => edge.from !== source && edge.to !== source)) issues.add("module-promotion-containment-cut", "removed containment edges must be non-empty and incident to the promoted source");
  if (cut.introducedApplicationDependencies.length > 0) issues.add("module-promotion-containment-cut", "promoted package must not introduce dependencies on application modules");
  if (cut.architecturalEdgesBefore < cut.removedEdges.length || cut.architecturalEdgesAfter !== cut.architecturalEdgesBefore - cut.removedEdges.length || cut.architecturalEdgesAfter >= cut.architecturalEdgesBefore) issues.add("module-promotion-containment-cut", "architectural containment-edge metric must improve by the exact recorded cut");
}

function validateHeader(manifest: ExtractionManifest, options: ValidatePlanOptions, issues: Issues): void {
  if (!manifest.planId) issues.add("plan-id", "planId must be a non-empty string");
  if (!COMMIT_HASH.test(manifest.baselineCommit ?? "")) issues.add("baseline-commit", "baselineCommit must be a git commit hash");
  if (Number.isNaN(Date.parse(manifest.createdAt ?? ""))) issues.add("created-at", "createdAt must be an ISO date");
  if (!isSha256(manifest.graphDigest ?? "")) issues.add("graph-digest", "graphDigest must be a SHA-256 hash");
  if (!options.config.applications.some((app) => app.name === manifest.application)) {
    issues.add("application", `manifest application ${JSON.stringify(manifest.application)} is not configured`);
  }
  validateProvenance(manifest, options, issues);
}

function validateProvenance(manifest: ExtractionManifest, options: ValidatePlanOptions, issues: Issues): void {
  const actual = manifest.provenance;
  if (actual === undefined) {
    if (manifest.schemaVersion !== LEGACY_PLAN_SCHEMA_VERSION) issues.add("provenance", `schema-v${manifest.schemaVersion} manifests must include provenance`);
    return;
  }
  if (!isSha256(actual.configDigest ?? "")) issues.add("config-digest", "provenance.configDigest must be a SHA-256 hash");
  if (!isSha256(actual.policyDigest ?? "")) issues.add("policy-digest", "provenance.policyDigest must be a SHA-256 hash");
  if (!isSha256(actual.compiler?.artifactIntegrity ?? "")) issues.add("compiler-integrity", "provenance.compiler.artifactIntegrity must be a SHA-256 hash");
  for (const [kind, adapter] of Object.entries(actual.adapters ?? {})) {
    if (!adapter?.id) issues.add("adapter-provenance", `${kind} adapter id must be non-empty`);
    if (!Number.isInteger(adapter?.contractVersion) || adapter.contractVersion < 1) issues.add("adapter-provenance", `${kind} adapter contractVersion must be a positive integer`);
    if (adapter?.declaredVersion !== undefined && adapter.declaredVersion === "") issues.add("adapter-provenance", `${kind} adapter declaredVersion must be non-empty when present`);
  }
  if (!("packageManager" in (actual.adapters ?? {})) || !("taskRunner" in (actual.adapters ?? {}))) {
    issues.add("adapter-provenance", "provenance.adapters must include packageManager and taskRunner");
    return;
  }
  if (!options.config.applications.some((app) => app.name === manifest.application)) return;
  const application = getApplication(options.config, manifest.application);
  const profile = resolveExtractionProfile(options.config, application, manifest.target?.profile?.name);
  const packageManager = createPackageManagerAdapter(options.config);
  const taskRunner = createTaskRunnerAdapter(options.config);
  const rootManifest = resolve(options.rootDir, "package.json");
  const expected = buildPlanProvenance({
    config: options.config,
    profileGates: profile.gates,
    scaffoldTemplates: profile.scaffoldTemplates,
    packageManager,
    taskRunner,
    ...(existsSync(rootManifest) ? { rootPackageJson: readFileSync(rootManifest, "utf8") } : {}),
  });
  if (actual.configDigest !== expected.configDigest) issues.add("config-digest", "plan configuration digest does not match the effective configuration");
  if (actual.policyDigest !== expected.policyDigest) issues.add("policy-digest", "plan policy digest does not match the effective planning policy");
  if (stableStringify(actual.adapters) !== stableStringify(expected.adapters)) issues.add("adapter-provenance", "plan adapter provenance does not match the configured adapters");
  if (stableStringify(actual.compiler) !== stableStringify(expected.compiler)) issues.add("compiler-integrity", "plan compiler identity does not match this compiler");
  validateEvacuationProvenance(manifest, options, issues);
}

function validateEvacuationProvenance(manifest: ExtractionManifest, options: ValidatePlanOptions, issues: Issues): void {
  const evacuation = manifest.provenance?.evacuation;
  if (evacuation === undefined) return;
  const canonical = (values: readonly string[]): boolean =>
    new Set(values).size === values.length && values.every((value, index) => index === 0 || value > values[index - 1]!);
  if (!canonical(evacuation.requested) || !canonical(evacuation.retainedComposition) || !canonical(evacuation.authorizedProtectedRoots)) {
    issues.add("evacuation-provenance", "evacuation provenance paths must be sorted and unique");
    return;
  }
  const application = options.config.applications.find(({ name }) => name === manifest.application);
  if (application === undefined) return;
  for (const root of evacuation.authorizedProtectedRoots) {
    if (!options.config.portfolio.protectedPaths.includes(root)) {
      issues.add("protected-authorization", `authorized root is not an exact configured protected path: ${root}`);
    }
    if (!evacuation.requested.some((path) => path === root || path.startsWith(`${root}/`))) {
      issues.add("protected-authorization", `authorized root is outside the selected evacuation: ${root}`);
    }
  }
  const protectedSources = [...(manifest.source?.files ?? []), ...(manifest.source?.tests ?? []), ...(manifest.source?.assets ?? [])]
    .filter((path) => options.config.portfolio.protectedPaths.some((root) => path === root || path.startsWith(`${root}/`)));
  for (const path of protectedSources) {
    if (!evacuation.authorizedProtectedRoots.some((root) => path === root || path.startsWith(`${root}/`))) {
      issues.add("protected-authorization", `protected source is not covered by evacuation authorization: ${path}`, { path });
    }
  }
  const expectedId = evacuationId(
    manifest.application,
    evacuation.requested,
    manifest.source?.files ?? [],
    evacuation.retainedComposition.length === 0 ? [] : [{ id: "provenance", members: evacuation.retainedComposition }],
    evacuation.authorizedProtectedRoots,
  );
  if (evacuation.id !== expectedId || (manifest.planId !== expectedId && !manifest.planId.startsWith(`${expectedId}--`))) {
    issues.add("evacuation-identity", "plan identity does not match canonical evacuation authorization provenance");
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
    const rootModule = module.exportKey === "." && module.specifier === packageName;
    if (!files.includes(module.source) || !module.target || (!rootModule && !module.specifier.startsWith(`${packageName}/`))) {
      issues.add("target-subpaths", `invalid public module mapping for ${module.source}`, { path: module.source });
    }
    if ((module.exportKey !== "." && !module.exportKey.startsWith("./")) || !module.exportTarget.startsWith("./")) {
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
