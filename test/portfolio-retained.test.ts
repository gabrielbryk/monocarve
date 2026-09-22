/**
 * `portfolio.retainedRoots` turns "graph-valid but useless" closures into
 * honest preparation candidates. A failure here looks like a closure that
 * silently absorbs config/db/infra files without any record of why it cannot
 * leave cleanly, or a report that inflates one retained module into many
 * blockers because several closure files happen to reach it.
 */

import { afterAll, describe, expect, test } from "bun:test";

import { parseConfig, type MonocarveConfig } from "../src/config.ts";
import { buildDependencyGraph, type ScanReport } from "../src/graph/build.ts";
import type { DependencyGraph } from "../src/graph/model.ts";
import { WorkspaceContext } from "../src/plan/context.ts";
import { buildPortfolio } from "../src/portfolio/rank.ts";
import { retainedBlockers } from "../src/portfolio/retained.ts";
import { cleanupFixtures, fixtureRepo } from "./support/fixture-repo.ts";

const APP = "apps/api/src";
const TSCONFIG = `${JSON.stringify({ compilerOptions: { moduleResolution: "Bundler", strict: true, noEmit: true } })}\n`;

function workspace(files: Record<string, string>): string {
  return fixtureRepo({
    "package.json": '{"name":"root","private":true}\n',
    "apps/api/package.json": '{"name":"@acme/api","private":true,"type":"module"}\n',
    "apps/api/tsconfig.json": TSCONFIG,
    ...files,
  });
}

function config(portfolio: Record<string, unknown>): MonocarveConfig {
  return parseConfig({
    applications: [{ name: "api", sourceRoot: APP, tsconfig: "apps/api/tsconfig.json", packageName: "@acme/api" }],
    packageRoots: ["libs"],
    packageScope: "@acme/",
    portfolio: { minFiles: 1, ...portfolio },
    scaffoldTemplates: { packageJson: { contents: "{}" } },
  });
}

function graphFor(root: string, cfg: MonocarveConfig, modules: ScanReport["modules"]): DependencyGraph {
  return buildDependencyGraph({ config: cfg, rootDir: root, reports: { api: { modules } } });
}

const module = (source: string, dependencies: ScanReport["modules"][number]["dependencies"] = []) => ({ source, dependencies });

afterAll(cleanupFixtures);

describe("retainedBlockers", () => {
  test("dedupes three files reaching one retained module into a single blocker", () => {
    const alpha = `${APP}/orders/alpha.ts`;
    const bravo = `${APP}/orders/bravo.ts`;
    const charlie = `${APP}/orders/charlie.ts`;
    const shared = `${APP}/shared/base.ts`;
    const root = workspace({
      [alpha]: 'import { Base } from "../shared/base.ts";\nexport const alpha = Base;\n',
      [bravo]: 'import { Base } from "../shared/base.ts";\nexport const bravo = Base;\n',
      [charlie]: 'import { Base } from "../shared/base.ts";\nexport const charlie = Base;\n',
      [shared]: "export const Base = 1;\n",
    });
    const cfg = config({ retainedRoots: [`${APP}/shared`] });
    const graph = graphFor(root, cfg, [
      module(alpha, [{ module: "../shared/base.ts", resolved: shared }]),
      module(bravo, [{ module: "../shared/base.ts", resolved: shared }]),
      module(charlie, [{ module: "../shared/base.ts", resolved: shared }]),
      module(shared),
    ]);
    const context = new WorkspaceContext(cfg, root);

    const blockers = retainedBlockers(context, graph, [alpha, bravo, charlie], cfg.portfolio.retainedRoots);

    expect(blockers).toEqual([{ file: alpha, specifier: "../shared/base.ts", target: shared, kind: "value" }]);
  });

  test("distinguishes a type-only edge from a value edge into different retained targets", () => {
    const valueConsumer = `${APP}/orders/value-consumer.ts`;
    const typeConsumer = `${APP}/orders/type-consumer.ts`;
    const runtime = `${APP}/shared/runtime.ts`;
    const types = `${APP}/shared/types.ts`;
    const root = workspace({
      [valueConsumer]: 'import { Widget } from "../shared/runtime.ts";\nexport const widget = Widget;\n',
      [typeConsumer]: 'import type { Widget } from "../shared/types.ts";\nexport type Consumer = Widget;\n',
      [runtime]: "export class Widget {}\n",
      [types]: "export interface Widget { id: string }\n",
    });
    const cfg = config({ retainedRoots: [`${APP}/shared`] });
    const graph = graphFor(root, cfg, [
      module(valueConsumer, [{ module: "../shared/runtime.ts", resolved: runtime }]),
      module(typeConsumer, [{ module: "../shared/types.ts", resolved: types }]),
      module(runtime),
      module(types),
    ]);
    const context = new WorkspaceContext(cfg, root);

    const blockers = retainedBlockers(context, graph, [valueConsumer, typeConsumer], cfg.portfolio.retainedRoots);

    expect(blockers).toEqual([
      { file: valueConsumer, specifier: "../shared/runtime.ts", target: runtime, kind: "value" },
      { file: typeConsumer, specifier: "../shared/types.ts", target: types, kind: "type" },
    ]);
  });

  test("empty retainedRoots produces no blockers at all", () => {
    const alpha = `${APP}/orders/alpha.ts`;
    const shared = `${APP}/shared/base.ts`;
    const root = workspace({ [alpha]: 'import { Base } from "../shared/base.ts";\nexport const alpha = Base;\n', [shared]: "export const Base = 1;\n" });
    const cfg = config({});
    const graph = graphFor(root, cfg, [module(alpha, [{ module: "../shared/base.ts", resolved: shared }]), module(shared)]);
    const context = new WorkspaceContext(cfg, root);

    expect(retainedBlockers(context, graph, [alpha], [])).toEqual([]);
  });
});

describe("boundary-aware ranking end to end", () => {
  test("a mixed app/config/db candidate reports its blockers and ranks below a portable leaf", () => {
    const configFile = `${APP}/config/env.ts`;
    const dbFile = `${APP}/db/client.ts`;
    const serviceFile = `${APP}/orders/service.ts`;
    const leafFile = `${APP}/format/util.ts`;
    const root = workspace({
      [configFile]: 'export const env = "prod";\n',
      [dbFile]: "export const client = { query: () => 1 };\n",
      [serviceFile]:
        'import { env } from "../config/env.ts";\nimport { client } from "../db/client.ts";\n' +
        "export function run(): number {\n  void env;\n  return client.query();\n}\n",
      [leafFile]: "export function upper(value: string): string {\n  return value.toUpperCase();\n}\n",
    });
    const cfg = config({ retainedRoots: [`${APP}/config`, `${APP}/db`] });
    const graph = graphFor(root, cfg, [
      module(configFile),
      module(dbFile),
      module(serviceFile, [
        { module: "../config/env.ts", resolved: configFile },
        { module: "../db/client.ts", resolved: dbFile },
      ]),
      module(leafFile),
    ]);

    const portfolio = buildPortfolio({ config: cfg, graph });
    const mixed = portfolio.candidates.find((candidate) => candidate.files.includes(serviceFile));
    const leaf = portfolio.candidates.find((candidate) => candidate.files.includes(leafFile) && candidate.files.length === 1);
    if (!mixed || !leaf) throw new Error("fixture did not produce both candidates");

    expect(mixed.eligible).toBe(true);
    expect(leaf.eligible).toBe(true);
    expect(mixed.classification).toBe("preparation");
    expect(leaf.classification).toBe("extraction");
    expect(mixed.retainedBlockers).toEqual([
      { file: serviceFile, specifier: "../config/env.ts", target: configFile, kind: "value" },
      { file: serviceFile, specifier: "../db/client.ts", target: dbFile, kind: "value" },
    ]);
    expect(mixed.warnings.some((warning) => warning.includes("2") && warning.includes("retainedRoots") && warning.includes(serviceFile))).toBe(true);
    expect(mixed.score).toBeLessThan(leaf.score);
  });
});
