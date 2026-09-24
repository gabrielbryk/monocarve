/**
 * Compile a config-declared integration-test suite into a leaf workspace
 * package.  This is deliberately not a portfolio candidate: tests do not have
 * a production SCC or a public surface to extract.  Their authority is the
 * named suite config and its exact donor import map.
 */

import { createPackageManagerAdapter, createTaskRunnerAdapter } from "../adapters/registry.ts";
import { GENERATOR } from "../branding.ts";
import {
  applicationOwner,
  getApplication,
  isFirstPartyPackageOwner,
  isPackageOwner,
  renderExtractionProfile,
  resolveExtractionProfile,
  type MonocarveConfig,
} from "../config.ts";
import type { DependencyGraph } from "../graph/model.ts";
import { resolveCommit } from "../util/git.ts";
import { hashText, type Sha256 } from "../util/hash.ts";
import { renderTemplate } from "../util/template.ts";
import { boundaryBaselineOf } from "./boundary-baseline.ts";
import { renderGates, graphDigest, moveOperation } from "./build.ts";
import { PlanningError, WorkspaceContext } from "./context.ts";
import { inferDependencies } from "./dependencies.ts";
import { collectIntegrationTestClosure, selectIntegrationTestRoots } from "./integration-test-closure.ts";
import { operationPaths, PLAN_SCHEMA_VERSION, type ExtractionManifest, type PlanOperation } from "./manifest.ts";
import { buildPlanProvenance } from "./provenance.ts";
import { packageOperations } from "./scaffold.ts";

export interface BuildIntegrationTestPlanOptions {
  readonly config: MonocarveConfig;
  readonly rootDir: string;
  readonly graph: DependencyGraph;
  readonly suite: string;
  readonly baselineCommit: string;
  readonly context?: WorkspaceContext;
}

export function buildIntegrationTestPlanSync(options: BuildIntegrationTestPlanOptions): ExtractionManifest {
  const { config, graph } = options;
  const { suite, application, packageName, context } = resolveSuiteDonor(options);
  const { profile, profileName } = resolveSuiteProfile(config, application, options.suite, suite.profile);
  const rendered = renderExtractionProfile(config, application, profile, options.suite);
  const packageManager = createPackageManagerAdapter(config);
  const taskRunner = createTaskRunnerAdapter(config);
  const baseline = resolveCommit(options.rootDir, options.baselineCommit);

  const roots = selectIntegrationTestRoots(context, options.suite, suite);
  const closure = collectIntegrationTestClosure(context, config, suite, packageName, roots);
  const { tests, assets } = closure;
  const operations = suiteMoveOperations(context, closure, rendered.packageRoot, suite.sourceRoot);
  const dependencies = leafTestDependencies(config, inferDependencies(context, graph, tests, rendered.packageName), packageName);
  const scaffoldInput = leafScaffoldInput({ context, config, application, packageManager, taskRunner, rendered, profile, dependencies, packageName });
  operations.push(...packageOperations(scaffoldInput));

  const sourceBlobs = integrationSourceBlobs(context, [...tests, ...assets]);
  const lockOperation = operations.find(
    (operation): operation is Extract<PlanOperation, { kind: "lockfile-importer" }> =>
      operation.kind === "lockfile-importer" && operation.packageRoot === rendered.packageRoot,
  );
  const projectId = scaffoldInput.projectId;
  const commitVars = {
    package: rendered.packageName,
    packageRoot: rendered.packageRoot,
    app: application.name,
    project: projectId,
    planId: `tests--${options.suite}`,
    fileCount: String(tests.length),
  };

  return {
    schemaVersion: PLAN_SCHEMA_VERSION,
    planId: `tests--${options.suite}`,
    createdAt: baseline.committedAt,
    generator: { ...GENERATOR },
    provenance: buildPlanProvenance({
      config,
      profileGates: profile.gates,
      scaffoldTemplates: profile.scaffoldTemplates,
      packageManager,
      taskRunner,
      ...rootPackageJson(context),
    }),
    baselineCommit: baseline.commit,
    graphDigest: graphDigest(graph),
    application: application.name,
    boundaryBaseline: boundaryBaselineOf({
      config,
      rootDir: options.rootDir,
      files: context.repositorySources(),
      referencesOf: (file) => context.moduleReferences(file),
    }),
    target: {
      packageName: rendered.packageName,
      packageRoot: rendered.packageRoot,
      entrypoint: profile.scaffoldTemplates.entrypoint,
      projectId,
      profile: { name: profileName, candidateName: options.suite },
      requiredExports: [],
    },
    source: { files: [], tests, ...(assets.length > 0 ? { assets } : {}), sccs: {} },
    dependencies,
    integrationTestSuite: suiteRecord(options.suite, suite, application.name),
    sourceBlobs,
    operations,
    consumers: [],
    generatedFiles: [],
    changedFiles: [...new Set(operations.flatMap(operationPaths))].toSorted(),
    ...(lockOperation ? { lockfileImporter: { packageRoot: rendered.packageRoot, hash: hashText(lockOperation.block) } } : {}),
    expectedDynamicImportDelta: { added: [], removed: [] },
    evaluationEffects: [],
    metrics: suiteMetrics(graph, tests),
    commits: suiteCommits(config, commitVars),
    gates: renderGates(config, profile.gates, { ...commitVars, consumerOwners: [applicationOwner(application)], taskRunner, rootDir: options.rootDir }),
  };
}

type SuiteConfig = MonocarveConfig["integrationTestSuites"][string];

/** Move every suite test and asset from under `sourceRoot` to the same relative path under `<packageRoot>/src`. */
function suiteMoveOperations(
  context: WorkspaceContext,
  closure: ReturnType<typeof collectIntegrationTestClosure>,
  packageRoot: string,
  sourceRoot: string,
): PlanOperation[] {
  const { tests, assets, rewrites } = closure;
  const targetOf = (source: string): string => `${packageRoot}/src/${source.slice(`${sourceRoot}/`.length)}`;
  const targets = tests.map(targetOf);
  const assetTargets = assets.map(targetOf);
  if (new Set(targets).size !== targets.length) throw new PlanningError("two integration tests would land on the same target path");
  const operations: PlanOperation[] = tests.map((source, index) => moveOperation(context, source, targets[index]!, rewrites.get(source) ?? []));
  operations.push(...assets.map((source, index) => moveOperation(context, source, assetTargets[index]!, [])));
  return operations;
}

function leafScaffoldInput(input: {
  readonly context: WorkspaceContext;
  readonly config: MonocarveConfig;
  readonly application: Application;
  readonly packageManager: ReturnType<typeof createPackageManagerAdapter>;
  readonly taskRunner: ReturnType<typeof createTaskRunnerAdapter>;
  readonly rendered: ReturnType<typeof renderExtractionProfile>;
  readonly profile: ReturnType<typeof resolveExtractionProfile>;
  readonly dependencies: ReturnType<typeof leafTestDependencies>;
  readonly packageName: string;
}) {
  const { context, config, application, packageManager, taskRunner, rendered, profile, dependencies, packageName } = input;
  return {
    context,
    config,
    application,
    packageManager,
    taskRunner,
    packageName: rendered.packageName,
    packageRoot: rendered.packageRoot,
    projectId: rendered.projectId ?? taskRunner.projectIdFor(rendered.packageName, rendered.packageRoot),
    templates: profile.scaffoldTemplates,
    production: [] as string[],
    dependencies,
    workspaceDependencyRoots: { [packageName]: applicationOwner(application) },
  };
}

function suiteRecord(name: string, suite: SuiteConfig, donorApplication: string): NonNullable<ExtractionManifest["integrationTestSuite"]> {
  return {
    name,
    sourceRoot: suite.sourceRoot,
    donorApplication,
    donorImports: [...suite.donorImports].toSorted((left, right) => left.source.localeCompare(right.source)),
  };
}

function rootPackageJson(context: WorkspaceContext): { rootPackageJson?: string } {
  return context.exists("package.json") ? { rootPackageJson: context.text("package.json") } : {};
}

function suiteMetrics(graph: DependencyGraph, tests: readonly string[]): ExtractionManifest["metrics"] {
  return {
    movedFiles: tests.length,
    movedLines: tests.reduce((total, path) => total + (graph.nodes.get(path)?.lineCount ?? 0), 0),
    applicationLinesBefore: 0,
    applicationLinesAfter: 0,
    consumers: 0,
  };
}

function suiteCommits(config: MonocarveConfig, vars: Record<string, string>): ExtractionManifest["commits"] {
  return {
    plan: { subject: renderTemplate(config.commitTemplates.plan, vars) },
    move: { subject: renderTemplate(config.commitTemplates.move, vars) },
    wiring: { subject: renderTemplate(config.commitTemplates.wiring, vars) },
  };
}
type Application = ReturnType<typeof getApplication>;

/** The named suite and its donor application, refused unless the donor publishes every imported surface. */
function resolveSuiteDonor(options: BuildIntegrationTestPlanOptions): {
  suite: SuiteConfig;
  application: Application;
  packageName: string;
  context: WorkspaceContext;
} {
  const { config } = options;
  const suite = config.integrationTestSuites[options.suite];
  if (!suite) throw new PlanningError(`unknown integration test suite ${JSON.stringify(options.suite)}`);
  const application = getApplication(config, suite.application);
  const packageName = application.packageName;
  if (!packageName) throw new PlanningError(`integration test suite ${options.suite} requires application ${application.name} to declare packageName`);
  const context = options.context ?? new WorkspaceContext(config, options.rootDir);
  if (context.manifest(applicationOwner(application)).name !== packageName) {
    throw new PlanningError(`integration test suite ${options.suite} donor application package.json does not declare ${packageName}`);
  }
  for (const donor of suite.donorImports) {
    if (publishedDonorTarget(context, applicationOwner(application), packageName, donor.specifier) !== donor.source) {
      throw new PlanningError(`integration test suite ${options.suite} donor surface ${donor.specifier} does not publish ${donor.source}`);
    }
  }
  return { suite, application, packageName, context };
}

function resolveSuiteProfile(config: MonocarveConfig, application: Application, suiteName: string, profileName: string | undefined) {
  const profile = resolveExtractionProfile(config, application, profileName);
  if (profile.name === undefined) throw new PlanningError(`integration test suite ${suiteName} requires an explicit extraction profile`);
  if (profile.kind !== "leaf-test") throw new PlanningError(`integration test suite ${suiteName} requires a leaf-test extraction profile`);
  return { profile, profileName: profile.name };
}

/**
 * This package is a test runner leaf. Even if a workspace forgot to include
 * its test matcher, none of its imports become production dependencies.
 */
function leafTestDependencies(config: MonocarveConfig, inferred: ReturnType<typeof inferDependencies>, donorPackageName: string) {
  return {
    runtime: {} as Record<string, string>,
    dev: { ...inferred.dev, ...inferred.runtime, [donorPackageName]: "workspace:*" },
    packageReferences: inferred.packageReferences.filter((owner) => isPackageOwner(config, owner) || isFirstPartyPackageOwner(config, owner)),
  };
}

function integrationSourceBlobs(context: WorkspaceContext, paths: readonly string[]): Record<string, Sha256> {
  const sourceBlobs: Record<string, Sha256> = {};
  for (const source of paths) {
    const state = context.state(source);
    if (state === "missing") throw new PlanningError(`integration test source does not exist: ${source}`);
    sourceBlobs[source] = state;
  }
  return sourceBlobs;
}

function publishedDonorTarget(context: WorkspaceContext, owner: string, packageName: string, specifier: string): string | undefined {
  if (specifier !== packageName && !specifier.startsWith(`${packageName}/`)) return undefined;
  const key = specifier === packageName ? "." : `.${specifier.slice(packageName.length)}`;
  const exports = context.manifest(owner).exports;
  const target = typeof exports === "string" ? (key === "." ? exports : undefined) : exports && !Array.isArray(exports) ? exports[key] : undefined;
  if (typeof target !== "string" || !target.startsWith("./")) return undefined;
  return `${owner}/${target.slice(2)}`;
}
