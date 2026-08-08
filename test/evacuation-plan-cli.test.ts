import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseConfig } from "../src/config.ts";
import { parseManifest } from "../src/plan/build.ts";
import { validatePlan } from "../src/plan/validate.ts";
import { simulatePlan } from "../src/transaction/simulate.ts";
import { auditPlanSync } from "../src/transaction/audit.ts";
import { cleanupFixtures, fixtureGit, write } from "./support/fixture-repo.ts";
import { committedWorkspace, existsSync, ROOT, runIn, writeFileSync } from "./support/cli.ts";

function configuredWorkspace(): string {
  const root = committedWorkspace();
  const configPath = join(root, "monocarve.config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as {
    applications: Array<Record<string, unknown>>;
    gates: Record<string, unknown>;
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
  const api = config.applications.find((application) => application.name === "api")!;
  api.compositionRoots = ["apps/api/src/routes-estimating.ts", "apps/api/src/wiring-estimating.ts"];
  api.scaffoldTemplates = {
    tsconfig: { contents: `${JSON.stringify({
      compilerOptions: { composite: true }, files: [], include: [],
      references: [{ path: "./tsconfig.lib.json" }, { path: "./tsconfig.spec.json" }],
    }, null, 2)}\n` },
    extraFiles: {
      "tsconfig.lib.json": { contents: `${JSON.stringify({
        compilerOptions: {
          composite: true, declaration: true, emitDeclarationOnly: true, rootDir: "src", outDir: "dist",
          module: "NodeNext", moduleResolution: "NodeNext", target: "ES2022", strict: true,
          allowImportingTsExtensions: true,
        },
        include: ["src/**/*.ts"], exclude: ["src/**/*.test.ts"],
      }, null, 2)}\n` },
      "tsconfig.spec.json": { contents: `${JSON.stringify({
        extends: "./tsconfig.lib.json", compilerOptions: { rootDir: ".", outDir: "dist/test" },
        include: ["src/**/*.test.ts"], references: [{ path: "./tsconfig.lib.json" }],
      }, null, 2)}\n` },
    },
    projectReferences: { target: "tsconfig.lib.json", dependencyTarget: "tsconfig.lib.json" },
  };
  config.gates = {
    package: [`bun ${join(ROOT, "node_modules/typescript/bin/tsc")} -b {packageRoot}/tsconfig.json --pretty false`],
    project: [],
    workspace: [],
  };
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
  write(root, "apps/api/src/wiring-estimating.ts", [
    'import { handle } from "./estimating/handler.ts";',
    "export const estimatingWiring = { handle };",
    "",
  ].join("\n"));
  fixtureGit(root, "add", "-A");
  fixtureGit(root, "commit", "-qm", "test: add evacuation fixture");
  return root;
}

afterAll(cleanupFixtures);

describe("evacuation immutable plan lifecycle", () => {
  test("moves an explicitly included selected composition root and tamper-checks provenance", async () => {
    const root = configuredWorkspace();
    const result = await runIn(root, "evacuate", "--app", "api", "--source", "apps/api/src/estimating", "--source", "apps/api/src/db/client.ts", "--source", "apps/api/src/routes-estimating.ts", "--source", "apps/api/src/wiring-estimating.ts", "--include-composition", "apps/api/src/wiring-estimating.ts", "--include-composition", "apps/api/src/routes-estimating.ts", "--package-name", "@acme/format", "--package-root", "libs/format", "--json");
    expect(result.code, result.stderr).toBe(0);
    const response = JSON.parse(result.stdout) as { id: string; includedCompositionRoots: string[]; retainedComposition: unknown[]; manifest: ReturnType<typeof parseManifest> };
    expect(response.includedCompositionRoots).toEqual(["apps/api/src/routes-estimating.ts", "apps/api/src/wiring-estimating.ts"]);
    expect(response.retainedComposition).toEqual([]);
    expect(response.manifest.source.files).toContain("apps/api/src/routes-estimating.ts");
    expect(response.manifest.source.files).toContain("apps/api/src/wiring-estimating.ts");
    expect(response.manifest.provenance?.evacuation?.includedCompositionRoots).toEqual(["apps/api/src/routes-estimating.ts", "apps/api/src/wiring-estimating.ts"]);

    const raw = JSON.parse(readFileSync(join(root, "monocarve.config.json"), "utf8"));
    const tampered = structuredClone(response.manifest);
    (tampered.provenance!.evacuation as { includedCompositionRoots?: readonly string[] }).includedCompositionRoots = ["apps/api/src/estimating/service.ts"];
    const validation = validatePlan(tampered, { config: parseConfig(raw, join(root, "monocarve.config.json")), rootDir: root });
    expect(validation.ok).toBe(false);
    expect(validation.issues.map(({ rule }) => rule)).toContain("composition-inclusion");
    expect(validation.issues.map(({ rule }) => rule)).toContain("evacuation-identity");
    const audit = auditPlanSync({ config: parseConfig(raw, join(root, "monocarve.config.json")), rootDir: root, manifest: tampered, skipCompileProof: true });
    expect(audit.passed).toBe(false);
    expect(audit.unauditable).toContainEqual(expect.stringContaining("[composition-inclusion]"));
    expect(audit.unauditable).toContainEqual(expect.stringContaining("[evacuation-identity]"));
  }, 240_000);

  test("refuses composition inclusion that was not selected", async () => {
    const root = configuredWorkspace();
    const result = await runIn(root, "evacuate", "--app", "api", "--source", "apps/api/src/estimating", "--include-composition", "apps/api/src/routes-estimating.ts", "--package-name", "@acme/format", "--json");
    expect(result.code, result.stderr).toBe(1);
    expect(result.stderr).toContain("outside the selected evacuation");
  }, 240_000);

  test("records protected authorization in report, identity, and tamper-checked manifest provenance", async () => {
    const root = configuredWorkspace();
    const configPath = join(root, "monocarve.config.json");
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as { portfolio: Record<string, unknown> };
    raw.portfolio = { ...raw.portfolio, protectedPaths: ["apps/api/src/estimating"] };
    writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`);
    fixtureGit(root, "add", "--", "monocarve.config.json");
    fixtureGit(root, "commit", "-qm", "test: protect evacuation fixture");

    const denied = await runIn(root, "evacuate", "--app", "api", "--source", "apps/api/src/estimating", "--source", "apps/api/src/db/client.ts", "--package-name", "@acme/format", "--json");
    expect((JSON.parse(denied.stdout) as { candidate: { eligible: boolean } }).candidate.eligible).toBe(false);

    const allowed = await runIn(root, "evacuate", "--app", "api", "--source", "apps/api/src/estimating", "--source", "apps/api/src/db/client.ts", "--authorize-protected", "apps/api/src/estimating", "--package-name", "@acme/format", "--package-root", "libs/format", "--json");
    expect(allowed.code).toBe(0);
    const response = JSON.parse(allowed.stdout) as { id: string; authorizedProtectedRoots: string[]; manifest: ReturnType<typeof parseManifest> };
    expect(response.authorizedProtectedRoots).toEqual(["apps/api/src/estimating"]);
    expect(response.manifest.provenance?.evacuation).toMatchObject({ id: response.id, authorizedProtectedRoots: ["apps/api/src/estimating"] });

    const cfg = parseConfig(raw, configPath);
    const tampered = structuredClone(response.manifest);
    (tampered.provenance!.evacuation!.authorizedProtectedRoots as string[])[0] = "apps/api/src/db";
    const validation = validatePlan(tampered, { config: cfg, rootDir: root });
    expect(validation.ok).toBe(false);
    expect(validation.issues.map(({ rule }) => rule)).toContain("protected-authorization");
    expect(validation.issues.map(({ rule }) => rule)).toContain("evacuation-identity");
  }, 240_000);

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

  test("new-package evacuation emits and typechecks a complete solution config", async () => {
    const root = configuredWorkspace();
    const result = await runIn(
      root,
      "evacuate",
      "--app", "api",
      "--source", "apps/api/src/estimating",
      "--source", "apps/api/src/db/client.ts",
      "--package-name", "@acme/estimating-evacuated",
      "--json",
    );

    expect(result.code).toBe(0);
    const response = JSON.parse(result.stdout) as { manifest: ReturnType<typeof parseManifest> };
    const writes = response.manifest.operations
      .filter((operation) => operation.kind === "write-file")
      .map((operation) => operation.path);
    expect(writes).toContain("libs/estimating-evacuated/tsconfig.json");
    expect(writes).toContain("libs/estimating-evacuated/tsconfig.lib.json");
    expect(writes).toContain("libs/estimating-evacuated/tsconfig.spec.json");
    expect(response.manifest.operations.filter((operation) =>
      operation.kind === "write-file" && operation.path === "libs/estimating-evacuated/tsconfig.json"
    )).toHaveLength(1);
    const simulation = await simulatePlan({
      config: parseConfig(JSON.parse(readFileSync(join(root, "monocarve.config.json"), "utf8")), join(root, "monocarve.config.json")),
      rootDir: root,
      manifest: response.manifest,
      verifyLockfile: true,
    });
    expect(simulation.ok, JSON.stringify(simulation, null, 2)).toBe(true);
    expect(simulation.gates).toContainEqual(expect.objectContaining({ tier: "package", exitCode: 0 }));
  }, 240_000);
});
