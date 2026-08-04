import { afterEach, expect, test } from "bun:test";

import { pnpmAdapter } from "../src/adapters/pnpm.ts";
import type { ExtractionManifest } from "../src/plan/manifest.ts";
import { verifyProjectedImporters } from "../src/transaction/projected-importers.ts";
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
