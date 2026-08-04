import { applicationOwner, getApplication, packageNameOf, renderExtractionProfile, resolveExtractionProfile, testKindOf } from "../../config.ts";
import { applyEscapeRewrites } from "../../codemod/imports.ts";
import { isSourceModulePath, sourceFiles } from "../../util/files.ts";
import { hashText } from "../../util/hash.ts";
import { WorkspaceContext } from "../context.ts";
import type { ExtractionManifest, PlanOperation } from "../manifest.ts";
import type { ValidatePlanOptions } from "./shared.ts";
import { Issues } from "./shared.ts";

/** Validate the config authority unique to a leaf integration-test plan. */
export function validateIntegrationTestSuite(
  manifest: ExtractionManifest,
  options: ValidatePlanOptions,
  issues: Issues,
): void {
  const record = manifest.integrationTestSuite;
  if (!record) return;
  const configured = options.config.integrationTestSuites[record.name];
  if (!configured) {
    issues.add("integration-test-suite", `integration test suite ${JSON.stringify(record.name)} is not configured`);
    return;
  }
  if (configured.sourceRoot !== record.sourceRoot || configured.application !== record.donorApplication) {
    issues.add("integration-test-suite", "integration test suite source root or donor application does not match configuration");
  }
  const actualDonors = JSON.stringify([...record.donorImports].sort((left, right) => left.source.localeCompare(right.source)));
  const expectedDonors = JSON.stringify([...configured.donorImports].sort((left, right) => left.source.localeCompare(right.source)));
  if (actualDonors !== expectedDonors) issues.add("integration-test-suite", "integration test suite donor import surfaces do not match configuration");
  if (manifest.source.files.length !== 0) {
    issues.add("integration-test-suite", "integration test suite plans may not move production modules");
  }
  for (const test of manifest.source.tests) {
    if (!test.startsWith(`${configured.sourceRoot}/`)) {
      issues.add("integration-test-suite", `test source is outside the configured suite: ${test}`, { path: test });
    }
    if (!options.offline && configured.patterns.some((pattern) => new RegExp(pattern).test(test)) && testKindOf(options.config, test) !== "integration") {
      issues.add("integration-test-suite", `test source is not classified as integration: ${test}`, { path: test });
    }
  }
  const app = getApplication(options.config, configured.application);
  const profile = resolveExtractionProfile(options.config, app, configured.profile);
  const rendered = renderExtractionProfile(options.config, app, profile, record.name);
  if (
    manifest.target.packageName !== rendered.packageName ||
    manifest.target.packageRoot !== rendered.packageRoot ||
    manifest.target.profile?.name !== configured.profile ||
    manifest.target.profile.candidateName !== record.name
  ) {
    issues.add("integration-test-suite", "integration test target does not match configured profile rendering");
  }
  if (manifest.target.requiredExports.length !== 0) {
    issues.add("integration-test-suite", "integration test package must not declare a public export surface");
  }
  if (app.packageName && manifest.dependencies.dev[app.packageName] !== "workspace:*" || Object.keys(manifest.dependencies.runtime).length !== 0) {
    issues.add("integration-test-suite", "integration test package must declare the donor application as a dev workspace dependency only");
  }
  if (options.offline) return;
  const context = new WorkspaceContext(options.config, options.rootDir);
  validatePublishedDonorSurfaces(context, app, configured.donorImports, issues);
  const closure = integrationClosure(context, configured.sourceRoot, configured.patterns, options.config.assetExtensions);
  if (!samePaths(manifest.source.tests, closure.sources) || !samePaths(manifest.source.assets ?? [], closure.assets)) {
    issues.add("integration-test-suite", "integration test suite sources or assets do not match the configured complete closure");
  }
  validateIntegrationMoves(manifest, options, issues, context, configured, app.packageName);
}

function validatePublishedDonorSurfaces(
  context: WorkspaceContext,
  app: ReturnType<typeof getApplication>,
  donors: readonly { readonly source: string; readonly specifier: string }[],
  issues: Issues,
): void {
  if (!app.packageName) return;
  const exports = context.manifest(applicationOwner(app)).exports;
  for (const donor of donors) {
    const key = donor.specifier === app.packageName ? "." : donor.specifier.startsWith(`${app.packageName}/`) ? `.${donor.specifier.slice(app.packageName.length)}` : undefined;
    const target = typeof exports === "string" ? (key === "." ? exports : undefined) : exports && !Array.isArray(exports) && key ? exports[key] : undefined;
    if (typeof target !== "string" || target !== `./${donor.source.slice(`${applicationOwner(app)}/`.length)}`) {
      issues.add("integration-test-suite", `integration donor surface is not published by its application: ${donor.specifier}`);
    }
  }
}

function integrationClosure(
  context: WorkspaceContext,
  sourceRoot: string,
  patterns: readonly string[],
  assetExtensions: readonly string[],
): { readonly sources: ReadonlySet<string>; readonly assets: ReadonlySet<string> } {
  const rootTests = sourceFiles(context.absolute(sourceRoot), undefined, context.config.sourceExtensions)
    .map((path) => context.relative(path))
    .filter((path) => patterns.some((pattern) => new RegExp(pattern).test(path)))
    .sort();
  const sources = new Set(rootTests);
  const assets = new Set<string>();
  const queue = [...rootTests];
  while (queue.length > 0) {
    const source = queue.shift()!;
    for (const reference of context.moduleReferences(source)) {
      if (!reference.specifier?.startsWith(".")) continue;
      const resolved = context.resolveRelative(source, reference.specifier);
      if (!resolved || !resolved.startsWith(`${sourceRoot}/`)) continue;
      if (isSourceModulePath(resolved, context.config.sourceExtensions) && !sources.has(resolved)) {
        sources.add(resolved);
        queue.push(resolved);
      } else if (assetExtensions.some((extension) => resolved.endsWith(extension))) {
        assets.add(resolved);
      }
    }
  }
  return { sources, assets };
}

function validateIntegrationMoves(
  manifest: ExtractionManifest,
  options: ValidatePlanOptions,
  issues: Issues,
  context: WorkspaceContext,
  configured: NonNullable<ValidatePlanOptions["config"]["integrationTestSuites"][string]>,
  donorPackageName: string | undefined,
): void {
  const moves = new Map(manifest.operations.filter((operation): operation is Extract<PlanOperation, { kind: "move" | "move-with-rewrite" }> => operation.kind === "move" || operation.kind === "move-with-rewrite").map((operation) => [operation.source, operation]));
  const donors = new Map(configured.donorImports.map((entry) => [entry.source, entry.specifier]));
  const selected = new Set(manifest.source.tests);
  const selectedAssets = new Set(manifest.source.assets ?? []);
  for (const test of manifest.source.tests) {
    const operation = moves.get(test);
    const expectedTarget = `${manifest.target.packageRoot}/src/${test.slice(`${configured.sourceRoot}/`.length)}`;
    if (!operation || operation.target !== expectedTarget) {
      issues.add("integration-test-suite", `integration test move is not the configured canonical relocation: ${test}`);
      continue;
    }
    const expected = context.moduleReferences(test).flatMap((reference) => {
      if (reference.specifier === null) {
        issues.add("integration-test-suite", `integration test has a computed module reference: ${test}`);
        return [];
      }
      if (!reference.specifier.startsWith(".")) {
        if (reference.dynamic && donorPackageName && packageNameOf(reference.specifier) === donorPackageName) {
          issues.add("integration-test-suite", `integration test has a dynamic donor import: ${test}`);
        }
        if (donorPackageName && packageNameOf(reference.specifier) === donorPackageName && !configured.donorImports.some((entry) => entry.specifier === reference.specifier)) {
          issues.add("integration-test-suite", `integration test imports an undeclared donor surface: ${test}`);
        }
        return [];
      }
      const resolved = context.resolveRelative(test, reference.specifier);
      const specifier = resolved === undefined ? undefined : donors.get(resolved);
      if (resolved === undefined || (!selected.has(resolved) && !selectedAssets.has(resolved) && !specifier)) {
        issues.add("integration-test-suite", `integration test reaches an undeclared relative target: ${test}`);
        return [];
      }
      if (reference.dynamic && specifier) {
        issues.add("integration-test-suite", `integration test has a dynamic donor import: ${test}`);
        return [];
      }
      return specifier ? [{ donorlessSpecifier: reference.specifier, packageSpecifier: specifier }] : [];
    });
    const actual = operation.kind === "move-with-rewrite" ? operation.rewrites : [];
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      issues.add("integration-test-suite", `integration test donor rewrites do not match configured surfaces: ${test}`);
      continue;
    }
    if (actual.length > 0 && operation.resultHash !== hashText(applyEscapeRewrites(
      context.text(test), context.absolute(test), actual, options.rootDir, options.config.moduleSpecifierCalls, options.config.assetExtensions, options.config.cssImportExtensions,
    ))) {
      issues.add("integration-test-suite", `integration test rewrite result hash does not replay: ${test}`);
    }
  }
}

function samePaths(left: readonly string[], right: ReadonlySet<string>): boolean {
  return left.length === right.size && left.every((path) => right.has(path));
}
