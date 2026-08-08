import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseManifest } from "../src/plan/build.ts";
import { cleanupFixtures, fixtureGit, write } from "./support/fixture-repo.ts";
import { committedWorkspace, existsSync, runIn, writeFileSync } from "./support/cli.ts";

function configuredWorkspace(): string {
  const root = committedWorkspace();
  const configPath = join(root, "monocarve.config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as {
    portfolio: Record<string, unknown>;
    portPromotions?: unknown[];
  };
  config.portfolio = { ...config.portfolio, retainedRoots: ["apps/api/src/db"] };
  config.portPromotions = [{
    id: "database-port",
    retainedRoots: ["apps/api/src/db"],
    contractPackage: "@acme/format",
    contractModule: "./index",
    appConcreteType: "apps/api/src/db/client.ts#Database",
    libraryPort: "DatabasePort",
    targetPackage: "@acme/format",
  }];
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  write(root, "apps/api/src/db/client.ts", "export interface Database { readonly id: string }\n");
  write(root, "apps/api/src/estimating/service.ts", [
    'import type { Database } from "../db/client.ts";',
    "export const estimate = (database: Database): string => database.id;",
    "",
  ].join("\n"));
  write(root, "apps/api/src/estimating/handler.ts", [
    'import { estimate } from "./service.ts";',
    'export const handle = (): string => estimate({ id: "one" });',
    "",
  ].join("\n"));
  write(root, "apps/api/src/routes-estimating.ts", [
    'import { handle } from "./estimating/handler.ts";',
    "export const estimatingRoute = handle;",
    "",
  ].join("\n"));
  fixtureGit(root, "add", "-A");
  fixtureGit(root, "commit", "-qm", "test: add evacuation fixture");
  return root;
}

afterAll(cleanupFixtures);

describe("evacuation immutable plan lifecycle", () => {
  test("writes one ordinary plan for multiple SCCs into an existing package", async () => {
    const root = configuredWorkspace();
    const output = ".monocarve/estimating-evacuation.json";
    const result = await runIn(
      root,
      "evacuate",
      "--app", "api",
      "--source", "apps/api/src/estimating",
      "--source", "apps/api/src/db/client.ts",
      "--package-name", "@acme/format",
      "--package-root", "libs/format",
      "--verify-lockfile",
      "--out", output,
      "--write",
      "--json",
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(existsSync(join(root, output))).toBe(true);
    const response = JSON.parse(result.stdout) as {
      id: string;
      boundaryCuts: { reason: string; remedy: { kind: string; id?: string } }[];
      manifest: ReturnType<typeof parseManifest>;
      simulation: { ok: boolean };
      written: boolean;
    };
    expect(response.id).toMatch(/^e-/);
    expect(response.written).toBe(true);
    expect(response.simulation.ok).toBe(true);
    expect(response.boundaryCuts).toContainEqual(expect.objectContaining({
      reason: "retained-root",
      remedy: { kind: "port-promotion", id: "database-port" },
    }));
    expect(response.manifest.planId).toBe(response.id);
    expect(response.manifest.target).toMatchObject({ packageName: "@acme/format", packageRoot: "libs/format" });
    expect(response.manifest.source.files).toEqual([
      "apps/api/src/db/client.ts",
      "apps/api/src/estimating/handler.ts",
      "apps/api/src/estimating/service.ts",
    ]);
    expect(response.manifest.consumers).toContainEqual(expect.objectContaining({ file: "apps/api/src/routes-estimating.ts" }));
    expect(response.manifest.operations).toContainEqual(expect.objectContaining({ kind: "rewrite-import", file: "apps/api/src/routes-estimating.ts" }));
    expect(parseManifest(readFileSync(join(root, output), "utf8")).planId).toBe(response.id);
  }, 240_000);

  test("writes nothing when a bounded dependency remains outside the evacuation", async () => {
    const root = configuredWorkspace();
    const output = ".monocarve/blocked-evacuation.json";
    const result = await runIn(
      root,
      "evacuate",
      "--app", "api",
      "--source", "apps/api/src/estimating",
      "--package-name", "@acme/format",
      "--out", output,
      "--write",
    );

    expect(result.code).toBe(64);
    expect(result.stderr).toContain("is not eligible");
    expect(result.stderr).toContain("apps/api/src/db/client.ts");
    expect(existsSync(join(root, output))).toBe(false);
  }, 240_000);
});
