import { afterEach, expect, test } from "bun:test";
import { moonAdapter } from "../src/adapters/moon.ts";
import { pnpmAdapter } from "../src/adapters/pnpm.ts";
import { WorkspaceContext } from "../src/plan/context.ts";
import { packageOperations } from "../src/plan/scaffold.ts";
import { cleanupFixtures, fixtureConfig, fixtureRepo } from "./support/fixture-repo.ts";

afterEach(cleanupFixtures);

test("refuses a JSX application scaffold whose configured tsconfig cannot enable JSX", () => {
  const root = fixtureRepo({ "pnpm-workspace.yaml": "packages:\n  - libs/*\n", "pnpm-lock.yaml": "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n\n" });
  const config = fixtureConfig(root, {
    applications: [{ name: "api", sourceRoot: "apps/api/src", tsconfig: "apps/api/tsconfig.json", packageName: "@acme/api", compilerProfile: { jsx: true } }],
    scaffoldTemplates: { packageJson: { contents: '{"name":"{package}"}\n' }, tsconfig: { contents: '{"compilerOptions":{"strict":true}}\n' } },
  });
  expect(() => packageOperations({
    context: new WorkspaceContext(config, root), config, application: config.applications[0]!,
    packageManager: pnpmAdapter, taskRunner: moonAdapter, packageName: "@acme/new-package",
    packageRoot: "libs/new-package", projectId: "new-package", production: ["apps/api/src/view.tsx"],
    dependencies: { runtime: {}, dev: {}, packageReferences: [] },
  })).toThrow("compilerProfile requires JSX");
});
