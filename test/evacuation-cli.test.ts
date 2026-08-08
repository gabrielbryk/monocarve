import { describe, expect, test } from "bun:test";

import { run } from "./support/cli.ts";

interface EvacuationJson {
  readonly schema: "evacuation";
  readonly application: string;
  readonly target: { readonly packageName: string };
  readonly requested: readonly string[];
  readonly moved: { readonly files: readonly string[]; readonly lineCount: number };
  readonly unselectedDependencies: readonly string[];
  readonly boundaryCuts: readonly {
    readonly from: string;
    readonly specifier: string;
    readonly target: string;
    readonly kind: "value" | "type";
    readonly reason: string;
    readonly remedy: { readonly kind: string; readonly id?: string };
  }[];
  readonly candidate: { readonly eligible: boolean; readonly rejectionReasons: readonly unknown[] };
}

const required = ["--app", "web", "--package-name", "@acme/chart-ui"];

async function jsonFor(source: string): Promise<EvacuationJson> {
  const result = await run("evacuate", ...required, "--source", source, "--json");
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout) as EvacuationJson;
}

describe("evacuate CLI", () => {
  test("documents its read-only, repeatable source contract", async () => {
    const result = await run("evacuate", "--help");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("--app <name>");
    expect(result.stdout).toContain("--source <file|directory|glob>");
    expect(result.stdout).toContain("--package-name <name>");
    expect(result.stdout).toContain("Read-only");
  });

  test("resolves exact, directory, and glob sources deterministically", async () => {
    const exact = await jsonFor("apps/web/src/widgets/chart.ts");
    const directory = await jsonFor("apps/web/src/widgets");
    const glob = await jsonFor("apps/web/src/widgets/**");

    expect(exact.requested).toEqual(["apps/web/src/widgets/chart.ts"]);
    expect(directory.requested).toEqual(exact.requested);
    expect(glob.requested).toEqual(exact.requested);
    expect(exact.moved.files).toEqual(exact.requested);
    expect(exact.target.packageName).toBe("@acme/chart-ui");
    expect(exact.unselectedDependencies).toContain("apps/web/src/types.ts");
  }, 240_000);

  test("requires app, package name, and at least one source", async () => {
    const noApp = await run("evacuate", "--source", "apps/web/src/widgets", "--package-name", "@acme/chart-ui");
    const noPackage = await run("evacuate", "--app", "web", "--source", "apps/web/src/widgets");
    const noSource = await run("evacuate", "--app", "web", "--package-name", "@acme/chart-ui");
    expect(noApp.code).toBe(64);
    expect(noApp.stderr).toContain("--app <name> is required");
    expect(noPackage.code).toBe(64);
    expect(noPackage.stderr).toContain("--package-name <name> is required");
    expect(noSource.code).toBe(64);
    expect(noSource.stderr).toContain("at least one --source");
  });

  test("refuses unmatched, cross-application, and write-oriented requests", async () => {
    const unmatched = await run("evacuate", ...required, "--source", "apps/web/src/missing/**");
    const crossing = await run("evacuate", ...required, "--source", "apps/*/src/**/*.ts");
    const writing = await run("evacuate", ...required, "--source", "apps/web/src/widgets", "--out", "report.json");
    expect(unmatched.code).toBe(1);
    expect(unmatched.stderr).toContain("matches no production graph nodes");
    expect(crossing.code).toBe(1);
    expect(crossing.stderr).toContain('crosses application "web"');
    expect(writing.code).toBe(64);
    expect(writing.stderr).toContain("unsupported by read-only evacuate");
  }, 240_000);

  test("renders blocked analysis in both JSON and human form", async () => {
    const report = await jsonFor("apps/web/src/widgets/chart.ts");
    expect(report.schema).toBe("evacuation");
    expect(report.application).toBe("web");
    expect(report.candidate.eligible).toBe(false);
    expect(report.boundaryCuts).toContainEqual({
      from: "apps/web/src/widgets/chart.ts",
      specifier: "../types.ts",
      target: "apps/web/src/types.ts",
      kind: "type",
      reason: "outside-evacuation",
      remedy: { kind: "unconfigured" },
    });

    const human = await run("evacuate", ...required, "--source", "apps/web/src/widgets/chart.ts");
    expect(human.code).toBe(0);
    expect(human.stdout).toStartWith("Evacuation e-");
    expect(human.stdout).toContain("Eligible: no");
    expect(human.stdout).toContain("outside-evacuation");
  }, 240_000);
});
