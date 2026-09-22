/**
 * Portfolio selection is a same-baseline recommendation, not a queue of
 * independently replanned moves. A failure looks like two selected candidates
 * both moving one travelling asset: after the first extraction the
 * second candidate's plan is stale, even though their production closures do
 * not intersect.
 */

import { afterAll, describe, expect, test } from "bun:test";

import { parseConfig } from "../src/config.ts";
import { buildDependencyGraph, type ScanReport } from "../src/graph/build.ts";
import { assertAssetImportersReachable } from "../src/plan/build.ts";
import { buildPortfolio } from "../src/portfolio/rank.ts";
import { cleanupFixtures, fixtureRepo, write } from "./support/fixture-repo.ts";

const APP = "apps/api/src";
const TSCONFIG = `${JSON.stringify({ compilerOptions: { moduleResolution: "Bundler", strict: true, noEmit: true } })}\n`;

function candidateFiles(name: string, lines: number): string {
  return `${Array.from({ length: lines - 1 }, (_, index) => `const value${index} = ${index};`).join("\n")}\nexport const ${name} = ${lines};\n`;
}

type SharedMovable = "asset" | "test";

function workspace(shared: SharedMovable, selfContained = false): { readonly root: string; readonly config: ReturnType<typeof parseConfig> } {
  const sharedAsset = shared === "asset";
  const root = fixtureRepo({
    "package.json": '{"name":"root","private":true}\n',
    "apps/api/package.json": '{"name":"@acme/api","private":true,"type":"module"}\n',
    "apps/api/tsconfig.json": TSCONFIG,
    [`${APP}/alpha.ts`]: `${sharedAsset ? 'import "./shared.css";\n' : ""}${candidateFiles("alpha", 4)}`,
    [`${APP}/bravo.ts`]: `${sharedAsset ? 'import "./shared.css";\n' : ""}${candidateFiles("bravo", 2)}`,
    [`${APP}/charlie.ts`]: candidateFiles("charlie", 8),
    [`${APP}/delta.ts`]: candidateFiles("delta", 6),
    ...(sharedAsset ? { [`${APP}/shared.css`]: ".shared { color: rebeccapurple; }\n" } : {}),
    ...(shared === "test"
      ? {
          [`${APP}/shared.test.ts`]: selfContained
            ? 'import { alpha } from "./alpha.ts"; import { bravo } from "./bravo.ts"; void alpha; void bravo;\n'
            : "export {};\n",
        }
      : {}),
  });
  const config = parseConfig({
    applications: [{ name: "api", sourceRoot: APP, tsconfig: "apps/api/tsconfig.json", packageName: "@acme/api" }],
    packageRoots: ["libs"],
    packageScope: "@acme/",
    ...(sharedAsset ? { assetExtensions: [".css"] } : { testPathPatterns: ["\\.test\\.ts$"] }),
    ...(selfContained ? { testRelocation: { strategy: "self-contained" } } : {}),
    portfolio: { minFiles: 1 },
    scaffoldTemplates: { packageJson: { contents: "{}" } },
  });
  write(root, "monocarve.config.json", `${JSON.stringify(config)}\n`);
  return { root, config };
}

function graphFor(root: string, config: ReturnType<typeof parseConfig>, shared: SharedMovable) {
  const module = (source: string, dependencies: ScanReport["modules"][number]["dependencies"] = []) => ({ source, dependencies });
  return buildDependencyGraph({
    config,
    rootDir: root,
    reports: {
      api: {
        modules: [
          module(`${APP}/alpha.ts`),
          module(`${APP}/bravo.ts`),
          module(`${APP}/charlie.ts`),
          module(`${APP}/delta.ts`),
          ...(shared === "test"
            ? [
                // Selection consumes the scanner's test-importer relation. The
                // empty body keeps this focused on claiming that relation rather
                // than test-codemod escape handling, which has its own coverage.
                module(`${APP}/shared.test.ts`, [
                  { module: "./alpha.ts", resolved: `${APP}/alpha.ts` },
                  { module: "./bravo.ts", resolved: `${APP}/bravo.ts` },
                ]),
              ]
            : []),
        ],
      },
    },
  });
}

afterAll(cleanupFixtures);

describe("portfolio same-baseline selection", () => {
  test("claims travelling assets as well as production files, while retaining disjoint candidates in score order", () => {
    const { root, config } = workspace("asset");
    const portfolio = buildPortfolio({ config, graph: graphFor(root, config, "asset") });
    const byFile = (file: string) => portfolio.candidates.find((candidate) => candidate.files.includes(file));
    const alpha = byFile(`${APP}/alpha.ts`);
    const bravo = byFile(`${APP}/bravo.ts`);
    const charlie = byFile(`${APP}/charlie.ts`);
    const delta = byFile(`${APP}/delta.ts`);
    if (!alpha || !bravo || !charlie || !delta) throw new Error("fixture did not produce every independent closure");

    // The control for the overlap: containment really attaches the same asset
    // to both closures, rather than the assertion relying on hand-written ids.
    expect(alpha.assets).toEqual([`${APP}/shared.css`]);
    expect(bravo.assets).toEqual([`${APP}/shared.css`]);
    expect(alpha.eligible).toBe(true);
    expect(bravo.eligible).toBe(true);
    expect(charlie.eligible).toBe(true);
    expect(delta.eligible).toBe(true);
    expect(alpha.score).toBeGreaterThan(bravo.score);
    expect(charlie.assets).toEqual([]);
    expect(delta.assets).toEqual([]);
    expect(charlie.score).toBeGreaterThan(delta.score);
    expect(delta.score).toBeGreaterThan(alpha.score);

    expect(portfolio.selected).toEqual([charlie.id, delta.id, alpha.id]);
    expect(portfolio.selected).not.toContain(bravo.id);
    const graph = graphFor(root, config, "asset");
    const outgoing = new Map(graph.outgoing);
    outgoing.set(alpha.files[0]!, alpha.assets);
    const unreachableIncoming = new Map(graph.incoming);
    unreachableIncoming.set(alpha.assets[0]!, [alpha.files[0]!]);
    expect(() => assertAssetImportersReachable({ ...graph, outgoing, incoming: unreachableIncoming }, alpha.files, alpha.assets)).toThrow(
      "asset side effect is not runtime-reachable before extraction",
    );
    const incoming = new Map(unreachableIncoming);
    incoming.set(alpha.assets[0]!, [alpha.files[0]!, `${APP}/runtime.ts`]);
    expect(() => assertAssetImportersReachable({ ...graph, outgoing, incoming }, alpha.files, alpha.assets)).not.toThrow();
  });

  test("claims a shared travelling test even when production closures are otherwise disjoint", () => {
    const { root, config } = workspace("test");
    const portfolio = buildPortfolio({ config, graph: graphFor(root, config, "test") });
    const byFile = (file: string) => portfolio.candidates.find((candidate) => candidate.files.includes(file));
    const alpha = byFile(`${APP}/alpha.ts`);
    const bravo = byFile(`${APP}/bravo.ts`);
    if (!alpha || !bravo) throw new Error("fixture did not produce the shared-test closures");

    expect(alpha.files).toEqual([`${APP}/alpha.ts`]);
    expect(bravo.files).toEqual([`${APP}/bravo.ts`]);
    expect(alpha.tests).toEqual([`${APP}/shared.test.ts`]);
    expect(bravo.tests).toEqual([`${APP}/shared.test.ts`]);
    expect(alpha.eligible).toBe(true);
    expect(bravo.eligible).toBe(true);
    expect(alpha.score).toBeGreaterThan(bravo.score);
    expect(portfolio.selected).toContain(alpha.id);
    expect(portfolio.selected).not.toContain(bravo.id);
  });

  test("retained shared tests neither conflict selection nor become protected movable paths", () => {
    const { root, config: base } = workspace("test", true);
    const config = parseConfig({ ...base, portfolio: { ...base.portfolio, protectedPaths: [`${APP}/shared.test.ts`] } });
    const portfolio = buildPortfolio({ config, graph: graphFor(root, config, "test") });
    const byFile = (file: string) => portfolio.candidates.find((candidate) => candidate.files.includes(file));
    const alpha = byFile(`${APP}/alpha.ts`);
    const bravo = byFile(`${APP}/bravo.ts`);
    if (!alpha || !bravo) throw new Error("fixture did not produce both closures");
    // The test reaches the other candidate's production file, so it stays as a
    // consumer for both. It must not make either candidate protected or occupy
    // the other candidate's same-baseline slot.
    expect(alpha.tests).toEqual([]);
    expect(bravo.tests).toEqual([]);
    expect(alpha.eligible).toBe(true);
    expect(bravo.eligible).toBe(true);
    expect(portfolio.selected).toContain(alpha.id);
    expect(portfolio.selected).toContain(bravo.id);
  });

  test("an unrelated computed build-artifact import does not reject every candidate", () => {
    const { root, config } = workspace("asset");
    write(root, `${APP}/build-report.test.ts`, 'const name = "report"; void import(`../../../dist/${name}.js`);\n');
    const portfolio = buildPortfolio({ config, graph: graphFor(root, config, "asset") });
    const alpha = portfolio.candidates.find((candidate) => candidate.files.includes(`${APP}/alpha.ts`));
    if (!alpha) throw new Error("fixture did not produce the alpha closure");

    expect(alpha.rejectionReasons.find((reason) => reason.code === "unsupported-module-reference")).toBeUndefined();
    expect(alpha.rejectionReasons.find((reason) => reason.detail.includes("unmoved first-party source"))).toBeUndefined();
    expect(alpha.eligible).toBe(true);
  });

  test("a computed reference inside the candidate remains a hard refusal", () => {
    const { root, config } = workspace("asset");
    write(root, `${APP}/alpha.ts`, 'const name = "runtime"; void import(`./${name}.ts`);\nexport const alpha = 1;\n');
    const portfolio = buildPortfolio({ config, graph: graphFor(root, config, "asset") });
    const alpha = portfolio.candidates.find((candidate) => candidate.files.includes(`${APP}/alpha.ts`));
    if (!alpha) throw new Error("fixture did not produce the alpha closure");

    expect(alpha.rejectionReasons).toContainEqual({
      code: "unsupported-module-reference",
      detail: "a computed module specifier in first-party source cannot be rewritten deterministically",
      edges: [`${APP}/alpha.ts`],
    });
    expect(alpha.eligible).toBe(false);
  });
});
