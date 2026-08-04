import { afterAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";

import { parseConfig } from "../src/config.ts";
import { buildDependencyGraph } from "../src/graph/build.ts";
import { buildIntegrationTestPlanSync } from "../src/plan/integration-tests.ts";
import { validatePlan } from "../src/plan/validate.ts";
import { executeJournal } from "../src/transaction/journal.ts";
import { auditPlanSync } from "../src/transaction/audit.ts";
import { hashText } from "../src/util/hash.ts";
import { cleanupFixtures, fixtureGit, fixtureRepo, read } from "./support/fixture-repo.ts";

const testPath = "tests/integration/api.test.ts";
const donorPath = "apps/api/src/testing.ts";

function config() {
  return parseConfig({
    packageScope: "@acme/",
    applications: [{ name: "api", sourceRoot: "apps/api/src", tsconfig: "apps/api/tsconfig.json", packageName: "@acme/api" }],
    packageRoots: ["libs", "tests"],
    testKinds: { unit: [], integration: ["\\.test\\.ts$"], e2e: [] },
    scaffoldTemplates: { packageJson: { contents: '{"name":"{package}"}' } },
    extractionProfiles: {
      profiles: {
        integration: {
          kind: "leaf-test",
          destinationRoot: "tests",
          directoryTemplate: "{name}",
          packageNameTemplate: "{scope}it-{name}",
          gates: { package: ["test -f {packageRoot}/src/api.test.ts"] },
        },
      },
    },
    integrationTestSuites: {
      api: {
        application: "api",
        profile: "integration",
        sourceRoot: "tests/integration",
        patterns: ["\\.test\\.ts$"],
        donorImports: [{ source: donorPath, specifier: "@acme/api/testing" }],
      },
    },
  });
}

function workspace(testSource = 'import { helper } from "../../apps/api/src/testing.ts"; expect(helper).toBe(1);\n') {
  const root = fixtureRepo({
    "package.json": '{"private":true}\n',
    "pnpm-workspace.yaml": "packages:\n  - apps/*\n  - libs/*\n  - tests/*\n",
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n\n  apps/api: {}\n",
    "apps/api/package.json": '{"name":"@acme/api","exports":{"./testing":"./src/testing.ts"}}\n',
    "apps/api/tsconfig.json": '{"compilerOptions":{"moduleResolution":"bundler"}}\n',
    [donorPath]: "export const helper = 1;\n",
    "apps/api/src/private.ts": "export const privateValue = 1;\n",
    [testPath]: testSource,
  });
  const configured = config();
  const graph = buildDependencyGraph({
    config: configured,
    rootDir: root,
    commit: fixtureGit(root, "rev-parse", "HEAD"),
    reports: { api: { modules: [
      { source: donorPath, dependencies: [] },
      { source: testPath, dependencies: [{ module: "../../apps/api/src/testing.ts", resolved: donorPath }] },
    ] } },
  });
  return { root, configured, graph };
}

afterAll(cleanupFixtures);

describe("integration-test relocation", () => {
  test("moves a declared leaf suite and rewrites only its configured donor surface", async () => {
    const { root, configured, graph } = workspace();
    const manifest = buildIntegrationTestPlanSync({ config: configured, rootDir: root, graph, suite: "api", baselineCommit: graph.commit! });

    expect(manifest.source).toEqual({ files: [], tests: [testPath], sccs: {} });
    expect(manifest.target).toMatchObject({ packageName: "@acme/it-api", packageRoot: "tests/api", requiredExports: [] });
    expect(manifest.dependencies).toMatchObject({ runtime: {}, dev: { "@acme/api": "workspace:*" } });
    expect(manifest.operations).toContainEqual(expect.objectContaining({ kind: "move-with-rewrite", source: testPath, target: "tests/api/src/api.test.ts", rewrites: [{ donorlessSpecifier: "../../apps/api/src/testing.ts", packageSpecifier: "@acme/api/testing" }] }));
    expect(validatePlan(manifest, { config: configured, rootDir: root })).toMatchObject({ ok: true });

    await executeJournal({ config: configured, treeRoot: root, manifest });
    expect(read(root, "tests/api/src/api.test.ts")).toContain('from "@acme/api/testing"');
    expect(read(root, "tests/api/package.json")).toContain('"@acme/api": "workspace:*"');
    expect(auditPlanSync({ config: configured, rootDir: root, manifest, skipCompileProof: true }).passed).toBe(true);
  });

  test("moves local source helpers and declared assets with their integration root", () => {
    const { root, configured, graph } = workspace('import { helper } from "./helper.ts"; import fixture from "./fixture.json"; void fixture; expect(helper).toBe(1);\n');
    writeFileSync(`${root}/tests/integration/helper.ts`, 'export const helper = 1;\n');
    writeFileSync(`${root}/tests/integration/fixture.json`, '{"ok":true}\n');
    const withAssets = parseConfig({ ...configured, assetExtensions: [".json"], testKinds: { unit: [], integration: ["tests/integration/"], e2e: [] } });
    const manifest = buildIntegrationTestPlanSync({ config: withAssets, rootDir: root, graph, suite: "api", baselineCommit: graph.commit! });
    expect(manifest.source.tests).toEqual(["tests/integration/api.test.ts", "tests/integration/helper.ts"]);
    expect(manifest.source.assets).toEqual(["tests/integration/fixture.json"]);
    expect(validatePlan(manifest, { config: withAssets, rootDir: root })).toMatchObject({ ok: true });
    const omitted = { ...manifest, source: { ...manifest.source, tests: ["tests/integration/api.test.ts"], assets: [] } };
    expect(validatePlan(omitted, { config: withAssets, rootDir: root })).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ rule: "integration-test-suite", message: expect.stringContaining("complete closure") })]),
    });
  });

  test("refuses an undeclared relative application target", () => {
    const { root, configured, graph } = workspace('import "../../apps/api/src/private.ts";\n');
    expect(() => buildIntegrationTestPlanSync({ config: configured, rootDir: root, graph, suite: "api", baselineCommit: graph.commit! })).toThrow(
      "reaches undeclared relative target apps/api/src/private.ts",
    );
  });

  test("refuses a donor source that its application does not publish", () => {
    const { root, configured, graph } = workspace();
    // The source exists, so this specifically proves the package export check.
    writeFileSync(`${root}/apps/api/package.json`, '{"name":"@acme/api"}\n');
    expect(() => buildIntegrationTestPlanSync({ config: configured, rootDir: root, graph, suite: "api", baselineCommit: graph.commit! })).toThrow(
      "does not publish apps/api/src/testing.ts",
    );
  });

  test("refuses dynamic or bare donor imports outside the configured surface", () => {
    const dynamic = workspace('void import("../../apps/api/src/testing.ts");\n');
    expect(() => buildIntegrationTestPlanSync({ config: dynamic.configured, rootDir: dynamic.root, graph: dynamic.graph, suite: "api", baselineCommit: dynamic.graph.commit! })).toThrow(
      "dynamic donor application import",
    );
    const bare = workspace('import "@acme/api/private";\n');
    expect(() => buildIntegrationTestPlanSync({ config: bare.configured, rootDir: bare.root, graph: bare.graph, suite: "api", baselineCommit: bare.graph.commit! })).toThrow(
      "imports undeclared donor application surface @acme/api/private",
    );
    const dynamicBare = workspace('void import("@acme/api/testing");\n');
    expect(() => buildIntegrationTestPlanSync({ config: dynamicBare.configured, rootDir: dynamicBare.root, graph: dynamicBare.graph, suite: "api", baselineCommit: dynamicBare.graph.commit! })).toThrow(
      "dynamic donor application import @acme/api/testing",
    );
  });

  test("refuses a forged donor allowance during validation", () => {
    const { root, configured, graph } = workspace();
    const manifest = buildIntegrationTestPlanSync({ config: configured, rootDir: root, graph, suite: "api", baselineCommit: graph.commit! });
    const forged = { ...manifest, integrationTestSuite: { ...manifest.integrationTestSuite!, donorImports: [] } };
    expect(validatePlan(forged, { config: configured, rootDir: root, offline: true })).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ rule: "integration-test-suite" })]),
    });
  });

  test("refuses a forged rewrite to an unapproved donor source before apply", () => {
    const { root, configured, graph } = workspace();
    const manifest = buildIntegrationTestPlanSync({ config: configured, rootDir: root, graph, suite: "api", baselineCommit: graph.commit! });
    const forged = {
      ...manifest,
      operations: manifest.operations.map((operation) =>
        operation.kind === "move-with-rewrite"
          ? { ...operation, rewrites: [{ donorlessSpecifier: "../../apps/api/src/private.ts", packageSpecifier: "@acme/api/testing" }], resultHash: hashText('import { helper } from "@acme/api/testing"; expect(helper).toBe(1);\n') }
          : operation,
      ),
    };
    expect(validatePlan(forged, { config: configured, rootDir: root })).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ rule: "integration-test-suite" })]),
    });
  });
});
