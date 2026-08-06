/**
 * Compile a config-declared integration-test suite into a leaf workspace
 * package.  This is deliberately not a portfolio candidate: tests do not have
 * a production SCC or a public surface to extract.  Their authority is the
 * named suite config and its exact donor import map.
 */

import { createPackageManagerAdapter, createTaskRunnerAdapter } from "../adapters/registry.ts";
import { applicationOwner, getApplication, isFirstPartyPackageOwner, isPackageOwner, renderExtractionProfile, resolveExtractionProfile, type MonocarveConfig } from "../config.ts";
import { GENERATOR } from "../branding.ts";
import type { DependencyGraph } from "../graph/model.ts";
import { resolveCommit } from "../util/git.ts";
import { hashText, type Sha256 } from "../util/hash.ts";
import { renderTemplate } from "../util/template.ts";
import { inferDependencies } from "./dependencies.ts";
import { renderGates, graphDigest, moveOperation } from "./build.ts";
import { PlanningError, WorkspaceContext } from "./context.ts";
import { operationPaths, PLAN_SCHEMA_VERSION, type ExtractionManifest, type PlanOperation } from "./manifest.ts";
import { buildPlanProvenance } from "./provenance.ts";
import { packageOperations } from "./scaffold.ts";
import { collectIntegrationTestClosure, selectIntegrationTestRoots } from "./integration-test-closure.ts";

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
  const suite = config.integrationTestSuites[options.suite];
  if (!suite) throw new PlanningError(`unknown integration test suite ${JSON.stringify(options.suite)}`);
  const application = getApplication(config, suite.application);
  if (!application.packageName) throw new PlanningError(`integration test suite ${options.suite} requires application ${application.name} to declare packageName`);
  const context = options.context ?? new WorkspaceContext(config, options.rootDir);
  if (context.manifest(applicationOwner(application)).name !== application.packageName) {
    throw new PlanningError(`integration test suite ${options.suite} donor application package.json does not declare ${application.packageName}`);
  }
  for (const donor of suite.donorImports) {
    if (publishedDonorTarget(context, applicationOwner(application), application.packageName, donor.specifier) !== donor.source) {
      throw new PlanningError(`integration test suite ${options.suite} donor surface ${donor.specifier} does not publish ${donor.source}`);
    }
  }
  const profile = resolveExtractionProfile(config, application, suite.profile);
  if (profile.name === undefined) throw new PlanningError(`integration test suite ${options.suite} requires an explicit extraction profile`);
  if (profile.kind !== "leaf-test") throw new PlanningError(`integration test suite ${options.suite} requires a leaf-test extraction profile`);
  const rendered = renderExtractionProfile(config, application, profile, options.suite);
  const packageManager = createPackageManagerAdapter(config);
  const taskRunner = createTaskRunnerAdapter(config);
  const baseline = resolveCommit(options.rootDir, options.baselineCommit);

  const roots = selectIntegrationTestRoots(context, options.suite, suite);
  const closure = collectIntegrationTestClosure(context, config, suite, application.packageName, roots);
  const { tests, assets, rewrites } = closure;

  const targetOf = (source: string): string => `${rendered.packageRoot}/src/${source.slice(`${suite.sourceRoot}/`.length)}`;
  const targets = tests.map(targetOf);
  const assetTargets = assets.map(targetOf);
  if (new Set(targets).size !== targets.length) throw new PlanningError("two integration tests would land on the same target path");
  const operations: PlanOperation[] = tests.map((source, index) => moveOperation(context, source, targets[index]!, rewrites.get(source) ?? []));
  operations.push(...assets.map((source, index) => moveOperation(context, source, assetTargets[index]!, [])));

  const inferred = inferDependencies(context, graph, tests, rendered.packageName);
  // This package is a test runner leaf.  Even if a workspace forgot to include
  // its test matcher, none of its imports become production dependencies.
  const dependencies = {
    runtime: {} as Record<string, string>,
    dev: { ...inferred.dev, ...inferred.runtime, [application.packageName]: "workspace:*" },
    packageReferences: inferred.packageReferences.filter((owner) => isPackageOwner(config, owner) || isFirstPartyPackageOwner(config, owner)),
  };
  const scaffoldInput = {
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
    workspaceDependencyRoots: { [application.packageName]: applicationOwner(application) },
  };
  const scaffolding = packageOperations(scaffoldInput);
  operations.push(...scaffolding);

  const sourceBlobs: Record<string, Sha256> = {};
  for (const source of [...tests, ...assets]) {
    const state = context.state(source);
    if (state === "missing") throw new PlanningError(`integration test source does not exist: ${source}`);
    sourceBlobs[source] = state;
  }
  const lockOperation = operations.find((operation): operation is Extract<PlanOperation, { kind: "lockfile-importer" }> =>
    operation.kind === "lockfile-importer" && operation.packageRoot === rendered.packageRoot,
  );
  const projectId = scaffoldInput.projectId;
  const commitVars = { package: rendered.packageName, packageRoot: rendered.packageRoot, app: application.name, project: projectId, planId: `tests--${options.suite}`, fileCount: String(tests.length) };

  return {
    schemaVersion: PLAN_SCHEMA_VERSION,
    planId: `tests--${options.suite}`,
    createdAt: baseline.committedAt,
    generator: { ...GENERATOR },
    provenance: buildPlanProvenance({ config, profileGates: profile.gates, scaffoldTemplates: profile.scaffoldTemplates, packageManager, taskRunner, ...(context.exists("package.json") ? { rootPackageJson: context.text("package.json") } : {}) }),
    baselineCommit: baseline.commit,
    graphDigest: graphDigest(graph),
    application: application.name,
    target: {
      packageName: rendered.packageName,
      packageRoot: rendered.packageRoot,
      entrypoint: profile.scaffoldTemplates.entrypoint,
      projectId,
      profile: { name: profile.name, candidateName: options.suite },
      requiredExports: [],
    },
    source: { files: [], tests, ...(assets.length > 0 ? { assets } : {}), sccs: {} },
    dependencies,
    integrationTestSuite: {
      name: options.suite,
      sourceRoot: suite.sourceRoot,
      donorApplication: application.name,
      donorImports: [...suite.donorImports].sort((left, right) => left.source.localeCompare(right.source)),
    },
    sourceBlobs,
    operations,
    consumers: [],
    generatedFiles: [],
    changedFiles: [...new Set(operations.flatMap(operationPaths))].sort(),
    ...(lockOperation ? { lockfileImporter: { packageRoot: rendered.packageRoot, hash: hashText(lockOperation.block) } } : {}),
    expectedDynamicImportDelta: { added: [], removed: [] },
    evaluationEffects: [],
    metrics: { movedFiles: tests.length, movedLines: tests.reduce((total, path) => total + (graph.nodes.get(path)?.lineCount ?? 0), 0), applicationLinesBefore: 0, applicationLinesAfter: 0, consumers: 0 },
    commits: {
      plan: { subject: renderTemplate(config.commitTemplates.plan, commitVars) },
      move: { subject: renderTemplate(config.commitTemplates.move, commitVars) },
      wiring: { subject: renderTemplate(config.commitTemplates.wiring, commitVars) },
    },
    gates: renderGates(config, profile.gates, { ...commitVars, consumerOwners: [applicationOwner(application)], taskRunner, rootDir: options.rootDir }),
  };
}

function publishedDonorTarget(context: WorkspaceContext, owner: string, packageName: string, specifier: string): string | undefined {
  if (specifier !== packageName && !specifier.startsWith(`${packageName}/`)) return undefined;
  const key = specifier === packageName ? "." : `.${specifier.slice(packageName.length)}`;
  const exports = context.manifest(owner).exports;
  const target = typeof exports === "string" ? (key === "." ? exports : undefined) : exports && !Array.isArray(exports) ? exports[key] : undefined;
  if (typeof target !== "string" || !target.startsWith("./")) return undefined;
  return `${owner}/${target.slice(2)}`;
}
