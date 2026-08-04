/** Generated interaction matrix for structured package projection. */

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { pnpmAdapter } from "../src/adapters/pnpm.ts";
import type { TaskRunnerAdapter } from "../src/adapters/types.ts";
import { WorkspaceContext } from "../src/plan/context.ts";
import { assertCompiledOperationInvariants } from "../src/plan/projected-workspace.ts";
import { packageOperations } from "../src/plan/scaffold.ts";
import { verifyProjectedImporters } from "../src/transaction/projected-importers.ts";
import { cleanupFixtures, fixtureConfig, fixtureRepo, write } from "./support/fixture-repo.ts";

const taskRunner: TaskRunnerAdapter = {
  id: "fixture", projectFileName: null, projectRegistryFileName: null,
  projectIdFor: (name) => name, projectIdOf: () => "",
  registerProject: () => ({ kind: "already-satisfied" }), wrapGateCommand: (command) => ["sh", "-c", command],
};

const cases = [
  { name: "new runtime target", existing: false, existingRuntime: false, incoming: "runtime" as const, assets: [] },
  { name: "existing runtime wins incoming dev", existing: true, existingRuntime: true, incoming: "dev" as const, assets: [] },
  { name: "existing package gains runtime", existing: true, existingRuntime: false, incoming: "runtime" as const, assets: [] },
  { name: "new asset-bearing target", existing: false, existingRuntime: false, incoming: "dev" as const, assets: ["apps/api/src/theme.css"] },
];

describe("projected workspace interaction matrix", () => {
  afterEach(cleanupFixtures);

  for (const scenario of cases) test(scenario.name, async () => {
    const root = fixtureRepo(seed(scenario.existing, scenario.existingRuntime));
    const config = fixtureConfig(root, { assetExtensions: [".css"], scaffoldTemplates: { packageJson: { contents: '{"name":"{package}","sideEffects":false}\n' } } });
    const input = {
      context: new WorkspaceContext(config, root), config, application: config.applications[0]!,
      packageManager: pnpmAdapter, taskRunner, packageName: "@acme/target", packageRoot: "libs/target", projectId: "target",
      production: [] as string[], assets: scenario.assets,
      dependencies: {
        runtime: scenario.incoming === "runtime" ? { "@acme/contracts": "workspace:*" } : {},
        dev: scenario.incoming === "dev" ? { "@acme/contracts": "workspace:*" } : {},
        packageReferences: ["libs/contracts"],
      },
    };
    const first = packageOperations(input);
    expect(packageOperations(input)).toEqual(first);
    expect(new Set(first.map(operationKey)).size).toBe(first.length);
    assertCompiledOperationInvariants(input.context, pnpmAdapter, first);
    applyStructured(root, first);
    const manifest = { target: { packageRoot: "libs/target" }, operations: first } as unknown as Parameters<typeof verifyProjectedImporters>[0]["manifest"];
    const verified = await verifyProjectedImporters({ workspacePath: root, manifest, adapter: pnpmAdapter });
    expect(verified).toMatchObject({ ok: true, checked: ["libs/target"] });
    const pkg = JSON.parse(await Bun.file(`${root}/libs/target/package.json`).text()) as Record<string, unknown>;
    const section = scenario.existingRuntime || scenario.incoming === "runtime" ? "dependencies" : "devDependencies";
    expect((pkg[section] as Record<string, string> | undefined)?.["@acme/contracts"]).toBe("workspace:*");
    if (scenario.assets.length > 0) expect(pkg.sideEffects).toEqual(["**/*.css"]);
  });
});

function seed(existing: boolean, runtime: boolean): Record<string, string> {
  const base = "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n\n  libs/contracts: {}\n\n";
  const files: Record<string, string> = {
    "pnpm-workspace.yaml": "packages:\n  - 'libs/*'\n", "pnpm-lock.yaml": base,
    "libs/contracts/package.json": '{"name":"@acme/contracts"}\n', "apps/api/src/theme.css": ".x{}\n",
  };
  if (!existing) return files;
  const dependencies = runtime ? { "@acme/contracts": "workspace:*" } : {};
  files["libs/target/package.json"] = `${JSON.stringify({ name: "@acme/target", dependencies })}\n`;
  const block = pnpmAdapter.renderImporterBlock({ packageRoot: "libs/target", dependencies, devDependencies: {}, lockfileText: base, workspaceRoots: { "@acme/contracts": "libs/contracts" } });
  files["pnpm-lock.yaml"] = pnpmAdapter.insertImporter(base, "libs/target", `${block}\n\n`);
  return files;
}

function applyStructured(root: string, operations: ReturnType<typeof packageOperations>): void {
  let lockfile = readFileSync(`${root}/pnpm-lock.yaml`, "utf8");
  for (const operation of operations) {
    if (operation.kind === "write-file") write(root, operation.path, operation.contents);
    if (operation.kind === "lockfile-importer") lockfile = pnpmAdapter.applyImporter(lockfile, operation.packageRoot, operation.block, operation.mode);
  }
  write(root, "pnpm-lock.yaml", lockfile);
}

function operationKey(operation: ReturnType<typeof packageOperations>[number]): string {
  return operation.kind === "lockfile-importer" ? `importer:${operation.packageRoot}`
    : operation.kind === "write-file" || operation.kind === "migrate-path-keys" ? `path:${operation.path}`
    : operation.kind === "rewrite-import" || operation.kind === "rewrite-fs-reference" || operation.kind === "rewrite-path-reference" ? `path:${operation.file}` : `move:${operation.source}`;
}
