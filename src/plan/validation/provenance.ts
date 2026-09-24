import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createPackageManagerAdapter, createTaskRunnerAdapter } from "../../adapters/registry.ts";
import { getApplication, resolveExtractionProfile } from "../../config.ts";
import { evacuationId } from "../../evacuation/candidate.ts";
import { isCompositionRoot } from "../../graph/layers.ts";
import { isSha256, stableStringify } from "../../util/hash.ts";
import { LEGACY_PLAN_SCHEMA_VERSION, type ExtractionManifest } from "../manifest.ts";
import { buildPlanProvenance } from "../provenance.ts";
import type { ValidatePlanOptions } from "./shared.ts";
import { Issues } from "./shared.ts";

export function validateProvenance(manifest: ExtractionManifest, options: ValidatePlanOptions, issues: Issues): void {
  const actual = manifest.provenance;
  if (actual === undefined) {
    if (manifest.schemaVersion !== LEGACY_PLAN_SCHEMA_VERSION) issues.add("provenance", `schema-v${manifest.schemaVersion} manifests must include provenance`);
    return;
  }
  if (!validateProvenanceShape(actual, issues)) return;
  if (!options.config.applications.some((app) => app.name === manifest.application)) return;
  validateProvenanceAgreement(manifest, actual, options, issues);
  validateEvacuationProvenance(manifest, options, issues);
}

/** Digest/adapter shape checks. Returns false when a further comparison against the effective config would be meaningless. */
function validateProvenanceShape(actual: NonNullable<ExtractionManifest["provenance"]>, issues: Issues): boolean {
  if (!isSha256(actual.configDigest ?? "")) issues.add("config-digest", "provenance.configDigest must be a SHA-256 hash");
  if (!isSha256(actual.policyDigest ?? "")) issues.add("policy-digest", "provenance.policyDigest must be a SHA-256 hash");
  if (!isSha256(actual.compiler?.artifactIntegrity ?? "")) issues.add("compiler-integrity", "provenance.compiler.artifactIntegrity must be a SHA-256 hash");
  for (const [kind, adapter] of Object.entries(actual.adapters ?? {})) {
    if (!adapter?.id) issues.add("adapter-provenance", `${kind} adapter id must be non-empty`);
    if (!Number.isInteger(adapter?.contractVersion) || adapter.contractVersion < 1)
      issues.add("adapter-provenance", `${kind} adapter contractVersion must be a positive integer`);
    if (adapter?.declaredVersion !== undefined && adapter.declaredVersion === "")
      issues.add("adapter-provenance", `${kind} adapter declaredVersion must be non-empty when present`);
  }
  if (!("packageManager" in (actual.adapters ?? {})) || !("taskRunner" in (actual.adapters ?? {}))) {
    issues.add("adapter-provenance", "provenance.adapters must include packageManager and taskRunner");
    return false;
  }
  return true;
}

function validateProvenanceAgreement(
  manifest: ExtractionManifest,
  actual: NonNullable<ExtractionManifest["provenance"]>,
  options: ValidatePlanOptions,
  issues: Issues,
): void {
  const application = getApplication(options.config, manifest.application);
  const profile = resolveExtractionProfile(options.config, application, manifest.target?.profile?.name);
  const packageManager = createPackageManagerAdapter(options.config);
  const taskRunner = createTaskRunnerAdapter(options.config);
  const rootManifest = resolve(options.rootDir, "package.json");
  const expected = buildPlanProvenance({
    config: options.config,
    profileGates: profile.gates,
    scaffoldTemplates:
      manifest.target.publicSurface === undefined ? profile.scaffoldTemplates : { ...profile.scaffoldTemplates, publicSurface: manifest.target.publicSurface },
    packageManager,
    taskRunner,
    ...(existsSync(rootManifest) ? { rootPackageJson: readFileSync(rootManifest, "utf8") } : {}),
  });
  if (actual.configDigest !== expected.configDigest) issues.add("config-digest", "plan configuration digest does not match the effective configuration");
  if (actual.policyDigest !== expected.policyDigest) issues.add("policy-digest", "plan policy digest does not match the effective planning policy");
  if (stableStringify(actual.adapters) !== stableStringify(expected.adapters))
    issues.add("adapter-provenance", "plan adapter provenance does not match the configured adapters");
  if (stableStringify(actual.compiler) !== stableStringify(expected.compiler))
    issues.add("compiler-integrity", "plan compiler identity does not match this compiler");
}

type Evacuation = NonNullable<NonNullable<ExtractionManifest["provenance"]>["evacuation"]>;

function validateEvacuationProvenance(manifest: ExtractionManifest, options: ValidatePlanOptions, issues: Issues): void {
  const evacuation = manifest.provenance?.evacuation;
  if (evacuation === undefined) return;
  const includedCompositionRoots = evacuation.includedCompositionRoots ?? [];
  const canonical = (values: readonly string[]): boolean =>
    new Set(values).size === values.length && values.every((value, index) => index === 0 || value > values[index - 1]!);
  if (
    !canonical(evacuation.requested) ||
    !canonical(evacuation.retainedComposition) ||
    !canonical(evacuation.authorizedProtectedRoots) ||
    !canonical(includedCompositionRoots)
  ) {
    issues.add("evacuation-provenance", "evacuation provenance paths must be sorted and unique");
    return;
  }
  const application = options.config.applications.find(({ name }) => name === manifest.application);
  if (application === undefined) return;
  validateAuthorizedProtectedRoots(evacuation, options, issues);
  validateIncludedCompositionRoots(manifest, evacuation, includedCompositionRoots, options, application.sourceRoot, issues);
  validateProtectedSourceCoverage(manifest, evacuation, options, issues);
  validateEvacuationIdentity(manifest, evacuation, includedCompositionRoots, issues);
}

function validateAuthorizedProtectedRoots(evacuation: Evacuation, options: ValidatePlanOptions, issues: Issues): void {
  for (const root of evacuation.authorizedProtectedRoots) {
    if (!options.config.portfolio.protectedPaths.includes(root)) {
      issues.add("protected-authorization", `authorized root is not an exact configured protected path: ${root}`);
    }
    if (!evacuation.requested.some((path) => path === root || path.startsWith(`${root}/`))) {
      issues.add("protected-authorization", `authorized root is outside the selected evacuation: ${root}`);
    }
  }
}

function validateIncludedCompositionRoots(
  manifest: ExtractionManifest,
  evacuation: Evacuation,
  includedCompositionRoots: readonly string[],
  options: ValidatePlanOptions,
  applicationSourceRoot: string,
  issues: Issues,
): void {
  for (const root of includedCompositionRoots) {
    if (!isCompositionRoot(options.config, root)) {
      issues.add("composition-inclusion", `included path is not an exact configured composition root: ${root}`);
    }
    if (root !== applicationSourceRoot && !root.startsWith(`${applicationSourceRoot}/`)) {
      issues.add("composition-inclusion", `included composition root crosses application ${JSON.stringify(manifest.application)}: ${root}`);
    }
    if (!evacuation.requested.includes(root)) {
      issues.add("composition-inclusion", `included composition root is outside the selected evacuation: ${root}`);
    }
    if (!(manifest.source?.files ?? []).includes(root)) {
      issues.add("composition-inclusion", `included composition root is absent from moved source: ${root}`, { path: root });
    }
  }
}

function validateProtectedSourceCoverage(manifest: ExtractionManifest, evacuation: Evacuation, options: ValidatePlanOptions, issues: Issues): void {
  const protectedSources = [...(manifest.source?.files ?? []), ...(manifest.source?.tests ?? []), ...(manifest.source?.assets ?? [])].filter((path) =>
    options.config.portfolio.protectedPaths.some((root) => path === root || path.startsWith(`${root}/`)),
  );
  for (const path of protectedSources) {
    if (!evacuation.authorizedProtectedRoots.some((root) => path === root || path.startsWith(`${root}/`))) {
      issues.add("protected-authorization", `protected source is not covered by evacuation authorization: ${path}`, { path });
    }
  }
}

function validateEvacuationIdentity(manifest: ExtractionManifest, evacuation: Evacuation, includedCompositionRoots: readonly string[], issues: Issues): void {
  const expectedId = evacuationId(
    manifest.application,
    evacuation.requested,
    manifest.source?.files ?? [],
    evacuation.retainedComposition.length === 0 ? [] : [{ id: "provenance", members: evacuation.retainedComposition }],
    evacuation.authorizedProtectedRoots,
    includedCompositionRoots,
  );
  if (evacuation.id !== expectedId || (manifest.planId !== expectedId && !manifest.planId.startsWith(`${expectedId}--`))) {
    issues.add("evacuation-identity", "plan identity does not match canonical evacuation authorization provenance");
  }
}
