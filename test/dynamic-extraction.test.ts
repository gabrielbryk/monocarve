/**
 * Literal dynamic imports are rewritable consumers, not an inherently unsafe
 * extraction shape. The plausible regression is either rejecting the donor
 * merely because it has a lazy consumer, or rewriting `import()` without
 * declaring the exact old/new specifier evidence the audit needs. This fixture
 * proves both properties from a real scanner report.
 */

import { afterAll, expect, test } from "bun:test";
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/config.ts";
import { scanDependencyGraph } from "../src/graph/cruiser.ts";
import { buildPlanSync, serializeManifest } from "../src/plan/build.ts";
import { validatePlan } from "../src/plan/validate.ts";
import { findConsumers } from "../src/plan/consumers.ts";
import { WorkspaceContext } from "../src/plan/context.ts";
import { buildPortfolio } from "../src/portfolio/rank.ts";
import { applyPlan } from "../src/transaction/apply.ts";
import { auditPlanSync } from "../src/transaction/audit.ts";
import { simulatePlan } from "../src/transaction/simulate.ts";
import { regenerateArtifacts } from "../src/transaction/regenerate.ts";
import { cleanupFixtures, fixtureGit, scratchDirectory, write } from "./support/fixture-repo.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "../fixtures/basic-monorepo");
const CHART = "apps/web/src/widgets/chart.ts";
const LAZY = "apps/web/src/lazy-chart.ts";
const COMPUTED_CONSUMER_SOURCE = [
  'import { renderChart } from "./widgets/chart.ts";',
  'const artifact = "../../../dist/chart.js";',
  "export const loadBuiltChart = () => import(artifact);",
  "void renderChart;",
  "",
].join("\n");

function workspace(
  lazySource = 'export const loadChart = () => import("./widgets/chart.ts");\n',
  subpaths = false,
): string {
  const root = join(scratchDirectory(), "dynamic-workspace");
  cpSync(FIXTURE, root, { recursive: true });
  rmSync(join(root, ".monocarve"), { recursive: true, force: true });
  writeFileSync(
    join(root, LAZY),
    lazySource,
  );
  if (subpaths) {
    const configPath = join(root, "monocarve.config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as { scaffoldTemplates: Record<string, unknown> };
    config.scaffoldTemplates.publicSurface = {
      mode: "subpaths",
      keyTemplate: "./{pathNoExtension}",
      targetTemplate: "./src/{path}",
    };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  }
  fixtureGit(root, "init", "-q", "-b", "dynamic-fixture");
  fixtureGit(root, "config", "user.email", "fixture@example.invalid");
  fixtureGit(root, "config", "user.name", "Monocarve Fixture");
  fixtureGit(root, "config", "commit.gpgsign", "false");
  fixtureGit(root, "add", "-A");
  fixtureGit(root, "commit", "-qm", "test: add lazy chart consumer");
  return root;
}

afterAll(cleanupFixtures);

test("applies and audits a literal dynamic consumer without collapsing its lazy boundary", async () => {
  const root = workspace(undefined, true);
  const { config } = await loadConfig({ cwd: root });
  const graph = await scanDependencyGraph({ config, rootDir: root, noCache: true });
  const candidate = buildPortfolio({ config, graph }).candidates.find(
    (entry) => entry.eligible && entry.files.includes(CHART),
  );
  expect(candidate).toBeDefined();

  const manifest = buildPlanSync({
    config,
    rootDir: root,
    graph,
    candidate: candidate!,
    baselineCommit: graph.commit!,
    packageName: "@acme/chart",
  });

  expect(manifest.consumers.find((consumer) => consumer.file === LAZY)?.specifiers).toEqual([
    {
      from: "./widgets/chart.ts",
      to: "@acme/chart/widgets/chart",
      donor: "apps/web/src/widgets/chart.ts",
    },
  ]);
  expect(manifest.expectedDynamicImportDelta).toEqual({
    added: ["@acme/chart/widgets/chart"],
    removed: ["./widgets/chart.ts"],
  });
  expect(manifest.target.publicModules?.find((module) => module.source === CHART)).toEqual(
    expect.objectContaining({
      target: "libs/chart/src/widgets/chart.ts",
      specifier: "@acme/chart/widgets/chart",
      exportKey: "./widgets/chart",
      exportTarget: "./src/widgets/chart.ts",
    }),
  );
  expect(manifest.target.requiredExports).toEqual([]);

  const manifestPath = "plans/dynamic-chart.json";
  write(root, manifestPath, serializeManifest(manifest));
  fixtureGit(root, "add", "--", manifestPath);
  fixtureGit(root, "commit", "-qm", manifest.commits.plan!.subject);
  const applied = await applyPlan({ config, rootDir: root, manifest, manifestPath, commit: true });
  expect(applied.ok).toBe(true);

  const landed = readFileSync(join(root, LAZY), "utf8");
  expect(landed).toContain('import("@acme/chart/widgets/chart")');
  expect(landed).not.toContain('from "@acme/chart/widgets/chart"');
  const passing = auditPlanSync({ config, rootDir: root, manifest });
  expect(passing.passed).toBe(true);
  expect(passing.graphEvidence.dynamicImportDelta).toEqual(manifest.expectedDynamicImportDelta);

  // A lazy import that still exists but reaches a different public module is
  // not equivalent. The graph proof must reject the observed specifier delta,
  // independently of the byte-fidelity proof rejecting the edited consumer.
  write(root, LAZY, landed.replace("@acme/chart/widgets/chart", "@acme/chart/types"));
  const wrongSubpath = auditPlanSync({ config, rootDir: root, manifest, skipCompileProof: true });
  expect(wrongSubpath.graphEvidence.dynamicImportDelta).toEqual({
    added: ["@acme/chart/types"],
    removed: ["./widgets/chart.ts"],
  });
  expect(wrongSubpath.failures).toContain("dynamic-import evidence does not match the declared plan");
  expect(wrongSubpath.passed).toBe(false);

  // Converting the expression into a static import changes runtime evaluation
  // even if it names the right module. This is the plausible regression that
  // a specifier-only consumer assertion cannot detect.
  write(
    root,
    LAZY,
    'import * as chart from "@acme/chart/widgets/chart";\nexport const loadChart = async () => chart;\n',
  );
  const madeStatic = auditPlanSync({ config, rootDir: root, manifest, skipCompileProof: true });
  expect(madeStatic.graphEvidence.dynamicImportDelta).toEqual({
    added: [],
    removed: ["./widgets/chart.ts"],
  });
  expect(madeStatic.failures).toContain("dynamic-import evidence does not match the declared plan");
  expect(madeStatic.passed).toBe(false);
}, 300_000);

test("keeps the default barrel manifest free of subpath-only fields and byte-deterministic", async () => {
  const root = workspace();
  const { config } = await loadConfig({ cwd: root });
  const graph = await scanDependencyGraph({ config, rootDir: root, noCache: true });
  const candidate = buildPortfolio({ config, graph }).candidates.find(
    (entry) => entry.eligible && entry.files.includes(CHART),
  );
  expect(candidate).toBeDefined();

  const input = {
    config,
    rootDir: root,
    graph,
    candidate: candidate!,
    baselineCommit: graph.commit!,
    packageName: "@acme/chart",
  };
  const first = buildPlanSync(input);
  const second = buildPlanSync(input);
  const bytes = serializeManifest(first);

  expect(serializeManifest(second)).toBe(bytes);
  expect(first.target.publicModules).toBeUndefined();
  expect(first.consumers.flatMap((consumer) => consumer.specifiers).every((rewrite) => rewrite.donor === undefined)).toBe(true);
  expect(bytes).not.toContain('"publicModules"');
  expect(bytes).not.toContain('"donor"');
});

test("does not guess that an unindexed computed dynamic import consumes this candidate", async () => {
  const root = workspace('const path = "./widgets/chart.ts";\nexport const loadChart = () => import(path);\n');
  const { config } = await loadConfig({ cwd: root });
  const context = new WorkspaceContext(config, root);
  const graph = await scanDependencyGraph({ config, rootDir: root, noCache: true });
  const candidate = buildPortfolio({ config, graph }).candidates.find((entry) => entry.files.includes(CHART));

  expect(candidate?.eligible).toBe(true);
  expect(candidate?.rejectionReasons.some((reason) => reason.code === "unsupported-module-reference")).toBe(false);
  expect(findConsumers(context, [CHART], "@acme/chart").some((consumer) => consumer.file === LAZY)).toBe(false);
});

test("rewrites a proven production consumer edge alongside an unrelated computed import", async () => {
  const testConsumer = "apps/web/src/lazy-chart.test.ts";
  const testRoot = workspace();
  write(testRoot, testConsumer, COMPUTED_CONSUMER_SOURCE);
  const { config: testConfig } = await loadConfig({ cwd: testRoot });
  const testContext = new WorkspaceContext(testConfig, testRoot);
  const testGraph = await scanDependencyGraph({ config: testConfig, rootDir: testRoot, noCache: true });
  const testCandidate = buildPortfolio({ config: testConfig, graph: testGraph }).candidates.find(
    (entry) => entry.files.includes(CHART),
  );

  expect(testContext.isTest(testConsumer)).toBe(true);
  expect(testContext.hasUnsupportedReference(testConsumer)).toBe(true);
  expect(findConsumers(testContext, [CHART], "@acme/chart").map((consumer) => consumer.file)).toContain(testConsumer);
  expect(testCandidate?.rejectionReasons.some((reason) => reason.code === "unsupported-module-reference")).toBe(false);
  expect(testCandidate?.rejectionReasons.some((reason) => reason.detail.includes("consumer inventory"))).toBe(false);
  expect(testCandidate?.eligible).toBe(true);

  const productionRoot = workspace();
  write(productionRoot, LAZY, COMPUTED_CONSUMER_SOURCE);
  const { config: productionConfig } = await loadConfig({ cwd: productionRoot });
  const productionContext = new WorkspaceContext(productionConfig, productionRoot);
  const productionGraph = await scanDependencyGraph({ config: productionConfig, rootDir: productionRoot, noCache: true });
  const productionCandidate = buildPortfolio({ config: productionConfig, graph: productionGraph }).candidates.find(
    (entry) => entry.files.includes(CHART),
  );

  expect(productionContext.isTest(LAZY)).toBe(false);
  expect(productionContext.hasUnsupportedReference(LAZY)).toBe(true);
  expect(findConsumers(productionContext, [CHART], "@acme/chart")).toContainEqual(
    expect.objectContaining({
      file: LAZY,
      rewrites: [{ from: "./widgets/chart.ts", to: "@acme/chart" }],
      donors: [CHART],
    }),
  );
  expect(productionCandidate?.rejectionReasons.some((reason) => reason.code === "unplannable")).toBe(false);
  expect(productionCandidate?.eligible).toBe(true);
});

test("applies and audits a route-introspection-shaped consumer while retaining its computed registry load", async () => {
  const source = [
    'import { renderChart } from "./widgets/chart.ts";',
    'import type { ChartOptions } from "./widgets/chart.ts";',
    'const ROOT = "/runtime";',
    'export async function introspect(domain: { module: string }, options: ChartOptions) {',
    '  const modulePath = `${ROOT}/${domain.module.slice(2)}`;',
    '  const loaded = await import(modulePath);',
    '  return [renderChart(options), loaded];',
    '}',
    '',
  ].join("\n");
  const root = workspace(source, true);
  const { config } = await loadConfig({ cwd: root });
  const graph = await scanDependencyGraph({ config, rootDir: root, noCache: true });
  const candidate = buildPortfolio({ config, graph }).candidates.find(
    (entry) => entry.eligible && entry.files.includes(CHART),
  );
  expect(candidate).toBeDefined();

  const manifest = buildPlanSync({
    config,
    rootDir: root,
    graph,
    candidate: candidate!,
    baselineCommit: graph.commit!,
    packageName: "@acme/chart",
  });
  expect(manifest.consumers.find((consumer) => consumer.file === LAZY)?.specifiers).toEqual([
    { from: "./widgets/chart.ts", to: "@acme/chart/widgets/chart", donor: CHART },
  ]);

  const manifestPath = "plans/route-introspection-chart.json";
  write(root, manifestPath, serializeManifest(manifest));
  fixtureGit(root, "add", "--", manifestPath);
  fixtureGit(root, "commit", "-qm", manifest.commits.plan!.subject);
  const applied = await applyPlan({ config, rootDir: root, manifest, manifestPath, commit: true });
  expect(applied.ok).toBe(true);

  const landed = readFileSync(join(root, LAZY), "utf8");
  expect(landed.match(/@acme\/chart\/widgets\/chart/g)).toHaveLength(2);
  expect(landed).toContain("await import(modulePath)");
  expect(auditPlanSync({ config, rootDir: root, manifest }).passed).toBe(true);
}, 300_000);

test("simulates a declared JSON runtime registry rewrite before external package compilation", async () => {
  const root = workspace(undefined, true);
  const configPath = join(root, "monocarve.config.json");
  const raw = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  raw.runtimeModuleRegistries = [{
    file: "apps/web/scripts/route-registry.json",
    pointer: "/domains/*/module",
    resolveFrom: "apps/web/src",
    stripPrefix: "./",
  }];
  raw.postJournalPreparers = [{
    id: "route-stubs",
    phase: "after-journal-before-gates",
    command: "bun apps/web/scripts/route-stubs.ts",
    outputs: ["apps/web/src/routes.ts"],
    triggers: ["^apps/web/scripts/route-registry\\.json$"],
    verify: "bun apps/web/scripts/route-stubs.ts --check",
  }];
  raw.transaction = { nodeModules: "symlink", cleanup: true, simulateGates: true };
  writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`);
  const webPackagePath = join(root, "apps/web/package.json");
  const webPackage = JSON.parse(readFileSync(webPackagePath, "utf8")) as { dependencies: Record<string, string> };
  webPackage.dependencies.zod = "1.0.0";
  writeFileSync(webPackagePath, `${JSON.stringify(webPackage, null, 2)}\n`);
  const lockfilePath = join(root, "pnpm-lock.yaml");
  writeFileSync(lockfilePath, readFileSync(lockfilePath, "utf8").replace(
    "      '@acme/logger':\n        specifier: workspace:*\n        version: link:../../libs/logger\n\n  libs/format:",
    "      '@acme/logger':\n        specifier: workspace:*\n        version: link:../../libs/logger\n      zod:\n        specifier: 1.0.0\n        version: 1.0.0\n\n  libs/format:",
  ));
  const chartPath = join(root, CHART);
  writeFileSync(chartPath, `import { z } from "zod";\n${readFileSync(chartPath, "utf8")}\nvoid z;\n`);
  write(root, "apps/web/node_modules/zod/package.json", '{"name":"zod","version":"1.0.0","type":"module","exports":"./index.js","types":"./index.d.ts"}\n');
  write(root, "apps/web/node_modules/zod/index.js", "export const z = {};\n");
  write(root, "apps/web/node_modules/zod/index.d.ts", "export declare const z: {};\n");
  mkdirSync(join(root, "apps/web/node_modules/@acme"), { recursive: true });
  symlinkSync(resolve(root, "libs/format"), join(root, "apps/web/node_modules/@acme/format"), "dir");
  write(root, "apps/web/scripts/route-registry.json", `${JSON.stringify({
    domains: [{ id: "chart", module: "./widgets/chart.ts", export: "renderChart" }],
  }, null, 2)}\n`);
  write(root, "apps/web/scripts/route-introspection.ts", [
    'import { join, resolve } from "node:path";',
    'import registry from "./route-registry.json";',
    'const SOURCE_ROOT = resolve(import.meta.dir, "../src");',
    'export const inspect = () => Promise.all(registry.domains.map((domain) => import(join(SOURCE_ROOT, domain.module.slice(2)))));',
    "",
  ].join("\n"));
  write(root, "apps/web/scripts/route-stubs.ts", [
    'import { readFileSync, writeFileSync } from "node:fs";',
    'const registryPath = "apps/web/scripts/route-registry.json";',
    'const outputPath = "apps/web/src/routes.ts";',
    'const registry = JSON.parse(readFileSync(registryPath, "utf8"));',
    'const expected = registry.domains.map((domain: { module: string; export: string }) => `export { ${domain.export} } from ${JSON.stringify(domain.module)};`).join("\\n") + "\\n";',
    'if (process.argv.includes("--check")) {',
    '  if (readFileSync(outputPath, "utf8") !== expected) process.exit(1);',
    '} else {',
    '  writeFileSync(outputPath, expected);',
    '  await import(new URL("../src/routes.ts", import.meta.url).href);',
    '}',
    "",
  ].join("\n"));
  write(root, "apps/web/src/routes.ts", 'export { renderChart } from "./widgets/chart.ts";\n');
  fixtureGit(root, "add", "-A");
  fixtureGit(root, "commit", "-qm", "test: add declared runtime module registry");

  const { config } = await loadConfig({ cwd: root });
  const graph = await scanDependencyGraph({ config, rootDir: root, noCache: true });
  const candidate = buildPortfolio({ config, graph }).candidates.find((entry) => entry.eligible && entry.files.includes(CHART));
  expect(candidate).toBeDefined();
  const manifest = buildPlanSync({ config, rootDir: root, graph, candidate: candidate!, baselineCommit: graph.commit!, packageName: "@acme/chart" });
  const registryRewrite = manifest.operations.find((operation) => operation.kind === "rewrite-path-reference" && operation.file === "apps/web/scripts/route-registry.json");
  expect(registryRewrite?.kind).toBe("rewrite-path-reference");
  if (registryRewrite?.kind !== "rewrite-path-reference") throw new Error("expected registry rewrite");
  expect(registryRewrite.rewrites).toEqual([{
    from: "./widgets/chart.ts",
    to: "./../../../libs/chart/src/widgets/chart.ts",
    donor: "apps/web/src/widgets/chart.ts",
    line: 5,
    column: 18,
    jsonPointer: "/domains/0/module",
    resolutionBase: "apps/web/src",
    strippedPrefix: "./",
  }]);

  const tampered = {
    ...manifest,
    operations: manifest.operations.map((operation) => operation === registryRewrite
      ? { ...operation, rewrites: operation.rewrites.map(({ strippedPrefix: _removed, ...rewrite }) => rewrite) }
      : operation),
  };
  expect(validatePlan(tampered, { config, rootDir: root }).issues.map((issue) => issue.rule)).toContain("path-reference-target");
  const generatedRoutes = manifest.generatedFiles.find((file) => file.path === "apps/web/src/routes.ts");
  expect(generatedRoutes?.preparerId).toBe("route-stubs");
  expect(generatedRoutes?.regenerate).toBe("bun apps/web/scripts/route-stubs.ts");
  expect(generatedRoutes?.verify).toBe("bun apps/web/scripts/route-stubs.ts --check");
  expect(manifest.generatedFiles.map((file) => file.path)).toEqual(
    [...manifest.generatedFiles.map((file) => file.path)].sort(),
  );
  const missingGeneratorRecord = {
    ...manifest,
    generatedFiles: manifest.generatedFiles.filter((file) => file.path !== "apps/web/src/routes.ts"),
  };
  expect(regenerateArtifacts({ config, treeRoot: root, manifest: missingGeneratorRecord }).failure)
    .toContain("configured post-journal preparer(s) missing from plan: route-stubs");

  const simulation = await simulatePlan({ config, rootDir: root, manifest });
  expect(simulation.ok, JSON.stringify(simulation, null, 2)).toBe(true);
  expect(simulation.regeneration?.artifacts).toContainEqual(expect.objectContaining({
    path: "apps/web/src/routes.ts",
    changed: true,
    exitCode: 0,
  }));
}, 300_000);

test("continues to reject a genuinely computed module reference inside moved production code", async () => {
  const root = workspace();
  write(
    root,
    CHART,
    'const modulePath = `./renderers/${name}.ts`;\nexport const renderChart = () => import(modulePath);\n',
  );
  const { config } = await loadConfig({ cwd: root });
  const graph = await scanDependencyGraph({ config, rootDir: root, noCache: true });
  const candidate = buildPortfolio({ config, graph }).candidates.find((entry) => entry.files.includes(CHART));

  expect(candidate?.rejectionReasons).toContainEqual(expect.objectContaining({
    code: "unsupported-module-reference",
    edges: expect.arrayContaining([CHART]),
  }));
  expect(candidate?.eligible).toBe(false);
});
