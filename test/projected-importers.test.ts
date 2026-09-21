import { afterEach, expect, test } from "bun:test";

import { pnpmAdapter } from "../src/adapters/pnpm.ts";
import type { ExtractionManifest } from "../src/plan/manifest.ts";
import { verifyPackageImporters, verifyProjectedImporters } from "../src/transaction/projected-importers.ts";
import { cleanupFixtures, fixtureRepo } from "./support/fixture-repo.ts";

afterEach(cleanupFixtures);

test("projected importer proof rejects a dependency-section mismatch", async () => {
  const base = "lockfileVersion: '9.0'\n\nimporters:\n\npackages:\n\n";
  const block = pnpmAdapter.renderImporterBlock({
    packageRoot: "libs/target", dependencies: {}, devDependencies: { "@acme/contracts": "workspace:*" },
    lockfileText: base, workspaceRoots: { "@acme/contracts": "libs/contracts" },
  });
  const lockfile = pnpmAdapter.insertImporter(base, "libs/target", `${block}\n\n`);
  const root = fixtureRepo({
    "pnpm-workspace.yaml": "packages:\n  - 'libs/*'\n",
    "pnpm-lock.yaml": lockfile,
    "libs/target/package.json": '{"name":"@acme/target","dependencies":{"@acme/contracts":"workspace:*"}}\n',
    "libs/contracts/package.json": '{"name":"@acme/contracts"}\n',
  });
  const manifest = { operations: [{ kind: "lockfile-importer", packageRoot: "libs/target" }] } as unknown as ExtractionManifest;
  const result = await verifyProjectedImporters({ workspacePath: root, manifest, adapter: pnpmAdapter });
  expect(result.ok).toBeFalse();
  expect(result.differences).toEqual([{ packageRoot: "libs/target", message: "package.json dependency sections do not match the projected lockfile importer" }]);
});

test("projected importer proof keeps an existing peer-context resolution local", async () => {
  const lockfile = [
    "lockfileVersion: '9.0'",
    "",
    "importers:",
    "",
    "  .: {}",
    "",
    "  apps/admin:",
    "    dependencies:",
    "      pluggable:",
    "        specifier: ^1.0.0",
    "        version: 1.0.0(react@17.0.0)",
    "",
    "  apps/web:",
    "    dependencies:",
    "      pluggable:",
    "        specifier: ^1.0.0",
    "        version: 1.0.0(react@18.0.0)",
    "",
    "packages:",
    "  pluggable@1.0.0:",
    "    resolution: {integrity: sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==}",
    "",
    "snapshots:",
    "  pluggable@1.0.0(react@17.0.0): {}",
    "  pluggable@1.0.0(react@18.0.0): {}",
    "",
  ].join("\n");
  const root = fixtureRepo({
    "pnpm-workspace.yaml": "packages:\n  - apps/*\n",
    "pnpm-lock.yaml": lockfile,
    "apps/admin/package.json": '{"name":"@acme/admin","dependencies":{"pluggable":"^1.0.0"}}\n',
    "apps/web/package.json": '{"name":"@acme/web","dependencies":{"pluggable":"^1.0.0"}}\n',
  });

  const result = await verifyPackageImporters(root, pnpmAdapter, ["apps/admin"]);

  expect(result).toEqual({ ok: true, checked: ["apps/admin"], differences: [] });
});
