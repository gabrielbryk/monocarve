import { afterAll, describe, expect, test } from "bun:test";

import { buildDependencyGraph, type ScanReport } from "../src/graph/build.ts";
import { compileBoundaryPreparationManifest } from "../src/prepare/build.ts";
import { assertPreparationManifestValid, createPreparationManifest } from "../src/prepare/manifest.ts";
import { simulatePreparation } from "../src/prepare/simulate.ts";
import { resolveCommit } from "../src/util/git.ts";
import { hashText } from "../src/util/hash.ts";
import { cleanupFixtures, fixtureConfig, fixtureRepo } from "./support/fixture-repo.ts";

afterAll(cleanupFixtures);

const RETAINED = "apps/api/src/widget.ts";
const CONSUMER = "apps/api/src/orders/service.ts";
const TARGET = "libs/ports/src/widget.ts";
const PACKAGE_MANIFEST = "libs/ports/package.json";

function fixture(exports: unknown) {
  const root = fixtureRepo({
    "apps/api/tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, noEmit: true, module: "ESNext", moduleResolution: "Bundler" }, include: ["src/**/*.ts"] }),
    [RETAINED]: "export interface Widget { amount: number }\n",
    [CONSUMER]: 'import type { Widget } from "../widget.ts";\nexport type Input = Widget;\n',
    [PACKAGE_MANIFEST]: JSON.stringify({ name: "@acme/ports", exports }),
  });
  const config = fixtureConfig(root, {
    portPromotions: [{
      id: "widget-port",
      retainedRoots: [RETAINED],
      contractPackage: "@acme/ports/widget",
      contractModule: "widget",
      appConcreteType: `${RETAINED}#Widget`,
      libraryPort: "Widget",
      targetPackage: "@acme/ports",
    }],
    preparation: {
      gates: { package: [], project: [], workspace: ["true"] },
      commit: { subject: "refactor: prepare widget port boundary" },
    },
  });
  const baseline = resolveCommit(root, "HEAD");
  const modules: ScanReport["modules"][number][] = [
    { source: RETAINED, dependencies: [] },
    { source: CONSUMER, dependencies: [{ module: "../widget.ts", resolved: RETAINED }] },
  ];
  const graph = buildDependencyGraph({ config, rootDir: root, reports: { api: { modules } }, commit: baseline.commit });
  return {
    root,
    config,
    input: {
      rootDir: root,
      config,
      baselineCommit: "HEAD",
      graphDigest: hashText("fixture-workspace-graph"),
      boundaryId: "widget-port",
      graph,
      contractTargetPath: TARGET,
      rendering: {
        gates: { package: [], project: [], workspace: ["true"] },
        commit: { subject: "refactor: prepare widget port boundary" },
      },
    },
  };
}

describe("port package public subpath", () => {
  test("adds the exact contract subpath and manifest validation rejects a forged omission", () => {
    const { input } = fixture({ "./other": "./src/other.ts" });
    const manifest = compileBoundaryPreparationManifest(input);
    const packageWrite = manifest.operations.find((operation) => operation.kind === "write-file" && operation.file.path === PACKAGE_MANIFEST);
    const consumerWrite = manifest.operations.find((operation) => operation.kind === "rewrite-module-specifier");
    if (packageWrite?.kind !== "write-file" || consumerWrite?.kind !== "rewrite-module-specifier") throw new Error("expected package and consumer writes");

    expect(JSON.parse(packageWrite.contents)).toEqual({
      name: "@acme/ports",
      exports: { "./other": "./src/other.ts", "./widget": "./src/widget.ts" },
    });
    expect(consumerWrite.contents).toContain('from "@acme/ports/widget"');
    expect(() => assertPreparationManifestValid(manifest)).not.toThrow();

    const forgedContents = `${JSON.stringify({ name: "@acme/ports", exports: { "./other": "./src/other.ts" } }, null, 2)}\n`;
    const forgedWrite = { ...packageWrite, file: { ...packageWrite.file, resultHash: hashText(forgedContents) }, contents: forgedContents };
    const { planId: _planId, ...draft } = manifest;
    const forged = createPreparationManifest({ ...draft, operations: manifest.operations.map((operation) => operation === packageWrite ? forgedWrite : operation) });
    expect(() => assertPreparationManifestValid(forged)).toThrow(/port package export must bind exactly one promoted contract target/);
  });

  test("simulates the package export and consumer subpath as one audited transaction", async () => {
    const { root, config, input } = fixture({ "./other": "./src/other.ts" });
    const manifest = compileBoundaryPreparationManifest(input);
    const result = await simulatePreparation({
      config,
      rootDir: root,
      manifest,
      baselineGraphScanner: async ({ baselineCommit }) => ({ commit: baselineCommit, digest: manifest.graphDigest }),
    });
    expect(result.ok).toBe(true);
    expect(result.audit?.passed).toBe(true);
  }, 30_000);

  test("refuses an occupied contract subpath pointing elsewhere", () => {
    const { input } = fixture({ "./widget": "./src/not-widget.ts" });
    expect(() => compileBoundaryPreparationManifest(input)).toThrow(
      /export \.\/widget already targets "\.\/src\/not-widget\.ts", not "\.\/src\/widget\.ts"/,
    );
  });
});
