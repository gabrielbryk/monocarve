/**
 * Literal dynamic imports are rewritable consumers, not an inherently unsafe
 * extraction shape. The plausible regression is either rejecting the donor
 * merely because it has a lazy consumer, or rewriting `import()` without
 * declaring the exact old/new specifier evidence the audit needs. This fixture
 * proves both properties from a real scanner report.
 */

import { afterAll, expect, test } from "bun:test";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/config.ts";
import { scanDependencyGraph } from "../src/graph/cruiser.ts";
import { buildPlanSync, serializeManifest } from "../src/plan/build.ts";
import { findConsumers } from "../src/plan/consumers.ts";
import { WorkspaceContext } from "../src/plan/context.ts";
import { buildPortfolio } from "../src/portfolio/rank.ts";
import { applyPlan } from "../src/transaction/apply.ts";
import { auditPlanSync } from "../src/transaction/audit.ts";
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

test("allows computed artifact imports only in configured test consumers across planning and portfolio", async () => {
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
  expect(() => findConsumers(productionContext, [CHART], "@acme/chart")).toThrow(
    `unsupported module reference in consumer ${LAZY}`,
  );
  expect(productionCandidate?.rejectionReasons).toContainEqual(
    expect.objectContaining({
      code: "unplannable",
      detail: expect.stringContaining(`unsupported module reference in consumer ${LAZY}`),
    }),
  );
  expect(productionCandidate?.eligible).toBe(false);
});
