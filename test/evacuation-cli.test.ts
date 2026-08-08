import { describe, expect, test } from "bun:test";

import { join } from "node:path";

import { existsSync, FIXTURE, run } from "./support/cli.ts";

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

async function jsonFor(...sources: string[]): Promise<EvacuationJson> {
  const result = await run("evacuate", ...required, ...sources.flatMap((source) => ["--source", source]), "--json");
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
    const exact = await jsonFor("apps/web/src/widgets/chart.ts", "apps/web/src/types.ts");
    const directory = await jsonFor("apps/web/src");
    const glob = await jsonFor("apps/web/src/**/*.ts");

    expect(exact.requested).toEqual(["apps/web/src/types.ts", "apps/web/src/widgets/chart.ts"]);
    expect(directory.requested).toContain("apps/web/src/widgets/chart.ts");
    expect(glob.requested).toEqual(directory.requested);
    expect(exact.moved.files).toEqual(exact.requested);
    expect(exact.target.packageName).toBe("@acme/chart-ui");
    expect(exact.unselectedDependencies).toEqual([]);
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
  }, 240_000);

  test("refuses unmatched, cross-application, and write-oriented requests", async () => {
    const unmatched = await run("evacuate", ...required, "--source", "apps/web/src/missing/**");
    const crossing = await run("evacuate", ...required, "--source", "apps/*/src/**/*.ts");
    const writing = await run("evacuate", ...required, "--source", "apps/web/src/widgets", "--apply");
    expect(unmatched.code).toBe(1);
    expect(unmatched.stderr).toContain("matches no production graph nodes");
    expect(crossing.code).toBe(1);
    expect(crossing.stderr).toContain('crosses application "web"');
    expect(writing.code).toBe(64);
    expect(writing.stderr).toContain("--apply is unsupported by evacuate");
  }, 240_000);

  test("refuses blocked analysis without writing and renders eligible human review", async () => {
    const blockedPlan = join(FIXTURE, ".monocarve/blocked.json");
    expect(existsSync(blockedPlan)).toBe(false);
    const analysis = await run("evacuate", ...required, "--source", "apps/web/src/widgets/chart.ts", "--json");
    expect(analysis.code).toBe(0);
    expect(analysis.stderr).toBe("");
    const blockedReport = JSON.parse(analysis.stdout) as EvacuationJson & { readonly manifest?: unknown };
    expect(blockedReport.candidate.eligible).toBe(false);
    expect(blockedReport.boundaryCuts).toContainEqual(expect.objectContaining({
      target: "apps/web/src/types.ts",
      reason: "outside-evacuation",
      remedy: { kind: "unconfigured" },
    }));
    expect(blockedReport.manifest).toBeUndefined();
    expect(existsSync(blockedPlan)).toBe(false);

    const blocked = await run("evacuate", ...required, "--source", "apps/web/src/widgets/chart.ts", "--out", ".monocarve/blocked.json", "--write");
    expect(blocked.code).toBe(64);
    expect(blocked.stderr).toContain("is not eligible");
    expect(blocked.stderr).toContain("apps/web/src/widgets/chart.ts -> ../types.ts -> apps/web/src/types.ts");
    expect(existsSync(blockedPlan)).toBe(false);

    const human = await run("evacuate", ...required, "--source", "apps/web/src/widgets/chart.ts", "--source", "apps/web/src/types.ts");
    expect(human.code).toBe(0);
    expect(human.stdout).toStartWith("Evacuation e-");
    expect(human.stdout).toContain("Eligible: yes");
    expect(human.stdout).toContain("Output:");
  }, 240_000);
});
