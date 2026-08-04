import { afterEach, expect, test } from "bun:test";

import { pnpmAdapter } from "../src/adapters/pnpm.ts";
import { auditRepositoryPostconditions } from "../src/transaction/postconditions.ts";
import { cleanupFixtures, fixtureRepo } from "./support/fixture-repo.ts";

afterEach(cleanupFixtures);

test("repository postconditions reject duplicate sections and unresolved workspace packages", async () => {
  const base = "lockfileVersion: '9.0'\n\nimporters:\n\n  libs/contracts: {}\n\n";
  const block = pnpmAdapter.renderImporterBlock({ packageRoot: "libs/app", dependencies: { "@acme/contracts": "workspace:*" }, devDependencies: { "@acme/contracts": "workspace:*", "@acme/missing": "workspace:*" }, lockfileText: base, workspaceRoots: { "@acme/contracts": "libs/contracts", "@acme/missing": "libs/missing" } });
  const root = fixtureRepo({
    "pnpm-workspace.yaml": "packages:\n  - 'libs/*'\n",
    "pnpm-lock.yaml": pnpmAdapter.insertImporter(base, "libs/app", `${block}\n\n`),
    "libs/app/package.json": '{"name":"@acme/app","dependencies":{"@acme/contracts":"workspace:*"},"devDependencies":{"@acme/contracts":"workspace:*","@acme/missing":"workspace:*"}}\n',
    "libs/contracts/package.json": '{"name":"@acme/contracts"}\n',
  });
  const report = await auditRepositoryPostconditions({ rootDir: root, adapter: pnpmAdapter });
  expect(report.passed).toBeFalse();
  expect(report.failures).toContain("libs/app/package.json: @acme/contracts appears in conflicting sections dependencies, devDependencies");
  expect(report.failures).toContain("libs/app/package.json: unresolved workspace dependency @acme/missing");
});

test("repository postconditions include the root package importer", async () => {
  const root = fixtureRepo({
    "package.json": '{"name":"@acme/root","dependencies":{"left-pad":"1.0.0"}}\n',
    "pnpm-workspace.yaml": "packages: []\n",
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n\n",
  });
  const report = await auditRepositoryPostconditions({ rootDir: root, adapter: pnpmAdapter });
  expect(report.passed).toBeFalse();
  expect(report.checkedPackages).toContain(".");
  expect(report.failures.join("\n")).toContain(".: cannot project importer");
});

test("repository postconditions accept a catalog dependency whose pnpm importer carries its concrete selected range", async () => {
  const root = fixtureRepo({
    "package.json": JSON.stringify({
      name: "@acme/root",
      devDependencies: { "left-pad": "catalog:" },
      workspaces: { catalog: { "left-pad": "1.3.0" } },
    }),
    "pnpm-workspace.yaml": "packages: []\n",
    "pnpm-lock.yaml": [
      "lockfileVersion: '9.0'",
      "",
      "importers:",
      "",
      "  .:",
      "    devDependencies:",
      "      left-pad:",
      "        specifier: 1.3.0",
      "        version: 1.3.0",
      "",
      "packages:",
      "",
      "  left-pad@1.3.0: {}",
      "",
    ].join("\n"),
  });

  const report = await auditRepositoryPostconditions({ rootDir: root, adapter: pnpmAdapter });

  expect(report.passed).toBeTrue();
  expect(report.importerVerification.differences).toEqual([]);
});

test("scoped postconditions do not project unrelated workspace importers", async () => {
  const base = "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n\n  libs/target: {}\n\n";
  const root = fixtureRepo({
    "pnpm-workspace.yaml": "packages:\n  - 'libs/*'\n",
    "pnpm-lock.yaml": base,
    "package.json": '{"name":"@acme/root"}\n',
    "libs/target/package.json": '{"name":"@acme/target"}\n',
    "libs/unrelated/package.json": '{"name":"@acme/unrelated","dependencies":{"unprojectable":"catalog:"}}\n',
  });
  const report = await auditRepositoryPostconditions({ rootDir: root, adapter: pnpmAdapter, packageRoots: [".", "libs/target"] });
  expect(report.passed).toBeTrue();
  expect(report.checkedPackages).toEqual([".", "libs/target"]);
});
