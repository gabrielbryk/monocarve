/**
 * `preparationRecipe` must never invent a remedy. A failure here looks like a
 * blocker matched to the wrong configured boundary/promotion, or — far worse
 * — a guessed remedy for a blocker nothing in the config actually covers.
 */

import { afterAll, describe, expect, test } from "bun:test";

import { parseConfig, type MonocarveConfig } from "../src/config.ts";
import { buildDependencyGraph, type ScanReport } from "../src/graph/build.ts";
import { buildPortfolio } from "../src/portfolio/rank.ts";
import { preparationRecipe } from "../src/portfolio/recipe.ts";
import type { RetainedBlocker } from "../src/portfolio/types.ts";
import { cleanupFixtures, fixtureRepo } from "./support/fixture-repo.ts";

const APP = "apps/api/src";
const TSCONFIG = `${JSON.stringify({ compilerOptions: { moduleResolution: "Bundler", strict: true, noEmit: true } })}\n`;

function config(overrides: Record<string, unknown> = {}): MonocarveConfig {
  return parseConfig({
    applications: [{ name: "api", sourceRoot: APP, tsconfig: "apps/api/tsconfig.json", packageName: "@acme/api" }],
    packageRoots: ["libs"],
    packageScope: "@acme/",
    portfolio: { minFiles: 1 },
    scaffoldTemplates: { packageJson: { contents: "{}" } },
    ...overrides,
  });
}

const dbBlocker: RetainedBlocker = {
  file: `${APP}/orders/service.ts`,
  specifier: "../db/client.ts",
  target: `${APP}/db/client.ts`,
  kind: "value",
};

const typeBlocker: RetainedBlocker = {
  file: `${APP}/orders/service.ts`,
  specifier: "../config/env.ts",
  target: `${APP}/config/env.ts`,
  kind: "type",
};

describe("preparationRecipe", () => {
  test("names the compositionBoundaries entry that already covers the blocker", () => {
    const cfg = config({
      compositionBoundaries: [
        { id: "env-shim", retained: typeBlocker.target, strategy: "existing-package", replacement: { specifier: "@acme/env", symbols: ["env"] } },
      ],
    });

    const [step] = preparationRecipe(cfg, [typeBlocker]);

    expect(step!.blocker).toEqual(typeBlocker);
    expect(step!.remedy).toEqual({ kind: "composition-boundary", id: "env-shim" });
  });

  test("names the portPromotions entry whose retainedRoots covers the blocker's target", () => {
    const cfg = config({
      portPromotions: [
        {
          id: "db-port",
          retainedRoots: [`${APP}/db`],
          contractPackage: "@acme/ports",
          contractModule: "db",
          appConcreteType: `${APP}/db/client.ts#Client`,
          libraryPort: "DbPort",
          targetPackage: "@acme/ports",
        },
      ],
    });

    const [step] = preparationRecipe(cfg, [dbBlocker]);

    expect(step!.blocker).toEqual(dbBlocker);
    expect(step!.remedy).toEqual({ kind: "port-promotion", id: "db-port" });
  });

  test("an uncovered blocker reports a gap naming the exact edge, never a guess", () => {
    const cfg = config();

    const [step] = preparationRecipe(cfg, [dbBlocker]);

    expect(step!.remedy).toEqual({ kind: "unconfigured" });
    expect(step!.detail).toContain(dbBlocker.file);
    expect(step!.detail).toContain(dbBlocker.specifier);
    expect(step!.detail).toContain(dbBlocker.target);
  });

  test("a near-miss config (wrong retained path, disjoint retainedRoots) still reports a gap, not a guess", () => {
    const cfg = config({
      compositionBoundaries: [
        { id: "unrelated", retained: `${APP}/config/other.ts`, strategy: "existing-package", replacement: { specifier: "@acme/other", symbols: ["x"] } },
      ],
      portPromotions: [
        {
          id: "unrelated-port",
          retainedRoots: [`${APP}/infra`],
          contractPackage: "@acme/ports",
          contractModule: "infra",
          appConcreteType: `${APP}/infra/client.ts#Client`,
          libraryPort: "InfraPort",
          targetPackage: "@acme/ports",
        },
      ],
    });

    const [step] = preparationRecipe(cfg, [dbBlocker]);

    expect(step!.remedy).toEqual({ kind: "unconfigured" });
  });
});

describe("preparationRecipe end to end", () => {
  afterAll(cleanupFixtures);

  const configFile = `${APP}/config/env.ts`;
  const dbFile = `${APP}/db/client.ts`;
  const serviceFile = `${APP}/orders/service.ts`;
  const leafFile = `${APP}/format/util.ts`;

  function fixture(): string {
    return fixtureRepo({
      "package.json": '{"name":"root","private":true}\n',
      "apps/api/package.json": '{"name":"@acme/api","private":true,"type":"module"}\n',
      "apps/api/tsconfig.json": TSCONFIG,
      [configFile]: 'export const env = "prod";\n',
      [dbFile]: "export const client = { query: () => 1 };\n",
      [serviceFile]:
        'import { env } from "../config/env.ts";\nimport { client } from "../db/client.ts";\n' +
        "export function run(): number {\n  void env;\n  return client.query();\n}\n",
      [leafFile]: "export function upper(value: string): string {\n  return value.toUpperCase();\n}\n",
    });
  }

  const module = (source: string, dependencies: ScanReport["modules"][number]["dependencies"] = []) => ({ source, dependencies });

  function graphFor(root: string, cfg: MonocarveConfig) {
    return buildDependencyGraph({
      config: cfg,
      rootDir: root,
      reports: {
        api: {
          modules: [
            module(configFile),
            module(dbFile),
            module(serviceFile, [
              { module: "../config/env.ts", resolved: configFile },
              { module: "../db/client.ts", resolved: dbFile },
            ]),
            module(leafFile),
          ],
        },
      },
    });
  }

  test("adding a matching port policy changes the recipe without changing which candidate ranks first", () => {
    const root = fixture();
    const before = config({ portfolio: { minFiles: 1, retainedRoots: [`${APP}/config`, `${APP}/db`] } });
    const beforePortfolio = buildPortfolio({ config: before, graph: graphFor(root, before) });
    const beforeMixed = beforePortfolio.candidates.find((candidate) => candidate.files.includes(serviceFile));
    const beforeLeaf = beforePortfolio.candidates.find((candidate) => candidate.files.length === 1 && candidate.files.includes(leafFile));
    if (!beforeMixed || !beforeLeaf) throw new Error("fixture did not produce both candidates");
    const beforeDbStep = beforeMixed.recipe?.find((step) => step.blocker.target === dbFile);
    expect(beforeDbStep?.remedy).toEqual({ kind: "unconfigured" });

    const after = config({
      portfolio: { minFiles: 1, retainedRoots: [`${APP}/config`, `${APP}/db`] },
      portPromotions: [
        {
          id: "db-port",
          retainedRoots: [`${APP}/db`],
          contractPackage: "@acme/ports",
          contractModule: "db",
          appConcreteType: `${dbFile}#Client`,
          libraryPort: "DbPort",
          targetPackage: "@acme/ports",
        },
      ],
    });
    const afterPortfolio = buildPortfolio({ config: after, graph: graphFor(root, after) });
    const afterMixed = afterPortfolio.candidates.find((candidate) => candidate.files.includes(serviceFile));
    const afterLeaf = afterPortfolio.candidates.find((candidate) => candidate.files.length === 1 && candidate.files.includes(leafFile));
    if (!afterMixed || !afterLeaf) throw new Error("fixture did not produce both candidates after config change");
    const afterDbStep = afterMixed.recipe?.find((step) => step.blocker.target === dbFile);

    expect(afterDbStep?.remedy).toEqual({ kind: "port-promotion", id: "db-port" });
    // Configuring a remedy documents the path — it must not silently reclassify
    // or re-rank the candidate as though the edge had actually been broken.
    expect(afterMixed.classification).toBe("preparation");
    expect(afterMixed.score).toBe(beforeMixed.score);
    expect(afterLeaf.score).toBeGreaterThan(afterMixed.score);
    expect(afterLeaf.files).toEqual(beforeLeaf.files);
  });
});
