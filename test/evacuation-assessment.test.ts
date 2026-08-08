import { afterAll, describe, expect, test } from "bun:test";

import { parseConfig } from "../src/config.ts";
import { assessEvacuationCandidate, buildEvacuationCandidate } from "../src/evacuation/index.ts";
import { buildDependencyGraph, type ScanReport } from "../src/graph/build.ts";
import { cleanupFixtures, fixtureRepo } from "./support/fixture-repo.ts";

const APP = "apps/api/src";
const service = `${APP}/estimating/service.ts`;
const database = `${APP}/db/client.ts`;
const infrastructure = `${APP}/infra/secrets.ts`;
const route = `${APP}/route.ts`;

function workspace(): string {
  return fixtureRepo({
    "package.json": '{"name":"root","private":true}\n',
    "apps/api/package.json": '{"name":"@acme/api","private":true,"type":"module"}\n',
    "apps/api/tsconfig.json": `${JSON.stringify({ compilerOptions: { moduleResolution: "Bundler", strict: true, noEmit: true } })}\n`,
    [service]: [
      'import { route } from "../route.ts";',
      'import type { Database } from "../db/client.ts";',
      'import { secret } from "../infra/secrets.ts";',
      "export const estimate = (database: Database): string => `${route}:${secret}:${database.id}`;",
      "",
    ].join("\n"),
    [database]: "export interface Database { id: string }\n",
    [infrastructure]: 'export const secret = "secret";\n',
    [route]: 'export const route = "route";\n',
  });
}

function config(protectedPaths: readonly string[] = []) {
  return parseConfig({
    applications: [{ name: "api", sourceRoot: APP, tsconfig: "apps/api/tsconfig.json", compositionRoots: [route] }],
    packageRoots: ["libs"],
    packageScope: "@acme/",
    portfolio: { minFiles: 99, maxFiles: 1, retainedRoots: [`${APP}/db`], protectedPaths },
    compositionBoundaries: [{
      id: "route-package",
      retained: route,
      strategy: "existing-package",
      replacement: { specifier: "@acme/routes", symbols: ["route"] },
    }],
    scaffoldTemplates: { packageJson: { contents: "{}" } },
  });
}

function graph(root: string, cfg: ReturnType<typeof config>) {
  const module = (source: string, dependencies: ScanReport["modules"][number]["dependencies"] = []) => ({ source, dependencies });
  return buildDependencyGraph({
    config: cfg,
    rootDir: root,
    reports: { api: { modules: [
      module(service, [
        { module: "../route.ts", resolved: route },
        { module: "../db/client.ts", resolved: database },
        { module: "../infra/secrets.ts", resolved: infrastructure },
      ]),
      module(database),
      module(infrastructure),
      module(route),
    ] } },
  });
}

afterAll(cleanupFixtures);

describe("evacuation assessment", () => {
  test("reports typed, reasoned cuts with configured and unconfigured remedies", () => {
    const root = workspace();
    const cfg = config();
    const dependencyGraph = graph(root, cfg);
    const evacuation = buildEvacuationCandidate({
      config: cfg,
      graph: dependencyGraph,
      application: "api",
      selected: [route, service, database],
    });
    const assessed = assessEvacuationCandidate({ config: cfg, graph: dependencyGraph, evacuation });

    expect(assessed.boundaryCuts).toEqual([
      {
        from: service,
        specifier: "../db/client.ts",
        target: database,
        kind: "type",
        reason: "retained-root",
        remedy: { kind: "unconfigured" },
      },
      {
        from: service,
        specifier: "../infra/secrets.ts",
        target: infrastructure,
        kind: "value",
        reason: "outside-evacuation",
        remedy: { kind: "unconfigured" },
      },
      {
        from: service,
        specifier: "../route.ts",
        target: route,
        kind: "value",
        reason: "composition-root",
        remedy: { kind: "composition-boundary", id: "route-package" },
      },
    ]);
    expect(assessed.candidate.id).toBe(evacuation.id);
    expect(assessed.candidate.files).toEqual([database, service]);
    expect(assessed.candidate.rejectionReasons.map(({ code }) => code)).not.toContain("too-small");
    expect(assessed.candidate.rejectionReasons.map(({ code }) => code)).not.toContain("too-large");
  });

  test("keeps protected paths as hard failures for explicit evacuation", () => {
    const root = workspace();
    const cfg = config([`${APP}/estimating`]);
    const dependencyGraph = graph(root, cfg);
    const evacuation = buildEvacuationCandidate({ config: cfg, graph: dependencyGraph, application: "api", selected: [service] });
    const assessed = assessEvacuationCandidate({ config: cfg, graph: dependencyGraph, evacuation });

    expect(assessed.candidate.eligible).toBe(false);
    expect(assessed.candidate.rejectionReasons).toContainEqual({
      code: "protected-path",
      detail: "1 movable path(s) are protected by portfolio.protectedPaths",
      edges: [service],
    });
  });
});
