import { afterAll, describe, expect, test } from "bun:test";

import { parseConfig } from "../src/config.ts";
import { buildDependencyGraph } from "../src/graph/build.ts";
import { buildPlanSync } from "../src/plan/build.ts";
import { validatePlan } from "../src/plan/validate.ts";
import { partitionTests } from "../src/plan/consumers.ts";
import { WorkspaceContext } from "../src/plan/context.ts";
import { buildPortfolio } from "../src/portfolio/rank.ts";
import { cleanupFixtures, fixtureGit, fixtureRepo, read } from "./support/fixture-repo.ts";
import { executeJournal } from "../src/transaction/journal.ts";
import { hashText } from "../src/util/hash.ts";

const sourceRoot = "apps/api/src";
const config = () =>
  parseConfig({
    applications: [{ name: "api", sourceRoot, tsconfig: "apps/api/tsconfig.json", packageName: "@acme/api" }],
    packageRoots: ["libs"],
    testPathPatterns: ["\\.test\\.ts$"],
    assetExtensions: [".css"],
    testRelocation: { strategy: "self-contained" },
    portfolio: { minFiles: 1 },
    scaffoldTemplates: { packageJson: { contents: "{}" } },
  });

function context(files: Record<string, string>): WorkspaceContext {
  const root = fixtureRepo({
    "package.json": "{}\n",
    "apps/api/package.json": "{}\n",
    "apps/api/tsconfig.json": '{"compilerOptions":{"moduleResolution":"bundler"}}\n',
    ...files,
  });
  return new WorkspaceContext(config(), root);
}

afterAll(cleanupFixtures);

describe("self-contained test relocation", () => {
  test("classifies unit, integration, and e2e tests mutually exclusively and only travels units", () => {
    const configured = parseConfig({
      applications: [{ name: "api", sourceRoot, tsconfig: "apps/api/tsconfig.json", packageName: "@acme/api" }],
      packageRoots: ["libs"],
      testKinds: { unit: ["\\.unit\\.ts$"], integration: ["\\.integration\\.ts$"], e2e: ["\\.e2e\\.ts$"] },
      portfolio: { minFiles: 1 },
      scaffoldTemplates: { packageJson: { contents: "{}" } },
    });
    const root = fixtureRepo({
      "package.json": "{}\n", "apps/api/package.json": "{}\n", "apps/api/tsconfig.json": "{}\n",
      [`${sourceRoot}/unit.ts`]: "export const unit = 1;\n",
      [`${sourceRoot}/unit.unit.ts`]: 'import { unit } from "./unit.ts"; void unit;\n',
      [`${sourceRoot}/unit.integration.ts`]: 'import { unit } from "./unit.ts"; void unit;\n',
      [`${sourceRoot}/unit.e2e.ts`]: 'import { unit } from "./unit.ts"; void unit;\n',
    });
    const workspace = new WorkspaceContext(configured, root);
    expect(workspace.testKind(`${sourceRoot}/unit.unit.ts`)).toBe("unit");
    expect(workspace.testKind(`${sourceRoot}/unit.integration.ts`)).toBe("integration");
    expect(workspace.testKind(`${sourceRoot}/unit.e2e.ts`)).toBe("e2e");
    expect(partitionTests(workspace, [`${sourceRoot}/unit.ts`], [`${sourceRoot}/unit.unit.ts`, `${sourceRoot}/unit.integration.ts`, `${sourceRoot}/unit.e2e.ts`], [])).toEqual({
      travelling: [`${sourceRoot}/unit.unit.ts`],
      retained: [`${sourceRoot}/unit.e2e.ts`, `${sourceRoot}/unit.integration.ts`],
    });
  });

  test("refuses a path matching more than one configured test kind", () => {
    expect(() => parseConfig({
      applications: [{ name: "api", sourceRoot, tsconfig: "apps/api/tsconfig.json" }], packageRoots: ["libs"],
      testKinds: { unit: ["test"], integration: ["test"], e2e: [] }, scaffoldTemplates: { packageJson: { contents: "{}" } },
    })).toThrow("must not repeat a pattern across test kinds");
  });

  test("refuses mixing legacy and typed test classifiers", () => {
    expect(() => parseConfig({
      applications: [{ name: "api", sourceRoot, tsconfig: "apps/api/tsconfig.json" }], packageRoots: ["libs"],
      testPathPatterns: ["\\.test\\.ts$"], testKinds: { unit: ["\\.unit\\.ts$"], integration: [], e2e: [] },
      scaffoldTemplates: { packageJson: { contents: "{}" } },
    })).toThrow("cannot be combined with legacy testPathPatterns");
  });
  test("retains a test that reaches app code outside the production closure", () => {
    const workspace = context({
      [`${sourceRoot}/unit.ts`]: "export const unit = 1;\n",
      [`${sourceRoot}/shell.ts`]: "export const shell = 1;\n",
      [`${sourceRoot}/unit.test.ts`]: 'import { unit } from "./unit.ts"; import { shell } from "./shell.ts"; import "undeclared-test-only"; void unit; void shell;\n',
    });
    expect(partitionTests(workspace, [`${sourceRoot}/unit.ts`], [`${sourceRoot}/unit.test.ts`], [])).toEqual({
      travelling: [],
      retained: [`${sourceRoot}/unit.test.ts`],
    });
  });

  test("moves a test whose complete first-party import set is in the closure", () => {
    const workspace = context({
      [`${sourceRoot}/unit.ts`]: "export const unit = 1;\n",
      [`${sourceRoot}/unit.test.ts`]: 'import { unit } from "./unit.ts"; void unit;\n',
    });
    expect(partitionTests(workspace, [`${sourceRoot}/unit.ts`], [`${sourceRoot}/unit.test.ts`], [])).toEqual({
      travelling: [`${sourceRoot}/unit.test.ts`],
      retained: [],
    });
  });

  test("retains a private test helper imported by a retained test", () => {
    const workspace = context({
      [`${sourceRoot}/unit.ts`]: "export const unit = 1;\n",
      [`${sourceRoot}/shell.ts`]: "export const shell = 1;\n",
      [`${sourceRoot}/test-support.test.ts`]: 'import { unit } from "./unit.ts"; export { unit };\n',
      [`${sourceRoot}/consumer.test.ts`]: 'import { unit } from "./unit.ts"; import { shell } from "./shell.ts"; import "./test-support.test.ts"; void unit; void shell;\n',
    });
    expect(partitionTests(
      workspace,
      [`${sourceRoot}/unit.ts`],
      [`${sourceRoot}/consumer.test.ts`, `${sourceRoot}/test-support.test.ts`],
      [],
    )).toEqual({
      travelling: [],
      retained: [`${sourceRoot}/consumer.test.ts`, `${sourceRoot}/test-support.test.ts`],
    });
  });

  test("refuses a retained test that imports a moved production asset", () => {
    const workspace = context({
      [`${sourceRoot}/unit.ts`]: "export const unit = 1;\n",
      [`${sourceRoot}/shell.ts`]: "export const shell = 1;\n",
      [`${sourceRoot}/unit.css`]: ".unit {}\n",
      [`${sourceRoot}/unit.test.ts`]: 'import "./unit.css"; import { shell } from "./shell.ts"; void shell;\n',
    });
    expect(() => partitionTests(workspace, [`${sourceRoot}/unit.ts`], [`${sourceRoot}/unit.test.ts`], [`${sourceRoot}/unit.css`])).toThrow(
      "retained test apps/api/src/unit.test.ts imports moved asset apps/api/src/unit.css",
    );
  });

  test("retains rather than moving a test with a relative asset outside the moved set", () => {
    const workspace = context({
      [`${sourceRoot}/unit.ts`]: "export const unit = 1;\n",
      [`${sourceRoot}/fixture.css`]: ".fixture {}\n",
      [`${sourceRoot}/unit.test.ts`]: 'import { unit } from "./unit.ts"; import "./fixture.css"; void unit;\n',
    });
    expect(partitionTests(workspace, [`${sourceRoot}/unit.ts`], [`${sourceRoot}/unit.test.ts`], [])).toEqual({
      travelling: [],
      retained: [`${sourceRoot}/unit.test.ts`],
    });
  });

  test("refuses a computed reference rather than retaining an unauditable test", () => {
    const workspace = context({
      [`${sourceRoot}/unit.ts`]: "export const unit = 1;\n",
      [`${sourceRoot}/unit.test.ts`]: 'const target = "./unit.ts"; void import(target);\n',
    });
    expect(() => partitionTests(workspace, [`${sourceRoot}/unit.ts`], [`${sourceRoot}/unit.test.ts`], [])).toThrow(
      "unsupported module reference in test importer",
    );
  });

  test("retains a test with a literal dynamic import for a deterministic consumer rewrite", () => {
    const workspace = context({
      [`${sourceRoot}/unit.ts`]: "export const unit = 1;\n",
      [`${sourceRoot}/shell.ts`]: "export const shell = 1;\n",
      [`${sourceRoot}/unit.test.ts`]: 'void import("./unit.ts"); import { shell } from "./shell.ts"; void shell;\n',
    });
    expect(partitionTests(workspace, [`${sourceRoot}/unit.ts`], [`${sourceRoot}/unit.test.ts`], [])).toEqual({
      travelling: [],
      retained: [`${sourceRoot}/unit.test.ts`],
    });
  });

  test("retains a default-strategy test with app-local support and compiles its donor rewrite", async () => {
    const files = {
      [`${sourceRoot}/unit.ts`]: "export const unit = 1;\n",
      [`${sourceRoot}/shell.ts`]: "export const shell = 1;\n",
      [`${sourceRoot}/unit.test.ts`]: 'vi.mock("./unit.ts", () => ({ unit: 2 })); import { shell } from "./shell.ts"; void shell;\n',
    };
    const root = fixtureRepo({
      "package.json": '{"private":true}\n',
      "pnpm-workspace.yaml": "packages:\n  - apps/*\n  - libs/*\n",
      "apps/api/package.json": '{"name":"@acme/api"}\n',
      "apps/api/tsconfig.json": '{"compilerOptions":{"moduleResolution":"bundler"}}\n',
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n\n  apps/api: {}\n",
      ...files,
    });
    const configured = parseConfig({
      applications: [{ name: "api", sourceRoot, tsconfig: "apps/api/tsconfig.json", packageName: "@acme/api" }],
      packageRoots: ["libs"],
      testPathPatterns: ["\\.test\\.ts$"],
      assetExtensions: [".css"],
      moduleSpecifierCalls: ["vi.mock"],
      portfolio: { minFiles: 1 },
      scaffoldTemplates: {
        packageJson: { contents: "{}" },
        publicSurface: { mode: "subpaths", keyTemplate: "./{pathNoExtension}", targetTemplate: "./src/{path}" },
      },
    });
    const graph = buildDependencyGraph({
      config: configured,
      rootDir: root,
      commit: fixtureGit(root, "rev-parse", "HEAD").trim(),
      reports: { api: { modules: Object.keys(files).map((source) => ({ source, dependencies: source.endsWith("unit.test.ts") ? [
        { module: "./unit.ts", resolved: `${sourceRoot}/unit.ts` },
        { module: "./shell.ts", resolved: `${sourceRoot}/shell.ts` },
      ] : [] })) } },
    });
    const candidate = buildPortfolio({ config: configured, graph }).candidates.find((entry) => entry.files.includes(`${sourceRoot}/unit.ts`));
    expect(candidate?.eligible).toBe(true);
    const manifest = buildPlanSync({ config: configured, rootDir: root, graph, candidate: candidate!, baselineCommit: graph.commit!, packageName: "unit" });
    expect(validatePlan(manifest, { config: configured, rootDir: root })).toMatchObject({ ok: true });
    expect(manifest.source.tests).toEqual([]);
    expect(manifest.consumers).toContainEqual(expect.objectContaining({
      file: `${sourceRoot}/unit.test.ts`,
      dependencySection: "dev",
      specifiers: [{ from: "./unit.ts", to: "unit/unit", donor: `${sourceRoot}/unit.ts` }],
    }));
    const appManifest = manifest.operations.find((operation) => operation.kind === "write-file" && operation.path === "apps/api/package.json");
    expect(appManifest?.kind === "write-file" && appManifest.contents).toContain('"devDependencies": {\n    "unit": "workspace:*"');
    // Failure after the retained-test rewrite must restore that rewrite and the
    // prior moves: otherwise self-contained retention would violate the same
    // no-partial-application contract as ordinary consumers.
    const rewriteIndex = manifest.operations.findIndex((operation) => operation.kind === "rewrite-import" && operation.file.endsWith("unit.test.ts"));
    expect(rewriteIndex).toBeGreaterThan(0);
    expect(manifest.operations[rewriteIndex]).toMatchObject({
      kind: "rewrite-import",
      resultHash: hashText('vi.mock("unit/unit", () => ({ unit: 2 })); import { shell } from "./shell.ts"; void shell;\n'),
    });
    const beforeTest = read(root, `${sourceRoot}/unit.test.ts`);
    process.env.MONOCARVE_FAIL_OPERATION = String(rewriteIndex);
    try {
      await expect(executeJournal({ config: configured, treeRoot: root, manifest })).rejects.toThrow(`injected operation failure ${rewriteIndex}`);
    } finally {
      delete process.env.MONOCARVE_FAIL_OPERATION;
    }
    expect(read(root, `${sourceRoot}/unit.test.ts`)).toBe(beforeTest);
    expect(read(root, `${sourceRoot}/unit.ts`)).toBe(files[`${sourceRoot}/unit.ts`]);
  });

  test("keeps a closure-contained test travelling in the compiled manifest", () => {
    const files = {
      [`${sourceRoot}/unit.ts`]: "export const unit = 1;\n",
      [`${sourceRoot}/unit.test.ts`]: 'import { unit } from "./unit.ts"; void unit;\n',
    };
    const root = fixtureRepo({
      "package.json": '{"private":true}\n',
      "pnpm-workspace.yaml": "packages:\n  - apps/*\n  - libs/*\n",
      "apps/api/package.json": '{"name":"@acme/api"}\n',
      "apps/api/tsconfig.json": '{"compilerOptions":{"moduleResolution":"bundler"}}\n',
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n\n  apps/api: {}\n",
      ...files,
    });
    const configured = parseConfig({
      applications: [{ name: "api", sourceRoot, tsconfig: "apps/api/tsconfig.json", packageName: "@acme/api" }],
      packageRoots: ["libs"],
      testPathPatterns: ["\\.test\\.ts$"],
      portfolio: { minFiles: 1 },
      scaffoldTemplates: { packageJson: { contents: "{}" } },
    });
    const graph = buildDependencyGraph({
      config: configured,
      rootDir: root,
      commit: fixtureGit(root, "rev-parse", "HEAD").trim(),
      reports: { api: { modules: [
        { source: `${sourceRoot}/unit.ts`, dependencies: [] },
        { source: `${sourceRoot}/unit.test.ts`, dependencies: [{ module: "./unit.ts", resolved: `${sourceRoot}/unit.ts` }] },
      ] } },
    });
    const candidate = buildPortfolio({ config: configured, graph }).candidates.find((entry) => entry.files.includes(`${sourceRoot}/unit.ts`));
    expect(candidate?.eligible).toBe(true);
    const manifest = buildPlanSync({ config: configured, rootDir: root, graph, candidate: candidate!, baselineCommit: graph.commit!, packageName: "unit" });
    expect(manifest.source.tests).toEqual([`${sourceRoot}/unit.test.ts`]);
    expect(manifest.operations).toContainEqual(expect.objectContaining({
      kind: "move",
      source: `${sourceRoot}/unit.test.ts`,
      target: "libs/unit/src/unit.test.ts",
    }));
    expect(manifest.consumers.some((consumer) => consumer.file === `${sourceRoot}/unit.test.ts`)).toBe(false);
    expect(validatePlan(manifest, { config: configured, rootDir: root })).toMatchObject({ ok: true });
  });

  test("keeps a production closure escape fail-closed", () => {
    const files = {
      [`${sourceRoot}/unit.ts`]: 'import { shell } from "./shell.ts"; export const unit = shell;\n',
      [`${sourceRoot}/shell.ts`]: "export const shell = 1;\n",
    };
    const root = fixtureRepo({
      "package.json": "{}\n",
      "apps/api/package.json": "{}\n",
      "apps/api/tsconfig.json": '{"compilerOptions":{"moduleResolution":"bundler"}}\n',
      ...files,
    });
    const configured = config();
    const graph = buildDependencyGraph({
      config: configured,
      rootDir: root,
      commit: fixtureGit(root, "rev-parse", "HEAD").trim(),
      reports: { api: { modules: Object.keys(files).map((source) => ({ source, dependencies: [] })) } },
    });
    const candidate = buildPortfolio({ config: configured, graph }).candidates.find(
      (entry) => entry.files.length === 1 && entry.files[0] === `${sourceRoot}/unit.ts`,
    );
    expect(candidate?.rejectionReasons).toContainEqual({
      code: "closure-escapes-app-code",
      detail: "1 relative import(s) leave the closure for code no package exports",
      edges: [`${sourceRoot}/unit.ts -> ./shell.ts`],
    });
    expect(candidate?.eligible).toBe(false);
  });

  test("profiles change target, scaffold, gates, and manifest identity without colliding", () => {
    const files = {
      [`${sourceRoot}/unit.ts`]: "export const unit = 1;\n",
      [`${sourceRoot}/unit.test.ts`]: 'import { unit } from "./unit.ts"; void unit;\n',
    };
    const root = fixtureRepo({
      "package.json": '{"private":true}\n',
      "pnpm-workspace.yaml": "packages:\n  - apps/*\n  - libs/*\n  - test-libs/*\n  - helpers/*\n",
      "apps/api/package.json": '{"name":"@acme/api"}\n',
      "apps/api/tsconfig.json": '{"compilerOptions":{"moduleResolution":"bundler"}}\n',
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n\n  apps/api: {}\n",
      ...files,
    });
    const configured = parseConfig({
      applications: [{ name: "api", sourceRoot, tsconfig: "apps/api/tsconfig.json", packageName: "@acme/api" }],
      packageRoots: ["libs", "test-libs", "helpers"],
      packageScope: "@acme/",
      testPathPatterns: ["\\.test\\.ts$"],
      portfolio: { minFiles: 1 },
      scaffoldTemplates: { packageJson: { contents: '{"name":"legacy"}' } },
      gates: { package: ["test -d {packageRoot}"] },
      extractionProfiles: {
        default: "testing",
        profiles: {
          testing: {
            destinationRoot: "test-libs",
            directoryTemplate: "{app}-{name}",
            packageNameTemplate: "{scope}{app}-{name}",
            projectIdTemplate: "project-{name}",
            scaffoldTemplates: { packageJson: { contents: '{"name":"profile"}' } },
            gates: { package: ["test -f {packageRoot}/package.json"] },
          },
          helper: {
            destinationRoot: "helpers",
            directoryTemplate: "{name}",
            packageNameTemplate: "{scope}helper-{name}",
            gates: { package: ["test -d {packageRoot}"] },
          },
        },
      },
    });
    const graph = buildDependencyGraph({
      config: configured,
      rootDir: root,
      commit: fixtureGit(root, "rev-parse", "HEAD").trim(),
      reports: { api: { modules: Object.keys(files).map((source) => ({ source, dependencies: [] })) } },
    });
    const candidate = buildPortfolio({ config: configured, graph }).candidates.find((entry) => entry.files.includes(`${sourceRoot}/unit.ts`));
    expect(candidate).toBeDefined();

    const defaultProfile = buildPlanSync({ config: configured, rootDir: root, graph, candidate: candidate!, baselineCommit: graph.commit! });
    const helper = buildPlanSync({ config: configured, rootDir: root, graph, candidate: candidate!, baselineCommit: graph.commit!, profile: "helper" });
    expect(defaultProfile.target).toMatchObject({
      packageName: "@acme/api-root",
      packageRoot: "test-libs/api-root",
      projectId: "project-root",
      profile: { name: "testing", candidateName: "root" },
    });
    expect(defaultProfile.operations).toContainEqual(expect.objectContaining({ kind: "write-file", path: "test-libs/api-root/package.json", contents: expect.stringContaining('"name": "profile"') }));
    expect(defaultProfile.gates.package).toEqual(["test -f test-libs/api-root/package.json"]);
    expect(defaultProfile.planId).toBe(`${candidate!.id}--testing`);
    expect(helper.planId).toBe(`${candidate!.id}--helper`);
    expect(helper.target.packageRoot).toBe("helpers/root");

    expect(validatePlan(defaultProfile, { config: configured, rootDir: root })).toMatchObject({ ok: true });

    const forged = { ...defaultProfile, target: { ...defaultProfile.target, packageRoot: "libs/forged" } };
    expect(validatePlan(forged, { config: configured, rootDir: root, offline: true })).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ rule: "target-profile" })]),
    });
    const forgedGates = { ...defaultProfile, gates: { ...defaultProfile.gates, package: ["false"] } };
    expect(validatePlan(forgedGates, { config: configured, rootDir: root })).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ rule: "target-profile-gates" })]),
    });
    const forgedScaffold = {
      ...defaultProfile,
      operations: defaultProfile.operations.map((operation) =>
        operation.kind === "write-file" && operation.generator === "scaffold:package-json"
          ? { ...operation, contents: '{"tampered":true}\n' }
          : operation,
      ),
    };
    expect(validatePlan(forgedScaffold, { config: configured, rootDir: root })).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ rule: "target-profile-scaffold" })]),
    });
    // The package's importer is part of the profile-produced package shape:
    // mutating it independently of package.json must fail the same proof.
    const forgedImporter = {
      ...defaultProfile,
      operations: defaultProfile.operations.map((operation) =>
        operation.kind === "lockfile-importer" && operation.packageRoot === defaultProfile.target.packageRoot
          ? { ...operation, block: `${operation.block}# forged dev importer\n` }
          : operation,
      ),
    };
    expect(validatePlan(forgedImporter, { config: configured, rootDir: root })).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ rule: "target-profile-scaffold" })]),
    });
    expect(() => buildPlanSync({ config: configured, rootDir: root, graph, candidate: candidate!, baselineCommit: graph.commit!, profile: "helper", packageName: "@acme/nope" })).toThrow(
      "cannot override a selected extraction profile",
    );
  });
});
