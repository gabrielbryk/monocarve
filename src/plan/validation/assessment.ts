import type { ExtractionManifest } from "../manifest.ts";
import { Issues } from "./shared.ts";

export function validateAssessment(manifest: ExtractionManifest, issues: Issues): void {
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
