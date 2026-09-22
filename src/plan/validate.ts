/**
 * Plan validation entrypoint.
 *
 * The ordered calls below are intentional: review tools rely on stable issue
 * ordering, while individual rule families live in `validation/` so each can
 * stay small enough to audit independently.
 */

import { LEGACY_PLAN_SCHEMA_VERSION, PREVIOUS_PLAN_SCHEMA_VERSION, PLAN_SCHEMA_VERSION, isSupportedExtractionManifestVersion, operationPaths, type ExtractionManifest } from "./manifest.ts";
import { PlanValidationError } from "../errors.ts";
import { isSha256 } from "../util/hash.ts";
import { relativeWorkspacePath } from "../util/paths.ts";
import { validateAssessment } from "./validation/assessment.ts";
import { validateModulePromotion } from "./validation/module-promotion.ts";
import { validateProvenance } from "./validation/provenance.ts";
import { validateSource } from "./validation/source.ts";
import { validateTarget } from "./validation/target.ts";
import { validateDependencies } from "./validation/dependencies.ts";
import { validateConsumers } from "./validation/consumers.ts";
import { validateMetadata } from "./validation/metadata.ts";
import { validateOperations } from "./validation/operations.ts";
import { Issues, validationResult, type ValidatePlanOptions, type ValidationResult } from "./validation/shared.ts";

export type { ValidatePlanOptions, ValidationIssue, ValidationResult, ValidationSeverity } from "./validation/shared.ts";

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
  const selectedDonors = new Set([...source.files, ...source.tests, ...source.assets]);
  const consumers = validateConsumers(manifest, issues, target.packageName, target.publicModules, selectedDonors, containedPath);
  validateModulePromotion(manifest, consumers, issues);
  validateMetadata(manifest, issues, containedPath);
  validateOperations(manifest, options, issues, {
    ...source,
    consumers,
    packageName: target.packageName,
    rewriteTargets: new Set([target.packageName, ...target.publicModules.map((module) => module.specifier)]),
    publicSpecifierByDonor: new Map(target.publicModules.map((module) => [module.source, module.specifier])),
    selectedDonors,
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
  validateProvenance(manifest, options, issues);
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
