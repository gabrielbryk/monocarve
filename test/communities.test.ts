import { afterAll, describe, expect, test } from "bun:test";

import { parseConfig } from "../src/config.ts";
import { buildDependencyGraph, type ScanReport } from "../src/graph/build.ts";
import { analyzeCommunities } from "../src/portfolio/communities.ts";
import { buildPortfolio } from "../src/portfolio/rank.ts";
import { cleanupFixtures, fixtureRepo, write } from "./support/fixture-repo.ts";

const APP = "apps/web/src";

function source(name: string): string {
  return `export const ${name} = "${name}";\n`;
}

function fixture(): { readonly root: string; readonly config: ReturnType<typeof parseConfig>; readonly graph: ReturnType<typeof graphFor> } {
  const files: Record<string, string> = {
    "package.json": '{"name":"root","private":true}\n',
    "apps/web/package.json": '{"name":"@acme/web","private":true,"type":"module"}\n',
    "apps/web/tsconfig.json": '{"compilerOptions":{"moduleResolution":"Bundler"}}\n',
  };
  for (const name of ["a", "b", "c", "d", "e", "f", "hub"]) files[`${APP}/${name}.ts`] = source(name);
  const root = fixtureRepo(files);
  const config = parseConfig({
    applications: [{ name: "web", sourceRoot: APP, tsconfig: "apps/web/tsconfig.json", packageName: "@acme/web" }],
    packageRoots: ["libs"],
    packageScope: "@acme/",
    portfolio: { minFiles: 1 },
    scaffoldTemplates: { packageJson: { contents: "{}" } },
  });
  write(root, "monocarve.config.json", `${JSON.stringify(config)}\n`);
  return { root, config, graph: graphFor(root, config) };
}

function graphFor(root: string, config: ReturnType<typeof parseConfig>) {
  const dependencies: Record<string, string[]> = {
    a: ["b", "c", "hub"],
    b: ["a", "c", "hub"],
    c: ["a", "b", "d", "hub"],
    d: ["c", "e", "f", "hub"],
    e: ["d", "f", "hub"],
    f: ["d", "e", "hub"],
    hub: [],
  };
  const modules: ScanReport["modules"] = Object.entries(dependencies).map(([name, targets]) => ({
    source: `${APP}/${name}.ts`,
    dependencies: targets.map((target) => ({ module: `./${target}.ts`, resolved: `${APP}/${target}.ts` })),
  }));
  return buildDependencyGraph({ config, rootDir: root, reports: { web: { modules } } });
}

afterAll(cleanupFixtures);

describe("community diagnostics", () => {
  test("finds two dense groups while retaining a suppressed hub as a visible node", () => {
    const { graph } = fixture();
    const report = analyzeCommunities(graph, { hubInboundThreshold: 4 });
    expect(report.suppressedHubs).toEqual([{ path: `${APP}/hub.ts`, incoming: 6 }]);
    // Suppression may remove the hub from the partitioning graph, but must not
    // conceal its real coupling from the person reviewing the report.
    expect(report.suppressedHubEdges).toHaveLength(6);
    expect(report.suppressedHubEdges).toContainEqual([`${APP}/a.ts`, `${APP}/hub.ts`]);
    expect(report.communities.find((group) => group.members.includes(`${APP}/a.ts`))?.externalEdges).toBeGreaterThan(0);
    expect(report.communities.map((group) => group.members)).toContainEqual([`${APP}/a.ts`, `${APP}/b.ts`, `${APP}/c.ts`]);
    expect(report.communities.map((group) => group.members)).toContainEqual([`${APP}/d.ts`, `${APP}/e.ts`, `${APP}/f.ts`]);
    expect(report.communities.flatMap((group) => group.members)).toContain(`${APP}/hub.ts`);
  });

  test("normalizes graph iteration order byte-for-byte", () => {
    const { graph } = fixture();
    const canonical = analyzeCommunities(graph, { hubInboundThreshold: 4 });
    const permuted = analyzeCommunities(
      {
        ...graph,
        paths: [...graph.paths].reverse(),
        edges: [...graph.edges].reverse(),
        nodes: new Map([...graph.nodes].reverse()),
        incoming: new Map([...graph.incoming].reverse().map(([path, values]) => [path, [...values].reverse()])),
      },
      { hubInboundThreshold: 4 },
    );
    expect(JSON.stringify(permuted)).toBe(JSON.stringify(canonical));
  });

  test("hub suppression only changes the diagnostic, not portfolio eligibility or selection", () => {
    const { config, graph } = fixture();
    const before = buildPortfolio({ config, graph });
    const suppressed = analyzeCommunities(graph, { hubInboundThreshold: 4 });
    const unsuppressed = analyzeCommunities(graph, { hubInboundThreshold: 99 });
    const after = buildPortfolio({ config, graph });
    expect(suppressed.suppressedHubs).toHaveLength(1);
    expect(unsuppressed.suppressedHubs).toHaveLength(0);
    expect(suppressed.communities).not.toEqual(unsuppressed.communities);
    expect(after).toEqual(before);
  });
});
