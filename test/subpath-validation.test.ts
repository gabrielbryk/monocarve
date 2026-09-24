/**
 * Public subpaths are executable routing claims, not descriptive metadata.
 * These cases forge otherwise-valid manifests in ways that used to weaken the
 * audit or swap two donors while retaining valid-looking subpath names.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";

import type { MonocarveConfig } from "../src/config.ts";
import type { ExtractionManifest, ImportRewrite, PlanOperation, PublicModule } from "../src/plan/manifest.ts";
import { assertPlanValid, validatePlan } from "../src/plan/validate.ts";
import { hashText } from "../src/util/hash.ts";
import { cleanupFixtures, fixtureConfig, fixtureGit, fixtureRepo, write } from "./support/fixture-repo.ts";

const ALPHA = "apps/api/src/alpha.ts";
const BETA = "apps/api/src/beta.ts";
const CONSUMER = "apps/api/src/main.ts";
const PACKAGE = "@acme/analytics";
const PACKAGE_ROOT = "libs/analytics";
const ALPHA_TARGET = `${PACKAGE_ROOT}/src/alpha.ts`;
const BETA_TARGET = `${PACKAGE_ROOT}/src/beta.ts`;
const ENTRYPOINT = `${PACKAGE_ROOT}/src/index.ts`;

const alphaSource = "export const alpha = 1;\n";
const betaSource = "export type Beta = { value: number };\n";
const consumerSource = 'import { alpha } from "./alpha.ts";\nimport type { Beta } from "./beta.ts";\nexport const value: Beta = { value: alpha };\n';
const rewrittenConsumer =
  'import { alpha } from "@acme/analytics/alpha";\nimport type { Beta } from "@acme/analytics/beta";\nexport const value: Beta = { value: alpha };\n';
const barrel = 'export * from "./alpha.ts";\nexport * from "./beta.ts";\n';

function setup(): { root: string; config: MonocarveConfig; manifest: ExtractionManifest } {
  const root = fixtureRepo({
    "package.json": '{ "name": "fixture-workspace", "private": true }\n',
    "apps/api/tsconfig.json": '{ "include": ["src"] }\n',
    [ALPHA]: alphaSource,
    [BETA]: betaSource,
    [CONSUMER]: consumerSource,
    [`${PACKAGE_ROOT}/package.json`]: `{ "name": "${PACKAGE}", "main": "./src/index.ts" }\n`,
  });
  const config = fixtureConfig(root, {
    scaffoldTemplates: {
      packageJson: { contents: "{}" },
      publicSurface: { mode: "subpaths", keyTemplate: "./{pathNoExtension}", targetTemplate: "./src/{path}" },
    },
  });

  const publicModules: readonly PublicModule[] = [
    {
      source: ALPHA,
      target: ALPHA_TARGET,
      specifier: `${PACKAGE}/alpha`,
      exportKey: "./alpha",
      exportTarget: "./src/alpha.ts",
      requiredExports: [{ name: "alpha", typeOnly: false }],
    },
    {
      source: BETA,
      target: BETA_TARGET,
      specifier: `${PACKAGE}/beta`,
      exportKey: "./beta",
      exportTarget: "./src/beta.ts",
      requiredExports: [{ name: "Beta", typeOnly: true }],
    },
  ];
  const rewrites: readonly ImportRewrite[] = [
    { from: "./alpha.ts", to: `${PACKAGE}/alpha`, donor: ALPHA },
    { from: "./beta.ts", to: `${PACKAGE}/beta`, donor: BETA },
  ];
  const operations: readonly PlanOperation[] = [
    { kind: "move", source: ALPHA, target: ALPHA_TARGET, preconditionHash: hashText(alphaSource), resultHash: hashText(alphaSource) },
    { kind: "move", source: BETA, target: BETA_TARGET, preconditionHash: hashText(betaSource), resultHash: hashText(betaSource) },
    {
      kind: "rewrite-import",
      file: CONSUMER,
      donors: [ALPHA, BETA],
      rewrites,
      preconditionHash: hashText(consumerSource),
      resultHash: hashText(rewrittenConsumer),
    },
    { kind: "write-file", path: ENTRYPOINT, contents: barrel, preconditionHash: "missing", resultHash: hashText(barrel) },
  ];
  const manifest: ExtractionManifest = {
    schemaVersion: 2,
    planId: "subpath-validation-fixture",
    createdAt: "2026-01-01T00:00:00.000Z",
    generator: { name: "monocarve", version: "0.0.0" },
    baselineCommit: fixtureGit(root, "rev-parse", "HEAD"),
    graphDigest: hashText("subpath-validation"),
    application: "api",
    target: {
      packageName: PACKAGE,
      packageRoot: PACKAGE_ROOT,
      entrypoint: "src/index.ts",
      requiredExports: [
        { name: "alpha", typeOnly: false },
        { name: "Beta", typeOnly: true },
      ],
      publicModules,
    },
    source: { files: [ALPHA, BETA], tests: [], sccs: { "scc-alpha": [ALPHA], "scc-beta": [BETA] } },
    dependencies: { runtime: {}, dev: {}, packageReferences: [] },
    sourceBlobs: { [ALPHA]: hashText(alphaSource), [BETA]: hashText(betaSource) },
    operations,
    consumers: [{ file: CONSUMER, owner: "apps/api", expectedImporter: "./alpha.ts", specifiers: rewrites, external: false, dependencySection: "runtime" }],
    generatedFiles: [],
    changedFiles: [ALPHA, ALPHA_TARGET, BETA, BETA_TARGET, CONSUMER, ENTRYPOINT].toSorted(),
    expectedDynamicImportDelta: { added: [], removed: [] },
    evaluationEffects: [],
    metrics: { movedFiles: 2, movedLines: 2, applicationLinesBefore: 5, applicationLinesAfter: 3, consumers: 1 },
    commits: {
      plan: { subject: "chore(@acme/analytics): compile extraction plan" },
      move: { subject: "refactor(@acme/analytics): move modules" },
      wiring: { subject: "refactor(@acme/analytics): wire package" },
    },
    gates: { package: [], project: [], workspace: [] },
  };
  return { root, config, manifest };
}

describe("public subpath plan validation", () => {
  afterEach(cleanupFixtures);

  test("accepts exact source-derived exports and donor routes", () => {
    const { root, config, manifest } = setup();
    expect(() => assertPlanValid(manifest, { config, rootDir: root })).not.toThrow();
  });

  test("accepts baseline export evidence after donors move out of the live tree", () => {
    const { root, config, manifest } = setup();
    for (const module of manifest.target.publicModules!) {
      write(root, module.target, module.source === ALPHA ? alphaSource : betaSource);
      rmSync(`${root}/${module.source}`);
    }
    expect(() => assertPlanValid(manifest, { config, rootDir: root })).not.toThrow();
  });

  test("rejects forged export evidence after donors move out of the live tree", () => {
    const { root, config, manifest } = setup();
    for (const module of manifest.target.publicModules!) {
      write(root, module.target, module.source === ALPHA ? alphaSource : betaSource);
      rmSync(`${root}/${module.source}`);
    }
    const [alpha, ...rest] = manifest.target.publicModules!;
    const forged: ExtractionManifest = { ...manifest, target: { ...manifest.target, publicModules: [{ ...alpha!, requiredExports: [] }, ...rest] } };
    expect(() => assertPlanValid(forged, { config, rootDir: root })).toThrow("public module map does not match configured surface templates");
  });

  test("rejects baseline bytes that disagree with the recorded source blob", () => {
    const { root, config, manifest } = setup();
    const forged: ExtractionManifest = { ...manifest, sourceBlobs: { ...manifest.sourceBlobs, [ALPHA]: hashText("different bytes\n") } };
    expect(() => assertPlanValid(forged, { config, rootDir: root })).toThrow(`baseline source does not match recorded source blob: ${ALPHA}`);
  });

  test.each([
    ["removed", []],
    ["changed type-only classification", [{ name: "alpha", typeOnly: true }]],
    ["renamed", [{ name: "notAlpha", typeOnly: false }]],
  ] as const)("rejects %s public-module export evidence", (_label, requiredExports) => {
    const { root, config, manifest } = setup();
    const [alpha, ...rest] = manifest.target.publicModules!;
    const forged: ExtractionManifest = { ...manifest, target: { ...manifest.target, publicModules: [{ ...alpha!, requiredExports }, ...rest] } };

    expect(() => assertPlanValid(forged, { config, rootDir: root })).toThrow("public module map does not match configured surface templates");
  });

  test("rejects two valid public subpaths swapped between their donors", () => {
    const { root, config, manifest } = setup();
    const swapped = manifest.consumers[0]!.specifiers.map((rewrite) => ({ ...rewrite, to: rewrite.donor === ALPHA ? `${PACKAGE}/beta` : `${PACKAGE}/alpha` }));
    const forged: ExtractionManifest = {
      ...manifest,
      consumers: [{ ...manifest.consumers[0]!, specifiers: swapped }],
      operations: manifest.operations.map((operation) => (operation.kind === "rewrite-import" ? { ...operation, rewrites: swapped } : operation)),
    };

    const result = validatePlan(forged, { config, rootDir: root });
    expect(result.ok).toBe(false);
    expect(result.issues.filter((issue) => issue.message.includes("must target its declared public surface"))).toEqual([
      expect.objectContaining({ rule: "consumer", path: CONSUMER }),
      expect.objectContaining({ rule: "consumer", path: CONSUMER }),
      expect.objectContaining({ rule: "rewrite-donor", path: CONSUMER }),
      expect.objectContaining({ rule: "rewrite-donor", path: CONSUMER }),
    ]);
  });

  test("rejects a public-subpath rewrite with its donor evidence removed", () => {
    const { root, config, manifest } = setup();
    const withoutDonor = manifest.consumers[0]!.specifiers.map(({ donor: _donor, ...rewrite }) => rewrite);
    const forged: ExtractionManifest = {
      ...manifest,
      consumers: [{ ...manifest.consumers[0]!, specifiers: withoutDonor }],
      operations: manifest.operations.map((operation) => (operation.kind === "rewrite-import" ? { ...operation, rewrites: withoutDonor } : operation)),
    };

    expect(() => assertPlanValid(forged, { config, rootDir: root })).toThrow(`rewrite targeting public subpath ${PACKAGE}/alpha must name its donor`);
  });
});
