import { applicationOwner, getApplication, renderExtractionProfile, resolveExtractionProfile, scaffoldFor } from "../../config.ts";
import { createPackageManagerAdapter, createTaskRunnerAdapter } from "../../adapters/registry.ts";
import { WorkspaceContext } from "../context.ts";
import { renderGates } from "../build.ts";
import { isAnyMove, type ExtractionManifest, type PlanOperation } from "../manifest.ts";
import { renderPublicModulePaths } from "../public-modules.ts";
import { sourceExportsFromFile } from "../public-surface.ts";
import { packageOperations } from "../scaffold.ts";
import type { ValidatePlanOptions } from "./shared.ts";
import { Issues } from "./shared.ts";

/** Re-derive configured subpaths and the source export evidence they carry. */
export function validatePublicModules(
  manifest: ExtractionManifest,
  options: ValidatePlanOptions,
  issues: Issues,
): void {
  try {
    const application = getApplication(options.config, manifest.application);
    const templates = manifest.target.profile
      ? resolveExtractionProfile(options.config, application, manifest.target.profile.name).scaffoldTemplates
      : scaffoldFor(options.config, application);
    const actual = manifest.target.publicModules ?? [];
    const publicSurface = templates.publicSurface;
    if (publicSurface.mode === "barrel") {
      if (actual.length > 0) issues.add("target-subpaths", "barrel surface config must not declare public modules");
      return;
    }
    const context = new WorkspaceContext(options.config, options.rootDir);
    const moves = new Map(
      manifest.operations
        .filter(isAnyMove)
        .map((operation) => [operation.source, operation.target]),
    );
    const moduleSources = [...manifest.source.files, ...(manifest.source.assets ?? [])];
    const rendered = renderPublicModulePaths(
      publicSurface,
      moduleSources.map((source) => context.targetRelativePath(source)),
    );
    const expected = moduleSources.map((source, index) => {
      const paths = rendered[index]!;
      return {
        source,
        target: moves.get(source),
        specifier: `${manifest.target.packageName}/${paths.exportKey.slice(2)}`,
        exportKey: paths.exportKey,
        exportTarget: paths.exportTarget,
        requiredExports: index < manifest.source.files.length ? sourceExportsFromFile(context.absolute(source), source) : [],
      };
    });
    const comparable = actual.map(({ source, target, specifier, exportKey, exportTarget, requiredExports }) => ({
      source,
      target,
      specifier,
      exportKey,
      exportTarget,
      requiredExports,
    }));
    if (JSON.stringify(comparable) !== JSON.stringify(expected)) {
      issues.add("target-subpaths", "public module map does not match configured surface templates");
    }
  } catch (error) {
    issues.add("target-subpaths", `cannot validate public module map: ${(error as Error).message}`);
  }
}

/**
 * A profile is not cosmetic target metadata. Re-render it from the current
 * config and demand exact agreement, so a reviewed manifest cannot claim a
 * profile while writing a target, project id, scaffold destination, or gates
 * selected by some other configuration.
 */
export function validateTargetProfile(manifest: ExtractionManifest, options: ValidatePlanOptions, issues: Issues): void {
  const profile = manifest.target?.profile;
  if (!profile) return;
  if (typeof profile.name !== "string" || profile.name.length === 0 || typeof profile.candidateName !== "string" || profile.candidateName.length === 0) {
    issues.add("target-profile", "target.profile must name a profile and its non-empty candidateName");
    return;
  }
  try {
    const application = getApplication(options.config, manifest.application);
    const resolved = resolveExtractionProfile(options.config, application, profile.name);
    // `profile.name` can never resolve the synthetic legacy profile, but keep
    // the check explicit: a forged empty name must not get legacy treatment.
    if (resolved.name === undefined) {
      issues.add("target-profile", "target.profile must resolve a configured profile");
      return;
    }
    const expectedKind = manifest.integrationTestSuite ? "leaf-test" : "library";
    if (resolved.kind !== expectedKind) {
      issues.add("target-profile", `target profile kind must be ${expectedKind}`);
    }
    const rendered = renderExtractionProfile(options.config, application, resolved, profile.candidateName);
    const expectedProject = rendered.projectId ?? createTaskRunnerAdapter(options.config).projectIdFor(rendered.packageName, rendered.packageRoot);
    if (
      manifest.target.packageName !== rendered.packageName ||
      manifest.target.packageRoot !== rendered.packageRoot ||
      manifest.target.projectId !== expectedProject
    ) {
      issues.add("target-profile", "target does not match its configured extraction profile");
    }
    const consumerOwners = [...new Set((manifest.consumers ?? []).map((consumer) => consumer.owner))].sort();
    const expectedGates = renderGates(options.config, resolved.gates, {
      package: rendered.packageName,
      packageRoot: rendered.packageRoot,
      app: application.name,
      project: expectedProject,
      planId: manifest.planId,
      fileCount: String((manifest.source?.files.length ?? 0) + (manifest.source?.tests.length ?? 0) + (manifest.source?.assets?.length ?? 0)),
      consumerOwners,
      taskRunner: createTaskRunnerAdapter(options.config),
      rootDir: options.rootDir,
    });
    if (JSON.stringify(manifest.gates) !== JSON.stringify(expectedGates)) {
      issues.add("target-profile-gates", "manifest gates do not match the configured extraction profile");
    }
    // Offline validation intentionally proves only manifest structure. The
    // profile scaffold is derived from template files/current package state,
    // so its byte comparison belongs to the normal on-tree validation path.
    if (!options.offline) validateProfilePackageOperations(manifest, options, issues, application, resolved, rendered, expectedProject);
  } catch (error) {
    issues.add("target-profile", `cannot resolve target profile: ${(error as Error).message}`);
  }
}

/** Rebuild the profile scaffold and importer, then compare exact declared bytes. */
function validateProfilePackageOperations(
  manifest: ExtractionManifest,
  options: ValidatePlanOptions,
  issues: Issues,
  application: ReturnType<typeof getApplication>,
  profile: ReturnType<typeof resolveExtractionProfile>,
  rendered: ReturnType<typeof renderExtractionProfile>,
  projectId: string,
): void {
  try {
    const context = new WorkspaceContext(options.config, options.rootDir);
    const expected = packageOperations({
      context,
      config: options.config,
      application,
      packageManager: createPackageManagerAdapter(options.config),
      taskRunner: createTaskRunnerAdapter(options.config),
      packageName: rendered.packageName,
      packageRoot: rendered.packageRoot,
      projectId,
      templates: profile.scaffoldTemplates,
      production: manifest.source.files,
      tests: manifest.source.tests,
      assets: manifest.source.assets ?? [],
      publicModules: manifest.target.publicModules ?? [],
      dependencies: {
        runtime: { ...manifest.dependencies.runtime },
        dev: { ...manifest.dependencies.dev },
        packageReferences: [...manifest.dependencies.packageReferences],
      },
      ...(manifest.integrationTestSuite && application.packageName
        ? { workspaceDependencyRoots: { [application.packageName]: applicationOwner(application) } }
        : {}),
    }).filter((operation) => isProfilePackageOperation(operation, rendered.packageRoot));
    const actual = manifest.operations.filter(
      (operation) => isProfilePackageOperation(operation, rendered.packageRoot),
    );
    if (
      expected.length !== actual.length ||
      expected.some((operation, index) => !sameProfilePackageOperation(operation, actual[index]))
    ) {
      issues.add("target-profile-scaffold", "profile-derived scaffold or lockfile importer does not match configured bytes");
    }
  } catch (error) {
    issues.add("target-profile-scaffold", `cannot render profile scaffold: ${(error as Error).message}`);
  }
}

function isProfilePackageOperation(operation: PlanOperation, packageRoot: string): boolean {
  return (
    (operation.kind === "write-file" && operation.generator?.startsWith("scaffold:") === true) ||
    (operation.kind === "lockfile-importer" && operation.packageRoot === packageRoot)
  );
}

function sameProfilePackageOperation(expected: PlanOperation, actual: PlanOperation | undefined): boolean {
  if (!actual || expected.kind !== actual.kind) return false;
  if (expected.kind === "write-file" && actual.kind === "write-file") {
    return expected.path === actual.path && expected.generator === actual.generator && expected.contents === actual.contents;
  }
  if (expected.kind === "lockfile-importer" && actual.kind === "lockfile-importer") {
    return expected.lockfile === actual.lockfile && expected.packageRoot === actual.packageRoot && expected.mode === actual.mode && expected.block === actual.block;
  }
  return false;
}
