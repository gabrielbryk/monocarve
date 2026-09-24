import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { cleanupFixtures, fixtureGit, scratchDirectory } from "./support/fixture-repo.ts";
import { runIn } from "./support/cli.ts";

afterEach(cleanupFixtures);

test("legacy scan keeps its JSON fields and zero exit while exposing degraded qualification additively", async () => {
  const root = legacyFixture();
  const result = await runIn(root, "scan", "--app", "web", "--json");
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  const output = JSON.parse(result.stdout) as {
    moduleCount: number; edgeCount: number; digest: string; byZone: Record<string, number>;
    architectureSummary: { graph: { applicationModules: number }; qualification: { status: string; exitCode: number }; packageReadiness: { status: string; diagnostics: unknown[] } };
    qualification: { schemaVersion: number; status: string; exitCode: number; mayPublish: boolean; diagnostics: unknown[]; overrides: unknown[] };
  };
  expect(output.moduleCount).toBeGreaterThan(0);
  expect(output.edgeCount).toBeGreaterThanOrEqual(0);
  expect(output.digest).toMatch(/^[0-9a-f]{64}$/);
  expect(output.byZone.application).toBeGreaterThan(0);
  expect(output.architectureSummary.graph.applicationModules).toBeGreaterThan(0);
  expect(output.architectureSummary.qualification).toMatchObject({ status: "degraded", exitCode: 2 });
  expect(output.architectureSummary.packageReadiness).toMatchObject({ status: "unavailable", diagnostics: [expect.objectContaining({ code: "WORKSPACE_PATTERN_UNMATCHED" })] });
  expect(output.qualification).toMatchObject({ schemaVersion: 1, status: "degraded", exitCode: 2, mayPublish: true });
  expect(output.qualification.diagnostics).toEqual([expect.objectContaining({ code: "WORKSPACE_PATTERN_UNMATCHED" })]);
});

test("legacy config-doctor keeps its zero exit for degraded qualification and adds the typed record", async () => {
  const root = legacyFixture();
  const result = await runIn(root, "config-doctor", "--json");
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  const output = JSON.parse(result.stdout) as {
    schema: string; effective: unknown[]; applications: unknown[]; workspacePackages: unknown[];
    workspaceResolution: { status: string };
    qualification: { schemaVersion: number; status: string; exitCode: number; mayPublish: boolean; diagnostics: unknown[]; overrides: unknown[] };
  };
  expect(output.schema).toBe("config-doctor");
  expect(output.effective.length).toBeGreaterThan(0);
  expect(output.applications.length).toBe(1);
  // Preserve the historic config-doctor field while the additive typed
  // qualification record reports the unmatched workspace warning.
  expect(output.workspaceResolution).toEqual({ status: "resolved" });
  expect(output.qualification).toMatchObject({ schemaVersion: 1, status: "degraded", exitCode: 2, mayPublish: true });
  expect(output.qualification.diagnostics).toEqual([expect.objectContaining({ code: "WORKSPACE_PATTERN_UNMATCHED" })]);
});

function legacyFixture(): string {
  const root = scratchDirectory();
  mkdirSync(join(root, "apps/web/src"), { recursive: true });
  writeFileSync(join(root, "apps/web/src/main.ts"), "export const main = 1;\n");
  writeFileSync(join(root, "apps/web/tsconfig.json"), '{"compilerOptions":{"module":"esnext","moduleResolution":"bundler","allowImportingTsExtensions":true,"noEmit":true},"include":["src/**/*.ts"]}\n');
  writeFileSync(join(root, "package.json"), '{"private":true}\n');
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
  writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeFileSync(join(root, "monocarve.config.json"), `${JSON.stringify({
    applications: [{ name: "web", sourceRoot: "apps/web/src", tsconfig: "apps/web/tsconfig.json" }],
    packageRoots: ["packages"], packageManager: "pnpm",
    scaffoldTemplates: { packageJson: { contents: '{"name":"{package}"}\n' } },
  })}\n`);
  fixtureGit(root, "init", "-q");
  fixtureGit(root, "config", "user.email", "fixture@example.invalid");
  fixtureGit(root, "config", "user.name", "Fixture");
  fixtureGit(root, "add", ".");
  fixtureGit(root, "commit", "-qm", "fixture");
  return root;
}
