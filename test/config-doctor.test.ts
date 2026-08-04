import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseConfig } from "../src/config.ts";
import { inspectConfig } from "../src/doctor/config-doctor.ts";
import { fixtureGit, scratchDirectory } from "./support/fixture-repo.ts";
import { runJsonIn } from "./support/cli.ts";

describe("config doctor", () => {
  test("reports effective provenance, workspace resolution, and preparation coverage without writing", async () => {
    const root = scratchDirectory();
    mkdirSync(join(root, "apps/consumer/src"), { recursive: true });
    mkdirSync(join(root, "packages/tool/src"), { recursive: true });
    writeFileSync(join(root, "apps/consumer/tsconfig.json"), "{}\n");
    writeFileSync(join(root, "packages/tool/package.json"), '{"name":"@acme/tool"}\n');
    writeFileSync(join(root, "package.json"), '{"private":true}\n');
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    fixtureGit(root, "init", "-q");
    fixtureGit(root, "config", "user.email", "fixture@example.invalid");
    fixtureGit(root, "config", "user.name", "Monocarve Fixture");
    fixtureGit(root, "add", ".");
    fixtureGit(root, "commit", "-qm", "test: fixture");
    writeFileSync(join(root, "scratch.txt"), "dirty\n");

    const userConfig = {
      applications: [{ name: "consumer", sourceRoot: "apps/consumer/src", tsconfig: "apps/consumer/tsconfig.json",
        compilerProfile: { types: ["runtime-types"], moduleResolution: "bundler" } }],
      packageRoots: ["packages"], packageScope: "@acme/", moduleSpecifierCalls: ["mock.module"],
      portfolio: { protectedPaths: ["shared/registry.ts"] },
      scaffoldTemplates: { packageJson: { contents: '{"name":"{package}"}\n' } },
      transaction: { allowDirtyPaths: ["scratch.txt"] },
      preparation: { commit: { subject: "chore: prepare {sourcePath}" }, gates: { project: ["check"] } },
      generatedArtifacts: { artifacts: [{ path: "generated/map.ts", source: "source/map.ts", regenerate: "generate" }] },
    };
    const report = await inspectConfig({ config: parseConfig(userConfig), configPath: join(root, "monocarve.config.ts"), rootDir: root, userConfig });

    expect(report.effective.find((item) => item.key === "packageScope")?.source).toBe("explicit");
    expect(report.effective.find((item) => item.key === "taskRunner")?.source).toBe("default");
    expect(report.applications[0]).toMatchObject({ sourceRootExists: true, tsconfigExists: true,
      compilerProfile: { types: ["runtime-types"], moduleResolution: "bundler" } });
    expect(report.workspacePackages).toEqual([{ dir: "packages/tool", name: "@acme/tool" }]);
    expect(report.adapters).toMatchObject({ packageManager: { status: "available" }, taskRunner: { status: "available" } });
    expect(report.dirtyPaths).toEqual(["scratch.txt"]);
    expect(report.preparation).toMatchObject({ policyConfigured: true, gateTiersConfigured: ["project"] });
    expect(report.generatedArtifacts.artifacts[0]?.path).toBe("generated/map.ts");
  });

  test("makes unsupported adapters and unknown provenance visible", async () => {
    const root = scratchDirectory();
    mkdirSync(join(root, "apps/consumer/src"), { recursive: true });
    writeFileSync(join(root, "apps/consumer/tsconfig.json"), "{}\n");
    fixtureGit(root, "init", "-q");
    const config = parseConfig({ applications: [{ name: "consumer", sourceRoot: "apps/consumer/src", tsconfig: "apps/consumer/tsconfig.json" }], packageRoots: ["packages"], packageManager: "bun", taskRunner: "nx", scaffoldTemplates: { packageJson: { contents: '{"name":"{package}"}\n' } } });
    const report = await inspectConfig({ config, configPath: join(root, "config.ts"), rootDir: root });

    expect(report.adapters.packageManager).toMatchObject({ configured: "bun", status: "not-yet-ported" });
    expect(report.adapters.taskRunner).toMatchObject({ configured: "nx", status: "not-yet-ported" });
    expect(report.workspaceResolution.status).toBe("unavailable");
    expect(report.effective.every((item) => item.source === "unknown")).toBe(true);
    expect(report.packageRoots).toEqual([{ path: "packages", exists: false }]);
  });

  test("names a root-export template that contradicts a subpaths-only surface", async () => {
    const root = scratchDirectory();
    mkdirSync(join(root, "apps/consumer/src"), { recursive: true });
    writeFileSync(join(root, "apps/consumer/tsconfig.json"), "{}\n");
    fixtureGit(root, "init", "-q");
    const config = parseConfig({
      applications: [{ name: "consumer", sourceRoot: "apps/consumer/src", tsconfig: "apps/consumer/tsconfig.json" }],
      packageRoots: ["packages"],
      scaffoldTemplates: {
        packageJson: { contents: '{"name":"{package}","exports":{".":"./src/index.ts"}}\n' },
        publicSurface: { mode: "subpaths", keyTemplate: "./{pathNoExtension}", targetTemplate: "./src/{path}" },
      },
    });

    const report = await inspectConfig({ config, configPath: join(root, "config.ts"), rootDir: root });
    expect(report.semanticIssues).toEqual([{
      severity: "error", context: "application consumer",
      detail: "scaffold package template declares a root export, but publicSurface is subpaths-only; remove the root export or select barrel mode",
    }]);
  });

  test("CLI exposes the report without changing the checkout", async () => {
    const root = scratchDirectory();
    mkdirSync(join(root, "apps/consumer/src"), { recursive: true });
    writeFileSync(join(root, "apps/consumer/tsconfig.json"), "{}\n");
    writeFileSync(join(root, "package.json"), '{"private":true}\n');
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n");
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    const userConfig = { applications: [{ name: "consumer", sourceRoot: "apps/consumer/src", tsconfig: "apps/consumer/tsconfig.json" }], packageRoots: ["packages"], scaffoldTemplates: { packageJson: { contents: '{"name":"{package}"}\n' } } };
    writeFileSync(join(root, "monocarve.config.json"), `${JSON.stringify(userConfig)}\n`);
    fixtureGit(root, "init", "-q");
    fixtureGit(root, "config", "user.email", "fixture@example.invalid");
    fixtureGit(root, "config", "user.name", "Monocarve Fixture");
    fixtureGit(root, "add", ".");
    fixtureGit(root, "commit", "-qm", "test: fixture");
    const before = fixtureGit(root, "status", "--short");

    const report = await runJsonIn<{ schema: string; effective: { key: string; source: string }[] }>(root, "config-doctor");

    expect(report.schema).toBe("config-doctor");
    expect(report.effective.find((item) => item.key === "packageRoots")?.source).toBe("explicit");
    expect(report.effective.find((item) => item.key === "packageManager")?.source).toBe("default");
    expect(fixtureGit(root, "status", "--short")).toBe(before);
  });

  test("detects pathReferenceRewrites.matchExtensionless true while pathReferences.matchExtensionless is false", async () => {
    const root = scratchDirectory();
    mkdirSync(join(root, "apps/consumer/src"), { recursive: true });
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(join(root, "apps/consumer/tsconfig.json"), "{}\n");
    writeFileSync(join(root, "config/scripts"), "");
    fixtureGit(root, "init", "-q");
    const config = parseConfig({
      applications: [{ name: "consumer", sourceRoot: "apps/consumer/src", tsconfig: "apps/consumer/tsconfig.json" }],
      packageRoots: ["packages"],
      pathReferences: { matchExtensionless: false },
      pathReferenceRewrites: { enabled: true, matchExtensionless: true, roots: [{ root: "config", extensions: [".sh"], mode: "exact-path-token" }] },
      scaffoldTemplates: { packageJson: { contents: '{"name":"{package}"}\n' } },
    });
    const report = await inspectConfig({ config, configPath: join(root, "config.ts"), rootDir: root });

    expect(report.semanticIssues).toContainEqual({
      severity: "error", context: "pathReferenceRewrites",
      detail: "matchExtensionless is true but pathReferences.matchExtensionless is false; the rewriter would mutate extensionless references the warning scanner never warned about",
    });
  });

  test("detects pathReferences.enabled false while pathReferenceRewrites.enabled is true", async () => {
    const root = scratchDirectory();
    mkdirSync(join(root, "apps/consumer/src"), { recursive: true });
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(join(root, "apps/consumer/tsconfig.json"), "{}\n");
    writeFileSync(join(root, "config/scripts"), "");
    fixtureGit(root, "init", "-q");
    const config = parseConfig({
      applications: [{ name: "consumer", sourceRoot: "apps/consumer/src", tsconfig: "apps/consumer/tsconfig.json" }],
      packageRoots: ["packages"],
      pathReferences: { enabled: false },
      pathReferenceRewrites: { enabled: true, roots: [{ root: "config", extensions: [".sh"], mode: "exact-path-token" }] },
      scaffoldTemplates: { packageJson: { contents: '{"name":"{package}"}\n' } },
    });
    const report = await inspectConfig({ config, configPath: join(root, "config.ts"), rootDir: root });

    expect(report.semanticIssues).toContainEqual({
      severity: "error", context: "pathReferenceRewrites",
      detail: "pathReferences.enabled is false while pathReferenceRewrites.enabled is true; the rewriter would mutate references the warning scanner never warned about",
    });
  });

  test("detects pathReferenceRewrites.roots entry not covered by pathReferences.textRoots", async () => {
    const root = scratchDirectory();
    mkdirSync(join(root, "apps/consumer/src"), { recursive: true });
    mkdirSync(join(root, "config"), { recursive: true });
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, "apps/consumer/tsconfig.json"), "{}\n");
    writeFileSync(join(root, "config/scripts"), "");
    writeFileSync(join(root, "scripts/test.sh"), "");
    fixtureGit(root, "init", "-q");
    const config = parseConfig({
      applications: [{ name: "consumer", sourceRoot: "apps/consumer/src", tsconfig: "apps/consumer/tsconfig.json" }],
      packageRoots: ["packages"],
      pathReferences: { textRoots: [{ root: "config", extensions: [".sh"] }] },
      pathReferenceRewrites: { enabled: true, roots: [{ root: "scripts", extensions: [".sh"], mode: "exact-path-token" }] },
      scaffoldTemplates: { packageJson: { contents: '{"name":"{package}"}\n' } },
    });
    const report = await inspectConfig({ config, configPath: join(root, "config.ts"), rootDir: root });

    expect(report.semanticIssues).toContainEqual({
      severity: "error", context: "pathReferenceRewrites",
      detail: "root \"scripts\" is not covered by pathReferences.textRoots; the rewriter would mutate a tree the warning scanner never looked at",
    });
  });
});
