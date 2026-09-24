import { afterAll, describe, expect, test } from "bun:test";

import { moonAdapter } from "../src/adapters/moon.ts";
import { pnpmAdapter } from "../src/adapters/pnpm.ts";
import { WorkspaceContext } from "../src/plan/context.ts";
import { packageOperations } from "../src/plan/scaffold.ts";
import { cleanupFixtures, fixtureConfig, fixtureRepo } from "./support/fixture-repo.ts";

const LOCKFILE = `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      runtime-lib:
        specifier: ^1.0.0
        version: 1.0.0

  libs/target: {}

packages:

  runtime-lib@1.0.0: {}

snapshots:

  runtime-lib@1.0.0: {}
`;

function operationsFor(files: Record<string, string>, runtime: Record<string, string>, dev: Record<string, string> = {}) {
  const root = fixtureRepo({ "pnpm-lock.yaml": LOCKFILE, "libs/target/package.json": '{"name":"@acme/target"}\n', ...files });
  const config = fixtureConfig(root);
  return packageOperations({
    context: new WorkspaceContext(config, root),
    config,
    application: config.applications[0]!,
    packageManager: pnpmAdapter,
    taskRunner: moonAdapter,
    packageName: "@acme/target",
    packageRoot: "libs/target",
    projectId: "target",
    production: [],
    dependencies: { runtime, dev, packageReferences: [] },
  });
}

describe("existing target package lockfile importer", () => {
  afterAll(cleanupFixtures);

  test("replaces the importer when the existing target gains a dependency", () => {
    const operations = operationsFor({}, { "runtime-lib": "^1.0.0" });
    const manifests = operations.filter((operation) => operation.kind === "write-file" && operation.path === "libs/target/package.json");
    const importers = operations.filter((operation) => operation.kind === "lockfile-importer" && operation.packageRoot === "libs/target");

    expect(manifests).toHaveLength(1);
    expect(importers).toHaveLength(1);
    expect(importers[0]).toMatchObject({ kind: "lockfile-importer", mode: "replace" });
    expect(importers[0]?.kind === "lockfile-importer" ? importers[0].block : "").toContain("runtime-lib:");
  });

  test("refuses an existing package whose importer is absent", () => {
    expect(() => operationsFor({ "pnpm-lock.yaml": LOCKFILE.replace("\n  libs/target: {}\n", "") }, { "runtime-lib": "^1.0.0" })).toThrow(
      "has no importer entry for existing package libs/target",
    );
  });

  test("does not rewrite an unchanged importer", () => {
    expect(operationsFor({}, {}).some((operation) => operation.kind === "lockfile-importer")).toBe(false);
  });

  test("derives the replacement importer from the merged manifest and never demotes an existing runtime dependency", () => {
    const dependency = "@acme/contracts";
    const lockfile = LOCKFILE.replace(
      "  libs/target: {}",
      `  libs/target:\n    dependencies:\n      '${dependency}':\n        specifier: workspace:*\n        version: link:../contracts`,
    );
    const operations = operationsFor(
      {
        "pnpm-lock.yaml": lockfile,
        "libs/target/package.json": `${JSON.stringify({ name: "@acme/target", dependencies: { [dependency]: "workspace:*" } })}\n`,
      },
      { "runtime-lib": "^1.0.0" },
      { [dependency]: "workspace:*" },
    );
    const manifest = operations.find((operation) => operation.kind === "write-file" && operation.path === "libs/target/package.json");
    const importer = operations.find((operation) => operation.kind === "lockfile-importer" && operation.packageRoot === "libs/target");
    const packageJson =
      manifest?.kind === "write-file"
        ? (JSON.parse(manifest.contents) as { dependencies: Record<string, string>; devDependencies: Record<string, string> })
        : undefined;

    expect(packageJson?.dependencies[dependency]).toBe("workspace:*");
    expect(packageJson?.devDependencies[dependency]).toBeUndefined();
    expect(importer?.kind === "lockfile-importer" ? importer.block : "").toContain(`    dependencies:\n      '${dependency}':`);
    expect(importer?.kind === "lockfile-importer" ? importer.block : "").not.toContain(`    devDependencies:\n      '${dependency}':`);
  });
});
