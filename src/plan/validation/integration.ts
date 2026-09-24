import { applyEscapeRewrites } from "../../codemod/imports.ts";
import { applicationOwner, getApplication, packageNameOf, renderExtractionProfile, resolveExtractionProfile, testKindOf } from "../../config.ts";
import { isSourceModulePath, sourceFiles } from "../../util/files.ts";
import { hashText } from "../../util/hash.ts";
import { WorkspaceContext } from "../context.ts";
import type { ExtractionManifest, PlanOperation } from "../manifest.ts";
import type { ValidatePlanOptions } from "./shared.ts";
import { Issues } from "./shared.ts";

type ConfiguredSuite = NonNullable<ValidatePlanOptions["config"]["integrationTestSuites"][string]>;
type SuiteRecord = NonNullable<ExtractionManifest["integrationTestSuite"]>;
type MoveOperation = Extract<PlanOperation, { kind: "move" | "move-with-rewrite" }>;
type ModuleReference = ReturnType<WorkspaceContext["moduleReferences"]>[number];

/** Validate the config authority unique to a leaf integration-test plan. */
export function validateIntegrationTestSuite(manifest: ExtractionManifest, options: ValidatePlanOptions, issues: Issues): void {
  const record = manifest.integrationTestSuite;
  if (!record) return;
  const configured = options.config.integrationTestSuites[record.name];
  if (!configured) {
    issues.add("integration-test-suite", `integration test suite ${JSON.stringify(record.name)} is not configured`);
    return;
  }
  validateSuiteRecord(manifest, record, configured, issues);
  validateSuiteTests(manifest, options, configured, issues);
  const app = getApplication(options.config, configured.application);
  validateSuiteTarget(manifest, options, record, configured, app, issues);
  if (options.offline) return;
  const context = new WorkspaceContext(options.config, options.rootDir);
  validatePublishedDonorSurfaces(context, app, configured.donorImports, issues);
  const closure = integrationClosure(context, configured.sourceRoot, configured.patterns, options.config.assetExtensions);
  if (!samePaths(manifest.source.tests, closure.sources) || !samePaths(manifest.source.assets ?? [], closure.assets)) {
    issues.add("integration-test-suite", "integration test suite sources or assets do not match the configured complete closure");
  }
  validateIntegrationMoves(manifest, options, issues, context, configured, app.packageName);
}

function validateSuiteRecord(manifest: ExtractionManifest, record: SuiteRecord, configured: ConfiguredSuite, issues: Issues): void {
  if (configured.sourceRoot !== record.sourceRoot || configured.application !== record.donorApplication) {
    issues.add("integration-test-suite", "integration test suite source root or donor application does not match configuration");
  }
  const actualDonors = JSON.stringify([...record.donorImports].toSorted((left, right) => left.source.localeCompare(right.source)));
  const expectedDonors = JSON.stringify([...configured.donorImports].toSorted((left, right) => left.source.localeCompare(right.source)));
  if (actualDonors !== expectedDonors) issues.add("integration-test-suite", "integration test suite donor import surfaces do not match configuration");
  if (manifest.source.files.length !== 0) {
    issues.add("integration-test-suite", "integration test suite plans may not move production modules");
  }
}

function validateSuiteTests(manifest: ExtractionManifest, options: ValidatePlanOptions, configured: ConfiguredSuite, issues: Issues): void {
  for (const test of manifest.source.tests) {
    if (!test.startsWith(`${configured.sourceRoot}/`)) {
      issues.add("integration-test-suite", `test source is outside the configured suite: ${test}`, { path: test });
    }
    if (!options.offline && configured.patterns.some((pattern) => new RegExp(pattern).test(test)) && testKindOf(options.config, test) !== "integration") {
      issues.add("integration-test-suite", `test source is not classified as integration: ${test}`, { path: test });
    }
  }
}

function validateSuiteTarget(
  manifest: ExtractionManifest,
  options: ValidatePlanOptions,
  record: SuiteRecord,
  configured: ConfiguredSuite,
  app: ReturnType<typeof getApplication>,
  issues: Issues,
): void {
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
  if ((app.packageName && manifest.dependencies.dev[app.packageName] !== "workspace:*") || Object.keys(manifest.dependencies.runtime).length !== 0) {
    issues.add("integration-test-suite", "integration test package must declare the donor application as a dev workspace dependency only");
  }
}

function validatePublishedDonorSurfaces(
  context: WorkspaceContext,
  app: ReturnType<typeof getApplication>,
  donors: readonly { readonly source: string; readonly specifier: string }[],
  issues: Issues,
): void {
  const packageName = app.packageName;
  if (!packageName) return;
  const exports = context.manifest(applicationOwner(app)).exports;
  for (const donor of donors) {
    const target = publishedExportTarget(exports, donorExportKey(donor.specifier, packageName));
    if (typeof target !== "string" || target !== `./${donor.source.slice(`${applicationOwner(app)}/`.length)}`) {
      issues.add("integration-test-suite", `integration donor surface is not published by its application: ${donor.specifier}`);
    }
  }
}

function donorExportKey(specifier: string, packageName: string): string | undefined {
  if (specifier === packageName) return ".";
  return specifier.startsWith(`${packageName}/`) ? `.${specifier.slice(packageName.length)}` : undefined;
}

function publishedExportTarget(exports: ReturnType<WorkspaceContext["manifest"]>["exports"], key: string | undefined): unknown {
  if (typeof exports === "string") return key === "." ? exports : undefined;
  return exports && !Array.isArray(exports) && key ? exports[key] : undefined;
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
    .toSorted();
  const sources = new Set(rootTests);
  const assets = new Set<string>();
  const queue = [...rootTests];
  while (queue.length > 0) {
    const source = queue.shift()!;
    for (const resolved of relativeTargetsWithin(context, source, sourceRoot))
      admitClosureTarget(context, assetExtensions, resolved, { sources, assets, queue });
  }
  return { sources, assets };
}

function admitClosureTarget(
  context: WorkspaceContext,
  assetExtensions: readonly string[],
  resolved: string,
  closure: { readonly sources: Set<string>; readonly assets: Set<string>; readonly queue: string[] },
): void {
  if (isSourceModulePath(resolved, context.config.sourceExtensions) && !closure.sources.has(resolved)) {
    closure.sources.add(resolved);
    closure.queue.push(resolved);
  } else if (assetExtensions.some((extension) => resolved.endsWith(extension))) {
    closure.assets.add(resolved);
  }
}

/** Relative module references of `source` that resolve inside `sourceRoot`, in reference order. */
function relativeTargetsWithin(context: WorkspaceContext, source: string, sourceRoot: string): string[] {
  return context.moduleReferences(source).flatMap((reference) => {
    if (!reference.specifier?.startsWith(".")) return [];
    const resolved = context.resolveRelative(source, reference.specifier);
    return resolved && resolved.startsWith(`${sourceRoot}/`) ? [resolved] : [];
  });
}

interface IntegrationMoveScope {
  readonly test: string;
  readonly context: WorkspaceContext;
  readonly configured: ConfiguredSuite;
  readonly donorPackageName: string | undefined;
  readonly donors: ReadonlyMap<string, string>;
  readonly selected: ReadonlySet<string>;
  readonly selectedAssets: ReadonlySet<string>;
  readonly issues: Issues;
}

function validateIntegrationMoves(
  manifest: ExtractionManifest,
  options: ValidatePlanOptions,
  issues: Issues,
  context: WorkspaceContext,
  configured: ConfiguredSuite,
  donorPackageName: string | undefined,
): void {
  const moves = new Map(
    manifest.operations
      .filter((operation): operation is MoveOperation => operation.kind === "move" || operation.kind === "move-with-rewrite")
      .map((operation) => [operation.source, operation]),
  );
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
    const scope: IntegrationMoveScope = { test, context, configured, donorPackageName, donors, selected, selectedAssets, issues };
    const expected = context.moduleReferences(test).flatMap((reference) => expectedDonorRewrite(scope, reference));
    const actual = operation.kind === "move-with-rewrite" ? operation.rewrites : [];
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      issues.add("integration-test-suite", `integration test donor rewrites do not match configured surfaces: ${test}`);
      continue;
    }
    if (actual.length > 0 && operation.resultHash !== replayedRewriteHash(context, options, test, actual)) {
      issues.add("integration-test-suite", `integration test rewrite result hash does not replay: ${test}`);
    }
  }
}

function expectedDonorRewrite(scope: IntegrationMoveScope, reference: ModuleReference): { donorlessSpecifier: string; packageSpecifier: string }[] {
  const { test, issues } = scope;
  if (reference.specifier === null) {
    issues.add("integration-test-suite", `integration test has a computed module reference: ${test}`);
    return [];
  }
  if (!reference.specifier.startsWith(".")) {
    checkPackageDonorReference(scope, reference, reference.specifier);
    return [];
  }
  const resolved = scope.context.resolveRelative(test, reference.specifier);
  const specifier = resolved === undefined ? undefined : scope.donors.get(resolved);
  if (resolved === undefined || (!scope.selected.has(resolved) && !scope.selectedAssets.has(resolved) && !specifier)) {
    issues.add("integration-test-suite", `integration test reaches an undeclared relative target: ${test}`);
    return [];
  }
  if (reference.dynamic && specifier) {
    issues.add("integration-test-suite", `integration test has a dynamic donor import: ${test}`);
    return [];
  }
  return specifier ? [{ donorlessSpecifier: reference.specifier, packageSpecifier: specifier }] : [];
}

function checkPackageDonorReference(scope: IntegrationMoveScope, reference: ModuleReference, specifier: string): void {
  const { test, issues, donorPackageName } = scope;
  if (reference.dynamic && donorPackageName && packageNameOf(specifier) === donorPackageName) {
    issues.add("integration-test-suite", `integration test has a dynamic donor import: ${test}`);
  }
  if (donorPackageName && packageNameOf(specifier) === donorPackageName && !scope.configured.donorImports.some((entry) => entry.specifier === specifier)) {
    issues.add("integration-test-suite", `integration test imports an undeclared donor surface: ${test}`);
  }
}

function replayedRewriteHash(
  context: WorkspaceContext,
  options: ValidatePlanOptions,
  test: string,
  rewrites: Parameters<typeof applyEscapeRewrites>[2],
): string {
  return hashText(
    applyEscapeRewrites(
      context.text(test),
      context.absolute(test),
      rewrites,
      options.rootDir,
      options.config.moduleSpecifierCalls,
      options.config.assetExtensions,
      options.config.cssImportExtensions,
    ),
  );
}

function samePaths(left: readonly string[], right: ReadonlySet<string>): boolean {
  return left.length === right.size && left.every((path) => right.has(path));
}
