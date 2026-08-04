import { afterEach, describe, expect, test } from "bun:test";
import { pnpmAdapter } from "../src/adapters/pnpm.ts";
import { WorkspaceContext } from "../src/plan/context.ts";
import { composeDonorDependencyPruning, donorDependencyPruningCandidates } from "../src/plan/donor-pruning.ts";
import { hashText } from "../src/util/hash.ts";
import { cleanupFixtures, fixtureConfig, fixtureRepo } from "./support/fixture-repo.ts";

const MOVED = "apps/api/src/moved.ts";
const RETAINED = "apps/api/src/retained.ts";
const LOCK = `lockfileVersion: '9.0'\n\nimporters:\n\n  apps/api:\n    dependencies:\n      left-pad:\n        specifier: 1.3.0\n        version: 1.3.0\n\npackages:\n\n  left-pad@1.3.0: {}\n`;

describe("donor dependency pruning", () => {
  afterEach(cleanupFixtures);

  test("removes the manifest and importer entry when only moved code references it", () => {
    const root = fixtureRepo(files("export const retained = true;\n"));
    const result = operations(root);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ kind: "write-file", path: "apps/api/package.json", generator: "wiring:consumer-dependency+donor-dependency-pruning" });
    expect((result[0] as { contents: string }).contents).not.toContain("left-pad");
    expect((result[0] as { contents: string }).contents).toContain("@acme/new-package");
    expect((result[1] as { block: string }).block).toContain("@acme/new-package");
    expect((result[1] as { block: string }).block).not.toContain("left-pad");
  });

  test("retains the dependency when any donor source still references it", () => {
    const root = fixtureRepo(files('import leftPad from "left-pad";\nexport const retained = leftPad;\n'));
    const result = operations(root);
    expect((result[0] as { contents: string }).contents).toContain("left-pad");
  });

  test("reports rather than disproving possible non-source consumers", () => {
    const root = fixtureRepo({ ...files("export const retained = true;\n"), "scripts/build.mjs": 'import "left-pad";\n' });
    const { context, dependencies } = evidence(root);
    expect(donorDependencyPruningCandidates({ context, donorRoot: "apps/api", movedSources: [MOVED], dependencies }))
      .toEqual([{ name: "left-pad", section: "runtime" }]);
    expect(context.config.dependencyPruning.mode).toBe("report");
  });

  test("counts retained tests, tsconfig types, and configured keep entries as consumers", () => {
    const root = fixtureRepo({
      "package.json": '{"private":true}\n',
      "apps/api/package.json": '{"name":"@acme/api","devDependencies":{"test-library":"1","vitest":"1","build-tool":"1"}}\n',
      "apps/api/tsconfig.json": '{"compilerOptions":{"types":["vitest/globals"]}}\n',
      [MOVED]: 'import "test-library"; import "vitest"; import "build-tool";\n',
      "apps/api/src/retained.test.ts": 'import "test-library";\n',
    });
    const config = fixtureConfig(root, { dependencyPruning: { mode: "apply", keep: ["build-tool"] } });
    const context = new WorkspaceContext(config, root);
    const candidates = donorDependencyPruningCandidates({
      context, donorRoot: "apps/api", movedSources: [MOVED],
      dependencies: { runtime: {}, dev: { "build-tool": "1", "test-library": "1", vitest: "1" }, packageReferences: [] },
    });
    expect(candidates).toEqual([]);
  });
});

function files(retained: string): Record<string, string> {
  return {
    "package.json": '{"private":true}\n',
    "apps/api/package.json": '{"name":"@acme/api","dependencies":{"left-pad":"1.3.0"}}\n',
    [MOVED]: 'import leftPad from "left-pad"; export const moved = leftPad;\n',
    [RETAINED]: retained,
    "pnpm-lock.yaml": LOCK,
  };
}

function operations(root: string) {
  const { context, dependencies } = evidence(root);
  const manifestContents = '{"name":"@acme/api","dependencies":{"@acme/new-package":"workspace:*","left-pad":"1.3.0"}}\n';
  const donorBlock = pnpmAdapter.addBlockDependency(pnpmAdapter.importerBlock(LOCK, "apps/api")!, "@acme/new-package", "workspace:*", "link:../../libs/new-package");
  const operations = [
    { kind: "write-file" as const, path: "apps/api/package.json", contents: manifestContents, generator: "wiring:consumer-dependency", preconditionHash: context.state("apps/api/package.json"), resultHash: hashText(manifestContents) },
    { kind: "lockfile-importer" as const, lockfile: "pnpm-lock.yaml", packageRoot: "apps/api", block: donorBlock, mode: "replace" as const, preconditionHash: hashText(LOCK), resultHash: hashText(LOCK) },
  ];
  return composeDonorDependencyPruning({ context, donorRoot: "apps/api", movedSources: [MOVED], dependencies, packageManager: pnpmAdapter, operations });
}

function evidence(root: string) {
  const config = fixtureConfig(root);
  const context = new WorkspaceContext(config, root);
  const dependencies = { runtime: { "left-pad": "1.3.0" }, dev: {}, packageReferences: [] };
  return { context, dependencies };
}
