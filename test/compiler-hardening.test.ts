/** Compact regressions distilled from production extraction failures. */

import { afterEach, describe, expect, test } from "bun:test";
import { pnpmAdapter } from "../src/adapters/pnpm.ts";
import { WorkspaceContext } from "../src/plan/context.ts";
import { collectDependencyUsage } from "../src/plan/dependency-usage.ts";
import { assertCompiledOperationInvariants, ProjectedWorkspace } from "../src/plan/projected-workspace.ts";
import { hashText } from "../src/util/hash.ts";
import { cleanupFixtures, fixtureConfig, fixtureRepo } from "./support/fixture-repo.ts";

const LOCK = `lockfileVersion: '9.0'\n\nimporters:\n\n  apps/api:\n    dependencies:\n      runtime-library:\n        specifier: 1\n        version: 1\n\npackages:\n\n  runtime-library@1: {}\n`;

describe("compiler hardening regressions", () => {
  afterEach(cleanupFixtures);

  test("structured transforms produce one final manifest and importer mutation", () => {
    const root = fixtureRepo(files());
    const context = new WorkspaceContext(fixtureConfig(root), root);
    const initialManifest = '{"name":"@acme/web","dependencies":{"@acme/carved":"workspace:*","runtime-library":"1"}}\n';
    const block = pnpmAdapter.addBlockDependency(pnpmAdapter.importerBlock(LOCK, "apps/api")!, "@acme/carved", "workspace:*", "link:../../libs/carved");
    const projected = new ProjectedWorkspace(context, pnpmAdapter, [
      {
        kind: "write-file",
        path: "apps/api/package.json",
        contents: initialManifest,
        generator: "consumer",
        preconditionHash: context.state("apps/api/package.json"),
        resultHash: hashText(initialManifest),
      },
      {
        kind: "lockfile-importer",
        lockfile: "pnpm-lock.yaml",
        packageRoot: "apps/api",
        block,
        mode: "replace",
        preconditionHash: hashText(LOCK),
        resultHash: hashText(LOCK),
      },
    ]);
    projected.transformJson("apps/api/package.json", "prune", (value) => ({ ...value, dependencies: { "@acme/carved": "workspace:*" } }));
    projected.transformImporter("apps/api", (current) => pnpmAdapter.removeBlockDependency(current, "runtime-library"));
    const operations = projected.finalize();
    expect(operations).toHaveLength(2);
    expect(JSON.parse((operations[0] as { contents: string }).contents).dependencies).toEqual({ "@acme/carved": "workspace:*" });
    expect((operations[1] as { block: string }).block).toContain("@acme/carved");
  });

  test("usage inventory sees retained tests, tsconfig types, and policy keeps", () => {
    const root = fixtureRepo(
      files({ "apps/api/src/retained.test.ts": 'import "test-library";\n', "apps/api/tsconfig.json": '{"compilerOptions":{"types":["vitest/globals"]}}\n' }),
    );
    const config = fixtureConfig(root, { dependencyPruning: { mode: "apply", keep: ["build-tool"] } });
    const evidence = collectDependencyUsage({
      context: new WorkspaceContext(config, root),
      donorRoot: "apps/api",
      movedSources: ["apps/api/src/moved.ts"],
      dependencyNames: ["test-library", "vitest", "build-tool", "runtime-library"],
    });
    expect(evidence.find(({ name }) => name === "test-library")?.retainedSources).toEqual(["apps/api/src/retained.test.ts"]);
    expect(evidence.find(({ name }) => name === "vitest")?.tsconfigTypes).toEqual([{ tsconfig: "apps/api/tsconfig.json", type: "vitest/globals" }]);
    expect(evidence.find(({ name }) => name === "build-tool")?.explicitlyKept).toBeTrue();
    expect(evidence.find(({ name }) => name === "runtime-library")).toMatchObject({ retainedSources: [], tsconfigTypes: [], explicitlyKept: false });
  });

  test("compiler invariants reject duplicate paths before manifest validation", () => {
    const root = fixtureRepo(files());
    const context = new WorkspaceContext(fixtureConfig(root), root);
    const contents = '{"name":"@acme/web"}\n';
    const operation = {
      kind: "write-file" as const,
      path: "apps/api/package.json",
      contents,
      preconditionHash: context.state("apps/api/package.json"),
      resultHash: hashText(contents),
    };
    expect(() => assertCompiledOperationInvariants(context, pnpmAdapter, [operation, operation])).toThrow("duplicate final mutation");
  });

  test("compiler invariants reject a stale lockfile hash chain", () => {
    const root = fixtureRepo(files());
    const context = new WorkspaceContext(fixtureConfig(root), root);
    const block = pnpmAdapter.importerBlock(LOCK, "apps/api")!;
    expect(() =>
      assertCompiledOperationInvariants(context, pnpmAdapter, [
        {
          kind: "lockfile-importer",
          lockfile: "pnpm-lock.yaml",
          packageRoot: "apps/api",
          block,
          mode: "replace",
          preconditionHash: "0".repeat(64),
          resultHash: hashText(LOCK),
        },
      ]),
    ).toThrow("stale lockfile precondition");
  });
});

function files(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "package.json": '{"private":true}\n',
    "apps/api/package.json": '{"name":"@acme/api","dependencies":{"runtime-library":"1"}}\n',
    "apps/api/src/moved.ts": 'import "runtime-library";\n',
    "pnpm-lock.yaml": LOCK,
    ...extra,
  };
}
