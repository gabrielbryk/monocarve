import { afterAll, expect, test } from "bun:test";

import { moonAdapter } from "../src/adapters/moon.ts";
import { pnpmAdapter } from "../src/adapters/pnpm.ts";
import { WorkspaceContext } from "../src/plan/context.ts";
import { consumerWiringOperations } from "../src/plan/scaffold.ts";
import { cleanupFixtures, fixtureConfig, fixtureRepo } from "./support/fixture-repo.ts";

afterAll(cleanupFixtures);

test("wires retained-test consumers as dev dependencies and promotes a mixed owner to runtime", () => {
  const lockfile = "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n\n  apps/api: {}\n";
  const root = fixtureRepo({
    "apps/api/package.json": '{"name":"@acme/api","private":true}\n',
    "pnpm-lock.yaml": lockfile,
  });
  const config = fixtureConfig(root);
  const context = new WorkspaceContext(config, root);
  const input = (consumerOwners: readonly ({ owner: string; dependencySection: "runtime" | "dev" })[]) =>
    consumerWiringOperations({
      context, config, application: config.applications[0]!, packageManager: pnpmAdapter, taskRunner: moonAdapter,
      packageName: "@acme/new-package", packageRoot: "libs/new-package", projectId: "new-package", production: [],
      dependencies: { runtime: {}, dev: {}, packageReferences: [] }, consumerOwners, lockfileText: lockfile,
    });

  const dev = input([{ owner: "apps/api", dependencySection: "dev" }]);
  expect(dev.find((operation) => operation.kind === "write-file" && operation.path === "apps/api/package.json"))
    .toMatchObject({ contents: expect.stringMatching(/"devDependencies"/) });
  expect(dev.find((operation) => operation.kind === "lockfile-importer"))
    .toMatchObject({ block: expect.stringContaining("    devDependencies:") });

  const mixed = input([
    { owner: "apps/api", dependencySection: "dev" },
    { owner: "apps/api", dependencySection: "runtime" },
  ]);
  expect(mixed.find((operation) => operation.kind === "write-file" && operation.path === "apps/api/package.json"))
    .toMatchObject({ contents: expect.stringMatching(/"dependencies"/) });
  expect(mixed.find((operation) => operation.kind === "lockfile-importer"))
    .toMatchObject({ block: expect.stringContaining("    dependencies:") });

  const promotionLockfile = [
    "lockfileVersion: '9.0'", "", "importers:", "", "  .: {}", "", "  apps/api:",
    "    devDependencies:", "      '@acme/new-package':", "        specifier: workspace:*",
    "        version: link:../../libs/new-package", "",
  ].join("\n");
  const promotionRoot = fixtureRepo({
    "apps/api/package.json": '{"name":"@acme/api","devDependencies":{"@acme/new-package":"workspace:*"}}\n',
    "pnpm-lock.yaml": promotionLockfile,
  });
  const promotionConfig = fixtureConfig(promotionRoot);
  const promoted = consumerWiringOperations({
    context: new WorkspaceContext(promotionConfig, promotionRoot), config: promotionConfig,
    application: promotionConfig.applications[0]!, packageManager: pnpmAdapter, taskRunner: moonAdapter,
    packageName: "@acme/new-package", packageRoot: "libs/new-package", projectId: "new-package", production: [],
    dependencies: { runtime: {}, dev: {}, packageReferences: [] },
    consumerOwners: [{ owner: "apps/api", dependencySection: "runtime" }], lockfileText: promotionLockfile,
  });
  const manifest = promoted.find((operation) => operation.kind === "write-file" && operation.path === "apps/api/package.json");
  const contents = manifest?.kind === "write-file" ? manifest.contents : undefined;
  expect(contents).toEqual(expect.any(String));
  const parsed = JSON.parse(contents!) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  expect(parsed.dependencies?.["@acme/new-package"]).toBe("workspace:*");
  expect(parsed.devDependencies?.["@acme/new-package"]).toBeUndefined();
  const importer = promoted.find((operation) => operation.kind === "lockfile-importer");
  const block = importer?.kind === "lockfile-importer" ? importer.block : "";
  expect(block.includes("    dependencies:")).toBe(true);
  expect(block.includes("    devDependencies:")).toBe(false);
});

test("does not add a project reference to an ordinary noEmit application config", () => {
  const root = fixtureRepo({
    "package.json": '{"name":"@acme/app","private":true}\n',
    "tsconfig.json": '{"compilerOptions":{"noEmit":true}}\n',
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n",
  });
  const config = fixtureConfig(root);
  const operations = consumerWiringOperations({
    context: new WorkspaceContext(config, root), config, application: config.applications[0]!,
    packageManager: pnpmAdapter, taskRunner: moonAdapter, packageName: "@acme/new-package",
    packageRoot: "libs/new-package", projectId: "new-package", production: [],
    dependencies: { runtime: {}, dev: {}, packageReferences: [] },
    consumerOwners: [{ owner: ".", dependencySection: "runtime" }],
    lockfileText: "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n",
  });
  expect(operations.some((operation) => operation.kind === "write-file" && operation.path === "package.json")).toBe(true);
  expect(operations.some((operation) => operation.kind === "write-file" && operation.path === "./tsconfig.json")).toBe(false);
});
