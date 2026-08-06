import { afterAll, expect, test } from "bun:test";

import { moonAdapter, noneTaskRunner } from "../src/adapters/moon.ts";
import { pnpmAdapter } from "../src/adapters/pnpm.ts";
import { PlanningError, WorkspaceContext } from "../src/plan/context.ts";
import { packageOperations } from "../src/plan/scaffold.ts";
import { cleanupFixtures, fixtureConfig, fixtureRepo } from "./support/fixture-repo.ts";

afterAll(cleanupFixtures);

function newPackage(root: string, taskRunner = noneTaskRunner, tests: readonly string[] | undefined = undefined, packageJson = '{"name":"{package}"}\n') {
  const config = fixtureConfig(root, taskRunner === moonAdapter ? {
    taskRunner: "moon",
    scaffoldTemplates: {
      packageJson: { contents: packageJson },
      taskFile: { contents: "id: {project}\ntags: [frontend-library]\n" },
    },
  } : {});
  return packageOperations({
    context: new WorkspaceContext(config, root), config, application: config.applications[0]!,
    packageManager: pnpmAdapter, taskRunner, packageName: "@acme/new-package",
    packageRoot: "libs/new-package", projectId: "new-package", production: [],
    ...(tests === undefined ? {} : { tests }), dependencies: { runtime: {}, dev: {}, packageReferences: [] },
  });
}

test("generates a Moon empty-suite override only for an explicitly test-less move", () => {
  const root = fixtureRepo({
    ".moon/workspace.yml": "projects:\n  globs:\n    - 'libs/*'\n",
    "pnpm-workspace.yaml": "packages:\n  - libs/*\n",
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n\n",
  });
  const task = newPackage(root, moonAdapter, []).find((operation) => operation.kind === "write-file" && operation.path === "libs/new-package/moon.yml");
  expect(task).toMatchObject({ kind: "write-file", contents: expect.stringContaining("args: [--passWithNoTests]") });
});

test("uses Bun's empty-suite flag for a Bun test scaffold", () => {
  const root = fixtureRepo({
    ".moon/workspace.yml": "projects:\n  globs:\n    - 'libs/*'\n",
    "pnpm-workspace.yaml": "packages:\n  - libs/*\n",
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n\n",
  });
  const task = newPackage(root, moonAdapter, [], '{"name":"{package}","scripts":{"test":"bun test"}}\n')
    .find((operation) => operation.kind === "write-file" && operation.path === "libs/new-package/moon.yml");
  expect(task).toMatchObject({ kind: "write-file", contents: expect.stringContaining("args: [--pass-with-no-tests]") });
});

test("registers a newly scaffolded package in an explicit Knip workspace map", () => {
  const root = fixtureRepo({
    "knip.jsonc": '{\n  "workspaces": {\n    ".": {}\n  }\n}\n',
    "pnpm-workspace.yaml": "packages:\n  - libs/*\n",
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n\n",
  });
  const knip = newPackage(root).find((operation) => operation.kind === "write-file" && operation.path === "knip.jsonc");
  expect(knip).toMatchObject({ kind: "write-file", contents: expect.stringContaining('"libs/new-package": {') });
});

test("records automatic React JSX dependencies as compiler-consumed Knip dependencies", () => {
  const root = fixtureRepo({
    "knip.jsonc": '{\n  "workspaces": {\n    ".": {}\n  }\n}\n',
    "pnpm-workspace.yaml": "packages:\n  - libs/*\n",
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      react:\n        specifier: 19.2.7\n        version: 19.2.7\n\npackages:\n\n  react@19.2.7: {}\n",
  });
  const config = fixtureConfig(root, {
    applications: [{ name: "web", sourceRoot: "apps/web/src", tsconfig: "apps/web/tsconfig.json", packageName: "@acme/web", compositionRoots: [], compilerProfile: { jsx: true } }],
    portfolio: { frameworkPackages: ["react"] },
  });
  const operations = packageOperations({
    context: new WorkspaceContext(config, root), config, application: config.applications[0]!,
    packageManager: pnpmAdapter, taskRunner: noneTaskRunner, packageName: "@acme/new-package",
    packageRoot: "libs/new-package", projectId: "new-package", production: ["apps/web/src/Widget.tsx"],
    dependencies: { runtime: { react: "19.2.7" }, dev: {}, packageReferences: [] },
  });
  const knip = operations.find((operation) => operation.kind === "write-file" && operation.path === "knip.jsonc");
  expect(knip).toMatchObject({ kind: "write-file", contents: expect.stringContaining('"ignoreDependencies": ["react", "@types/react", "@types/react-dom"]') });
});

test("puts inferred workspace references in a configured library project", () => {
  const root = fixtureRepo({
    "pnpm-workspace.yaml": "packages:\n  - libs/*\n",
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n\n",
    "libs/format/package.json": '{"name":"@acme/format"}\n',
  });
  const config = fixtureConfig(root, {
    scaffoldTemplates: {
      packageJson: { contents: '{"name":"{package}"}\n' },
      tsconfig: {
        contents: '{"compilerOptions":{"composite":true},"files":[],"references":[{"path":"./tsconfig.lib.json"},{"path":"./tsconfig.spec.json"}]}\n',
      },
      extraFiles: {
        "tsconfig.lib.json": { contents: '{"compilerOptions":{"jsx":"react-jsx"}}\n' },
        "tsconfig.spec.json": { contents: '{"extends":"./tsconfig.lib.json","references":[{"path":"./tsconfig.lib.json"}]}\n' },
      },
      projectReferences: { target: "tsconfig.lib.json", dependencyTarget: "tsconfig.lib.json" },
    },
  });
  const operations = packageOperations({
    context: new WorkspaceContext(config, root), config, application: config.applications[0]!,
    packageManager: pnpmAdapter, taskRunner: noneTaskRunner, packageName: "@acme/new-package",
    packageRoot: "libs/new-package", projectId: "new-package", production: ["apps/api/src/Widget.tsx"],
    dependencies: { runtime: {}, dev: {}, packageReferences: ["libs/format"] },
  });
  const writes = new Map(
    operations.filter((operation) => operation.kind === "write-file").map((operation) => [operation.path, operation.contents]),
  );

  expect(JSON.parse(writes.get("libs/new-package/tsconfig.json")!)).toEqual({
    compilerOptions: { composite: true }, files: [], references: [
      { path: "./tsconfig.lib.json" }, { path: "./tsconfig.spec.json" }, { path: "../format" },
    ],
  });
  expect(JSON.parse(writes.get("libs/new-package/tsconfig.lib.json")!)).toEqual({
    compilerOptions: { jsx: "react-jsx" }, references: [{ path: "../format/tsconfig.lib.json" }],
  });
  expect(JSON.parse(writes.get("libs/new-package/tsconfig.spec.json")!)).toEqual({
    extends: "./tsconfig.lib.json", references: [{ path: "./tsconfig.lib.json" }],
  });
});

test("refuses a configured reference target without a scaffold template", () => {
  const root = fixtureRepo({ "README.md": "fixture\n" });
  const config = fixtureConfig(root, {
    scaffoldTemplates: {
      packageJson: { contents: '{"name":"{package}"}\n' },
      projectReferences: { target: "tsconfig.lib.json", dependencyTarget: "tsconfig.lib.json" },
    },
  });

  expect(() => packageOperations({
    context: new WorkspaceContext(config, root), config, application: config.applications[0]!,
    packageManager: pnpmAdapter, taskRunner: noneTaskRunner, packageName: "@acme/new-package",
    packageRoot: "libs/new-package", projectId: "new-package", production: [],
    dependencies: { runtime: {}, dev: {}, packageReferences: [] },
  })).toThrow(PlanningError);
  expect(() => packageOperations({
    context: new WorkspaceContext(config, root), config, application: config.applications[0]!,
    packageManager: pnpmAdapter, taskRunner: noneTaskRunner, packageName: "@acme/new-package",
    packageRoot: "libs/new-package", projectId: "new-package", production: [],
    dependencies: { runtime: {}, dev: {}, packageReferences: [] },
  })).toThrow('projectReferences.target "tsconfig.lib.json" must name a configured scaffold extraFile');
});
