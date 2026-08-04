/**
 * Resolve the complete, movable closure of a configured integration-test
 * suite. A suite may carry local helpers and assets, but every edge that
 * escapes its source root must be an explicitly configured donor surface.
 */

import { packageNameOf, type IntegrationTestSuiteConfig, type MonocarveConfig } from "../config.ts";
import { sourceFiles } from "../util/files.ts";
import type { EscapeRewrite } from "./manifest.ts";
import { PlanningError, type WorkspaceContext } from "./context.ts";

export interface IntegrationTestClosure {
  readonly tests: readonly string[];
  readonly assets: readonly string[];
  readonly rewrites: ReadonlyMap<string, readonly EscapeRewrite[]>;
}

export function selectIntegrationTestRoots(
  context: WorkspaceContext,
  suiteName: string,
  suite: IntegrationTestSuiteConfig,
): string[] {
  const roots = sourcePathsWithinSuite(context, suite)
    .filter((path) => suite.patterns.some((pattern) => new RegExp(pattern).test(path)))
    .sort();
  if (roots.length === 0) throw new PlanningError(`integration test suite ${suiteName} selects no source files`);
  for (const test of roots) requireIntegrationTest(context, suiteName, test);
  return roots;
}

export function collectIntegrationTestClosure(
  context: WorkspaceContext,
  config: MonocarveConfig,
  suite: IntegrationTestSuiteConfig,
  applicationPackageName: string,
  roots: readonly string[],
): IntegrationTestClosure {
  const selected = new Set(roots);
  const assets = new Set<string>();
  const rewrites = new Map<string, readonly EscapeRewrite[]>();
  const donors = new Map(suite.donorImports.map((entry) => [entry.source, entry.specifier]));

  for (const test of selected) {
    const fileRewrites = referencesForTest({
      context,
      config,
      suite,
      applicationPackageName,
      selected,
      assets,
      donors,
      test,
    });
    if (fileRewrites.length > 0) rewrites.set(test, fileRewrites);
  }

  const tests = [...selected].sort();
  refuseInboundConsumers(context, tests);
  return { tests, assets: [...assets].sort(), rewrites };
}

function sourcePathsWithinSuite(context: WorkspaceContext, suite: IntegrationTestSuiteConfig): string[] {
  return sourceFiles(context.absolute(suite.sourceRoot), undefined, context.config.sourceExtensions).map((path) => context.relative(path));
}

function requireIntegrationTest(context: WorkspaceContext, suiteName: string, test: string): void {
  if (context.testKind(test) !== "integration") {
    throw new PlanningError(`integration test suite ${suiteName} selects a non-integration test ${test}`);
  }
}

interface ReferenceCollectionInput {
  readonly context: WorkspaceContext;
  readonly config: MonocarveConfig;
  readonly suite: IntegrationTestSuiteConfig;
  readonly applicationPackageName: string;
  readonly selected: Set<string>;
  readonly assets: Set<string>;
  readonly donors: ReadonlyMap<string, string>;
  readonly test: string;
}

function referencesForTest(input: ReferenceCollectionInput): EscapeRewrite[] {
  const rewrites: EscapeRewrite[] = [];
  for (const reference of input.context.moduleReferences(input.test)) {
    if (reference.specifier === null) {
      throw new PlanningError(`integration test ${input.test} has an unsupported computed module reference`);
    }
    if (!reference.specifier.startsWith(".")) {
      validateBareReference(input, reference.specifier, reference.dynamic);
      continue;
    }
    collectRelativeReference(input, reference.specifier, reference.dynamic, rewrites);
  }
  return rewrites;
}

function validateBareReference(input: ReferenceCollectionInput, specifier: string, dynamic: boolean): void {
  if (packageNameOf(specifier) !== input.applicationPackageName) return;
  if (dynamic) throw new PlanningError(`integration test ${input.test} has a dynamic donor application import ${specifier}`);
  if (!input.suite.donorImports.some((entry) => entry.specifier === specifier)) {
    throw new PlanningError(`integration test ${input.test} imports undeclared donor application surface ${specifier}`);
  }
}

function collectRelativeReference(
  input: ReferenceCollectionInput,
  specifier: string,
  dynamic: boolean,
  rewrites: EscapeRewrite[],
): void {
  const resolved = input.context.resolveRelative(input.test, specifier);
  if (!resolved) throw new PlanningError(`integration test ${input.test} has an unresolved relative import ${specifier}`);
  if (isSuiteSource(input.suite, resolved)) {
    collectSuiteTarget(input, resolved);
    return;
  }
  if (input.selected.has(resolved)) return;
  const donorSpecifier = input.donors.get(resolved);
  if (!donorSpecifier) throw new PlanningError(`integration test ${input.test} reaches undeclared relative target ${resolved}`);
  if (dynamic) throw new PlanningError(`integration test ${input.test} has a dynamic donor application import ${specifier}`);
  rewrites.push({ donorlessSpecifier: specifier, packageSpecifier: donorSpecifier });
}

function isSuiteSource(suite: IntegrationTestSuiteConfig, path: string): boolean {
  return path.startsWith(`${suite.sourceRoot}/`);
}

function collectSuiteTarget(input: ReferenceCollectionInput, resolved: string): void {
  if (/\.[cm]?[jt]sx?$/.test(resolved)) {
    input.selected.add(resolved);
    return;
  }
  if (input.config.assetExtensions.some((extension) => resolved.endsWith(extension))) input.assets.add(resolved);
}

function refuseInboundConsumers(context: WorkspaceContext, tests: readonly string[]): void {
  const selected = new Set(tests);
  for (const test of tests) {
    for (const importer of context.consumerIndex().get(context.absolute(test)) ?? []) {
      if (!selected.has(importer)) {
        throw new PlanningError(`integration test ${test} has an inbound first-party importer ${importer}`);
      }
    }
  }
}
