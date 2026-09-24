import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseConfig } from "../src/config.ts";
import { qualifyAssessment } from "../src/assessment/qualification.ts";
import { qualifyWorkspace } from "../src/assessment/qualify-workspace.ts";
import { inspectConfig } from "../src/doctor/config-doctor.ts";
import { fixtureGit, scratchDirectory } from "./support/fixture-repo.ts";

describe("assessment qualification", () => {
  test("fatal diagnostics take precedence over degraded and allowed-empty", () => {
    const qualification = qualifyAssessment({ allowedEmpty: true, diagnostics: [
      { code: "WORKSPACE_PATTERN_UNMATCHED", severity: "warning", message: "unmatched", impact: "partial" },
      { code: "WORKSPACE_PACKAGE_DUPLICATE", severity: "error", message: "duplicate", impact: "ambiguous" },
    ] });
    expect(qualification).toMatchObject({ status: "fatal", exitCode: 1, mayPublish: false, overrides: ["allow-empty"] });
  });

  test("allowed-empty plus a supported unmatched pattern is degraded", () => {
    const qualification = qualifyAssessment({ allowedEmpty: true, diagnostics: [
      { code: "WORKSPACE_PATTERN_UNMATCHED", severity: "warning", message: "unmatched", impact: "partial" },
    ] });
    expect(qualification).toMatchObject({ status: "degraded", exitCode: 2, mayPublish: true, overrides: ["allow-empty"] });
  });

  test("only a genuinely empty existing root can be allowed", async () => {
    const root = fixtureRoot();
    const config = fixtureConfig();
    const result = await qualifyWorkspace({ config, rootDir: root, application: "consumer", reports: { consumer: { modules: [] } }, allowEmpty: true });
    expect(result.qualification).toMatchObject({ status: "allowed-empty", exitCode: 0, overrides: ["allow-empty"] });
  });

  test("allow-empty cannot conceal tsconfig exclusion of production files", async () => {
    const root = fixtureRoot();
    writeFileSync(join(root, "apps/consumer/src/excluded.ts"), "export const value = 1;\n");
    writeFileSync(join(root, "apps/consumer/tsconfig.json"), '{"include":["elsewhere/**/*.ts"]}\n');
    const config = fixtureConfig();
    const result = await qualifyWorkspace({ config, rootDir: root, application: "consumer", reports: { consumer: { modules: [] } }, allowEmpty: true });
    expect(result.qualification.status).toBe("fatal");
    expect(result.qualification.diagnostics.map((entry) => entry.code)).toContain("SCAN_TSCONFIG_EXCLUDES_PRODUCTION");
  });

  test("config doctor preserves resolved legacy status and exposes unmatched diagnostics additively", async () => {
    const root = fixtureRoot("packages:\n  - 'packages/*'\n  - 'plugins/*/ui'\n");
    mkdirSync(join(root, "packages/tool"), { recursive: true });
    writeFileSync(join(root, "packages/tool/package.json"), '{"name":"@acme/tool"}\n');
    const config = fixtureConfig();
    const report = await inspectConfig({ config, configPath: join(root, "config.ts"), rootDir: root });
    // Legacy wire-format compatibility: successful adapter inspection has
    // always reported `resolved`; qualification owns the degraded distinction.
    expect(report.workspaceResolution.status).toBe("resolved");
    expect(report.workspacePackages).toEqual([{ dir: "packages/tool", name: "@acme/tool" }]);
    expect(report.qualification).toMatchObject({ status: "degraded", diagnostics: [{ code: "WORKSPACE_PATTERN_UNMATCHED" }] });
  });

  test("degraded qualification keeps graph facts but withholds resolution-dependent fields", () => {
    const diagnostic = { code: "WORKSPACE_PATTERN_UNMATCHED" as const, severity: "warning" as const, message: "unmatched", impact: "package readiness unavailable" };
    const qualification = qualifyAssessment({ diagnostics: [diagnostic] });
    expect(qualification).toMatchObject({ status: "degraded", exitCode: 2, mayPublish: true });
    expect(qualification.diagnostics).toEqual([diagnostic]);
  });

  test("unsupported syntax and duplicate names are typed fatal diagnostics", async () => {
    const unsupportedRoot = fixtureRoot("packages:\n  - 'packages/**'\n");
    const config = fixtureConfig();
    const unsupported = await qualifyWorkspace({ config, rootDir: unsupportedRoot });
    expect(unsupported.qualification.diagnostics[0]?.code).toBe("WORKSPACE_GLOB_UNSUPPORTED");

    const duplicateRoot = fixtureRoot("packages:\n  - 'packages/*'\n");
    for (const dir of ["one", "two"]) {
      mkdirSync(join(duplicateRoot, "packages", dir), { recursive: true });
      writeFileSync(join(duplicateRoot, "packages", dir, "package.json"), '{"name":"@acme/same"}\n');
    }
    const duplicate = await qualifyWorkspace({ config, rootDir: duplicateRoot });
    expect(duplicate.qualification.diagnostics[0]?.code).toBe("WORKSPACE_PACKAGE_DUPLICATE");
  });
});

function fixtureRoot(workspace = "packages: []\n"): string {
  const root = scratchDirectory();
  mkdirSync(join(root, "apps/consumer/src"), { recursive: true });
  writeFileSync(join(root, "apps/consumer/tsconfig.json"), '{"include":["src/**/*.ts"]}\n');
  writeFileSync(join(root, "package.json"), '{"private":true}\n');
  writeFileSync(join(root, "pnpm-workspace.yaml"), workspace);
  writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  fixtureGit(root, "init", "-q");
  return root;
}

function fixtureConfig() {
  return parseConfig({
    applications: [{ name: "consumer", sourceRoot: "apps/consumer/src", tsconfig: "apps/consumer/tsconfig.json" }],
    packageRoots: ["packages"],
    scaffoldTemplates: { packageJson: { contents: '{"name":"{package}"}\n' } },
  });
}
