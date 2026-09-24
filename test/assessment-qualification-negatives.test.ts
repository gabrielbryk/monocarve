import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { qualifyAssessment } from "../src/assessment/qualification.ts";
import { qualifyWorkspace } from "../src/assessment/qualify-workspace.ts";
import { parseConfig } from "../src/config.ts";
import { runIn } from "./support/cli.ts";
import { fixtureGit, scratchDirectory } from "./support/fixture-repo.ts";

test("an empty existing source root is fatal unless allow-empty is explicit", async () => {
  const root = qualificationRoot();
  const result = await qualifyWorkspace({ config: qualificationConfig(), rootDir: root, application: "web", reports: { web: { modules: [] } } });
  expect(result.qualification.status).toBe("fatal");
  expect(result.qualification.exitCode).toBe(1);
  expect(result.qualification.diagnostics.map((entry) => entry.code)).toEqual(["SOURCE_ROOT_EMPTY"]);
});

test("allow-empty cannot conceal a missing source root", async () => {
  const root = scratchDirectory();
  writeWorkspaceFiles(root);
  const result = await qualifyWorkspace({
    config: qualificationConfig(),
    rootDir: root,
    application: "web",
    reports: { web: { modules: [] } },
    allowEmpty: true,
  });
  expect(result.qualification).toMatchObject({ status: "fatal", exitCode: 1, mayPublish: false, overrides: [] });
  expect(result.qualification.diagnostics.map((entry) => entry.code)).toContain("SOURCE_ROOT_MISSING");
});

test("allow-empty cannot conceal production files omitted by the scanner", async () => {
  const root = qualificationRoot();
  writeFileSync(join(root, "apps/web/src/main.ts"), "export const value = 1;\n");
  const result = await qualifyWorkspace({
    config: qualificationConfig(),
    rootDir: root,
    application: "web",
    reports: { web: { modules: [] } },
    allowEmpty: true,
  });
  expect(result.qualification).toMatchObject({ status: "fatal", exitCode: 1, mayPublish: false, overrides: [] });
  expect(result.qualification.diagnostics.map((entry) => entry.code)).toContain("SCAN_UNEXPECTED_EMPTY_GRAPH");
});

test("allow-empty cannot conceal a configured compound-suffix file excluded by tsconfig", async () => {
  const root = qualificationRoot();
  writeFileSync(join(root, "apps/web/src/widget.component.ts"), "export const widget = 1;\n");
  writeFileSync(join(root, "apps/web/tsconfig.json"), '{"include":["src/**/*.plain.ts"]}\n');
  const config = qualificationConfig({ sourceExtensions: [".component.ts"] });
  const result = await qualifyWorkspace({ config, rootDir: root, application: "web", reports: { web: { modules: [] } }, allowEmpty: true });
  expect(result.qualification).toMatchObject({ status: "fatal", exitCode: 1, mayPublish: false });
  expect(result.qualification.diagnostics.map((entry) => entry.code)).toContain("SCAN_TSCONFIG_EXCLUDES_PRODUCTION");
});

test("allow-empty cannot conceal a configured graph exclusion of every production file", async () => {
  const root = qualificationRoot();
  writeFileSync(join(root, "apps/web/src/main.ts"), "export const value = 1;\n");
  const config = qualificationConfig({ graph: { exclude: ["src/**/*.ts"] } });
  const result = await qualifyWorkspace({ config, rootDir: root, application: "web", reports: { web: { modules: [] } }, allowEmpty: true });
  expect(result.qualification.status).toBe("fatal");
  expect(result.qualification.diagnostics.map((entry) => entry.code)).toContain("SCAN_CONFIGURATION_EXCLUDES_PRODUCTION");
});

test("unsupported workspace syntax remains fatal even when allow-empty is supplied", async () => {
  const root = qualificationRoot("packages:\n  - 'packages/**'\n");
  const result = await qualifyWorkspace({
    config: qualificationConfig(),
    rootDir: root,
    application: "web",
    reports: { web: { modules: [] } },
    allowEmpty: true,
  });
  expect(result.qualification).toMatchObject({ status: "fatal", exitCode: 1, mayPublish: false, overrides: ["allow-empty"] });
  expect(result.qualification.diagnostics.map((entry) => entry.code)).toContain("WORKSPACE_GLOB_UNSUPPORTED");
});

test("an unrecognized qualification error defaults to fatal", () => {
  const result = qualifyAssessment({
    diagnostics: [{ code: "WORKSPACE_DISCOVERY_FAILED", severity: "warning", message: "unreadable", impact: "unavailable" }],
  });
  expect(result).toMatchObject({ status: "fatal", exitCode: 1, mayPublish: false });
});

test("allow-empty cannot override replay mismatch or input drift", () => {
  for (const code of ["ASSESSMENT_REPLAY_INPUT_MISMATCH", "ASSESSMENT_INPUT_DRIFT"] as const) {
    const result = qualifyAssessment({
      allowedEmpty: true,
      diagnostics: [{ code, severity: "warning", message: "authority changed", impact: "captured evidence is stale" }],
    });
    expect(result).toMatchObject({ status: "fatal", exitCode: 1, mayPublish: false, overrides: ["allow-empty"] });
  }
});

test("a missing or inconsistent scanner report is fatal instead of an allowed empty", async () => {
  const root = qualificationRoot();
  const missing = await qualifyWorkspace({ config: qualificationConfig(), rootDir: root, application: "web", reports: {}, allowEmpty: true });
  expect(missing.qualification).toMatchObject({ status: "fatal", exitCode: 1, mayPublish: false });
  expect(missing.qualification.diagnostics.map((entry) => entry.code)).toContain("SCAN_REPORT_MALFORMED");

  writeFileSync(join(root, "apps/web/src/main.ts"), "export const main = 1;\n");
  writeFileSync(join(root, "apps/web/src/other.ts"), "export const other = 1;\n");
  const inconsistent = await qualifyWorkspace({
    config: qualificationConfig(),
    rootDir: root,
    application: "web",
    allowEmpty: true,
    reports: {
      web: {
        modules: [
          { source: "apps/web/src/other.ts", dependencies: [] },
          { source: "apps/web/src/other.ts", dependencies: [] },
        ],
      },
    },
  });
  expect(inconsistent.qualification).toMatchObject({ status: "fatal", exitCode: 1, mayPublish: false });
  expect(inconsistent.qualification.diagnostics.map((entry) => entry.code)).toContain("SCAN_REPORT_MALFORMED");
  expect(inconsistent.qualification.overrides).toEqual([]);
});

test("fatal assessment JSON has the complete machine-readable outcome envelope", async () => {
  // Keep the destination's parent valid so this exercises the missing replay
  // provenance path, rather than failing first on publication confinement.
  const result = await runIn(
    join(import.meta.dir, "../fixtures/basic-monorepo"),
    "assess",
    "--app",
    "web",
    "--evidence-dir",
    "fatal-output",
    "--replay",
    "missing-replay",
    "--json",
  );
  expect(result.code).toBe(1);
  const output = JSON.parse(result.stdout) as { status?: string; exitCode?: number; diagnostics?: unknown[]; published?: boolean };
  expect(output).toMatchObject({ status: "fatal", exitCode: 1, published: false });
  expect(output.diagnostics?.length).toBeGreaterThan(0);
});

test("missing source roots produce fatal JSON and no evidence directory", async () => {
  const root = scratchDirectory();
  writeWorkspaceFiles(root);
  mkdirSync(join(root, "apps/missing"), { recursive: true });
  writeFileSync(join(root, "apps/missing/tsconfig.json"), '{"include":["src/**/*.ts"]}\n');
  writeFileSync(
    join(root, "monocarve.config.json"),
    `${JSON.stringify({
      applications: [{ name: "web", sourceRoot: "apps/missing/src", tsconfig: "apps/missing/tsconfig.json" }],
      packageRoots: ["packages"],
      scaffoldTemplates: { packageJson: { contents: '{"name":"{package}"}\\n' } },
    })}\n`,
  );
  fixtureGit(root, "init", "-q", "-b", "qualification-fixture");
  fixtureGit(root, "config", "user.email", "fixture@example.invalid");
  fixtureGit(root, "config", "user.name", "Monocarve Fixture");
  fixtureGit(root, "config", "commit.gpgsign", "false");
  fixtureGit(root, "add", "-A");
  fixtureGit(root, "commit", "-qm", "test: seed qualification fixture");
  const result = await runIn(root, "assess", "--app", "web", "--evidence-dir", "evidence", "--json");
  expect(result.code).toBe(1);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toMatchObject({
    status: "fatal",
    exitCode: 1,
    published: false,
    diagnostics: [expect.objectContaining({ code: "SOURCE_ROOT_MISSING" })],
  });
  expect(existsSync(join(root, "evidence"))).toBeFalse();
});

test("invalid assessment configuration also uses the fatal JSON envelope", async () => {
  const root = scratchDirectory();
  writeFileSync(join(root, "monocarve.config.json"), "{not-json\n");
  const result = await runIn(root, "assess", "--app", "web", "--evidence-dir", "evidence", "--json");
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({ status: "fatal", exitCode: 1, published: false });
  expect(result.stderr).toBe("");
});

function qualificationRoot(workspace = "packages: []\n"): string {
  const root = scratchDirectory();
  mkdirSync(join(root, "apps/web/src"), { recursive: true });
  writeWorkspaceFiles(root, workspace);
  writeFileSync(join(root, "apps/web/tsconfig.json"), '{"include":["src/**/*.ts"]}\n');
  return root;
}

function writeWorkspaceFiles(root: string, workspace = "packages: []\n"): void {
  writeFileSync(join(root, "package.json"), '{"private":true}\n');
  writeFileSync(join(root, "pnpm-workspace.yaml"), workspace);
  writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
}

function qualificationConfig(overrides: Record<string, unknown> = {}) {
  return parseConfig({
    applications: [{ name: "web", sourceRoot: "apps/web/src", tsconfig: "apps/web/tsconfig.json" }],
    packageRoots: ["packages"],
    scaffoldTemplates: { packageJson: { contents: '{"name":"{package}"}\n' } },
    ...overrides,
  });
}
