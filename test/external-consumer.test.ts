/**
 * The external-consumer proof has to compile from outside the package it is
 * checking. These fixtures exercise the resolution routes that ordinary
 * workspace typechecks can accidentally hide: a published workspace subpath,
 * a JavaScript-only dependency with DefinitelyTyped declarations, an ambient
 * profile type, and bundler's extensionless relative imports.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { rmSync } from "node:fs";

import { parseConfig, type MonocarveConfig } from "../src/config.ts";
import { compileExternalConsumer } from "../src/transaction/external-consumer.ts";
import type { ExtractionManifest } from "../src/plan/manifest.ts";
import { cleanupFixtures, fixtureRepo, write } from "./support/fixture-repo.ts";

const TARGET_NAME = "@acme/carved";
const TARGET_ROOT = "libs/carved";

function packageJson(value: Record<string, unknown>): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function manifest(requiredExports: ExtractionManifest["target"]["requiredExports"] = [{ name: "combined", typeOnly: false }]): ExtractionManifest {
  return {
    schemaVersion: 2,
    planId: "external-consumer-fixture",
    createdAt: "2020-01-01T00:00:00.000Z",
    generator: { name: "test", version: "0" },
    baselineCommit: "fixture",
    graphDigest: "0".repeat(64),
    application: "donor",
    target: {
      packageName: TARGET_NAME,
      packageRoot: TARGET_ROOT,
      entrypoint: "src/index.ts",
      requiredExports,
    },
    source: { files: [], tests: [], sccs: {} },
    dependencies: { runtime: {}, dev: {}, packageReferences: [] },
    sourceBlobs: {},
    operations: [],
    consumers: [],
    generatedFiles: [],
    changedFiles: [],
    expectedDynamicImportDelta: { added: [], removed: [] },
    evaluationEffects: [],
    metrics: { movedFiles: 0, movedLines: 0, applicationLinesBefore: 0, applicationLinesAfter: 0, consumers: 0 },
    commits: { move: { subject: "move" }, wiring: { subject: "wire" } },
    gates: { package: [], project: [], workspace: [] },
  };
}

function config(moduleResolution: "nodenext" | "bundler" = "bundler", types: readonly string[] = ["ambient-only"], interop = false): MonocarveConfig {
  return parseConfig(
    {
      applications: [
        {
          name: "donor",
          sourceRoot: "apps/donor/src",
          tsconfig: "apps/donor/tsconfig.json",
          packageName: "@acme/donor",
          compositionRoots: [],
          compilerProfile: { lib: ["lib.es2022.d.ts"], types: [...types], jsx: false, moduleResolution, esModuleInterop: interop, allowSyntheticDefaultImports: interop },
        },
      ],
      packageRoots: ["libs"],
      packageScope: "@acme/",
      packageManager: "pnpm",
      taskRunner: "none",
      guardedBranches: [],
      gates: { package: [], project: [], workspace: [] },
      commitTemplates: { plan: "plan {planId}", move: "move {package}", wiring: "wire {package}", trailer: "" },
      scaffoldTemplates: { packageJson: { contents: "{}\n" } },
      transaction: { worktreeRoot: ".scratch", nodeModules: "none", cleanup: true, simulateGates: true },
    },
    "<external-consumer-fixture>",
  );
}

function proofFixture(): { readonly root: string; readonly config: MonocarveConfig; readonly manifest: ExtractionManifest } {
  const root = fixtureRepo({
    "package.json": packageJson({ name: "fixture-root", private: true }),
    "apps/donor/package.json": packageJson({
      name: "@acme/donor",
      private: true,
      dependencies: {
        "adjacent-declarations": "1.0.0",
        "legacy-default": "1.0.0",
        "legacy-typed": "1.0.0",
        "plain-runtime": "1.0.0",
      },
    }),
    "apps/donor/tsconfig.json": packageJson({ compilerOptions: {}, include: ["src"] }),
    "libs/carved/package.json": packageJson({
      name: TARGET_NAME,
      type: "module",
      exports: { ".": { types: "./src/index.ts", import: "./src/index.ts" } },
    }),
    // This import must use the workspace package's declared `./feature`
    // export. No node_modules copy exists, so missing the subpath mapping
    // genuinely makes the synthetic external consumer fail.
    "libs/carved/src/index.ts": [
      'import { feature } from "@acme/utility/feature";',
      'import { runtimeValue } from "plain-runtime";',
      'import { legacyValue } from "legacy-typed";',
      'import { adjacentValue } from "adjacent-declarations";',
      "export const combined = `${feature}:${runtimeValue}:${legacyValue}:${adjacentValue}:${ambientSignal}`;",
      'export { bundled } from "./bundled";',
      "",
    ].join("\n"),
    "libs/carved/src/bundled.ts": "export const bundled = true;\n",
    "libs/utility/package.json": packageJson({
      name: "@acme/utility",
      exports: {
        ".": { types: "./src/index.ts", import: "./src/index.ts" },
        "./feature": { types: "./src/feature.ts", import: "./src/feature.ts" },
      },
    }),
    "libs/utility/src/index.ts": "export const root = true;\n",
    "libs/utility/src/feature.ts": 'export const feature = "feature";\n',
    "apps/donor/node_modules/plain-runtime/package.json": packageJson({ name: "plain-runtime", main: "./index.js" }),
    "apps/donor/node_modules/plain-runtime/index.js": "exports.runtimeValue = 1;\n",
    "apps/donor/node_modules/legacy-typed/package.json": packageJson({ name: "legacy-typed", main: "./lib/index.js" }),
    "apps/donor/node_modules/legacy-typed/lib/index.js": "exports.legacyValue = 1;\n",
    "apps/donor/node_modules/legacy-typed/index.d.ts": "export const legacyValue: number;\n",
    "apps/donor/node_modules/adjacent-declarations/package.json": packageJson({
      name: "adjacent-declarations",
      type: "module",
      main: "./dist/index.mjs",
      exports: { ".": { import: "./dist/index.mjs", default: "./dist/index.mjs" } },
    }),
    "apps/donor/node_modules/adjacent-declarations/dist/index.mjs": "export const adjacentValue = 1;\n",
    "apps/donor/node_modules/adjacent-declarations/dist/index.d.mts": "export const adjacentValue: number;\n",
    "apps/donor/node_modules/@types/plain-runtime/package.json": packageJson({ name: "@types/plain-runtime", types: "./index.d.ts" }),
    "apps/donor/node_modules/@types/plain-runtime/index.d.ts": "export const runtimeValue: number;\n",
    "apps/donor/node_modules/@types/ambient-only/index.d.ts": "declare const ambientSignal: string;\n",
    "apps/donor/node_modules/@types/ambient-alternate/index.d.ts": "declare const alternateSignal: string;\n",
  });
  return { root, config: config(), manifest: manifest() };
}

function run(root: string, fixtureConfig: MonocarveConfig, fixtureManifest: ExtractionManifest) {
  return compileExternalConsumer({ config: fixtureConfig, manifest: fixtureManifest, rootDir: root });
}

describe("external consumer compile proof", () => {
  afterEach(cleanupFixtures);

  test("resolves workspace export subpaths, DefinitelyTyped JavaScript dependencies, ambient types, and bundler imports", () => {
    const fixture = proofFixture();
    const result = run(fixture.root, fixture.config, fixture.manifest);

    expect(result.passed).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });

  test("fails when a workspace package stops declaring the imported export subpath", () => {
    const fixture = proofFixture();
    write(
      fixture.root,
      "libs/utility/package.json",
      packageJson({ name: "@acme/utility", exports: { ".": { types: "./src/index.ts", import: "./src/index.ts" } } }),
    );

    const result = run(fixture.root, fixture.config, fixture.manifest);

    expect(result.passed).toBe(false);
    expect(result.diagnostics.join("\n")).toContain("@acme/utility/feature");
    expect(result.diagnostics[0]).toMatch(/\(\d+,\d+\): TS\d+:/);
  });

  test("fails when a JavaScript-only dependency loses its DefinitelyTyped declaration", () => {
    const fixture = proofFixture();
    rmSync(`${fixture.root}/apps/donor/node_modules/@types/plain-runtime`, { recursive: true, force: true });

    const result = run(fixture.root, fixture.config, fixture.manifest);

    expect(result.passed).toBe(false);
    expect(result.diagnostics.join("\n")).toContain("plain-runtime");
  });

  test("does not guess a mismatched declaration flavor beside an ESM entry", () => {
    const fixture = proofFixture();
    rmSync(`${fixture.root}/apps/donor/node_modules/adjacent-declarations/dist/index.d.mts`);
    write(
      fixture.root,
      "apps/donor/node_modules/adjacent-declarations/dist/index.d.ts",
      "export const adjacentValue: number;\n",
    );

    const result = run(fixture.root, fixture.config, fixture.manifest);

    expect(result.passed).toBe(false);
    expect(result.diagnostics.join("\n")).toContain("adjacent-declarations");
  });

  test("fails when the donor compiler profile omits the ambient type it needs", () => {
    const fixture = proofFixture();
    const result = run(fixture.root, config("bundler", ["ambient-alternate"]), fixture.manifest);

    expect(result.passed).toBe(false);
    expect(result.diagnostics.join("\n")).toContain("ambientSignal");
  });

  test("fails under NodeNext when the donor's bundler-resolved source uses extensionless imports", () => {
    const fixture = proofFixture();
    const result = run(fixture.root, config("nodenext"), fixture.manifest);

    expect(result.passed).toBe(false);
    expect(result.diagnostics.join("\n")).toContain("explicit file extensions");
  });

  test("reproduces the donor's configured CommonJS default-import interoperability", () => {
    const fixture = proofFixture();
    write(fixture.root, "libs/carved/src/index.ts", 'import legacyDefault from "legacy-default";\nexport const combined = legacyDefault.value;\n');
    write(fixture.root, "apps/donor/node_modules/legacy-default/package.json", packageJson({ name: "legacy-default", main: "./index.js", types: "./index.d.ts" }));
    write(fixture.root, "apps/donor/node_modules/legacy-default/index.js", "module.exports = { value: 1 };\n");
    write(fixture.root, "apps/donor/node_modules/legacy-default/index.d.ts", "declare const legacyDefault: { value: number };\nexport = legacyDefault;\n");

    const disabled = run(fixture.root, config("bundler", ["ambient-only"], false), fixture.manifest);
    expect(disabled.passed).toBe(false);
    expect(disabled.diagnostics.join("\n")).toContain("allowSyntheticDefaultImports");

    const enabled = run(fixture.root, config("bundler", ["ambient-only"], true), fixture.manifest);
    expect(enabled.passed).toBe(true);
    expect(enabled.diagnostics).toEqual([]);
  });

  test("imports a required default export and rejects a surface that omits it", () => {
    const fixture = proofFixture();
    const required = [{ name: "combined", typeOnly: false }, { name: "default", typeOnly: false }] as const;

    write(fixture.root, "libs/carved/src/index.ts", `${targetSource()}export default combined;\n`);
    expect(run(fixture.root, fixture.config, manifest(required)).passed).toBe(true);

    write(fixture.root, "libs/carved/src/index.ts", targetSource());
    const missing = run(fixture.root, fixture.config, manifest(required));
    expect(missing.passed).toBe(false);
    expect(missing.diagnostics.join("\n")).toContain("has no default export");
  });

  test("uses collision-safe aliases for named exports, including string-named exports", () => {
    const fixture = proofFixture();
    write(
      fixture.root,
      "libs/carved/src/index.ts",
      [
        targetSource(),
        "export const target = true;",
        "export const __externalConsumerExport2 = true;",
        "declare const stringNamed: unique symbol;",
        'export { stringNamed as "string-named" };',
        "",
      ].join("\n"),
    );
    const required = [
      { name: "combined", typeOnly: false },
      { name: "target", typeOnly: false },
      { name: "__externalConsumerExport2", typeOnly: false },
      { name: "string-named", typeOnly: false },
    ] as const;

    const result = run(fixture.root, fixture.config, manifest(required));

    expect(result.passed).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });

  test("imports a required default type export and rejects a surface that omits it", () => {
    const fixture = proofFixture();
    const required = [{ name: "combined", typeOnly: false }, { name: "default", typeOnly: true }] as const;

    write(fixture.root, "libs/carved/src/index.ts", `${targetSource()}export default interface DefaultShape { value: string }\n`);
    expect(run(fixture.root, fixture.config, manifest(required)).passed).toBe(true);

    write(fixture.root, "libs/carved/src/index.ts", `${targetSource()}export default combined;\n`);
    const valueInstead = run(fixture.root, fixture.config, manifest(required));
    expect(valueInstead.passed).toBe(false);
    expect(valueInstead.diagnostics.join("\n")).toContain("refers to a value, but is being used as a type");

    write(fixture.root, "libs/carved/src/index.ts", targetSource());
    const missing = run(fixture.root, fixture.config, manifest(required));
    expect(missing.passed).toBe(false);
    expect(missing.diagnostics.join("\n")).toContain("has no default export");
  });

  test("proves generic type exports without guessing their type-parameter arity", () => {
    const fixture = proofFixture();
    const required = [{ name: "combined", typeOnly: false }, { name: "GenericResult", typeOnly: true }] as const;

    write(
      fixture.root,
      "libs/carved/src/index.ts",
      `${targetSource()}export interface GenericResult<T, TError = Error> { value: T; error?: TError }\n`,
    );

    const result = run(fixture.root, fixture.config, manifest(required));
    expect(result.passed).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });

  test("rejects a value where a string-named type export is required", () => {
    const fixture = proofFixture();
    const required = [{ name: "combined", typeOnly: false }, { name: "string-type", typeOnly: true }] as const;

    write(
      fixture.root,
      "libs/carved/src/index.ts",
      `${targetSource()}interface StringType { value: string }\nexport type { StringType as "string-type" };\n`,
    );
    expect(run(fixture.root, fixture.config, manifest(required)).passed).toBe(true);

    write(
      fixture.root,
      "libs/carved/src/index.ts",
      `${targetSource()}const stringType = true;\nexport { stringType as "string-type" };\n`,
    );
    const valueInstead = run(fixture.root, fixture.config, manifest(required));
    expect(valueInstead.passed).toBe(false);
    expect(valueInstead.diagnostics.join("\n")).toContain("refers to a value, but is being used as a type");
  });
});

function targetSource(): string {
  return [
    'import { feature } from "@acme/utility/feature";',
    'import { runtimeValue } from "plain-runtime";',
    "export const combined = `${feature}:${runtimeValue}:${ambientSignal}`;",
    'export { bundled } from "./bundled";',
    "",
  ].join("\n");
}
